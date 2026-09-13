// TerminalApp (M1 refactor): tab orchestration against the transport seam.
// - Sessions are created server-side (transport.createTab → SessionInfo)
// - Startup restores the tab list from the registry (WBS-M1-E)
// - onTabsChange reconciles the local tab bar with server truth (remote
//   created/removed tabs appear/disappear here in M2)
import { SessionInfo } from '../shared/ipcChannels';
import { getTransport } from './transport';
import { TerminalTab, setInputTransform } from './terminalTab';
import { TabBar } from './tabBar';
import { SearchBar } from './searchBar';
import { ThemeManager } from './themeManager';
import { openRelaySettings } from './relaySettings';
import { t, detectLocale } from '../shared/i18n';
import {
  ModifierState,
  NO_MODIFIERS,
  applyModifiers,
  arrowSequence,
  hasModifiers,
  ArrowDirection,
} from '../shared/modifierKeys';

export class TerminalApp {
  private tabs: Map<string, TerminalTab> = new Map();
  /** Web follow-mode: attached (not created-here) tabs never resize the PTY. */
  private followMode = false;
  /** Session ids created by THIS client — they keep geometry ownership. */
  private createdHere = new Set<string>();
  private activeTabId: string | null = null;
  /** B+：最近一次 tabs 广播（跟随渲染取会话当前尺寸用）。 */
  private lastTabs: SessionInfo[] | null = null;
  private tabBar: TabBar;
  private searchBar: SearchBar;
  private themeManager: ThemeManager;
  private terminalContainer: HTMLElement;

  // Soft-keyboard modifier state (web only; local window never sets it).
  // One-shot semantics: the next single-char keystroke consumes it.
  private pendingMods: ModifierState = { ...NO_MODIFIERS };
  /** UI refresh hook — the soft-keys bar re-lights its buttons. */
  onPendingModsChange: (() => void) | null = null;

