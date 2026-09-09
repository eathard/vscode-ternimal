// TerminalTransport (technical design §2.4) — the single seam that lets the
// same UI components run on Electron IPC (local window) and WebSocket (M2
// remote web client). UI code must never touch window.electronAPI directly.

import type {
  SessionInfo,
  DataPayload,
  ExitPayload,
  TitlePayload,
} from '../../shared/ipcChannels';

export type Unsubscribe = () => void;

export interface CreateTabOptions {
  shell?: string;
  cwd?: string;
  /** Initial registry dimensions; the owning client's first fit() refines. */
  cols?: number;
  rows?: number;
}

export interface AttachedPayload {
  id: string;
  replay: string;
}

export interface TerminalTransport {
  // Session lifecycle
  listTabs(): Promise<SessionInfo[]>;
  createTab(opts: CreateTabOptions): Promise<SessionInfo>;
  closeTab(id: string): void;

  /**
   * Optional scrollback snapshot for restoring a fresh UI tab (M4): the
   * local window uses it when reopening after close; the web client gets
   * replay via `attach`/`attached` instead, so it may omit this.
   */
  getReplay?(id: string): Promise<string>;

  // Streaming
  /** Declare interest in a session (explicit for remote; no-op for local). */
  attach(id: string): void;
  detach(id: string): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;

  // Environment
  getDefaultShell(): Promise<string>;
  clipboardWrite(text: string): void;
  clipboardRead(): Promise<string>;

  // Events
  onTabsChange(cb: (tabs: SessionInfo[]) => void): Unsubscribe;
  onData(cb: (payload: DataPayload) => void): Unsubscribe;
  onExit(cb: (payload: ExitPayload) => void): Unsubscribe;
  onTitle(cb: (payload: TitlePayload) => void): Unsubscribe;
  onAttached(cb: (payload: AttachedPayload) => void): Unsubscribe;
}
