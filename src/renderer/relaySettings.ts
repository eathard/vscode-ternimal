// RelaySettingsPanel (WBS-R2-E/F) — 主机窗口的中继设置面板。
//
// 注意：这是纯主机侧 UI（Electron 窗口专属），直接使用 window.electronAPI 的
// relay 管理面，不属于 TerminalTransport 接缝 —— web bundle 不会加载本模块，
// 双环境组件（terminalTab 等）依旧不碰 electronAPI。
//
// 结构：全屏遮罩 + 表单（开关/地址/主码/双开/退出清除）+ 状态行 + 分享链接
// 生成区 + 已签发子码列表（吊销）。所有文案走 i18n。
import { t, detectLocale } from '../shared/i18n';
import type {
  RelaySettingsDto,
  RelayStatusEvent,
  RelaySubcodeInfo,
} from '../shared/ipcChannels';

const locale = detectLocale(navigator.language);

let overlay: HTMLElement | null = null;
let unsubscribeStatus: (() => void) | null = null;

export function openRelaySettings(): void {
  if (overlay) {
    overlay.remove();
    unsubscribeStatus?.();
  }
  overlay = buildPanel();
  document.body.appendChild(overlay);
  unsubscribeStatus = window.electronAPI.onRelayStatus((e: RelayStatusEvent) => {
    const el = overlay?.querySelector<HTMLSpanElement>('.rs-status-value');
    if (el) el.textContent = t(locale, `settings.relay.state.${e.state}`);
  });
  void refreshSubcodes();
}

