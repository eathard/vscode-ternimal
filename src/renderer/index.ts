import './style.css';
import '@xterm/xterm/css/xterm.css';
import { TerminalApp } from './terminalApp';

window.onerror = (msg, src, line, col, err) => {
  console.error('[Ternimal] Uncaught error:', msg, src, line, col, err);
};

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Ternimal] Unhandled promise rejection:', e);
});

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (root) {
    try {
      new TerminalApp(root);
    } catch (err) {
      console.error('[Ternimal] Failed to create TerminalApp:', err);
      document.body.innerHTML = '<pre style="color:red;padding:20px;">Error: ' + err + '</pre>';
    }
  }
});
