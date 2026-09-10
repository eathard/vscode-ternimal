// relayGate.ts (WBS-R3-A) — web bundle 的中继模式启动门。
//
// 同一份 dist/web 由两种宿主提供：RemoteServer（LAN，cookie 鉴权，/login
// 页由服务端渲染）与 relay（无 cookie 概念，凭据走 URL 片段 #S=/#T= 或
// 手动输入）。boot 时探测 /health：JSON 且 service==='trelay' → relay 模式。
//
// Gate 状态机（对应 WebSocketTransport.onRelayState）：
//   connecting → ready（挂 TerminalApp）
//   denied / revoked → 回卡片显示原因（不自动重试，TC-R3-03 不白屏不挂起）
//   ready 之后 connecting（闪断重连）→ 顶部横幅，不打断已渲染的终端
import { t, detectLocale } from '../shared/i18n';

const locale = detectLocale(navigator.language);

export interface RelayCreds {
  subCode: string;
  token: string;
}

/** '#S=<sub>&T=<tok>'（顺序不敏感，值需 URL 解码）。 */
export function parseRelayHash(hash: string): RelayCreds | null {
  const params = new Map<string, string>();
  for (const part of hash.replace(/^#/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    } catch {
      /* malformed escape — skip */
    }
  }
  const subCode = params.get('S');
  const token = params.get('T');
  return subCode && token ? { subCode, token } : null;
}

/** 探测当前页面是否由 relay 托管（RemoteServer 的 /health 是纯文本 'ok'）。 */
export async function pageServedByRelay(): Promise<boolean> {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const text = (await res.text()).trim();
    if (!text.startsWith('{')) return false;
    const json = JSON.parse(text) as { service?: string };
    return json.service === 'trelay';
  } catch {
    return false; // 探测失败按 LAN 宿主处理（保持既有行为）
  }
}

export class RelayGate {
  private overlay: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private submitted = false;

  /** 显示凭据卡片（手动兜底，TC-R3-02）。onSubmit 仅触发一次直至出错重显。 */
  showCard(onSubmit: (creds: RelayCreds) => void, error?: string): void {
    this.hideBanner();
    this.overlay?.remove();
    this.submitted = false;

    const overlay = document.createElement('div');
    overlay.className = 'rg-overlay';

    const card = document.createElement('div');
    card.className = 'rg-card';
    card.appendChild(el('h1', 'rg-title', t(locale, 'relay.gate.title')));

    const subInput = input(t(locale, 'relay.gate.sub'), 'text');
    const tokInput = input(t(locale, 'relay.gate.token'), 'password');
    card.appendChild(subInput.wrap);
    card.appendChild(tokInput.wrap);

    if (error) card.appendChild(el('div', 'rg-error', error));

    const btn = el('button', 'rg-button', t(locale, 'relay.gate.connect')) as HTMLButtonElement;
    card.appendChild(btn);

    const submit = () => {
      if (this.submitted) return;
      const subCode = subInput.input.value.trim();
      const token = tokInput.input.value.trim();
      if (!subCode || !token) return;
      this.submitted = true;
      onSubmit({ subCode, token });
    };
    btn.addEventListener('click', submit);
    subInput.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tokInput.input.focus();
    });
    tokInput.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    subInput.input.focus();
  }

  /** 首次/初始连接中的全屏提示。 */
  showConnecting(): void {
    if (this.overlay) return; // 卡片之上不重复盖
    this.overlay = el('div', 'rg-overlay');
    this.overlay.appendChild(el('div', 'rg-status', t(locale, 'relay.gate.connecting')));
    document.body.appendChild(this.overlay);
  }

  /** 已就绪后闪断重连的轻量横幅（不遮挡终端）。 */
  showReconnectingBanner(): void {
    if (this.banner) return;
    this.banner = el('div', 'rg-banner', t(locale, 'relay.gate.reconnecting'));
    document.body.appendChild(this.banner);
  }

  hideBanner(): void {
    this.banner?.remove();
    this.banner = null;
  }

  /** gate 完成（ready）：撤掉全部遮罩。 */
  hide(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.hideBanner();
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(label: string, type: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'rg-field');
  wrap.appendChild(el('label', 'rg-label', label));
  const node = document.createElement('input');
  node.type = type;
  node.className = 'rg-input';
  node.spellcheck = false;
  wrap.appendChild(node);
  return { wrap, input: node };
}
