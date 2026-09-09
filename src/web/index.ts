// Web client entry (M2-D): same UI components as the Electron renderer,
// different transport. The server's RemoteServer serves this bundle from
// dist/web and the WebSocketTransport carries the session stream.
import '../renderer/style.css';
import '@xterm/xterm/css/xterm.css';
import { setTransport } from '../renderer/transport';
import { WebSocketTransport } from '../renderer/transport/webSocketTransport';
import { TerminalApp } from '../renderer/terminalApp';

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

setTransport(new WebSocketTransport(wsUrl()));

window.onerror = (msg, src, line, col, err) => {
  console.error('[Ternimal/Web] Uncaught error:', msg, src, line, col, err);
};

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Ternimal/Web] Unhandled promise rejection:', e);
});

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (root) {
    try {
      new TerminalApp(root);
    } catch (err) {
      console.error('[Ternimal/Web] Failed to create TerminalApp:', err);
      document.body.innerHTML =
        '<pre style="color:red;padding:20px;">Error: ' + err + '</pre>';
    }
  }
});
