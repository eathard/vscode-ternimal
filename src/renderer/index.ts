import './style.css';
import '@xterm/xterm/css/xterm.css';
import { setTransport } from './transport';
import { LocalIpcTransport } from './transport/localIpcTransport';
import { TerminalApp } from './terminalApp';

// Electron entry: install the IPC transport before any UI boots.
setTransport(new LocalIpcTransport());

// 多实例：取实例配色，尽早写入 CSS 变量（标题栏=tab 条背景对应托盘图标色）
interface InstanceInfoDto {
  id: string;
  isDefault: boolean;
  color: string;
  barBg: string;
  accent: string;
}
{
  const api = (window as { electronAPI?: { instanceInfo?: () => Promise<InstanceInfoDto> } }).electronAPI;
  void api
    ?.instanceInfo?.()
    .then((info) => {
      if (!info) return;
      if (!info.isDefault) document.title = `Ternimal — ${info.id}`;
      const st = document.documentElement.style;
      st.setProperty('--instance-bar-bg', info.barBg);
      st.setProperty('--instance-accent', info.accent);
      st.setProperty('--instance-color', info.color);
    })
    .catch(() => { /* 展示性信息，失败静默走默认 */ });
}

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
