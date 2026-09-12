const { contextBridge, ipcRenderer, clipboard } = require('electron');
import { IPC, type RelaySettingsDto } from '../shared/ipcChannels';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: unknown[]) => {
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const subscription = (_event: unknown, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  // Typed helpers
  ptySpawn: (request: { shell?: string; cwd?: string; cols: number; rows: number }) => {
    return ipcRenderer.invoke(IPC.PTY_SPAWN, request);
  },
  ptyWrite: (id: string, data: string) => {
    ipcRenderer.send(IPC.PTY_WRITE, { id, data });
  },
  ptyResize: (id: string, cols: number, rows: number) => {
    ipcRenderer.send(IPC.PTY_RESIZE, { id, cols, rows });
  },
  ptyKill: (id: string) => {
    ipcRenderer.send(IPC.PTY_KILL, { id });
  },
  onPtyData: (callback: (payload: { id: string; data: string }) => void) => {
    const handler = (_event: unknown, payload: { id: string; data: string }) => callback(payload);
    ipcRenderer.on(IPC.PTY_ON_DATA, handler);
    return () => ipcRenderer.removeListener(IPC.PTY_ON_DATA, handler);
  },
  onPtyExit: (callback: (payload: { id: string; exitCode: number }) => void) => {
    const handler = (_event: unknown, payload: { id: string; exitCode: number }) => callback(payload);
    ipcRenderer.on(IPC.PTY_ON_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC.PTY_ON_EXIT, handler);
  },
  onPtyTitle: (callback: (payload: { id: string; title: string }) => void) => {
    const handler = (_event: unknown, payload: { id: string; title: string }) => callback(payload);
    ipcRenderer.on(IPC.PTY_ON_TITLE, handler);
    return () => ipcRenderer.removeListener(IPC.PTY_ON_TITLE, handler);
  },
  tabsList: () => {
    return ipcRenderer.invoke(IPC.TABS_LIST);
  },
  tabsGetReplay: (id: string) => {
    return ipcRenderer.invoke(IPC.TABS_GET_REPLAY, id) as Promise<string>;
  },
  onTabsChange: (callback: (tabs: unknown[]) => void) => {
    const handler = (_event: unknown, tabs: unknown[]) => callback(tabs);
    ipcRenderer.on(IPC.TABS_ON_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC.TABS_ON_CHANGE, handler);
  },
  getDefaultShell: () => {
    return ipcRenderer.invoke(IPC.GET_DEFAULT_SHELL);
  },
  // 多实例：实例配色/标签（顶栏背景对应托盘图标的依据）
  instanceInfo: () => {
    return ipcRenderer.invoke(IPC.APP_INSTANCE_INFO);
  },
  // Relay settings panel (R-M2) — host window only, never part of the
  // TerminalTransport seam (web bundle has no relay admin UI).
  relayGetSettings: () => {
    return ipcRenderer.invoke(IPC.RELAY_GET_SETTINGS);
  },
  relayApplySettings: (patch: Record<string, unknown>) => {
    return ipcRenderer.invoke(IPC.RELAY_APPLY_SETTINGS, patch);
  },
  relayShareLink: (label?: string, ttlHours?: number) => {
    return ipcRenderer.invoke(IPC.RELAY_SHARE_LINK, label, ttlHours);
  },
  relayListSubcodes: () => {
    return ipcRenderer.invoke(IPC.RELAY_LIST_SUBCODES);
  },
  relayViewSubcode: (id: string) => {
    return ipcRenderer.invoke(IPC.RELAY_VIEW_SUBCODE, id);
  },
  relayRevokeSubcode: (id: string, purge?: boolean) => {
    return ipcRenderer.invoke(IPC.RELAY_REVOKE_SUBCODE, id, purge);
  },
  relayForceRegister: () => {
    return ipcRenderer.invoke(IPC.RELAY_FORCE_REGISTER) as Promise<void>;
  },
  relayPreviewToken: (token: string) => {
    return ipcRenderer.invoke(IPC.RELAY_PREVIEW_TOKEN, token) as Promise<import('../shared/ipcChannels').RelayTokenPreview>;
  },
  relayApplyToken: (token: string) => {
    return ipcRenderer.invoke(IPC.RELAY_APPLY_TOKEN, token) as Promise<RelaySettingsDto>;
  },
  relayRenewSubcode: (id: string, opts: { days?: number; permanent?: boolean }) => {
    return ipcRenderer.invoke(IPC.RELAY_RENEW_SUBCODE, id, opts);
  },
  onRelayStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on(IPC.RELAY_ON_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.RELAY_ON_STATUS, handler);
  },
  clipboardWrite: (text: string) => {
    clipboard.writeText(text);
  },
  clipboardRead: () => {
    return Promise.resolve(clipboard.readText());
  },
});
