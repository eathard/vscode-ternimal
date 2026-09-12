// LocalIpcTransport — TerminalTransport over the Electron preload bridge.
// attach/detach are no-ops: the local window receives the full broadcast
// stream, exactly like today's behavior (design §2.4).
import type {
  SessionInfo,
  DataPayload,
  ExitPayload,
  TitlePayload,
  RelaySettingsDto, RelayTokenPreview,
  RelayStatusEvent,
  RelayShareLink,
  RelaySubcodeInfo,
  RelaySubcodeView,
} from '../../shared/ipcChannels';
import type { TerminalTransport, Unsubscribe } from './transport';

declare global {
  interface Window {
    electronAPI: {
      ptySpawn: (request: { shell?: string; cwd?: string; cols: number; rows: number }) => Promise<SessionInfo>;
      ptyWrite: (id: string, data: string) => void;
      ptyResize: (id: string, cols: number, rows: number) => void;
      ptyKill: (id: string) => void;
      onPtyData: (callback: (payload: DataPayload) => void) => () => void;
      onPtyExit: (callback: (payload: ExitPayload) => void) => () => void;
      onPtyTitle: (callback: (payload: TitlePayload) => void) => () => void;
      tabsList: () => Promise<SessionInfo[]>;
      tabsGetReplay: (id: string) => Promise<string>;
      onTabsChange: (callback: (tabs: SessionInfo[]) => void) => () => void;
      getDefaultShell: () => Promise<string>;
      clipboardWrite: (text: string) => void;
      clipboardRead: () => Promise<string>;
      // R-M2 relay admin surface (host window only)
      relayGetSettings: () => Promise<RelaySettingsDto>;
      relayApplySettings: (patch: Partial<RelaySettingsDto>) => Promise<RelaySettingsDto>;
      relayShareLink: (label?: string, ttlHours?: number) => Promise<RelayShareLink>;
      relayListSubcodes: () => Promise<RelaySubcodeInfo[]>;
      relayViewSubcode: (id: string) => Promise<RelaySubcodeView>;
      relayRevokeSubcode: (id: string, purge?: boolean) => Promise<void>;
      relayRenewSubcode: (id: string, opts: { days?: number; permanent?: boolean }) => Promise<number | null>;
      relayForceRegister: () => Promise<void>;
      relayPreviewToken: (token: string) => Promise<RelayTokenPreview>;
      relayApplyToken: (token: string) => Promise<RelaySettingsDto>;
      onRelayStatus: (callback: (status: RelayStatusEvent) => void) => () => void;
      // B+ 几何所有权（Electron 窗口）
      geoFocus: (focused: boolean) => void;
      onGeoOwnership: (callback: (payload: { id: string; owner: string }) => void) => () => void;
    };
  }
}

export class LocalIpcTransport implements TerminalTransport {
  /** B+：本地窗口在几何所有权协议里的对端 id 就是 'local'
   * （web 端 = auth-ok 下发的连接 id —— 两端用同一规则 owner===geoClientId）。 */
  readonly geoClientId = 'local';

  listTabs(): Promise<SessionInfo[]> {
    return window.electronAPI.tabsList();
  }

  /** Scrollback restore for a reopened local window (M4, TC-M4-03). */
  getReplay(id: string): Promise<string> {
    return window.electronAPI.tabsGetReplay(id);
  }

  createTab(opts: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<SessionInfo> {
    return window.electronAPI.ptySpawn({
      shell: opts.shell,
      cwd: opts.cwd,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
  }

  closeTab(id: string): void {
    window.electronAPI.ptyKill(id);
  }

  attach(_id: string): void {
    /* implicit for local — full broadcast */
  }

  detach(_id: string): void {
    /* implicit for local */
  }

  input(id: string, data: string): void {
    window.electronAPI.ptyWrite(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    window.electronAPI.ptyResize(id, cols, rows);
  }

  getDefaultShell(): Promise<string> {
    return window.electronAPI.getDefaultShell();
  }

  clipboardWrite(text: string): void {
    window.electronAPI.clipboardWrite(text);
  }

  clipboardRead(): Promise<string> {
    return window.electronAPI.clipboardRead();
  }

  onTabsChange(cb: (tabs: SessionInfo[]) => void): Unsubscribe {
    return window.electronAPI.onTabsChange(cb);
  }

  onData(cb: (payload: DataPayload) => void): Unsubscribe {
    return window.electronAPI.onPtyData(cb);
  }

  onExit(cb: (payload: ExitPayload) => void): Unsubscribe {
    return window.electronAPI.onPtyExit(cb);
  }

  onTitle(cb: (payload: TitlePayload) => void): Unsubscribe {
    return window.electronAPI.onPtyTitle(cb);
  }

  onAttached(_cb: (payload: { id: string; replay: string }) => void): Unsubscribe {
    return () => {
      /* local attach is implicit; no replay for local in M1 */
    };
  }
}
