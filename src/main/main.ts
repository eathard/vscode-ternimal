import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { SessionRegistry } from './sessionRegistry';
import { RemoteServer } from './remoteServer';
import { registerIpcHandlers, unregisterIpcHandlers, setRemoteServerForGeo } from './ipcHandlers';
import { IPC } from '../shared/ipcChannels';
import { ConfigStore } from './configStore';
import { ensureCertificate } from './certManager';
import { AuthManager } from './authManager';
import { TrayController } from './tray';
import { RelayController } from './relayController';
import { detectLocale } from '../shared/i18n';
import { resolveInstanceId, instanceIdentity, isolateUserData } from './instanceIdentity';

// Disable Chromium sandbox for Linux compatibility with distros like Deepin
// where the SUID sandbox crashes on startup
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

// ---- 多实例（方案 B）：--ternimal-instance=<id> → 独立 userData + 实例配色 ----
// 必须在 app ready 前完成 setPath（默认实例零迁移）。
const INSTANCE_ID = resolveInstanceId(process.argv, process.env);
const INSTANCE_COLOR = isolateUserData(app, INSTANCE_ID);
// 单实例锁（按实例 userData 隔离）：同实例双开 = 第二个立即退出并聚焦已有窗口。
// 根除「同主码双进程 → 中继接管互踢 → 无限重连」这类稳定性事故。
const gotLock = app.requestSingleInstanceLock({ instanceId: INSTANCE_ID });
if (!gotLock) {
  console.log(`[Ternimal] instance '${INSTANCE_ID}' already running — exiting.`);
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
const INSTANCE = instanceIdentity(INSTANCE_ID, INSTANCE_COLOR);

// 自签 relay 根证书（relay.caPath）：实例 userData 已定向后读取，
// 尽早注入主进程 NODE_EXTRA_CA_CERTS（管理端 API fetch 的 TLS 信任）。
// 插件子进程由 pluginHost.fork 再显式注入，双保险。
{
  try {
    const caPath = new ConfigStore(path.join(app.getPath('userData'), 'config')).load().relay.caPath;
    // 覆盖式：NODE_EXTRA_CA_CERTS 仅接受单一路径，冒号拼接会导致整串被忽略
    if (caPath) process.env.NODE_EXTRA_CA_CERTS = caPath;
  } catch { /* 读不到配置 = 无覆盖，走默认 CA */ }
}

// Single Sources of Truth, wired in whenReady (paths need a ready app).
let mainWindow: BrowserWindow | null = null;
let registry: SessionRegistry | null = null;
let remoteServer: RemoteServer | null = null;
let tray: TrayController | null = null;
let relay: RelayController | null = null;
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
    title: INSTANCE.isDefault ? 'Ternimal' : `Ternimal — ${INSTANCE.id}`,
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

  // 外链（如设置页 GitHub 仓库）一律用系统浏览器打开，不在应用窗口内导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); void shell.openExternal(url); }
  });

  // Load the renderer — its init() restores tabs + scrollback from the
  // registry (TC-M4-03: sessions and history survive window close).
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 页面自带 <title> 会覆盖窗口标题：加载后按实例身份重设（多实例辨识）
  mainWindow.webContents.on('did-finish-load', () => {
    if (!INSTANCE.isDefault) mainWindow?.setTitle(`Ternimal — ${INSTANCE.id}`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** TC-M4-07: the ONE exit path — tray menu quit. Idempotent. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // WBS-R2-A: 先停中继插件（kill 子进程 → socket 与代码一并卸载）
    await relay?.stopForShutdown();
    relay?.handleExitClearMaster();
    registry?.killAll();
    registry?.dispose();
    await remoteServer?.stop();
    tray?.destroy();
    unregisterIpcHandlers();
    relay?.unregisterIpc();
  } finally {
    app.quit();
  }
}

// ---- M3/M4 bootstrap: config → token → cert → server → tray ----

let configuredPort = 0;

async function startRemoteServer(portOverride?: number): Promise<void> {
  const userData = app.getPath('userData');
  const configStore = new ConfigStore(path.join(userData, 'config'));
  const config = configStore.load();

  // Dynamic access token: env TERNIMAL_TOKEN override (tests/recovery);
  // otherwise a fresh 192-bit token every launch — scan the tray QR code
  // to sign in on a phone. Restart rotates it by design.
  const auth = new AuthManager({
    accessToken: process.env.TERNIMAL_TOKEN,
  });

  const port = portOverride ?? (Number(process.env.TERNIMAL_PORT) || config.port);
  configuredPort = port;
  // WBS-R2-D/E：中继启用且未显式双开时收窄到 loopback（fail-secure，§8-Q3）。
  // 环境覆盖（smoke/恢复）显式给出即视为启用。
  const envRelay =
    !!process.env.TERNIMAL_RELAY_URL && !!process.env.TERNIMAL_RELAY_MASTER;
  const relayReady =
    envRelay || (config.relay.enabled && !!config.relay.url && !!config.relay.masterCode);
  const host =
    process.env.TERNIMAL_HOST ||
    (relayReady && !config.relay.lanDirect && config.host === '0.0.0.0'
      ? '127.0.0.1'
      : config.host);

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

  remoteServer = new RemoteServer({
    registry,
    auth,
    tls,
    port,
    host,
    maxSessions: config.maxSessions,
    locale: detectLocale(process.env.TERNIMAL_LOCALE ?? app.getLocale()),
    allowRelayFirstFrameAuth: relayReady,
    // R-M4-B：中继 E2E 加密（默认关；settings 面板或 TERNIMAL_RELAY_E2EE=1）
    relayE2EE: config.relay.e2ee || process.env.TERNIMAL_RELAY_E2EE === '1',
  });
  remoteServer.certFingerprint = tls.fingerprint;
  try {
    await remoteServer.start();
  } catch (err) {
    try { await remoteServer.stop(); } catch { /* 未完成监听，忽略 */ }
    throw err;
  }

  // IPC handlers exactly once, with a lazy window accessor (M4 reopen safe).
  registerIpcHandlers(registry, () => mainWindow, INSTANCE);

  // B+ 几何所有权流动：geo-ownership 广播转发到本地渲染进程，
  // 并把 remoteServer 交给 ipcHandlers（聚焦上报/本地 resize 夺回）。
  remoteServer.setGeoLocalBroadcast((msg) => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(IPC.GEO_ON_OWNERSHIP, msg);
  });
  setRemoteServerForGeo(remoteServer);

  // The access URL (token in the fragment) is logged once per launch.
  console.warn(`[Ternimal] access URL: https://${host === '0.0.0.0' ? lanIpForLog() : host}:${remoteServer.getPort()}/#T=${auth.getToken()}`);
  console.warn('[Ternimal] 托盘「查看访问信息」可显示二维码（手机扫码即登录），「重置访问令牌」可轮换');

  // WBS-R2-E/F：中继编排面（设置 IPC + 分享链接 + 状态广播），
  // tray 与设置面板共享同一实例。
  relay = new RelayController({
    configStore,
    certsDir: path.join(app.getPath('userData'), 'certs'),
    auth,
    getPort: () => remoteServer?.getPort() ?? port,
    fingerprint: tls.fingerprint,
    serverHost: host,
    serverRelayAuth: relayReady,
    getWindow: () => mainWindow,
    setE2EE: (v) => remoteServer?.setRelayE2EE(v),
    onStatus: (e) => {
      // 单行状态日志（用户可读 + smoke-e2e 观测通道）
      console.warn(`[Ternimal] relay: ${e.state}${e.detail ? ` (${e.detail})` : ''} pid=${e.pid} pipes=${e.pipes}`);
      tray?.rebuildMenu();
    },
  });
  relay.registerIpc();
  relay.ensureStarted();

  // Tray (M4-A): the residency control surface. Skipped in headless test
  // mode (CI boxes may have no display; Tray would throw).
  if (!process.env.TERNIMAL_HEADLESS_TEST) {
    const relayForTray = relay;
    tray = new TrayController({
      auth,
      identity: INSTANCE,
      locale: detectLocale(process.env.TERNIMAL_LOCALE ?? app.getLocale()),
      getPort: () => remoteServer?.getPort() ?? port,
      certFingerprint: tls.fingerprint,
      showWindow: createWindow,
      shutdown,
      relay: {
        state: () => relayForTray.stateSummary,
        copyShareLink: async () => {
          try {
            const share = await relayForTray.shareLink('tray');
            const { clipboard } = require('electron') as typeof import('electron');
            clipboard.writeText(share.url);
            return true;
          } catch {
            return false;
          }
        },
        shareUrl: async () => {
          try {
            return (await relayForTray.shareLink('qr')).url;
          } catch {
            return null;
          }
        },
      },
    });
    tray.create();
  }
}

function lanIpForLog(): string {
  const os = require('os') as typeof import('os');
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

app.whenReady().then(() => {
  startRemoteServer()
    .then(() => {
      if (!process.env.TERNIMAL_HEADLESS_TEST) {
        createWindow();
      }
    })
    .catch(async (err: NodeJS.ErrnoException) => {
      // 多实例共存：端口被占（多半是另一实例）→ 回退 0 自动分配重试一次
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Ternimal] 端口 ${configuredPort} 被占用（多实例？），改用自动端口`);
        try {
          await startRemoteServer(0);
          if (!process.env.TERNIMAL_HEADLESS_TEST) {
            createWindow();
          }
          return;
        } catch (err2) {
          console.error('[Ternimal] startup failed (port fallback):', err2);
        }
      } else {
        console.error('[Ternimal] startup failed:', err);
      }
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
