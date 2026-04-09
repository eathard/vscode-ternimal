import { ipcMain, BrowserWindow } from 'electron';
import { PtyManager } from './ptyManager';
import {
  IPC,
  SpawnRequest,
  WritePayload,
  ResizePayload,
  KillPayload,
} from '../shared/ipcChannels';

export function registerIpcHandlers(ptyManager: PtyManager, mainWindow: BrowserWindow): void {
  const sendToRenderer = (channel: string, ...args: unknown[]) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Forward PTY events to renderer
  ptyManager.on('data', (payload) => sendToRenderer(IPC.PTY_ON_DATA, payload));
  ptyManager.on('exit', (payload) => sendToRenderer(IPC.PTY_ON_EXIT, payload));
  ptyManager.on('title', (payload) => sendToRenderer(IPC.PTY_ON_TITLE, payload));

  // Spawn a new PTY process
  ipcMain.handle(IPC.PTY_SPAWN, async (_event, request: SpawnRequest) => {
    const ptyProcess = ptyManager.spawn(request);
    return { pid: ptyProcess.pid };
  });

  // Write data to PTY
  ipcMain.on(IPC.PTY_WRITE, (_event, payload: WritePayload) => {
    ptyManager.write(payload.id, payload.data);
  });

  // Resize PTY
  ipcMain.on(IPC.PTY_RESIZE, (_event, payload: ResizePayload) => {
    ptyManager.resize(payload.id, payload.cols, payload.rows);
  });

  // Kill PTY
  ipcMain.on(IPC.PTY_KILL, (_event, payload: KillPayload) => {
    ptyManager.kill(payload.id);
  });

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
