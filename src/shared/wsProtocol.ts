// WS protocol (technical design §2.6) — shared between RemoteServer (main)
// and WebSocketTransport (web client). JSON text frames, one envelope per
// frame; field names stay aligned with the IPC payloads in ipcChannels.ts.

import type { SessionInfo } from './ipcChannels';

export const WS = {
  PATH: '/ws',
  /** Messages larger than this are rejected with BAD_MESSAGE + disconnect. */
  MAX_MESSAGE_BYTES: 1024 * 1024,
  ERROR_CODES: {
    AUTH_REQUIRED: 4001,
    RATE_LIMITED: 4002,
    NO_SESSION: 4003,
    BAD_MESSAGE: 4004,
  } as const,
  /** Defaults; RemoteServer accepts overrides (tests run them fast). */
  HEARTBEAT_INTERVAL_MS: 30_000,
  SLOW_CLIENT_BYTES: 8 * 1024 * 1024,
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

export type ClientMessage =
  | WsListMsg
  | WsCreateMsg
  | WsCloseMsg
  | WsAttachMsg
  | WsDetachMsg
  | WsInputMsg
  | WsResizeMsg;

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

export type ServerMessage =
  | WsTabsMsg
  | WsAttachedMsg
  | WsDataMsg
  | WsExitMsg
  | WsTitleMsg
  | WsErrorMsg;

// ---------- (de)serialization with strict shape validation ----------

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
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
      return typeof m.id === 'string' ? ({ type: m.type, id: m.id } as ClientMessage) : null;
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
