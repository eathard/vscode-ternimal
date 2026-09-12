// Web client entry (M2-D): same UI components as the Electron renderer,
// different transport. The server's RemoteServer serves this bundle from
// dist/web and the WebSocketTransport carries the session stream.
//
// R-M3 (WBS-R3-A): the SAME bundle is also hosted by the relay. Boot probes
// /health — 'trelay' service → relay mode (gate reads #S=/#T= fragments or
// manual sub-code+token entry, transport runs join+first-frame-auth);
// otherwise the original LAN cookie flow is untouched.
import '../renderer/style.css';
import '@xterm/xterm/css/xterm.css';
import { setTransport, getTransport } from '../renderer/transport';
import { WebSocketTransport } from '../renderer/transport/webSocketTransport';
import { TerminalApp } from '../renderer/terminalApp';
import { mountSoftKeys } from './softKeys';
import { RelayGate, parseRelayHash, pageServedByRelay, RelayCreds } from './relayGate';
import { t, detectLocale } from '../shared/i18n';

const locale = detectLocale(navigator.language);

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function relayWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/join`;
}

window.onerror = (msg, src, line, col, err) => {
  console.error('[Ternimal/Web] Uncaught error:', msg, src, line, col, err);
};

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Ternimal/Web] Unhandled promise rejection:', e);
});

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (!root) return;
  void boot(root);
});

async function boot(root: HTMLElement): Promise<void> {
  if (!(await pageServedByRelay())) {
    // LAN host mode — pre-existing behavior, cookie auth via /login.
    setTransport(new WebSocketTransport(wsUrl()));
    mountApp(root);
    return;
  }

  // Relay mode (TC-R3-01 zero-config / TC-R3-02 manual fallback).
  const gate = new RelayGate();
  let app: TerminalApp | null = null;
  let everReady = false;

  const startWith = (creds: RelayCreds): void => {
    const transport = new WebSocketTransport(relayWsUrl(), { relay: creds });
    setTransport(transport);
    transport.onRelayState((state) => {
      switch (state) {
        case 'ready':
          gate.hide();
          if (!app) app = mountApp(root);
          everReady = true;
          break;
        case 'denied':
          gate.showCard(startWith, t(locale, 'relay.gate.denied'));
          break;
        case 'revoked':
          gate.showCard(startWith, t(locale, 'relay.gate.revoked'));
          break;
        case 'connecting':
          // After a drop the terminal stays rendered — banner, not overlay.
          if (everReady) gate.showReconnectingBanner();
          break;
      }
    });
  };

  const creds = parseRelayHash(window.location.hash);
  if (creds) {
    gate.showConnecting();
    startWith(creds);
  } else {
    gate.showCard(startWith, t(locale, 'relay.gate.badFragment'));
  }
}

function mountApp(root: HTMLElement): TerminalApp {
  try {
    const app = new TerminalApp(root);
    // Soft keyboard (Ctrl/Alt/Shift combos + Esc/Tab) — web only.
    mountSoftKeys(app);
    // Follow mode (web viewers): attached sessions keep their geometry —
    // phone rotation/keyboard-open become pure display changes. Tabs this
    // client creates still own theirs; per-tab opt-in via the adapt chip.
    app.setFollowMode(true);
    mountAdaptChip(app, locale);
    // B+ 所有权流动：页面可见+聚焦时自动申请当前活跃标签的几何所有权
    // （服务端规则：桌面未聚焦才放行；5s 防乒乓；chip=force）。
    // 失焦/隐藏 → 释放，桌面回到原生尺寸。
    wireAutoAdapt(app);
    return app;
  } catch (err) {
    console.error('[Ternimal/Web] Failed to create TerminalApp:', err);
    document.body.innerHTML =
      '<pre style="color:red;padding:20px;">Error: ' + err + '</pre>';
    throw err;
  }
}

/** B+：web 端自动接管/释放（注意力 = 页面可见且聚焦 + 活跃标签）。 */
function wireAutoAdapt(app: TerminalApp): void {
  const transport = getTransport() as WebSocketTransport;
  if (!transport.claimGeometry || !transport.releaseGeometry) return;
  let claimedId: string | null = null;

  const attentive = (): boolean =>
    document.visibilityState === 'visible' && document.hasFocus();

  const claimActive = (): void => {
    if (!attentive()) return;
    const id = app.getActiveTabId();
    if (id) transport.claimGeometry?.(id); // 非 force：服务端裁定
  };
  const releaseClaimed = (): void => {
    if (claimedId) transport.releaseGeometry?.(claimedId);
  };

  // 服务端广播维护 claimedId（own 才算持有；被拒/被夺回即清）
  transport.onGeoOwnership?.((e) => {
    if (e.owner === transport.geoClientId) claimedId = e.id;
    else if (e.id === claimedId) claimedId = null;
  });

  window.addEventListener('focus', claimActive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') claimActive();
    else releaseClaimed();
  });
  // 兜底重试：窗口经 WM 激活但页面本已持焦时不会再生 focus 事件——
  // 专注且未持有时每 3s 重发申请（服务端裁定，幂等无害）。
  setInterval(() => {
    const id = app.getActiveTabId();
    if (id && !app.isGeometryOwner(id)) claimActive();
  }, 3000);
  window.addEventListener('blur', releaseClaimed);
  window.addEventListener('pagehide', releaseClaimed);
  // 标签切换：释放旧的，在新活跃标签上重新申请。
  app.onTabActivated = () => {
    releaseClaimed();
    claimedId = null;
    claimActive();
  };
}

/**
 * 「适配本机宽度」chip（web only）：显示当前标签几何归属，点击切换。
 * 跟随=只影响本机视图；适配=本端接管会话尺寸（last-writer-wins）。
 */
function mountAdaptChip(app: TerminalApp, locale: ReturnType<typeof detectLocale>): void {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'web-adapt-chip';
  chip.style.display = 'none';
  const refresh = (): void => {
    const id = app.getActiveTabId();
    if (!id) {
      chip.style.display = 'none';
      return;
    }
    const owning = app.isGeometryOwner(id);
    chip.style.display = '';
    chip.classList.toggle('owning', owning);
    chip.textContent = owning
      ? t(locale, 'web.adapt.on')
      : t(locale, 'web.adapt.off');
    chip.title = t(locale, 'web.adapt.hint');
  };
  chip.addEventListener('click', () => {
    // B+：chip = 手动强制接管/释放（豁免驻留与桌面聚焦检查）。
    const id = app.getActiveTabId();
    if (!id) return;
    const transport = getTransport() as WebSocketTransport;
    if (app.isGeometryOwner(id)) transport.releaseGeometry?.(id);
    else transport.claimGeometry?.(id, true);
  });
  document.body.appendChild(chip);
  // 初次挂载 + 每次标签切换后刷新
  setTimeout(refresh, 400);
  setInterval(refresh, 1500);
}
