// WebSocketTransport (M2, design §2.4) — TerminalTransport over the /ws
// protocol for the remote web client. Owns connection lifecycle: exponential
// backoff reconnect (1s..30s) and automatic re-attach of known sessions so a
// network blip mid-Claude-Code-task heals transparently (replay comes from
// the server's ring buffer via `attached`).
//
// R-M3 relay mode (WBS-R3-B/C): pass `opts.relay = {subCode, token}` to talk
// to a relay `/join` endpoint instead of a cookie-authed `/ws`. On open the
// transport sends the join frame then the first-frame auth immediately —
// the relay buffers early frames until the pipe is spliced, so no ack is
// needed. Fatal close codes (bad sub-code / rate limit / sub-code revoked)
// STOP reconnection and surface via onRelayState; transient failures keep
// the existing backoff loop and re-run the join+auth handshake.
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
import { sealFrame, openFrame, deriveSessionKey } from '../../shared/e2ee';

type ListenerBag = {
  tabs: Array<(tabs: SessionInfo[]) => void>;
  data: Array<(p: DataPayload) => void>;
  exit: Array<(p: ExitPayload) => void>;
  title: Array<(p: TitlePayload) => void>;
  attached: Array<(p: AttachedPayload) => void>;
  geo: Array<(p: { id: string; owner: string }) => void>;
};

export type RelayGateState =
  | 'connecting' // dialing / joining / awaiting auth-ok
  | 'ready' // auth-ok received — terminal live
  | 'denied' // bad sub-code / token locked — will NOT retry
  | 'revoked'; // sub-code expired or revoked — will NOT retry

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5000;
/** relay close codes that must not be retried (relay/src/protocol.mjs CLOSE).
 * 与 relay 实际关闭码表逐一对齐（R4-C 矩阵 M-03 发现旧表错位：
 * 4003 实为 HOST_OFFLINE（瞬态——插件重启期），4004 实为 BUSY（瞬态），
 * 4005 实为 PENDING_TIMEOUT（瞬态）；真正「重试无意义」的是错码/限速/
 * 过期/吊销）。瞬态码走退避重连，恢复后自动回归。 */
const FATAL_CLOSE_CODES: Record<number, RelayGateState> = {
  4001: 'denied', // BAD_CODE — wrong/unknown sub-code
  4002: 'denied', // RATE_LIMITED — locked out
  4008: 'revoked', // SUBCODE_EXPIRED
  4009: 'revoked', // SUBCODE_REVOKED
};

/**
 * Node/test injection seam (M4-D): the browser build uses the global
 * WebSocket with no options; verify-reconnect.mjs passes the `ws` package
 * implementation plus a Cookie header so the REAL transport code can be
 * exercised outside a browser.
 */
export interface WebSocketTransportOptions {
  wsImpl?: any;
  wsOptions?: Record<string, unknown>;
  /** R-M3: relay access mode (join + first-frame auth, no cookie). */
  relay?: { subCode: string; token: string };
}
export class WebSocketTransport implements TerminalTransport {
  private url: string;
  private wsImpl: any;
  private wsOptions?: Record<string, unknown>;
  private readonly relay?: { subCode: string; token: string };
  private ws: any = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the host confirms auth (auth-ok). Gates the pre-auth
   * reconnect cap: a client that never authenticated is failing on
   * credentials/path, and retrying forever hammers the relay — 2026-09-12
   * incident: a stale phone tab retried every ~10s with a rotated-out
   * token, kept the host's shared relay-auth window locked, and valid
   * clients were rejected too. */
  private everAuthenticated = false;
  /** Relay gate state (LAN mode: always 'ready' once open). */
  private gateState: RelayGateState = 'connecting';
  private gateListeners: Array<(s: RelayGateState, detail: string) => void> = [];

  /** Sessions this client wants to follow across reconnects. */
  private attachedIds = new Set<string>();
  /** Latest tab list (lets late UI subscribers render immediately). */
  private lastTabs: SessionInfo[] = [];
  private knownIds = new Set<string>();
  private listeners: ListenerBag = { tabs: [], data: [], exit: [], title: [], attached: [], geo: [] };
  private waitersForTabs: Array<(tabs: SessionInfo[]) => void> = [];
  /** Messages sent while offline; flushed the moment the socket opens. */
  private outbox: string[] = [];
  /** R-M4-B: 最近一次挑战的 nonce（E2E 会话密钥 HKDF 材料）。 */
  private relayNonce = '';
  /** R-M4-B: E2E 会话密钥（auth-ok{enc:1} 起生效；null = 明文）。 */
  private e2eeKey: CryptoKey | null = null;
  /** R-M4-B: 加密发送链（Promise 串行，保证 seal 完成顺序 = 发送顺序）。 */
  private e2eeQueue: Promise<void> = Promise.resolve();

