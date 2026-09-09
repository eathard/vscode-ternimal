// IPC channel constants shared between main and renderer processes
// M1: session state moves to the main process (SessionRegistry).
// Channel names/payloads stay aligned with the WS protocol (M2, wsProtocol.ts).

export const IPC = {
  // PTY lifecycle (routed through SessionRegistry since M1)
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_ON_DATA: 'pty:onData',
  PTY_ON_EXIT: 'pty:onExit',
  PTY_ON_TITLE: 'pty:onTitle',

  // Tab/session registry
  TABS_LIST: 'tabs:list',
  TABS_ON_CHANGE: 'tabs:onChange',
  TABS_GET_REPLAY: 'tabs:getReplay',

  // Shell detection
  GET_DEFAULT_SHELL: 'shell:getDefault',
} as const;

export interface SpawnRequest {
  /**
   * Deprecated: client-generated IDs are ignored. The SessionRegistry
   * generates authoritative IDs server-side (kept for compile compatibility).
   */
  id?: string;
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/**
 * Server-side truth about one terminal session. Owned by SessionRegistry
 * in the main process; both the local window and (in M2) remote WebSocket
 * clients consume it.
 */
export interface SessionInfo {
  id: string; // tab-{timestamp}-{counter}
  title: string;
  pid: number;
  cols: number; // current PTY size (last writer wins)
  rows: number;
  shell?: string;
  cwd?: string;
  createdAt: number;
}

export interface ResizePayload {
  id: string;
  cols: number;
  rows: number;
}

export interface WritePayload {
  id: string;
  data: string;
}

export interface KillPayload {
  id: string;
}

export interface DataPayload {
  id: string;
  data: string;
}

export interface ExitPayload {
  id: string;
  exitCode: number;
}

export interface TitlePayload {
  id: string;
  title: string;
}
