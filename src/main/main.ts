import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { SessionRegistry } from './sessionRegistry';
import { RemoteServer } from './remoteServer';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipcHandlers';
import { ConfigStore } from './configStore';
import { ensureCertificate } from './certManager';
import { AuthManager, generatePassword, hashPassword } from './authManager';
import { TrayController } from './tray';

// Disable Chromium sandbox for Linux compatibility with distros like Deepin
// where the SUID sandbox crashes on startup
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

// Single Sources of Truth, wired in whenReady (paths need a ready app).
let mainWindow: BrowserWindow | null = null;
let registry: SessionRegistry | null = null;
let remoteServer: RemoteServer | null = null;
let tray: TrayController | null = null;
let shuttingDown = false;

// ---- window lifecycle (M4-B: resident; tray is the control surface) ----

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
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

  // Load the renderer — its init() restores tabs + scrollback from the
  // registry (TC-M4-03: sessions and history survive window close).
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** TC-M4-07: the ONE exit path — tray menu quit. Idempotent. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    registry?.killAll();
    registry?.dispose();
    await remoteServer?.stop();
    tray?.destroy();
    unregisterIpcHandlers();
  } finally {
    app.quit();
  }
}

// ---- M3/M4 bootstrap: config → password → cert → server → tray ----

async function startRemoteServer(): Promise<void> {
  const userData = app.getPath('userData');
  const configStore = new ConfigStore(path.join(userData, 'config'));
  const config = configStore.load();

  // Password: explicit env override (recovery/tests) > stored hash >
  // first-boot random (logged once; tray offers display + reset in M4).
  if (process.env.TERNIMAL_PASSWORD) {
    config.passwordHash = hashPassword(process.env.TERNIMAL_PASSWORD);
  } else if (!config.passwordHash) {
    const password = generatePassword();
    config.passwordHash = hashPassword(password);
    configStore.save({ passwordHash: config.passwordHash });
    console.warn(`[Ternimal] first-boot access password (SAVE IT): ${password}`);
    console.warn('[Ternimal] 也可稍后在托盘菜单「重置密码」获取新密码');
  }

  const port = Number(process.env.TERNIMAL_PORT) || config.port;
  const host = process.env.TERNIMAL_HOST || config.host;

  const tls = await ensureCertificate(
    path.join(userData, 'certs'),
    config.certPath || undefined
  );
  if (tls.generated) {
    console.warn(`[Ternimal] generated self-signed cert — SHA-256 fingerprint:`);
    console.warn(`[Ternimal]   ${tls.fingerprint}`);
  }

  // Registry takes the configured replay budget (M4-C, TC-M4-04).
  registry = new SessionRegistry({ replayBytes: config.replayBufferBytes });

  const auth = new AuthManager({ passwordHash: config.passwordHash });
  remoteServer = new RemoteServer({
    registry,
    auth,
    tls,
    port,
    host,
    maxSessions: config.maxSessions,
  });
  remoteServer.certFingerprint = tls.fingerprint;
  await remoteServer.start();

  // IPC handlers exactly once, with a lazy window accessor (M4 reopen safe).
  registerIpcHandlers(registry, () => mainWindow);

  // Tray (M4-A): the residency control surface. Skipped in headless test
  // mode (CI boxes may have no display; Tray would throw).
  if (!process.env.TERNIMAL_HEADLESS_TEST) {
    tray = new TrayController({
      auth,
      config: configStore,
      getPort: () => remoteServer?.getPort() ?? port,
      certFingerprint: tls.fingerprint,
      showWindow: createWindow,
      shutdown,
    });
    tray.create();
  }
}

app.whenReady().then(() => {
  startRemoteServer()
    .then(() => {
      if (!process.env.TERNIMAL_HEADLESS_TEST) {
        createWindow();
      }
    })
    .catch((err) => {
      console.error('[Ternimal] startup failed:', err);
      app.quit();
    });
});

// M4-B: closing the window NEVER exits — sessions outlive the window
// (TC-M4-02). The tray remains; quit is explicit via tray (TC-M4-07).
app.on('window-all-closed', () => {
  /* resident by design */
});

app.on('activate', () => {
  // macOS dock click — same as tray "显示窗口"
  if (!process.env.TERNIMAL_HEADLESS_TEST) createWindow();
});

app.on('before-quit', () => {
  // Covers Ctrl-C / OS logout paths; idempotent with shutdown().
  if (!shuttingDown) {
    void shutdown();
  }
});
