// RemoteServer (M3: HTTPS + auth; see technical design §2.5/§2.9).
//
// Changes from M2:
//   - TLS always on (cert/key injected; plain HTTP gets nothing usable)
//   - GET/POST /login with the self-contained login page (shows cert
//     fingerprint for eyeball anti-MITM)
//   - Everything except /login and /health requires a valid session cookie
//   - WS upgrade validates the cookie BEFORE handleUpgrade (401 otherwise)
//   - Per-IP failed-login rate limiting handled by AuthManager
//   - maxSessions cap from config enforced on `create`
//
// Carried over from M2: ws maxPayload guard, BAD_MESSAGE disconnect,
// heartbeat sweep (pong + slow-client backlog), replay-on-attach.

import * as https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionRegistry } from './sessionRegistry';
import { t, Locale, detectLocale } from '../shared/i18n';
import { AuthManager, SESSION_COOKIE } from './authManager';
import type { SessionInfo, DataPayload, ExitPayload, TitlePayload } from '../shared/ipcChannels';
import {
  WS,
  encodeServerMessage,
  parseClientMessage,
  type ServerMessage,
  type WsTabsMsg,
  type WsAttachedMsg,
  type WsDataMsg,
  type WsExitMsg,
  type WsTitleMsg,
  type WsErrorMsg,
} from '../shared/wsProtocol';

export interface RemoteServerOptions {
  /** UI locale for served pages (default: env TERNIMAL_LOCALE, else en). */
  locale?: Locale;
  registry: SessionRegistry;
  auth: AuthManager;
  tls: { cert: string; key: string };
  /** Listen port; 0 = ephemeral (tests). Default 8443. */
  port?: number;
  /** Bind address. Default 0.0.0.0 (design: LAN/VPN only). */
  host?: string;
  /** Static web root; missing dir is tolerated (404s). */
  webRoot?: string;
  heartbeatIntervalMs?: number;
  slowClientBytes?: number;
  maxSessions?: number;
}

interface ClientState {
  ws: WebSocket;
  attached: Set<string>;
  sawPong: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export class RemoteServer {
  private readonly registry: SessionRegistry;
  private readonly auth: AuthManager;
  private readonly tls: { cert: string; key: string };
  private readonly port: number;
  private readonly host: string;
  private readonly webRoot: string;
  private readonly heartbeatIntervalMs: number;
  private readonly slowClientBytes: number;
  private readonly maxSessions: number;

  private server: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<ClientState> = new Set();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private unsubscribeRegistry: (() => void)[] = [];
  private actualPort = 0;
  certFingerprint = ''; // set by owner for the login page (WBS-M3-A display)
  locale: Locale = detectLocale(process.env.TERNIMAL_LOCALE);

  constructor(opts: RemoteServerOptions) {
    this.registry = opts.registry;
    this.auth = opts.auth;
    this.locale = opts.locale ?? this.locale;
    this.tls = opts.tls;
    this.port = opts.port ?? 8443;
    this.host = opts.host ?? '0.0.0.0';
    this.webRoot = opts.webRoot ?? path.join(__dirname, '..', 'web');
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? WS.HEARTBEAT_INTERVAL_MS;
    this.slowClientBytes = opts.slowClientBytes ?? WS.SLOW_CLIENT_BYTES;
    this.maxSessions = opts.maxSessions ?? 16;
  }

  /** Start listening. Resolves with the actual port (useful for port 0). */
  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.actualPort);

