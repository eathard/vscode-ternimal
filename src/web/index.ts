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
import { RelayGate, parseHashParts, pageServedByRelay, RelayCreds } from './relayGate';
import { Keychain } from './keychain';
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
  const keychain = new Keychain();
  let app: TerminalApp | null = null;
  let everReady = false;

  let currentTransport: WebSocketTransport | null = null;
  // auth-ok 的凭据（钥匙串在 ready 时存它；denied 侧不落盘）
  let pendingCreds: RelayCreds | null = null;
  const startWith = (creds: RelayCreds): void => {
    // P0：换凭据重试前掐掉旧 transport——否则旧连接的 denied/关闭事件
    // 会继续打到 gate，把用户正在输入的新凭据卡片顶掉。
    currentTransport?.dispose();
    const transport = new WebSocketTransport(relayWsUrl(), { relay: creds });
    currentTransport = transport;
    setTransport(transport);
    pendingCreds = creds;
    transport.onRelayState((state) => {
      switch (state) {
        case 'ready': {
          gate.hide();
          if (!app) app = mountApp(root);
          everReady = true;
          // v1.3.2 钥匙串：服务端接受后才落盘（多电脑书签的免扫码回访凭据）。
          if (pendingCreds) keychain.remember(pendingCreds.subCode, pendingCreds.token);
          pendingCreds = null;
          break;
        }
        case 'denied':
          gate.showCard(startWith, t(locale, 'relay.gate.denied'));
          renderSavedDevices();
          break;
        case 'revoked':
          // 子码已被吊销：钥匙串里这条也一并作废，避免下次继续拿死钥匙试
          if (pendingCreds) keychain.forget(pendingCreds.subCode);
          gate.showCard(startWith, t(locale, 'relay.gate.revoked'));
          renderSavedDevices();
          break;
        case 'connecting':
          // After a drop the terminal stays rendered — banner, not overlay.
          if (everReady) gate.showReconnectingBanner();
          break;
      }
    });
  };

  /** 手输卡之上的「已保存的电脑」列表（连接走钥匙串、忘记即吊销该行）。 */
  const renderSavedDevices = (): void => {
    const devices = keychain.list().map((d) => ({ subCode: d.subCode, daysLeft: d.daysLeft }));
    gate.appendSavedDevices(
      devices,
      (sub) => {
        const token = keychain.lookup(sub);
        if (!token) {
          // 刚过期：重绘列表（该行已被清扫）
          renderSavedDevices();
          return;
        }
        gate.showConnecting();
        startWith({ subCode: sub, token });
      },
      (sub) => {
        keychain.forget(sub);
        renderSavedDevices();
      },
    );
  };

  const parts = parseHashParts(window.location.hash);
  const creds = parts.subCode && parts.token ? { subCode: parts.subCode, token: parts.token } : null;
  if (creds) {
    // P0：令牌不得驻留浏览器——历史/地址栏/截屏/复制链接都是活凭据。
    // LAN 认证页早就这么做（history.replaceState）；刷新重连靠
    // sessionStorage 快照（仅本标签页存活）。
    // v1.3.2：片段里保留 #S=<子码>（主机标识，非机密）——书签因此能区分
    // 多台电脑；仅抹除令牌。
    try {
      sessionStorage.setItem('ternimal.relayCreds', JSON.stringify(creds));
      history.replaceState(null, '', `${location.pathname}#S=${encodeURIComponent(creds.subCode)}`);
    } catch { /* 隐私模式：降级为仅清 URL */ }
    gate.showConnecting();
    startWith(creds);
  } else if (parts.subCode) {
    // 书签回访（v1.3.2）：#S=<子码> → 钥匙串取令牌免扫码直连
    const token = keychain.lookup(parts.subCode);
    if (token) {
      gate.showConnecting();
      startWith({ subCode: parts.subCode, token });
    } else {
      gate.showCard(startWith);
      renderSavedDevices();
    }
  } else {
    // 刷新恢复：URL 已清，凭据从 sessionStorage 复原（无痕模式则走手输卡）
    let cached: RelayCreds | null = null;
    try {
      const raw = sessionStorage.getItem('ternimal.relayCreds');
      if (raw) cached = JSON.parse(raw) as RelayCreds;
    } catch { /* corrupted: ignore */ }
    if (cached) {
      gate.showConnecting();
      startWith(cached);
      return;
    }
    gate.showCard(startWith);
    renderSavedDevices();
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
    // P3：textContent 而非 innerHTML——错误消息是动态串。
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:red;padding:20px;';
    pre.textContent = 'Error: ' + err;
    document.body.replaceChildren(pre);
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
  // 专注且未持有时周期重发申请。P2：固定 3s 轮询在「双设备都专注」时
  // 与服务端 5s 驻留规则形成 ~6s 乒乓（每次翻转全体观看者跟着重排）。
  // 改为指数退避：申请未被裁定为本端持有时 3s→6s→12s→…封顶 30s；
  // 任何注意力跃迁（focus/可见/切标签/重连就绪）立即复位退避。
  let pollDelay = 3_000;
  const resetBackoff = (): void => { pollDelay = 3_000; };
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const poll = (): void => {
    const id = app.getActiveTabId();
    if (id && !app.isGeometryOwner(id)) {
      if (attentive()) transport.claimGeometry?.(id);
      pollDelay = Math.min(pollDelay * 2, 30_000); // 未成为持有者 → 退避加倍
    } else {
      pollDelay = 3_000; // 已持有（或无活跃标签）→ 复位
    }
    pollTimer = setTimeout(poll, pollDelay);
  };
  pollTimer = setTimeout(poll, pollDelay);
  window.addEventListener('focus', resetBackoff);
  document.addEventListener('visibilitychange', resetBackoff);
  window.addEventListener('pagehide', () => { if (pollTimer) clearTimeout(pollTimer); });
  window.addEventListener('blur', releaseClaimed);
  window.addEventListener('pagehide', releaseClaimed);
  // 标签切换：释放旧的，在新活跃标签上重新申请。
  app.onTabActivated = () => {
    resetBackoff();
    releaseClaimed();
    claimedId = null;
    claimActive();
  };
  // P1：重连后所有权状态失步自愈——断线时服务端 dropClient 并广播
  // owner=local，但重连客户端错过该广播，chip/所有权停留 stale-true。
  // 每次认证就绪（ready）先清空本地所有权认知，再对当前活跃标签重新
  // 申请（服务端 claim 幂等）。
  transport.onRelayState((state) => {
    if (state !== 'ready') return;
    claimedId = null;
    claimActive();
  });
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
