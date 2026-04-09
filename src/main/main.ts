import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { PtyManager } from './ptyManager';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipcHandlers';

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 400,
    minHeight: 300,
    title: 'Ternimal',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    frame: true,
    autoHideMenuBar: true,
  });

  // Load the renderer
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Register IPC handlers
  registerIpcHandlers(ptyManager, mainWindow);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  ptyManager.killAll();
  unregisterIpcHandlers();
  app.quit();
});

app.on('before-quit', () => {
  ptyManager.killAll();
});
