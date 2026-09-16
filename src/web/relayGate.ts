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
  const parts = parseHashParts(hash);
  return parts.subCode && parts.token ? { subCode: parts.subCode, token: parts.token } : null;
}

/** v1.3.2：书签回访只需 #S=<sub>（令牌从钥匙串取）。S/T 均可缺。 */
export function parseHashParts(hash: string): { subCode: string | null; token: string | null } {
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
  return { subCode: params.get('S') ?? null, token: params.get('T') ?? null };
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

  /**
   * v1.3.2：手输卡之上追加「已保存的电脑」列表（多主机书签场景）。
   * 每行 = 掩码子码 + 剩余天数 + 连接 / 忘记。onPick/onForget 由调用方
   * 接钥匙串。列表渲染在重新 showCard 时刷新。
   */
  appendSavedDevices(
    devices: Array<{ subCode: string; daysLeft: number }>,
    onPick: (subCode: string) => void,
    onForget: (subCode: string) => void,
  ): void {
    if (!this.overlay || devices.length === 0) return;
    const card = this.overlay.querySelector('.rg-card');
    if (!card) return;

    const section = document.createElement('div');
    section.className = 'rg-saved';
    section.appendChild(el('div', 'rg-saved-title', t(locale, 'relay.gate.saved.title')));
    for (const dev of devices) {
      const row = document.createElement('div');
      row.className = 'rg-saved-row';
      row.appendChild(el('span', 'rg-saved-sub', maskSubCode(dev.subCode)));
      row.appendChild(el(
        'span',
        'rg-saved-days',
        t(locale, 'relay.gate.saved.days').replace('{n}', String(dev.daysLeft)),
      ));
      const pick = el('button', 'rg-saved-btn', t(locale, 'relay.gate.saved.connect')) as HTMLButtonElement;
      pick.addEventListener('click', () => onPick(dev.subCode));
      const forget = el('button', 'rg-saved-btn rg-saved-forget', t(locale, 'relay.gate.saved.forget')) as HTMLButtonElement;
      forget.addEventListener('click', () => onForget(dev.subCode));
      row.appendChild(pick);
      row.appendChild(forget);
      section.appendChild(row);
    }
    section.appendChild(el('div', 'rg-saved-hint', t(locale, 'relay.gate.saved.hint')));
    card.appendChild(section);
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

/** 子码掩码：保留首尾、中段折叠（列表展示用；子码非机密，仅为整洁）。 */
function maskSubCode(sub: string): string {
  if (sub.length <= 12) return sub;
  return `${sub.slice(0, 8)}…${sub.slice(-4)}`;
}

function el(tag: string, className: string, text?: string): HTMLElement {  const node = document.createElement(tag);
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
