// WS protocol (technical design §2.6) — shared between RemoteServer (main)
// and WebSocketTransport (web client). JSON text frames, one envelope per
// frame; field names stay aligned with the IPC payloads in ipcChannels.ts.
//
// WIRE COMPATIBILITY (docs/wire-compatibility.md) — web pages outlive app
// updates, so mixed client/host versions are the NORMAL state:
//   1. New OPTIONAL field on an existing frame: safe (old peers ignore it),
//      but only for as long as every reader treats it as optional.
//   2. A NEW frame type is NOT safe: old parseClientMessage returns null →
//      BAD_MESSAGE disconnect; old client decoders silently drop it. Any new
//      interaction must be gated behind the caps handshake below.
//   3. Changing what a peer publishes (field stops being populated) is a
//      wire change even when the codec does not move.
//   Frame/message names are PERMANENT once shipped — never reuse or repurpose.

import type { SessionInfo } from './ipcChannels';
import { estimateSealedWireBytes } from './e2ee';

export const WS = {
  PATH: '/ws',
  /** Messages larger than this are rejected with BAD_MESSAGE + disconnect. */
  MAX_MESSAGE_BYTES: 1024 * 1024,
  /**
   * 出站密文帧（secure 信封）的字节预算。relay /pipe 的 maxPayload
   * 默认 1MB（relay/src/server.mjs）：一个 1MB 回放密封后 ≈1.4MB，
   * attach 必超限 → 管道被断（host error）→ 客户端重连再 attach 的
   * 死循环（2026-10-02 线上事故）。预算留足 base64×4/3 + tag + 信封
   * 余量后取整 900KB；本地 IPC/窗口路径无帧上限，不受影响。
   */
  MAX_SECURE_FRAME_BYTES: 900 * 1024,
  ERROR_CODES: {
    AUTH_REQUIRED: 4001,
    RATE_LIMITED: 4002,
    NO_SESSION: 4003,
    BAD_MESSAGE: 4004,
    /** WBS-R2-C: relay/loopback first-frame auth denied (token mismatch). */
    AUTH_DENIED: 4005,
  } as const,
  /** Defaults; RemoteServer accepts overrides (tests run them fast). */
  HEARTBEAT_INTERVAL_MS: 30_000,
  SLOW_CLIENT_BYTES: 8 * 1024 * 1024,
  /** WBS-R2-C: first-frame auth deadline for relay/loopback connections. */
  RELAY_AUTH_TIMEOUT_MS: 5_000,
} as const;

// ---------- client → server ----------

export interface WsListMsg {
  type: 'list';
}
export interface WsCreateMsg {
  type: 'create';
  shell?: string;
  cwd?: string;
}
export interface WsCloseMsg {
  type: 'close';
  id: string;
}
export interface WsAttachMsg {
  type: 'attach';
  id: string;
}
export interface WsDetachMsg {
  type: 'detach';
  id: string;
}
export interface WsInputMsg {
  type: 'input';
  id: string;
  data: string;
}
export interface WsResizeMsg {
  type: 'resize';
  id: string;
  cols: number;
  rows: number;
}

// ---------- B+ 几何所有权流动（geoArbiter） ----------

export interface WsGeoClaimMsg {
  /** web→server：申请该会话的几何所有权（force = 手动 chip，豁免驻留/聚焦检查）。 */
  type: 'geo-claim';
  id: string;
  force?: 1;
}
export interface WsGeoReleaseMsg {
  /** web→server：主动释放（失焦/隐藏）。 */
  type: 'geo-release';
  id: string;
}
export interface WsGeoOwnershipMsg {
  /** server→all：所有权变化广播。owner = 'local' | ws clientId。 */
  type: 'geo-ownership';
  id: string;
  owner: string;
}

export interface WsJoinAuthMsg {
  /** WBS-R2-C: first-frame auth for relay/loopback connections (no cookie).
   * R-M4-A 起 relay 路径不再接受明文 auth（改挑战应答）；类型保留仅为
   * 协议兼容识别，服务端对 relay 连接的明文 auth 一律 AUTH_REQUIRED。 */
  type: 'auth';
  token: string;
}

/** R-M4-B：加密数据面信封（auth-ok{enc:1} 之后的双向业务帧）。 */
export interface WsSecureMsg {
  type: 'secure';
  iv: string;
  ct: string;
}

export interface WsAuthResponseMsg {
  /** R-M4-A 挑战应答：对 auth-challenge 的 HMAC-SHA256(token, nonce)，
   * hex 编码。Token 明文不再经过中继/插件。 */
  type: 'auth-response';
  mac: string;
  /** R-M4-B：客户端请求 E2E 加密（能力宣告，由 host 决定是否启用）。 */
  enc?: 1;
  /** 客户端能力宣告（wire-compat 规则 2 的协商通道）。可选；host 忽略
   * 未知项。旧 host 的解析器本就丢弃未知字段，故本字段向后兼容。 */
  caps?: string[];
}

export type ClientMessage =
  | WsListMsg
  | WsCreateMsg
  | WsCloseMsg
  | WsAttachMsg
  | WsDetachMsg
  | WsInputMsg
  | WsResizeMsg
  | WsJoinAuthMsg
  | WsAuthResponseMsg
  | WsSecureMsg
  | WsGeoClaimMsg
  | WsGeoReleaseMsg;

// ---------- server → client ----------

