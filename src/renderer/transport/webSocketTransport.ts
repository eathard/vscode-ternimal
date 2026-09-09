// WebSocketTransport (M2, design §2.4) — TerminalTransport over the /ws
// protocol for the remote web client. Owns connection lifecycle: exponential
// backoff reconnect (1s..30s) and automatic re-attach of known sessions so a
// network blip mid-Claude-Code-task heals transparently (replay comes from
// the server's ring buffer via `attached`).
import type {
  SessionInfo,
  DataPayload,
  ExitPayload,
  TitlePayload,
} from '../../shared/ipcChannels';
import type {
  TerminalTransport,
  CreateTabOptions,
  AttachedPayload,
  Unsubscribe,
} from './transport';

type ListenerBag = {
  tabs: Array<(tabs: SessionInfo[]) => void>;
  data: Array<(p: DataPayload) => void>;
  exit: Array<(p: ExitPayload) => void>;
  title: Array<(p: TitlePayload) => void>;
  attached: Array<(p: AttachedPayload) => void>;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Node/test injection seam (M4-D): the browser build uses the global
 * WebSocket with no options; verify-reconnect.mjs passes the `ws` package
 * implementation plus a Cookie header so the REAL transport code can be
 * exercised outside a browser.
 */
export interface WebSocketTransportOptions {
  wsImpl?: any;
  wsOptions?: Record<string, unknown>;
}
export class WebSocketTransport implements TerminalTransport {
  private url: string;
  private wsImpl: any;
  private wsOptions?: Record<string, unknown>;
  private ws: any = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Sessions this client wants to follow across reconnects. */
  private attachedIds = new Set<string>();
  /** Latest tab list (lets late UI subscribers render immediately). */
  private lastTabs: SessionInfo[] = [];
  private knownIds = new Set<string>();
  private listeners: ListenerBag = { tabs: [], data: [], exit: [], title: [], attached: [] };
  private waitersForTabs: Array<(tabs: SessionInfo[]) => void> = [];
  /** Messages sent while offline; flushed the moment the socket opens. */
  private outbox: string[] = [];

  constructor(url: string, opts: WebSocketTransportOptions = {}) {
    this.url = url;
    this.wsImpl = opts.wsImpl ?? WebSocket;
    this.wsOptions = opts.wsOptions;
    this.connect();
  }

  dispose(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  // ---- session lifecycle ----

  listTabs(): Promise<SessionInfo[]> {
    // A fresh transport (page load/refresh) has an EMPTY cache and a
    // still-connecting socket — resolving from cache here would look like
    // "server has no sessions" and make TerminalApp.init() spawn a NEW tab
    // on every refresh. Instead: wait (bounded) for the connection, then
    // ask the server; only fall back to cache on timeout/dispose.
    return new Promise((resolve) => {
      const deadline = Date.now() + REQUEST_TIMEOUT_MS;
      let settled = false;
      let settleOnTabs: (tabs: SessionInfo[]) => void;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = this.waitersForTabs.indexOf(settleOnTabs);
        if (i >= 0) this.waitersForTabs.splice(i, 1);
        resolve([...this.lastTabs]);
      }, REQUEST_TIMEOUT_MS);
      settleOnTabs = (tabs: SessionInfo[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(tabs);
      };
      const attempt = () => {
        if (settled) return;
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.waitersForTabs.push(settleOnTabs);
          this.send({ type: 'list' });
        } else if (!this.closedByUser && Date.now() < deadline) {
          setTimeout(attempt, 50);
        } else {
          settled = true;
          clearTimeout(timeout);
          resolve([...this.lastTabs]);
        }
      };
      attempt();
    });
  }

  createTab(opts: CreateTabOptions): Promise<SessionInfo> {
    this.send({
      type: 'create',
      shell: opts.shell,
      cwd: opts.cwd,
    });
    // Resolve when a session unknown to this client appears in a tabs
    // broadcast (reconcileTabs dedupes by id, so overlap is harmless).
    // Baseline snapshot at call time: the tabs handler updates knownIds
    // BEFORE notifying listeners, so comparing against the live set would
    // never see the new session as fresh.
    const baseline = new Set(this.knownIds);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('createTab: no new session appeared (timeout)'));
      }, REQUEST_TIMEOUT_MS);
      const check = (tabs: SessionInfo[]) => {
        const fresh = tabs.find((t) => !baseline.has(t.id));
        if (fresh) {
          clearTimeout(timer);
          this.listeners.tabs = this.listeners.tabs.filter((l) => l !== check);
          resolve(fresh);
        }
      };
      this.listeners.tabs.push(check);
      check(this.lastTabs);
    });
  }

  closeTab(id: string): void {
    this.attachedIds.delete(id);
    this.send({ type: 'close', id });
  }

  attach(id: string): void {
    this.attachedIds.add(id);
    this.send({ type: 'attach', id });
  }

  detach(id: string): void {
    this.attachedIds.delete(id);
    this.send({ type: 'detach', id });
  }

  input(id: string, data: string): void {
    // Dropped while disconnected: PTY state is server-side, replay heals.
    this.send({ type: 'input', id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: 'resize', id, cols, rows });
  }

  // ---- environment ----

  getDefaultShell(): Promise<string> {
    // Server-side concern; the web client never spawns shells itself.
    return Promise.resolve('');
  }

  clipboardWrite(text: string): void {
    navigator.clipboard?.writeText(text).catch(() => {
      /* no secure context or permission denied — degrade silently */
    });
  }

  async clipboardRead(): Promise<string> {
    try {
      return (await navigator.clipboard?.readText()) ?? '';
    } catch {
      return '';
    }
  }

  // ---- events ----

  onTabsChange(cb: (tabs: SessionInfo[]) => void): Unsubscribe {
    this.listeners.tabs.push(cb);
    return () => {
      this.listeners.tabs = this.listeners.tabs.filter((l) => l !== cb);
    };
  }

  onData(cb: (p: DataPayload) => void): Unsubscribe {
    this.listeners.data.push(cb);
    return () => {
      this.listeners.data = this.listeners.data.filter((l) => l !== cb);
    };
  }

  onExit(cb: (p: ExitPayload) => void): Unsubscribe {
    this.listeners.exit.push(cb);
    return () => {
      this.listeners.exit = this.listeners.exit.filter((l) => l !== cb);
    };
  }

  onTitle(cb: (p: TitlePayload) => void): Unsubscribe {
    this.listeners.title.push(cb);
    return () => {
      this.listeners.title = this.listeners.title.filter((l) => l !== cb);
    };
  }

  onAttached(cb: (p: AttachedPayload) => void): Unsubscribe {
    this.listeners.attached.push(cb);
    return () => {
      this.listeners.attached = this.listeners.attached.filter((l) => l !== cb);
    };
  }

  // ---- connection plumbing ----

  private connect(): void {
    if (this.closedByUser) return;
    try {
      this.ws = this.wsOptions
        ? new this.wsImpl(this.url, this.wsOptions)
        : new this.wsImpl(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      if (this.outbox.length) {
        const queued = this.outbox.splice(0);
        for (const raw of queued) this.ws.send(raw);
      }
      // Server pushes an initial tabs snapshot on connect; re-attach the
      // sessions we were following (replay arrives via `attached`).
      for (const id of this.attachedIds) {
        this.send({ type: 'attach', id });
      }
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(String(ev.data));
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      /* onclose follows; reconnect handled there */
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    console.warn(`[Ternimal] WS disconnected; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(msg: unknown): void {
    const raw = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.outbox.push(raw); // e.g. create during startup, before open
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // protocol violation; server closes such peers anyway
    }

    switch (msg.type) {
      case 'tabs': {
        const tabs: SessionInfo[] = msg.tabs ?? [];
        this.lastTabs = tabs;
        for (const t of tabs) this.knownIds.add(t.id);
        const known = new Set(tabs.map((t) => t.id));
        for (const id of [...this.attachedIds]) {
          if (!known.has(id)) this.attachedIds.delete(id); // session gone
        }
        // Drain one-shot listTabs waiters
        const waiters = this.waitersForTabs.splice(0);
        waiters.forEach((w) => w([...tabs]));
        this.listeners.tabs.forEach((l) => l(tabs));
        break;
      }
      case 'attached': {
        const p: AttachedPayload = { id: msg.id, replay: msg.replay };
        this.listeners.attached.forEach((l) => l(p));
        break;
      }
      case 'data':
        this.listeners.data.forEach((l) => l({ id: msg.id, data: msg.data }));
        break;
      case 'exit':
        this.attachedIds.delete(msg.id);
        this.listeners.exit.forEach((l) => l({ id: msg.id, exitCode: msg.exitCode }));
        break;
      case 'title':
        this.listeners.title.forEach((l) => l({ id: msg.id, title: msg.title }));
        break;
      case 'error':
        if (msg.code === 4001 && typeof window !== 'undefined' && window.location) {
          // AUTH_REQUIRED (M3): land on the login page.
          window.location.href = '/login';
        }
        console.warn('[Ternimal] server error:', msg.code, msg.message);
        break;
    }
  }
}
