// TrayController (M4, WBS-M4-A; design §2.6; QR/token model per user request).
//
// Desktop residency surface: the app survives window close; the tray is the
// always-available control point. Menu actions:
//   显示窗口      — recreate-or-show the local window (TC-M4-03)
//   复制访问地址  — LAN https URL (with #T=<token>) into the clipboard
//   查看访问信息  — window with QR code (scan on the phone → straight in),
//                   URL, token and cert fingerprint (anti-MITM)
//   重置访问令牌  — rotate the dynamic token (all sessions die), show the
//                   new QR immediately, restart-free
//   退出          — single shutdown() path (TC-M4-07)
import { app, Tray, Menu, clipboard, nativeImage, BrowserWindow } from 'electron';
import * as path from 'path';
import * as os from 'os';
import QRCode from 'qrcode';
import type { AuthManager } from './authManager';

export interface TrayDeps {
  auth: AuthManager;
  /** Actual listen port (may differ from configured when ephemeral). */
  getPort: () => number;
  certFingerprint: string;
  showWindow: () => void;
  /** Full application shutdown: PTYs, server, quit. */
  shutdown: () => Promise<void> | void;
}

export class TrayController {
  private tray: Tray | null = null;
  private infoWindow: BrowserWindow | null = null;
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

  /** Refresh labels/tooltips (e.g. after token rotation or port change). */
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
          },
        },
        {
          label: '查看访问信息（二维码）',
          click: () => {
            void this.showAccessInfo();
          },
        },
        { type: 'separator' },
        {
          label: '重置访问令牌',
          click: () => {
            deps.auth.rotateToken();
            this.rebuildMenu();
            void this.showAccessInfo(); // new QR immediately
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

  /** Access URL carrying the token in the FRAGMENT (never sent to the
   *  server, not logged, stripped by the auth page after exchange). */
  accessUrl(): string {
    return `https://${lanIp()}:${this.deps.getPort()}/#T=${this.deps.auth.getToken()}`;
  }

  /** Desktop window: QR code + URL + token + cert fingerprint. */
  private async showAccessInfo(): Promise<void> {
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(this.accessUrl(), {
        width: 320,
        margin: 2,
        color: { dark: '#1e1e1e', light: '#ffffff' },
      });
    } catch {
      // QR generation failing must not block showing textual info.
    }
    const html = accessInfoHtml({
      url: this.accessUrl(),
      token: this.deps.auth.getToken(),
      fingerprint: this.deps.certFingerprint,
      qrDataUrl,
    });
    const encoded = 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');

    if (this.infoWindow && !this.infoWindow.isDestroyed()) {
      this.infoWindow.loadURL(encoded);
      this.infoWindow.show();
      this.infoWindow.focus();
      return;
    }
    this.infoWindow = new BrowserWindow({
      width: 460,
      height: 640,
      title: 'Ternimal 访问信息',
      resizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#1e1e1e',
    });
    this.infoWindow.on('closed', () => {
      this.infoWindow = null;
    });
    this.infoWindow.loadURL(encoded);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.infoWindow?.destroy();
    this.infoWindow = null;
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

function accessInfoHtml(info: { url: string; token: string; fingerprint: string; qrDataUrl: string }): string {
  const qr = info.qrDataUrl
    ? `<img src="${info.qrDataUrl}" width="320" height="320" alt="访问二维码">`
    : '<div class="err">（二维码生成失败 — 请使用下方链接/令牌）</div>';
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>Ternimal 访问信息</title>
<style>
  body { background:#1e1e1e; color:#d4d4d4; font-family:system-ui,sans-serif;
         display:flex; flex-direction:column; align-items:center; padding:24px;
         box-sizing:border-box; margin:0; user-select:text; }
  h1 { font-size:16px; margin:0 0 16px; }
  .qr { background:#fff; padding:8px; border-radius:8px; line-height:0; }
  .tip { margin:14px 0 0; font-size:13px; color:#8a8a8a; text-align:center; }
  .row { margin-top:14px; width:100%; font-size:12px; word-break:break-all; }
  .row b { color:#8a8a8a; font-weight:normal; display:block; margin-bottom:3px; }
  code { font-family:ui-monospace,monospace; color:#cfcfcf; background:#252526;
         padding:2px 6px; border-radius:4px; display:inline-block; }
</style>
</head>
<body>
  <h1>手机扫码访问 Ternimal</h1>
  <div class="qr">${qr}</div>
  <div class="tip">扫码后浏览器将自动完成鉴权（首次需信任自签名证书）。<br>
    令牌随链接以 URL 片段携带，不会出现在服务器日志中。</div>
  <div class="row"><b>访问链接（含令牌，可直接复制给内网设备）</b><code>${info.url}</code></div>
  <div class="row"><b>访问令牌（手动输入用，重置后立即失效）</b><code>${info.token}</code></div>
  <div class="row"><b>证书 SHA-256 指纹（应与登录页显示一致）</b><code>${info.fingerprint}</code></div>
</body>
</html>`;
}