    this.server = https.createServer({ cert: this.tls.cert, key: this.tls.key }, (req, res) => {
      this.handleHttp(req, res).catch((err) => {
        try {
          res.writeHead(500).end('internal error');
        } catch {
          /* response already gone */
        }
        console.error('[Ternimal] HTTP handler error:', err);
      });
    });

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: WS.MAX_MESSAGE_BYTES,
    });

    this.server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url || '/', 'https://localhost');
      if (pathname !== WS.PATH) {
        socket.destroy();
        return;
      }
      // WBS-M3-C: reject unauthenticated upgrades before any WS traffic.
      const token = this.auth.tokenFromCookieHeader(req.headers.cookie);
      if (!this.auth.isValidSession(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.registerClient(ws);
      });
    });

    this.subscribeRegistry();

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.actualPort = (this.server!.address() as import('net').AddressInfo).port;
        // eslint-disable-next-line no-console
        console.warn(
          `[Ternimal] RemoteServer (HTTPS, token-auth) listening on ` +
            `https://${this.host}:${this.actualPort} — LAN/VPN only.`
        );
        this.startHeartbeat();
        resolve(this.actualPort);
      });
    });
  }

  stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unsubscribeRegistry.forEach((fn) => fn());
    this.unsubscribeRegistry = [];
    for (const client of this.clients) {
      client.ws.terminate();
    }
    this.clients.clear();
    const closeWss = this.wss
      ? new Promise<void>((r) => this.wss!.close(() => r()))
      : Promise.resolve();
    const closeHttp = this.server
      ? new Promise<void>((r) => this.server!.close(() => r()))
      : Promise.resolve();
    this.wss = null;
    this.server = null;
    return Promise.all([closeWss, closeHttp]).then(() => undefined);
  }

  getPort(): number {
    return this.actualPort;
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  // ---------- HTTP ----------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'https://localhost');
    const ip = req.socket.remoteAddress ?? 'unknown';
    const authed = this.auth.isValidSession(
      this.auth.tokenFromCookieHeader(req.headers.cookie)
    );

    // Open routes: health probe + auth page/submit. Everything else gated.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    // /login is kept as a GET alias (bookmarks); the POST target is /auth.
    if (url.pathname === '/login' || url.pathname === '/auth') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const badToken = url.searchParams.get('e') === '1';
        const locked = this.auth.isLocked(ip);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(authPageHtml(this.locale, this.certFingerprint, badToken, locked));
        return;
      }
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const token = new URLSearchParams(body).get('token') ?? '';
        const result = this.auth.login(ip, token);
        if (result.ok && result.cookie) {
          res.writeHead(303, { 'Set-Cookie': result.cookie, Location: '/' }).end();
        } else if (result.status === 429) {
          res.writeHead(429, { 'Retry-After': String(Math.ceil((result.retryAfterMs ?? 60000) / 1000)) });
          res.end('too many attempts — locked for 1 minute');
        } else {
          res.writeHead(303, { Location: '/login?e=1' }).end();
        }
        return;
      }
      res.writeHead(405).end();
      return;
    }

    if (!authed) {
      res.writeHead(302, { Location: '/login' }).end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    // Map / → index.html; /static/<f> → webRoot/<f> with traversal guard.
    let relative: string | null = null;
    if (url.pathname === '/' || url.pathname === '/index.html') {
      relative = 'index.html';
    } else if (url.pathname.startsWith('/static/')) {
      relative = url.pathname.slice('/static/'.length);
    }

    if (!relative) {
      res.writeHead(404).end('not found');
      return;
    }

    const filePath = path.normalize(path.join(this.webRoot, relative));
    // Defense: normalized path must stay inside webRoot.
    if (!filePath.startsWith(this.webRoot + path.sep) && filePath !== this.webRoot) {
      res.writeHead(403).end('forbidden');
      return;
    }

    await new Promise<void>((resolve) => {
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end('not found');
        } else {
          const type =
            CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type }).end(req.method === 'HEAD' ? undefined : data);
        }
        resolve();
      });
    });
  }

  private readBody(req: IncomingMessage, limit = 4096): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---------- WS wiring ----------

  private registerClient(ws: WebSocket): void {
    const client: ClientState = { ws, attached: new Set(), sawPong: true };
    this.clients.add(client);

    ws.on('pong', () => {
      client.sawPong = true;
    });

    ws.on('message', (raw) => {
      this.handleClientMessage(client, raw.toString());
    });

    ws.on('close', () => {
      this.clients.delete(client);
    });
    ws.on('error', () => {
      this.clients.delete(client);
      try {
        ws.terminate();
      } catch {
        /* already dead */
      }
    });

    // Zero-latency bootstrap: push the current tab list immediately.
    this.sendTo(client, { type: 'tabs', tabs: this.registry.list() } as WsTabsMsg);
  }

  private handleClientMessage(client: ClientState, raw: string): void {
    if (Buffer.byteLength(raw, 'utf8') > WS.MAX_MESSAGE_BYTES) {
      this.failWith(client, WS.ERROR_CODES.BAD_MESSAGE, 'frame too large');
      return;
    }
    const msg = parseClientMessage(raw);
    if (process.env.TERNIMAL_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[RemoteServer:debug] msg=${raw.slice(0, 120)} parsed=${msg ? msg.type : 'null'}`);
    }
    if (!msg) {
      this.failWith(client, WS.ERROR_CODES.BAD_MESSAGE, 'malformed message');
      return;
    }

    switch (msg.type) {
      case 'list':
        this.sendTo(client, { type: 'tabs', tabs: this.registry.list() });
        return;
      case 'create': {
        if (this.registry.list().length >= this.maxSessions) {
          this.sendTo(client, {
            type: 'error',
            code: WS.ERROR_CODES.BAD_MESSAGE,
            message: `session limit reached (${this.maxSessions})`,
          } as WsErrorMsg);
          return;
        }
        try {
          this.registry.create({ cols: 80, rows: 24, shell: msg.shell, cwd: msg.cwd });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[RS:debug] create THREW:`, (err as Error).stack ?? err);
        }
        return;
      }
      case 'close':
        this.registry.kill(msg.id);
        return;
      case 'attach': {
        const session = this.registry.list().find((s) => s.id === msg.id);
        if (process.env.TERNIMAL_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(`[RemoteServer:debug] attach ${msg.id} found=${!!session}`);
        }
        if (!session) {
          this.sendTo(client, {
            type: 'error',
            code: WS.ERROR_CODES.NO_SESSION,
            message: `no session ${msg.id}`,
          } as WsErrorMsg);
          return;
        }
        client.attached.add(msg.id);
        this.sendTo(client, {
          type: 'attached',
          id: session.id,
          replay: this.registry.getReplay(session.id),
          cols: session.cols,
          rows: session.rows,
          title: session.title,
        } as WsAttachedMsg);
        return;
      }
      case 'detach':
        client.attached.delete(msg.id);
        return;
      case 'input':
        if (client.attached.has(msg.id)) {
          this.registry.write(msg.id, msg.data);
        } else {
          this.sendTo(client, {
            type: 'error',
            code: WS.ERROR_CODES.NO_SESSION,
            message: `not attached to ${msg.id}`,
          } as WsErrorMsg);
        }
        return;
      case 'resize':
        this.registry.resize(msg.id, msg.cols, msg.rows);
        return;
    }
  }

  private failWith(client: ClientState, code: number, message: string): void {
    try {
      this.sendTo(client, { type: 'error', code, message } as WsErrorMsg);
      client.ws.close(1008, message);
    } catch {
      client.ws.terminate();
    }
  }

  // ---------- registry fan-out ----------

  private subscribeRegistry(): void {
    const on = (event: string, handler: (payload: never) => void) => {
      this.registry.on(event, handler as never);
      this.unsubscribeRegistry.push(() => this.registry.off(event, handler as never));
    };

    on('data', (payload: DataPayload) => {
      const msg: WsDataMsg = { type: 'data', id: payload.id, data: payload.data };
      for (const client of this.clients) {
        if (client.attached.has(payload.id)) {
          this.sendTo(client, msg);
        }
      }
    });

    on('exit', (payload: ExitPayload) => {
      const msg: WsExitMsg = { type: 'exit', id: payload.id, exitCode: payload.exitCode };
      for (const client of this.clients) {
        if (client.attached.has(payload.id)) {
          client.attached.delete(payload.id);
          this.sendTo(client, msg);
        }
      }
    });

    on('title', (payload: TitlePayload) => {
      const msg: WsTitleMsg = { type: 'title', id: payload.id, title: payload.title };
      for (const client of this.clients) {
        this.sendTo(client, msg);
      }
    });

    on('tabs', (tabs: SessionInfo[]) => {
      if (process.env.TERNIMAL_DEBUG) {
        // eslint-disable-next-line no-console
        console.error(`[RS:debug] tabs fanout n=${tabs.length} clients=${this.clients.size}`);
      }
      const msg: WsTabsMsg = { type: 'tabs', tabs };
      for (const client of this.clients) {
        this.sendTo(client, msg);
      }
    });
  }

  // ---------- heartbeat + slow-client sweeps ----------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.sawPong) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        // Slow-client sweep: a browser that stopped draining its socket
        // gets cut so the PTY read loop never blocks on it (risk R2).
        if (client.ws.bufferedAmount > this.slowClientBytes) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.sawPong = false;
        try {
          client.ws.ping();
        } catch {
          this.clients.delete(client);
        }
      }
    }, this.heartbeatIntervalMs);
  }

  /** Backpressure-aware send: never throws, cuts slow clients instead. */
  private sendTo(client: ClientState, msg: ServerMessage): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > this.slowClientBytes) {
      client.ws.terminate();
      this.clients.delete(client);
      return;
    }
    try {
      client.ws.send(encodeServerMessage(msg));
    } catch {
      this.clients.delete(client);
    }
  }
}

