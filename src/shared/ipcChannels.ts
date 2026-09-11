// IPC channel constants shared between main and renderer processes
// M1: session state moves to the main process (SessionRegistry).
// Channel names/payloads stay aligned with the WS protocol (M2, wsProtocol.ts).

export const IPC = {
  APP_INSTANCE_INFO: 'app:instance-info',
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

  // Relay plugin (R-M2): settings panel + share links + subcode admin
  RELAY_GET_SETTINGS: 'relay:getSettings',
  RELAY_APPLY_SETTINGS: 'relay:applySettings',
  RELAY_ON_STATUS: 'relay:onStatus',
  RELAY_SHARE_LINK: 'relay:shareLink',
  RELAY_LIST_SUBCODES: 'relay:listSubcodes',
  RELAY_REVOKE_SUBCODE: 'relay:revokeSubcode',
  RELAY_RENEW_SUBCODE: 'relay:renewSubcode',
  RELAY_FORCE_REGISTER: 'relay:forceRegister',
  RELAY_PREVIEW_TOKEN: 'relay:previewToken',
  RELAY_APPLY_TOKEN: 'relay:applyToken',
} as const;

// ---------- Relay plugin (R-M2, relay-design §4) ----------

export type RelayPluginState =
  | 'stopped'
  | 'starting'
  | 'registered'
  | 'reconnecting'
  | 'occupied' // 主码在另一台设备在线（非 force 注册被拒，30s 静默探测）
  | 'parked'; // 被人工强制接管：驻停，不再自动重连，等待夺回

/** 混合口令预览摘要（主码掩码展示，防肩窥）。 */
export interface RelayTokenPreview {
  url: string;
  masterPreview: string;
  caFingerprint: string | null;
  e2ee: boolean;
  label: string;
}

/** Settings panel DTO (main → renderer); mirrors configStore.relay + live state. */
export interface RelaySettingsDto {
  enabled: boolean;
  url: string;
  masterCode: string;
  clearMasterCodeOnExit: boolean;
  lanDirect: boolean;
  /** R-M4-B：中继 E2E 加密开关（生效于此后新建的认证会话）。 */
  e2ee: boolean;
  /** 自签 relay 根证书 PEM 路径（公共 CA/明文 relay 留空）。 */
  caPath: string;
  /** Live plugin state ('stopped' when not running). */
  state: RelayPluginState;
  /** Effective server bind address (informational). */
  hostBinding: string;
  /** True = binding/auth-surface change needs an app restart to take effect. */
  restartRequired: boolean;
}

export interface RelayStatusEvent {
  state: RelayPluginState;
  detail: string;
  pipes: number;
  /** 插件子进程 pid（0 = 未知）。 */
  pid: number;
}

export interface RelayShareLink {
  /** https://relay/#S=<subCode>&T=<token> — fragments never hit server logs. */
  url: string;
  subCode: string;
  expiresAt: number;
}

export interface RelaySubcodeInfo {
  id: string;
  code: string;
  label: string;
  createdAt: number;
  expiresAt: number | null; // null = 长期（续期转永久）
  revoked: boolean;
  stats: { bytes: number; joins: number };
}

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
