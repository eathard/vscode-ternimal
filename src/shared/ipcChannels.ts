// IPC channel constants shared between main and renderer processes

export const IPC = {
  // PTY lifecycle
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_ON_DATA: 'pty:onData',
  PTY_ON_EXIT: 'pty:onExit',
  PTY_ON_TITLE: 'pty:onTitle',

  // Shell detection
  GET_DEFAULT_SHELL: 'shell:getDefault',
} as const;

export interface SpawnRequest {
  id: string;
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface SpawnResponse {
  pid: number;
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
