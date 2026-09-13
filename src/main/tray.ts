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
import type { InstanceIdentity } from './instanceIdentity';

/** 亮度掩模染色：像素亮度 → 实例色（alpha 保留），形状不变颜色变。 */
function tintByLuminance(img: Electron.NativeImage, colorHex: string): Electron.NativeImage {
  const size = img.getSize();
  const bitmap = img.getBitmap(); // BGRA
  const h = colorHex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const out = Buffer.alloc(bitmap.length);
  for (let i = 0; i < bitmap.length; i += 4) {
    const lum = (bitmap[i] * 299 + bitmap[i + 1] * 587 + bitmap[i + 2] * 114) / 1000 / 255;
    out[i] = Math.round(b * lum); // BGRA 顺序
    out[i + 1] = Math.round(g * lum);
    out[i + 2] = Math.round(r * lum);
    out[i + 3] = bitmap[i + 3];
  }
  return nativeImage.createFromBitmap(out, { width: size.width, height: size.height });
}
import * as path from 'path';
import * as os from 'os';
import QRCode from 'qrcode';
import type { AuthManager } from './authManager';
import { t, Locale } from '../shared/i18n';

export interface TrayDeps {
  identity: InstanceIdentity;
  auth: AuthManager;
  /** UI locale (main detects once from app.getLocale()). */
  locale: Locale;
  /** Actual listen port (may differ from configured when ephemeral). */
  getPort: () => number;
  certFingerprint: string;
  showWindow: () => void;
  /** Full application shutdown: PTYs, server, quit. */
  shutdown: () => Promise<void> | void;
  /** R-M2 relay surface (optional — absent when relay code path disabled). */
  relay?: {
    /** off = 未启用 / conn = 连接中 / on = 已注册（TC-R2-01 tray 状态）。 */
    state: () => 'off' | 'conn' | 'on';
    /** 生成分享链接并写剪贴板；返回是否成功。 */
    copyShareLink: () => Promise<boolean>;
    /** 生成分享链接（不写剪贴板），供信息窗二维码展示；null = 不可用。 */
    shareUrl: () => Promise<string | null>;
  };
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
    // 多实例：托盘图标按实例色染色（亮度掩模：原图亮度→实例色，保形状与透明度）
    const identity = this.deps.identity;
    if (!identity.isDefault) image = tintByLuminance(image, identity.color);
    this.tray = new Tray(image);
    const label = identity.isDefault ? 'Ternimal' : `Ternimal [${identity.id}]`;
    this.tray.setToolTip(`${label} — https://${lanIp()}:${this.deps.getPort()}`);
    this.rebuildMenu();
  }

  /** Refresh labels/tooltips (e.g. after token rotation or port change). */
  rebuildMenu(): void {
    if (!this.tray) return;
    const deps = this.deps;
    const relayState = deps.relay?.state() ?? 'off';
    const menu: Electron.MenuItemConstructorOptions[] = [
      // 首行：本托盘所属实例名（多实例下点开即知是哪一个；不可点击的标识行）
      { label: `Ternimal · ${deps.identity.id}`, enabled: false },
      { type: 'separator' },
      { label: t(deps.locale, 'tray.show'), click: () => deps.showWindow() },
      { type: 'separator' },
      {
        label: t(deps.locale, 'tray.copyUrl'),
        click: () => {
          clipboard.writeText(this.accessUrl());
        },
      },
    ];
    if (relayState !== 'off') {
      menu.push({
        label:
          relayState === 'on'
            ? t(deps.locale, 'tray.relay.on')
            : t(deps.locale, 'tray.relay.conn'),
        enabled: false,
      });
      if (relayState === 'on') {
        menu.push({
          label: t(deps.locale, 'tray.relay.copyShare'),
          click: () => {
            void deps.relay!.copyShareLink();
          },
        });
      }
      menu.push({ type: 'separator' });
    }
    menu.push(
      {
        label: t(deps.locale, 'tray.viewAccess'),
        click: () => {
          void this.showAccessInfo();
        },
      },
      { type: 'separator' },
      {
        label: t(deps.locale, 'tray.rotateToken'),
        click: () => {
          deps.auth.rotateToken();
          this.rebuildMenu();
          void this.showAccessInfo(); // new QR immediately
        },
      },
      { type: 'separator' },
      {
        label: t(deps.locale, 'tray.quit'),
        click: () => {
          void deps.shutdown();
        },
      }
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(menu));
    // P2：tooltip 不再携带 #T=令牌——一次悬停就把承载凭据暴露给肩窥/
    // 屏幕共享。令牌仍可经「查看访问信息」点击获取。
    this.tray.setToolTip(
      relayState === 'on'
        ? `Ternimal — ${t(deps.locale, 'tray.relay.on')} — ${this.accessUrl().split('#')[0]}`
        : `Ternimal — ${this.accessUrl().split('#')[0]}`
    );
  }

  /** Access URL carrying the token in the FRAGMENT (never sent to the
   *  server, not logged, stripped by the auth page after exchange). */
  accessUrl(): string {
    return `https://${lanIp()}:${this.deps.getPort()}/#T=${this.deps.auth.getToken()}`;
  }

  /** Desktop window: QR code + URL + token + cert fingerprint.
   * TC-R2-02: 中继已连接时切换为中继分享链接二维码（远端扫码即入）。 */
  private async showAccessInfo(): Promise<void> {
    const relayUrl =
      this.deps.relay && this.deps.relay.state() === 'on'
        ? await this.deps.relay.shareUrl().catch(() => null)
        : null;
    const displayUrl = relayUrl ?? this.accessUrl();
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(displayUrl, {
        width: 320,
        margin: 2,
        color: { dark: '#1e1e1e', light: '#ffffff' },
      });
    } catch {
      // QR generation failing must not block showing textual info.
    }
    const html = accessInfoHtml({
      url: displayUrl,
      token: this.deps.auth.getToken(),
      fingerprint: this.deps.certFingerprint,
      qrDataUrl,
      locale: this.deps.locale,
      relayMode: !!relayUrl,
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
      title: t(this.deps.locale, 'info.title'),
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

function accessInfoHtml(info: {
  url: string;
  token: string;
  fingerprint: string;
  qrDataUrl: string;
  locale: Locale;
  relayMode?: boolean;
}): string {
  const L = info.locale;
  const heading = info.relayMode ? t(L, 'info.relayHeading') : t(L, 'info.heading');
  const tip = info.relayMode ? t(L, 'info.relayTip') : t(L, 'info.tip');
  const urlLabel = info.relayMode ? t(L, 'settings.relay.shareTip') : t(L, 'info.url');
  const qr = info.qrDataUrl
    ? `<img src="${info.qrDataUrl}" width="320" height="320" alt="QR">`
    : `<div class="err">${t(L, 'info.qrFailed')}</div>`;
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
  <h1>${heading}</h1>
  <div class="qr">${qr}</div>
  <div class="tip">${tip.split('\n').join('<br>')}</div>
  <div class="row"><b>${urlLabel}</b><code>${info.url}</code></div>
  <div class="row"><b>${t(L, 'info.token')}</b><code>${info.token}</code></div>
  <div class="row"><b>${t(L, 'info.fp')}</b><code>${info.fingerprint}</code></div>
</body>
</html>`;
}