  constructor(root: HTMLElement) {
    const transport = getTransport();

    // Soft-keyboard input transform: map the next keystroke under the
    // pending Ctrl/Alt/Shift combo into terminal bytes (identity locally
    // — nothing ever sets pendingMods there).
    setInputTransform((data) => {
      if (!hasModifiers(this.pendingMods)) return data;
      const r = applyModifiers(data, this.pendingMods);
      if (r.consumed) this.clearPendingMods();
      return r.data;
    });

    // Theme manager
    this.themeManager = new ThemeManager();

    // Apply initial theme to body
    const theme = this.themeManager.getCurrentTheme();
    document.body.style.backgroundColor = theme.background || '#1e1e1e';

    // Tab bar
    this.tabBar = new TabBar(root);
    this.tabBar.onTabSelect = (id) => this.switchTab(id);
    this.tabBar.onTabClose = (id) => this.closeTab(id);
    this.tabBar.onNewTab = () => void this.newTab();

    // R-M2 (WBS-R2-E): relay settings gear — host window only; on the web
    // bundle the transport seam never exposes relay admin, so the button is
    // installed only when the preload API is present.
    if (typeof window !== 'undefined' && (window as { electronAPI?: unknown }).electronAPI) {
      const locale = detectLocale(navigator.language);
      this.tabBar.addTrailingButton('⚙', t(locale, 'settings.gear'), () => openRelaySettings());
    }

    // Web transport: attach-carried replay fills a freshly rendered tab
    // (first activation / browser refresh). Local IPC is unaffected.
    transport.onAttached((p) => {
      const tab = this.tabs.get(p.id);
      if (tab && !tab.hasOutput && p.replay) {
        tab.write(p.replay);
      }
    });
    this.tabBar.onNewTab = () => {
      this.newTab().catch((err) => console.error('[Ternimal] newTab failed:', err));
    };

    // Search bar
    this.searchBar = new SearchBar(root);

    // Terminal container
    this.terminalContainer = document.createElement('div');
    this.terminalContainer.className = 'terminal-container';
    root.appendChild(this.terminalContainer);

    // Theme change propagation
    this.themeManager.onThemeChange((newTheme) => {
      document.body.style.backgroundColor = newTheme.background || '#1e1e1e';
      this.tabs.forEach((tab) => {
        tab.wrapper.applyTheme(newTheme);
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));

    // Server-driven tab list keeps the local tab bar honest (M2: changes
    // made by remote clients surface here too).
    transport.onTabsChange((tabs) => this.reconcileTabs(tabs));

    // B+ 几何所有权流动：
    //  - web 端：服务端广播 owner（'local' | 自己 | 其他）→ 切换本端
    //    原生/跟随渲染（尺寸变化经由 tabs 广播走 applyFollowGeometry）。
    //  - Electron 端：owner!=='local' 时本地转为跟随（固定网格），
    //    owner==='local' 恢复原生 fit+resize。
    if (transport.onGeoOwnership) {
      transport.onGeoOwnership((e) => this.applyServerGeometry(e.id, e.owner));
    }

    // Electron 窗口：聚焦态上报（服务端据此放行手机端自动接管申请，
    // 聚焦即夺回）。web 端无此通道 —— 手机端的「注意力」就是页面可见+聚焦。
    const api = (window as { electronAPI?: { geoFocus?: (f: boolean) => void; onGeoOwnership?: (cb: (p: { id: string; owner: string }) => void) => () => void } }).electronAPI;
    if (api?.geoFocus) {
      const report = (): void => api.geoFocus?.(document.hasFocus());
      window.addEventListener('focus', report);
      window.addEventListener('blur', report);
      report();
      // 窗口关闭前避免误报聚焦
      window.addEventListener('beforeunload', () => api.geoFocus?.(false));
    }
    // Electron 端 geo 广播不经 transport（无 ws）——IPC 直连。
    if (api?.onGeoOwnership && !transport.onGeoOwnership) {
      api.onGeoOwnership((e) => this.applyServerGeometry(e.id, e.owner));
    }

    // Restore existing sessions, or create the initial tab on first boot.
    this.init().catch((err) => console.error('[Ternimal] init failed:', err));
  }

  private async init(): Promise<void> {
    const tabs = await getTransport().listTabs();
    if (tabs.length === 0) {
      await this.newTab();
    } else {
      tabs.forEach((info) => this.addTabFromInfo(info, { activate: false }));
      // Focus the most recently created session
      const last = tabs[tabs.length - 1];
      this.switchTab(last.id);
    }
  }

  async newTab(shell?: string, cwd?: string): Promise<string> {
    const info = await getTransport().createTab({ shell, cwd });
    this.addTabFromInfo(info, { activate: true, createdHere: true });
    return info.id;
  }

  /**
   * Follow mode (web viewers): attached tabs stop resizing the shared PTY.
   * Per-tab overrides persist in localStorage ('1' own / '0' follow).
   */
  setFollowMode(on: boolean): void {
    this.followMode = on;
    for (const [id, tab] of this.tabs) tab.setGeometryOwner(this.effectiveOwner(id));
  }

  /** Toggle the active tab's geometry ownership; returns the new state. */
  toggleAdapt(tabId: string | null): boolean {
    const id = tabId ?? this.activeTabId;
    if (!id) return false;
    const cur = this.effectiveOwner(id);
    const tab = this.tabs.get(id);
    if (!tab) return false;
    try {
      window.localStorage.setItem(`ternimal.adapt.${id}`, cur ? '0' : '1');
    } catch { /* private mode etc. */ }
    tab.setGeometryOwner(!cur);
    return !cur;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  /** Current geometry-ownership state of a tab (chip UI reads this). */
  isGeometryOwner(id: string): boolean {
    return this.tabs.get(id)?.geometryOwner ?? true;
  }

  /**
   * B+：服务端所有权广播落地。mine = 本端持有（原生几何）；
   * 其余一律跟随（固定网格渲染，尺寸随 tabs 广播更新）。
   */
  applyServerGeometry(id: string, owner: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const transport = getTransport();
    // 本地窗口 geoClientId='local'；web 端 = auth-ok 下发的连接 id。
    // 两端同一规则：owner === 自己的 id 才是原生几何持有方。
    const mine = owner === transport.geoClientId;
    if (mine === tab.geometryOwner) return;
    tab.setGeometryOwner(mine);
    if (!mine) {
      // 跟随渲染：固定到会话当前尺寸（后续 tabs 广播继续校正）。
      const info = this.lastTabs?.find((s) => s.id === id);
      if (info) tab.applyFollowGeometry(info.cols, info.rows);
    }
  }

  private effectiveOwner(id: string): boolean {
    if (!this.followMode) return true; // Electron window: everyone owns (unchanged)
    let override: string | null = null;
    try {
      override = window.localStorage.getItem(`ternimal.adapt.${id}`);
    } catch { /* ignore */ }
    if (override === '1') return true;
    if (override === '0') return false;
    return this.createdHere.has(id);
  }

  private addTabFromInfo(info: SessionInfo, opts: { activate: boolean; createdHere?: boolean }): void {
    if (this.tabs.has(info.id)) {
      // Dedupe vs onTabsChange echo — but a LATE activate intent (the
      // session was adopted by reconcile before createTab resolved)
      // must not be swallowed: the tab would stay hidden forever.
      // Same for geometry ownership: reconcile created it as a follower;
      // the resolved create confirms THIS client made it.
      if (opts.activate) this.switchTab(info.id);
      if (opts.createdHere) {
        this.createdHere.add(info.id);
        this.tabs.get(info.id)?.setGeometryOwner(this.effectiveOwner(info.id));
      }
      return;
    }

    const theme = this.themeManager.getCurrentTheme();
    const follower = !this.effectiveOwner(info.id);
    const tab = new TerminalTab(info, this.terminalContainer, theme, { follower });
    tab.onExit = (t) => {
      if (this.tabs.size > 1) {
        this.closeTab(t.id);
      }
    };
    tab.onTitleChange = (t, title) => {
      this.tabBar.updateTitle(t.id, title);
    };

    this.tabs.set(info.id, tab);
    this.tabBar.addTab(info.id, info.title || 'Terminal');

    // Geometry ownership (phone follow-mode, docs/phone-display-issue.md):
    // creator keeps it; attached tabs follow unless the user opts in per-tab.
    if (opts.createdHere) this.createdHere.add(info.id);
    if (follower) tab.applyFollowGeometry(info.cols, info.rows);

    // M4 TC-M4-03: a tab born from server truth (reopen/reconcile) restores
    // its scrollback from the server-side ring buffer when the transport
    // supports it. Fire-and-forget: live data flows regardless.
    const transport = getTransport();
    if (transport.getReplay) {
      transport
        .getReplay(info.id)
        .then((replay) => {
          if (replay && this.tabs.has(info.id)) tab.write(replay);
        })
        .catch(() => {
          /* replay is best-effort */
        });
    }

    if (opts.activate) {
      this.switchTab(info.id);
    } else {
      tab.hide(); // only the active tab's container is visible
    }
  }

  /** Bring local tab state in line with server truth. */
  private reconcileTabs(tabs: SessionInfo[]): void {
    this.lastTabs = tabs;
    const serverIds = new Set(tabs.map((t) => t.id));

    // Drop local tabs whose session is gone (remote close / natural exit
    // handled elsewhere). disposeTab only — the session is already dead.
    for (const id of Array.from(this.tabs.keys())) {
      if (!serverIds.has(id)) {
        this.disposeTab(id);
      }
    }

    // Adopt sessions not yet known locally (created remotely in M2).
    for (const info of tabs) {
      this.addTabFromInfo(info, { activate: false });
    }

    // Follow-mode tabs track the session's live geometry (owner resized).
    for (const info of tabs) {
      const tab = this.tabs.get(info.id);
      if (tab && !tab.geometryOwner) tab.applyFollowGeometry(info.cols, info.rows);
    }
  }

  /** B+：活跃标签变化回调（web 自动接管在新标签上重新申请所有权）。 */
  onTabActivated: ((id: string) => void) | null = null;

  switchTab(id: string): void {
    if (!this.tabs.has(id)) return;
    // P1：先更新 activeTabId 再通知——回调方（wireAutoAdapt）读
    // getActiveTabId() 时必须看到新标签页，否则切换瞬间申请的是
    // 「正在离开的」会话，把手机钉成双会话所有者。
    const previousId = this.activeTabId;
    const changed = id !== previousId;
    this.activeTabId = id;
    if (changed) this.onTabActivated?.(id);

    // Pending soft-key combos never survive a tab switch (one-shot
    // semantics belong to the tab the user is looking at).
    this.clearPendingMods();

    // Hide previous
    if (previousId && previousId !== id) {
      const current = this.tabs.get(previousId);
      if (current) current.hide();
    }
    // Remote transport requires an explicit attach before input is
    // accepted server-side; local IPC attach is a no-op.
    getTransport().attach(id);
    const tab = this.tabs.get(id);
    if (tab) {
      tab.show();
      this.tabBar.setActive(id);
    }
  }

  /** User-initiated close: kill the session, then tear down local UI. */
  closeTab(id: string): void {
    if (!this.tabs.has(id)) return;
    getTransport().closeTab(id);
    this.disposeTab(id);
  }

  // ---- soft keyboard (web only; see modifierKeys.ts) ----

  getPendingMods(): ModifierState {
    return { ...this.pendingMods };
  }

  setPendingMods(mods: ModifierState): void {
    this.pendingMods = { ...mods };
    if (this.onPendingModsChange) this.onPendingModsChange();
  }

  clearPendingMods(): void {
    if (!hasModifiers(this.pendingMods)) return;
    this.pendingMods = { ...NO_MODIFIERS };
    if (this.onPendingModsChange) this.onPendingModsChange();
  }

  /** Direct key tap (Esc/Tab buttons): mapped under pending mods, sent to
   *  the ACTIVE tab, and always consumes the pending combo. */
  sendDirect(data: string): void {
    if (!this.activeTabId) return;
    const r = applyModifiers(data, this.pendingMods);
    getTransport().input(this.activeTabId, r.data);
    this.clearPendingMods();
  }

  /** Arrow-key tap: sequence honors pending modifiers and the active tab's
   *  cursor mode (DECCKM — vim/less switch to SS3 arrows). */
  sendArrow(dir: ArrowDirection): void {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    const appCursor = tab ? tab.wrapper.isApplicationCursorMode() : false;
    getTransport().input(this.activeTabId, arrowSequence(dir, this.pendingMods, appCursor));
    this.clearPendingMods();
  }

  /** Local-only teardown: unsubscribe, remove DOM, fix active tab. */
  private disposeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    tab.dispose();
    this.tabs.delete(id);
    this.tabBar.removeTab(id);

    // Switch to another tab if we disposed the active one
    if (this.activeTabId === id) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
        // No tabs left - create a new one
        this.newTab().catch((err) => console.error('[Ternimal] newTab failed:', err));
      }
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Ctrl+Shift+T: New tab
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      this.newTab().catch((err) => console.error('[Ternimal] newTab failed:', err));
      return;
    }

    // Ctrl+W: Close tab
    if (e.ctrlKey && !e.shiftKey && e.key === 'w') {
      e.preventDefault();
      if (this.activeTabId) {
        this.closeTab(this.activeTabId);
      }
      return;
    }

    // Ctrl+Tab: Next tab
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = Array.from(this.tabs.keys());
      const currentIdx = ids.indexOf(this.activeTabId || '');
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + ids.length) % ids.length
        : (currentIdx + 1) % ids.length;
      this.switchTab(ids[nextIdx]);
      return;
    }

    // Ctrl+Shift+F: Search
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
      if (tab) {
        this.searchBar.toggle(tab.wrapper);
      }
      return;
    }

    // Ctrl+Shift+L: Toggle theme
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      e.preventDefault();
      const current = this.themeManager.getCurrentThemeName();
      this.themeManager.setTheme(current === 'dark' ? 'light' : 'dark');
      return;
    }
  }
}
