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
import {
  ModifierState,
  NO_MODIFIERS,
  applyModifiers,
  hasModifiers,
} from '../shared/modifierKeys';

export class TerminalApp {
  private tabs: Map<string, TerminalTab> = new Map();
  private activeTabId: string | null = null;
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
    this.addTabFromInfo(info, { activate: true });
    return info.id;
  }

  private addTabFromInfo(info: SessionInfo, opts: { activate: boolean }): void {
    if (this.tabs.has(info.id)) {
      // Dedupe vs onTabsChange echo — but a LATE activate intent (the
      // session was adopted by reconcile before createTab resolved)
      // must not be swallowed: the tab would stay hidden forever.
      if (opts.activate) this.switchTab(info.id);
      return;
    }

    const theme = this.themeManager.getCurrentTheme();
    const tab = new TerminalTab(info, this.terminalContainer, theme);
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
  }

  switchTab(id: string): void {
    if (!this.tabs.has(id)) return;

    // Pending soft-key combos never survive a tab switch (one-shot
    // semantics belong to the tab the user is looking at).
    this.clearPendingMods();

    // Hide current
    if (this.activeTabId) {
      const current = this.tabs.get(this.activeTabId);
      if (current) current.hide();
    }

    // Show new
    this.activeTabId = id;
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