/** Self-contained auth page (no external assets; CSP-friendly).
 *  Auto-exchanges the URL fragment "#T=<token>" (from the tray QR code /
 *  copied access link — the fragment never reaches the server) for a
 *  session cookie, then relocates to /. Manual paste kept as fallback. */
function authPageHtml(locale: Locale, fingerprint: string, badToken: boolean, locked: boolean): string {
  const fp = fingerprint || '(unavailable)';
  const L = locale;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t(L, 'auth.title')}</title>
<style>
  body { background:#1e1e1e; color:#d4d4d4; font-family:system-ui,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { background:#252526; padding:32px; border-radius:8px; width:320px;
          box-shadow:0 4px 24px rgba(0,0,0,.5); }
  h1 { font-size:18px; margin:0 0 20px; }
  input[type=text] { width:100%; box-sizing:border-box; padding:10px; border-radius:4px;
          border:1px solid #3c3c3c; background:#1e1e1e; color:#d4d4d4; font-size:15px; }
  button { width:100%; margin-top:12px; padding:10px; border:0; border-radius:4px;
           background:#0e639c; color:#fff; font-size:15px; cursor:pointer; }
  button:hover { background:#1177bb; }
  .err { color:#f48771; font-size:13px; min-height:18px; margin-top:10px; }
  .fp { margin-top:20px; font-size:11px; color:#6a6a6a; word-break:break-all; }
  .fp b { color:#8a8a8a; }
  .hint { margin-top:10px; font-size:12px; color:#8a8a8a; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/auth" id="f">
    <h1>${t(L, 'auth.heading')}</h1>
    <input type="text" name="token" placeholder="${t(L, 'auth.placeholder')}" autofocus ${locked ? 'disabled' : ''}>
    <button type="submit" ${locked ? 'disabled' : ''}>${locked ? t(L, 'auth.locked') : t(L, 'auth.submit')}</button>
    <div class="err">${badToken ? t(L, 'auth.wrongToken') : ''}${locked ? t(L, 'auth.tooMany') : ''}</div>
    <div class="hint">${t(L, 'auth.hint')}</div>
    <div class="fp"><b>${t(L, 'auth.fpLabel')}</b><br>${fp}</div>
  </form>
  <script>
    (function () {
      var m = /^#T=(.+)$/.exec(location.hash || '');
      if (!m) return;
      try { history.replaceState(null, '', '/'); } catch (e) {}
      var body = 'token=' + encodeURIComponent(m[1]);
      fetch('/auth', { method: 'POST', credentials: 'same-origin',
                       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                       body: body, redirect: 'manual' })
        .then(function (r) { location.href = r.type === 'opaqueredirect' ? '/' : (r.redirected ? r.url : '/'); })
        .catch(function () {});
    })();
  </script>
</body>
</html>`;
}
