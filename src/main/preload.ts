const { contextBridge, ipcRenderer, clipboard } = require('electron');
import { IPC } from '../shared/ipcChannels';

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
  clipboardWrite: (text: string) => {
    clipboard.writeText(text);
  },
  clipboardRead: () => {
    return Promise.resolve(clipboard.readText());
  },
});
