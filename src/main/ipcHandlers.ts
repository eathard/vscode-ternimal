// IPC handlers (M1 refactor, technical design §2.3):
// All PTY traffic now flows through the SessionRegistry; events fan out to
// the local window. The window reference is an accessor (not a captured
// BrowserWindow) so handlers survive window close/reopen (M4 tray residency).

import { ipcMain, BrowserWindow } from 'electron';
import { SessionRegistry } from './sessionRegistry';
import type { InstanceIdentity } from './instanceIdentity';
import type { RemoteServer } from './remoteServer';
import {
  IPC,
  SpawnRequest,
  WritePayload,
  ResizePayload,
  KillPayload,
} from '../shared/ipcChannels';

/** B+：remoteServer 在 main.ts 启动后注入（几何所有权仲裁）。 */
let remoteServerRef: RemoteServer | null = null;
export function setRemoteServerForGeo(rs: RemoteServer | null): void {
  remoteServerRef = rs;
}

export function registerIpcHandlers(
  registry: SessionRegistry,
  getWindow: () => BrowserWindow | null,
  identity?: InstanceIdentity
): void {
  const sendToRenderer = (channel: string, ...args: unknown[]) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
    // Window closed (M4: tray residency) → fan-out degrades to WS-only; the
    // registry and its buffers keep running untouched.
  };

  // Forward session events to the local renderer
  registry.on('data', (payload) => sendToRenderer(IPC.PTY_ON_DATA, payload));
  registry.on('exit', (payload) => sendToRenderer(IPC.PTY_ON_EXIT, payload));
  registry.on('title', (payload) => sendToRenderer(IPC.PTY_ON_TITLE, payload));
  registry.on('tabs', (tabs) => sendToRenderer(IPC.TABS_ON_CHANGE, tabs));

  // Create a session (ID is generated server-side; SpawnRequest.id ignored)
  // 多实例：渲染层取实例配色/标签（标题栏与托盘对应的依据）
  ipcMain.handle(IPC.APP_INSTANCE_INFO, () => identity ?? { id: 'default', isDefault: true, color: '#4a7fd6', barBg: '#181818', accent: '#4a7fd6' });

  ipcMain.handle(IPC.PTY_SPAWN, async (_event, request: SpawnRequest) => {
    return registry.create(request);
  });

  // Write data to a session
  ipcMain.on(IPC.PTY_WRITE, (_event, payload: WritePayload) => {
    registry.write(payload.id, payload.data);
  });

  // Resize a session (debounced + last-writer-wins inside the registry)
  // B+：本地 resize 经过 remoteServer 仲裁 —— web 持有几何时，本地 resize
  // 视为桌面注意力，先夺回所有权再放行（noteLocalResize 内部广播）。
  ipcMain.on(IPC.PTY_RESIZE, (_event, payload: ResizePayload) => {
    remoteServerRef?.noteLocalResize(payload.id);
    registry.resize(payload.id, payload.cols, payload.rows);
  });

  // B+：渲染进程上报窗口聚焦态；聚焦即夺回被 web 持有的会话几何。
  ipcMain.on(IPC.GEO_FOCUS, (_event, focused: boolean) => {
    remoteServerRef?.setLocalGeoFocus(focused === true);
  });

  // Kill a session
  ipcMain.on(IPC.PTY_KILL, (_event, payload: KillPayload) => {
    registry.kill(payload.id);
  });

  // List sessions (window startup restore / refresh)
  ipcMain.handle(IPC.TABS_LIST, async () => registry.list());

  // Replay snapshot (M4 TC-M4-03): a reopened window restores scrollback.
  ipcMain.handle(IPC.TABS_GET_REPLAY, async (_event, id: string) =>
    registry.getReplay(id)
  );

  // Get default shell
  ipcMain.handle(IPC.GET_DEFAULT_SHELL, async () => {
    if (process.platform === 'win32') {
      return 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  });
}

export function unregisterIpcHandlers(): void {
  Object.values(IPC).forEach((channel) => {
    ipcMain.removeAllListeners(channel);
  });
}