  constructor(url: string, opts: WebSocketTransportOptions = {}) {
    this.url = url;
    this.wsImpl = opts.wsImpl ?? WebSocket;
    this.wsOptions = opts.wsOptions;
    this.relay = opts.relay;
    this.connect();
  }

  /** R-M3: relay gate state (denied/revoked drive the fallback UI). */
  onRelayState(cb: (state: RelayGateState, detail: string) => void): Unsubscribe {
    this.gateListeners.push(cb);
    cb(this.gateState, '');
    return () => {
      this.gateListeners = this.gateListeners.filter((l) => l !== cb);
    };
  }

  get relayGate(): RelayGateState {
    return this.gateState;
  }

  private setGate(state: RelayGateState, detail = ''): void {
    this.gateState = state;
    this.gateListeners.forEach((l) => l(state, detail));
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

  // ---- B+ 几何所有权流动 ----

  private geoClientIdValue = '';
  /** auth-ok 下发的本连接 id（web 端与 geo-ownership.owner 比对）。 */
  get geoClientId(): string {
    return this.geoClientIdValue;
  }

  claimGeometry(id: string, force?: boolean): void {
    this.send({ type: 'geo-claim', id, ...(force ? { force: 1 } : {}) });
  }

  releaseGeometry(id: string): void {
    this.send({ type: 'geo-release', id });
  }

  onGeoOwnership(cb: (payload: { id: string; owner: string }) => void): Unsubscribe {
    this.listeners.geo.push(cb);
    return () => {
      this.listeners.geo = this.listeners.geo.filter((l) => l !== cb);
    };
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
    if (this.relay) this.setGate('connecting');
    try {
      this.ws = this.wsOptions
        ? new this.wsImpl(this.url, this.wsOptions)
        : new this.wsImpl(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // 重试计数只在「认证成功」时清零（relay 路径）：join 能连上但认证
      // 失败的循环（旧令牌页）不能靠 onopen 无限洗白重试上限。
      if (!this.relay) this.reconnectAttempt = 0;
      this.e2eeKey = null; // 新连接新会话：重连后按新挑战重新派生
      if (this.relay) {
        // R-M4-A: 只发 join；认证改挑战应答——收到 auth-challenge 后回
        // HMAC(token, nonce)，Token 明文不再经过中继/插件。
        this.sendControl({ v: 1, type: 'join', subCode: this.relay.subCode });
        return; // re-attach happens after auth-ok (server pushes tabs then)
      }
      if (this.outbox.length) {
        const queued = this.outbox.splice(0);
        for (const raw of queued) this.sendRaw(raw);
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

    this.ws.onclose = (arg0?: any) => {
      // Close-code shapes differ: browser CloseEvent vs `ws` package
      // (code, reason) callback args. Normalize.
      const code = typeof arg0 === 'number' ? arg0 : Number(arg0?.code ?? 1006);
      this.ws = null;
      if (this.relay) {
        const fatal = FATAL_CLOSE_CODES[code];
        if (fatal) {
          // Bad sub-code / locked / revoked — retrying is pointless and
          // would hammer the relay; stop and surface to the gate UI.
          this.setGate(fatal, `close ${code}`);
          return;
        }
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      /* onclose follows; reconnect handled there */
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    // P0：denied/revoked 是终态判定（错令牌/被锁/被吊销）——重试只会给
    // 宿主的共享鉴权锁定窗续期（2026-09-13 循环事故的完整闭环）。
    if (this.relay && (this.gateState === 'denied' || this.gateState === 'revoked')) return;
    if (this.relay && !this.everAuthenticated && this.reconnectAttempt >= 8) {
      // Pre-auth storm cap (relay mode): every attempt failed before the
      // host confirmed auth — stale credentials or a wedged path. Stop and
      // surface; the operator gets a fresh link instead of the client
      // locking the shared relay-auth window for everyone.
      this.setGate('denied', 'auth retry cap');
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    console.warn(`[Ternimal] WS disconnected; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** R-M4-A 挑战应答：HMAC-SHA256(token, nonce) → {auth-response, mac}。
   * crypto.subtle 需要安全上下文（https 或 localhost）。 */
  private async answerChallenge(nonce: string): Promise<void> {
    if (!nonce) return;
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      // 非安全上下文（例如 http 公网中继）无法完成挑战应答
      this.setGate('denied', 'WebCrypto unavailable (insecure context)');
      this.dispose();
      return;
    }
    try {
      const enc = new TextEncoder();
      const key = await subtle.importKey(
        'raw',
        enc.encode(this.relay!.token),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await subtle.sign('HMAC', key, enc.encode(nonce));
      const mac = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
      this.relayNonce = nonce; // R-M4-B: 留作 HKDF salt
      this.sendControl({ type: 'auth-response', mac, enc: 1 }); // enc 由 host 决定
    } catch (err) {
      console.warn('[Ternimal] challenge answer failed:', err);
    }
  }

  private send(msg: unknown): void {
    this.sendRaw(JSON.stringify(msg));
  }

  /** 认证流程自身的控制帧（join / auth-response）：不受认证门约束。 */
  private sendControl(msg: unknown): void {
    this.sendRaw(JSON.stringify(msg), true);
  }

  /** R-M4-B：加密激活后出站业务帧一律 seal；控制帧（join/auth-response）
   * 在密钥生效前发送，天然明文。 */
  private sendRaw(raw: string, control = false): void {
    if (this.e2eeKey) {
      this.e2eeQueue = this.e2eeQueue
        .then(async () => {
          if (!this.e2eeKey || this.ws?.readyState !== WebSocket.OPEN) return;
          this.ws.send(await sealFrame(this.e2eeKey, raw));
        })
        .catch(() => {
          /* 重连/断开自愈 */
        });
      return;
    }
    // P0：relay 模式下 socket OPEN ≠ 可发——join 后到 auth-ok 前是认证
    // 窗口，明文业务帧会被宿主以 AUTH_REQUIRED 杀连接（failWith）。E2EE
    // 派生完成前同理。未 ready 一律入 outbox（relayAuthOk 统一冲洗）。
    // join/auth-response 本身必须在认证前发出（控制帧豁免），否则死锁。
    const relayNotReady = !control && this.relay && this.gateState !== 'ready';
    if (!relayNotReady && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.outbox.push(raw); // e.g. create during startup, before open/auth
    }
  }

  /** R-M3 relay mode ready 路径（R-M4-B: 密钥激活后走加密出站）。 */
  private relayAuthOk(): void {
    this.everAuthenticated = true;
    this.reconnectAttempt = 0; // 认证成功才洗白重试上限（与 onopen 的 relay 分支配套）
    this.setGate('ready');
    if (this.outbox.length) {
      const queued = this.outbox.splice(0);
      for (const raw of queued) this.sendRaw(raw);
    }
    for (const id of this.attachedIds) {
      this.send({ type: 'attach', id });
    }
  }

  /** R-M4-B：auth-ok{enc:1} → 本地派生会话密钥再放行业务流。 */
  private async activateE2EE(): Promise<void> {
    try {
      this.e2eeKey = await deriveSessionKey(this.relay!.token, this.relayNonce);
      this.relayAuthOk();
    } catch (err) {
      console.warn('[Ternimal] E2EE key derivation failed:', err);
      this.setGate('denied', 'E2EE key derivation failed');
      this.dispose();
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
      case 'secure': {
        // R-M4-B: 解封后按普通业务帧分发（嵌套 secure 解封必败 → 丢弃）。
        if (this.e2eeKey) {
          void openFrame(this.e2eeKey, raw)
            .then((inner) => {
              if (inner !== null) this.handleMessage(inner);
            })
            .catch(() => {
              /* 单帧损坏：忽略，连接层错误由服务端裁决 */
            });
        }
        break;
      }
      case 'auth-challenge': {
        // R-M4-A: HMAC-SHA256(token, nonce)（WebCrypto，浏览器与 Node 同码）。
        if (this.relay) void this.answerChallenge(String(msg.nonce ?? ''));
        break;
      }
      case 'auth-ok': {
        // B+：记录本连接 clientId（几何所有权广播对端标识）。
        if (typeof msg.clientId === 'string' && msg.clientId) this.geoClientIdValue = msg.clientId;
        // R-M3 relay mode: gate open. The host pushes a tabs snapshot right
        // after; re-attach followed sessions (replay via `attached`).
        if (this.relay) {
          if (msg.enc === 1) void this.activateE2EE();
          else this.relayAuthOk();
        }
        break;
      }
      case 'geo-ownership':
        this.listeners.geo.forEach((l) => l({ id: msg.id, owner: msg.owner }));
        break;
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
        if (this.relay) {
          // Relay mode has no /login page — surface to the gate UI instead.
          // 宿主侧 error 帧：4005（凭据错）与 4002（鉴权窗被锁）重试无益
          // 且火上浇油——锁定窗口正是被重试续期的，必须立刻停（2026-09-13
          // 「中继连接中断，正在自动重连…」死循环根因）。其余（4003 无会话
          // 等）保持瞬态退避。
          const fatalHostError = msg.code === 4005 || msg.code === 4002;
          this.setGate(fatalHostError ? 'denied' : 'connecting', `error ${msg.code}`);
        } else if (msg.code === 4001 && typeof window !== 'undefined' && window.location) {
          // AUTH_REQUIRED (M3): land on the login page.
          window.location.href = '/login';
        }
        console.warn('[Ternimal] server error:', msg.code, msg.message);
        break;
    }
  }
}
