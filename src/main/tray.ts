// TrayController (M4, WBS-M4-A; design §2.6).
//
// Desktop residency surface: the app survives window close; the tray is the
// always-available control point. Menu actions:
//   显示窗口      — recreate-or-show the local window (TC-M4-03)
//   复制访问地址  — LAN https URL into the clipboard
//   查看访问信息  — dialog with address + cert fingerprint (anti-MITM)
//   重置密码      — rotate password (all sessions die), persist hash,
//                   show the new password once, restart-free
//   退出          — single shutdown() path (TC-M4-07)
import { app, Tray, Menu, dialog, clipboard, nativeImage, BrowserWindow } from 'electron';
import * as path from 'path';
import * as os from 'os';
import type { AuthManager } from './authManager';
import type { ConfigStore } from './configStore';
import { hashPassword } from './authManager';

export interface TrayDeps {
  auth: AuthManager;
  config: ConfigStore;
  /** Actual listen port (may differ from configured when ephemeral). */
  getPort: () => number;
  certFingerprint: string;
  showWindow: () => void;
  /** Full application shutdown: PTYs, server, quit. */
  shutdown: () => Promise<void> | void;
}

export class TrayController {
  private tray: Tray | null = null;
  private readonly deps: TrayDeps;

  constructor(deps: TrayDeps) {
    this.deps = deps;
  }

  create(): void {
    // Candidates across dev tree / asar / asar-unpacked (asar paths work
    // with nativeImage via Electron's transparent fs).
    const appRoot = app.getAppPath();
    const candidates = [
      path.join(appRoot, 'build', 'icon.png'),
      path.join(appRoot.replace('app.asar', 'app.asar.unpacked'), 'build', 'icon.png'),
      path.join(__dirname, '..', '..', 'build', 'icon.png'),
    ];
    let image = nativeImage.createFromPath('');
    for (const p of candidates) {
      const next = nativeImage.createFromPath(p);
      if (!next.isEmpty()) {
        image = next;
        break;
      }
    }
    if (image.isEmpty()) {
      // Never block startup on a missing icon — use a 1px fallback.
      image = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      );
    }
    this.tray = new Tray(image);
    this.tray.setToolTip(`Ternimal — https://${lanIp()}:${this.deps.getPort()}`);
    this.rebuildMenu();
  }

  /** Refresh labels/tooltips (e.g. after password reset or port change). */
  rebuildMenu(): void {
    if (!this.tray) return;
    const deps = this.deps;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示窗口', click: () => deps.showWindow() },
        { type: 'separator' },
        {
          label: '复制访问地址',
          click: () => {
            clipboard.writeText(this.accessUrl());
            showInfo('Ternimal', `访问地址已复制：\n${this.accessUrl()}`);
          },
        },
        {
          label: '查看访问信息',
          click: () => {
            showInfo(
              'Ternimal 访问信息',
              `地址：${this.accessUrl()}\n\n` +
                `证书 SHA-256 指纹（登录页应显示相同值）：\n${deps.certFingerprint}\n\n` +
                `在内网设备浏览器打开并信任证书后，用访问密码登录。`
            );
          },
        },
        { type: 'separator' },
        {
          label: '重置密码',
          click: () => {
            const chosen = dialog.showMessageBoxSync({
              type: 'warning',
              buttons: ['取消', '重置'],
              defaultId: 0,
              cancelId: 0,
              message: '重置访问密码？',
              detail: '所有已登录的远程会话将立即失效，需要用新密码重新登录。',
            });
            if (chosen !== 1) return;
            const next = deps.auth.resetPassword();
            deps.config.save({ passwordHash: hashPassword(next) });
            this.rebuildMenu();
            showInfo(
              'Ternimal 新访问密码',
              `新密码：${next}\n\n仅本次显示，请立即保存。` +
                `（忘记时可用环境变量 TERNIMAL_PASSWORD 覆盖启动）`
            );
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            void deps.shutdown();
          },
        },
      ])
    );
    this.tray.setToolTip(`Ternimal — ${this.accessUrl()}`);
  }

  accessUrl(): string {
    return `https://${lanIp()}:${this.deps.getPort()}`;
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

function lanIp(): string {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function showInfo(title: string, message: string): void {
  const options = {
    type: 'info' as const,
    buttons: ['好'],
    message: title,
    detail: message,
  };
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    dialog.showMessageBox(win, options);
  } else {
    dialog.showMessageBox(options);
  }
}