export interface WsTabsMsg {
  type: 'tabs';
  tabs: SessionInfo[];
}
export interface WsAttachedMsg {
  type: 'attached';
  id: string;
  replay: string;
  cols: number;
  rows: number;
  title: string;
}
export interface WsDataMsg {
  type: 'data';
  id: string;
  data: string;
}
export interface WsExitMsg {
  type: 'exit';
  id: string;
  exitCode: number;
}
export interface WsTitleMsg {
  type: 'title';
  id: string;
  title: string;
}
export interface WsErrorMsg {
  type: 'error';
  code: number;
  message: string;
}

export interface WsAuthOkMsg {
  /** WBS-R2-C: acknowledges a first-frame `auth` (relay/loopback path). */
  type: 'auth-ok';
  /** R-M4-B：host 已启用 E2E 加密——此后双向业务帧均为 secure 信封。 */
  enc?: 1;
  /** B+：本连接的客户端 id（几何所有权广播对端用它与 own 比对）。 */
  clientId?: string;
  /** host 能力宣告（wire-compat 规则 1：可选字段，旧客户端自然忽略）。
   * 新客户端在 caps 缺失时必须按「旧 host」降级——缺失即功能关闭。 */
  caps?: string[];
}

export interface WsAuthChallengeMsg {
  /** R-M4-A: relay 路径挑战。客户端须回 {type:'auth-response', mac}，
   * mac = HMAC-SHA256(token, nonce) hex。nonce 单次有效（30s TTL）。 */
  type: 'auth-challenge';
  nonce: string;
}

export type ServerMessage =
  | WsTabsMsg
  | WsAttachedMsg
  | WsDataMsg
  | WsExitMsg
  | WsTitleMsg
  | WsErrorMsg
  | WsAuthOkMsg
  | WsAuthChallengeMsg
  | WsSecureMsg
  | WsGeoOwnershipMsg;

// ---------- (de)serialization with strict shape validation ----------

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * 裁剪回放串直至 serialize(replay) 密封后不超 budgetBytes（relay 管道
 * maxPayload 硬限）。只从头部丢（保最新输出），优先对齐到行首让终端
 * 首行完整；无换行的极端单行（如 base64 转储）允许硬切——仅首行残缺。
 * serialize 必须对 replay 确定（就是真实帧的构造器），否则估不准。
 * 收敛性：每轮至少砍 25%，O(log) 轮内到空串。
 */
export function fitReplayToBudget(
  replay: string,
  serialize: (replay: string) => string,
  budgetBytes: number,
): string {
  let fitted = replay;
  while (fitted.length > 0 && estimateSealedWireBytes(serialize(fitted)) > budgetBytes) {
    // cut 至少 1：len≤3 时 floor(0.75×len) 可能为 0，slice(0) 返回自身
    // 会死循环（单测抓出）——保证每轮严格变短才是收敛的前提。
    const cut = Math.max(1, Math.min(Math.floor(fitted.length * 0.75), fitted.length - 1));
    const nl = fitted.indexOf('\n', cut);
    fitted = nl === -1 ? fitted.slice(cut) : fitted.slice(nl + 1);
  }
  return fitted;
}

/**
 * Parse and validate one client frame. Returns null for anything malformed
 * (non-JSON, wrong envelope, missing/ill-typed fields) — the server answers
 * BAD_MESSAGE and closes. Deliberately dependency-free and total: it never
 * throws, so it is safe on untrusted input.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  switch (m.type) {
    case 'list':
      return { type: 'list' };
    case 'create':
      return {
        type: 'create',
        shell: optionalString(m.shell),
        cwd: optionalString(m.cwd),
      };
    case 'close':
    case 'attach':
    case 'detach':
    case 'geo-release':
      return typeof m.id === 'string' ? ({ type: m.type, id: m.id } as ClientMessage) : null;
    case 'geo-claim':
      return typeof m.id === 'string'
        ? { type: 'geo-claim', id: m.id, ...(m.force === 1 ? { force: 1 as const } : {}) }
        : null;
    case 'auth':
      return typeof m.token === 'string'
        ? { type: 'auth', token: m.token }
        : null;
    case 'auth-response': {
      if (typeof m.mac !== 'string') return null;
      const caps = parseCaps(m.caps);
      if (caps === null) return null; // malformed caps → BAD_MESSAGE
      return {
        type: 'auth-response',
        mac: m.mac,
        ...(m.enc === 1 ? { enc: 1 as const } : {}),
        ...(caps ? { caps } : {}),
      };
    }
    case 'secure':
      return typeof m.iv === 'string' && typeof m.ct === 'string'
        ? { type: 'secure', iv: m.iv, ct: m.ct }
        : null;
    case 'input':
      return typeof m.id === 'string' && typeof m.data === 'string'
        ? { type: 'input', id: m.id, data: m.data }
        : null;
    case 'resize':
      return (
        typeof m.id === 'string' &&
        typeof m.cols === 'number' &&
        Number.isFinite(m.cols) &&
        typeof m.rows === 'number' &&
        Number.isFinite(m.rows)
      )
        ? { type: 'resize', id: m.id, cols: m.cols, rows: m.rows }
        : null;
    default:
      return null;
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Validate a caps announcement (wire-compat 规则 2 的协商通道). Returns
 * undefined when absent, null when MALFORMED (caller rejects the frame):
 * at most 16 entries, each a ≤32-char lowercase [a-z0-9-] token.
 */
export function parseCaps(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 16) return null;
  for (const entry of v) {
    if (typeof entry !== 'string' || !/^[a-z0-9-]{1,32}$/.test(entry)) return null;
  }
  return v as string[];
}