function closePanel(): void {
  unsubscribeStatus?.();
  unsubscribeStatus = null;
  overlay?.remove();
  overlay = null;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildPanel(): HTMLElement {
  const root = el('div', 'rs-overlay');
  root.addEventListener('click', (e) => {
    if (e.target === root) closePanel();
  });

  const panel = el('div', 'rs-panel');
  panel.appendChild(el('h2', 'rs-title', t(locale, 'settings.relay.title')));

  const form = el('div', 'rs-form');

  const enabledRow = el('label', 'rs-row');
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'rs-check';
  enabledRow.appendChild(enabled);
  enabledRow.appendChild(el('span', 'rs-label', t(locale, 'settings.relay.enable')));
  form.appendChild(enabledRow);

  const RELAY_HELP_URL =
    'https://github.com/eathard/vscode-ternimal/blob/main/docs/relay-help.md';
  const urlInput = labeledInput(form, t(locale, 'settings.relay.url'), 'text', RELAY_HELP_URL);
  const masterInput = labeledInput(form, t(locale, 'settings.relay.master'), 'password');
  // 主码行「显示密码」：勾选明文/取消遮蔽（与管理页登录卡同交互）
  {
    const row = el('label', 'rs-row rs-master-row');
    const show = document.createElement('input');
    show.type = 'checkbox';
    show.className = 'rs-check';
    show.addEventListener('change', () => {
      masterInput.type = show.checked ? 'text' : 'password';
    });
    row.appendChild(show);
    row.appendChild(el('span', 'rs-label', t(locale, 'settings.relay.showMaster')));
    form.appendChild(row);
  }

  const caInput = labeledInput(form, t(locale, 'settings.relay.caPath'), 'text');

  const lanRow = el('label', 'rs-row');
  const lanDirect = document.createElement('input');
  lanDirect.type = 'checkbox';
  lanDirect.className = 'rs-check';
  lanRow.appendChild(lanDirect);
  lanRow.appendChild(el('span', 'rs-label', t(locale, 'settings.relay.lanDirect')));
  form.appendChild(lanRow);
  const lanWarn = el('div', 'rs-warn rs-hidden', t(locale, 'settings.relay.lanDirectWarn'));
  lanDirect.addEventListener('change', () => {
    lanWarn.classList.toggle('rs-hidden', !lanDirect.checked);
  });
  form.appendChild(lanWarn);

  const clearRow = el('label', 'rs-row');
  const clearOnExit = document.createElement('input');
  clearOnExit.type = 'checkbox';
  clearOnExit.className = 'rs-check';
  clearRow.appendChild(clearOnExit);
  clearRow.appendChild(el('span', 'rs-label', t(locale, 'settings.relay.clearOnExit')));
  form.appendChild(clearRow);

  const e2eeRow = el('label', 'rs-row');
  const e2ee = document.createElement('input');
  e2ee.type = 'checkbox';
  e2ee.className = 'rs-check';
  e2eeRow.appendChild(e2ee);
  e2eeRow.appendChild(el('span', 'rs-label', t(locale, 'settings.relay.e2ee')));
  form.appendChild(e2eeRow);

  const statusRow = el('div', 'rs-row');
  statusRow.appendChild(el('span', 'rs-label', t(locale, 'settings.relay.status')));
  const statusValue = el('span', 'rs-status-value', '…');
  statusValue.className = 'rs-status-value';
  statusRow.appendChild(statusValue);
  form.appendChild(statusRow);

  panel.appendChild(form);

  const msg = el('div', 'rs-msg rs-hidden');
  panel.appendChild(msg);

  const restartNote = el('div', 'rs-restart rs-hidden', t(locale, 'settings.relay.restartRequired'));
  panel.appendChild(restartNote);

  // ---- 分享链接区 ----
  const shareBox = el('div', 'rs-share');
  const shareBtn = el('button', 'rs-button', t(locale, 'settings.relay.share'));
  shareBox.appendChild(shareBtn);
  const shareOut = el('div', 'rs-share-out rs-hidden');
  shareBox.appendChild(shareOut);
  panel.appendChild(shareBox);

  shareBtn.addEventListener('click', () => {
    void (async () => {
      setMsg('', false);
      try {
        const share = await window.electronAPI.relayShareLink('panel');
        shareOut.classList.remove('rs-hidden');
        shareOut.textContent = '';
        const code = el('code', 'rs-share-url', share.url);
        shareOut.appendChild(code);
        const copy = el('button', 'rs-button rs-small', t(locale, 'settings.relay.copy'));
        copy.addEventListener('click', () => {
          window.electronAPI.clipboardWrite(share.url);
          setMsg(t(locale, 'settings.relay.shareTip'), false);
        });
        shareOut.appendChild(copy);
        void refreshSubcodes();
      } catch (err) {
        setMsg(
          String(err).includes('not registered')
            ? t(locale, 'settings.relay.notRegistered')
            : String(err),
          true
        );
      }
    })();
  });

  // ---- 子码列表 ----
  panel.appendChild(el('h3', 'rs-subhead', t(locale, 'settings.relay.subcodes')));
  const subList = el('div', 'rs-sublist');
  panel.appendChild(subList);

  // ---- 底部按钮 ----
  const actions = el('div', 'rs-actions');
  const saveBtn = el('button', 'rs-button rs-primary', t(locale, 'settings.relay.save'));
  const closeBtn = el('button', 'rs-button', t(locale, 'settings.relay.close'));
  closeBtn.addEventListener('click', closePanel);
  actions.appendChild(saveBtn);
  actions.appendChild(closeBtn);
  panel.appendChild(actions);

  saveBtn.addEventListener('click', () => {
    void (async () => {
      setMsg('', false);
      try {
        const next = await window.electronAPI.relayApplySettings({
          enabled: enabled.checked,
          url: urlInput.value,
          masterCode: masterInput.value,
          clearMasterCodeOnExit: clearOnExit.checked,
          lanDirect: lanDirect.checked,
          e2ee: e2ee.checked,
          caPath: caInput.value.trim(),
        });
        restartNote.classList.toggle('rs-hidden', !next.restartRequired);
        statusValue.textContent = t(locale, `settings.relay.state.${next.state}`);
        void refreshSubcodes();
      } catch (err) {
        setMsg(
          String(err).includes('url/masterCode missing')
            ? t(locale, 'settings.relay.emptyMaster')
            : String(err),
          true
        );
      }
    })();
  });

  // 预填当前设置
  void (async () => {
    try {
      const s: RelaySettingsDto = await window.electronAPI.relayGetSettings();
      enabled.checked = s.enabled;
      urlInput.value = s.url;
      masterInput.value = s.masterCode;
      lanDirect.checked = s.lanDirect;
      clearOnExit.checked = s.clearMasterCodeOnExit;
      e2ee.checked = !!s.e2ee;
      caInput.value = s.caPath ?? '';
      statusValue.textContent = t(locale, `settings.relay.state.${s.state}`);
      restartNote.classList.toggle('rs-hidden', !s.restartRequired);
    } catch (err) {
      setMsg(String(err), true);
    }
  })();

  // ---- GitHub 页脚（官方 Octicon 图标 + 地址，钉在面板最底；点击系统浏览器打开） ----
  const ghBox = el('div', 'rs-gh');
  const ghLink = document.createElement('a');
  ghLink.className = 'rs-link';
  ghLink.href = 'https://github.com/eathard/vscode-ternimal';
  ghLink.target = '_blank';
  ghLink.rel = 'noreferrer';
  ghLink.title = 'GitHub';
  ghLink.setAttribute('aria-label', 'GitHub repository');
  ghLink.innerHTML =
    '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="32" height="32" fill="currentColor" ' +
    'overflow="visible" style="vertical-align:text-bottom;flex:none">' +
    '<path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965' +
    '.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988' +
    '.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336' +
    'c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545' +
    'c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313' +
    '-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235' +
    '.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943"></path></svg>';
  ghLink.appendChild(document.createTextNode(ghLink.href));
  ghBox.appendChild(ghLink);
  panel.appendChild(ghBox);

  root.appendChild(panel);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
  return root;

  function setMsg(text: string, isError: boolean): void {
    if (!text) {
      msg.classList.add('rs-hidden');
      return;
    }
    msg.textContent = text;
    msg.classList.toggle('rs-error', isError);
    msg.classList.remove('rs-hidden');
  }

  function labeledInput(
    parent: HTMLElement,
    label: string,
    type: string,
    helpUrl?: string
  ): HTMLInputElement {
    const labelRow = el('div', 'rs-label');
    labelRow.textContent = label;
    if (helpUrl) {
      // 「?」帮助按钮：首次安装用户对中继概念陌生 → 跳转 GitHub 图文帮助（含自建/购买两种用法）
      const help = document.createElement('a');
      help.className = 'rs-help';
      help.href = helpUrl;
      help.target = '_blank';
      help.rel = 'noreferrer';
      help.textContent = '?';
      help.title = t(locale, 'settings.relay.help');
      help.setAttribute('aria-label', 'relay help');
      labelRow.appendChild(help);
    }
    parent.appendChild(labelRow);
    const input = document.createElement('input');
    input.type = type;
    input.className = 'rs-input';
    input.spellcheck = false;
    parent.appendChild(input);
    return input;
  }
}

function fmtRemaining(expiresAt: number | null, revoked: boolean): string {
  if (revoked) return t(locale, 'settings.relay.revokedTag');
  if (expiresAt === null) return t(locale, 'settings.relay.permanent');
  const ms = expiresAt - Date.now();
  if (ms <= 0) return t(locale, 'settings.relay.expiredTag');
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `≈${d}d ${h % 24}h`;
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `≈${h}h ${m}m`;
  return `≈${m}m`;
}

async function refreshSubcodes(): Promise<void> {
  const list = overlay?.querySelector('.rs-sublist');
  if (!list) return;
  try {
    const subs: RelaySubcodeInfo[] = await window.electronAPI.relayListSubcodes();
    list.textContent = '';
    if (subs.length === 0) {
      list.appendChild(el('div', 'rs-empty', t(locale, 'settings.relay.noSubcodes')));
      return;
    }
    for (const sub of subs) {
      const row = el('div', 'rs-sub');
      row.appendChild(el('code', 'rs-sub-code', sub.code.slice(0, 14) + '…'));
      // 剩余时效（长期/已过期/X天X时/X时X分），30 秒自刷新倒计时
      const rem = el('span', 'rs-sub-rem', fmtRemaining(sub.expiresAt, sub.revoked));
      row.appendChild(rem);
      row.appendChild(el('span', 'rs-sub-exp', `${t(locale, 'settings.relay.ttl')}: ${sub.expiresAt === null ? t(locale, 'settings.relay.permanent') : new Date(sub.expiresAt).toLocaleString()}`));
      if (!sub.revoked) {
        for (const [label, opts] of [
          [t(locale, 'settings.relay.renew1'), { days: 1 }],
          [t(locale, 'settings.relay.renew7'), { days: 7 }],
          [t(locale, 'settings.relay.renewP'), { permanent: true }],
        ] as Array<[string, { days?: number; permanent?: boolean }]>) {
          const btn = el('button', 'rs-button rs-small', label) as HTMLButtonElement;
          btn.addEventListener('click', () => {
            if (opts.permanent && !window.confirm(t(locale, 'settings.relay.renewPConfirm'))) return;
            void window.electronAPI.relayRenewSubcode(sub.id, opts).then(refreshSubcodes);
          });
          row.appendChild(btn);
        }
      }
      // 吊销后按钮变「删除」（purge：从表中移除记录）
      const action = sub.revoked
        ? el('button', 'rs-button rs-small rs-danger', t(locale, 'settings.relay.delete'))
        : el('button', 'rs-button rs-small rs-danger', t(locale, 'settings.relay.revoke'));
      action.addEventListener('click', () => {
        void window.electronAPI.relayRevokeSubcode(sub.id, sub.revoked).then(refreshSubcodes);
      });
      row.appendChild(action);
      list.appendChild(row);
    }
  } catch {
    // 插件未运行时静默置空
    list.textContent = '';
    list.appendChild(el('div', 'rs-empty', t(locale, 'settings.relay.noSubcodes')));
  }
}
