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
import { setTransport } from '../renderer/transport';
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
    return app;
  } catch (err) {
    console.error('[Ternimal/Web] Failed to create TerminalApp:', err);
    document.body.innerHTML =
      '<pre style="color:red;padding:20px;">Error: ' + err + '</pre>';
    throw err;
  }
}
