import { TerminalTab } from './terminalTab';
import { TabBar } from './tabBar';
import { SearchBar } from './searchBar';
import { ThemeManager } from './themeManager';

let tabCounter = 0;

function generateId(): string {
  return `tab-${Date.now()}-${++tabCounter}`;
}

export class TerminalApp {
  private tabs: Map<string, TerminalTab> = new Map();
  private activeTabId: string | null = null;
  private tabBar: TabBar;
  private searchBar: SearchBar;
  private themeManager: ThemeManager;
  private terminalContainer: HTMLElement;

  constructor(root: HTMLElement) {
    // Theme manager
    this.themeManager = new ThemeManager();

    // Apply initial theme to body
    const theme = this.themeManager.getCurrentTheme();
    document.body.style.backgroundColor = theme.background || '#1e1e1e';

    // Tab bar
    this.tabBar = new TabBar(root);
    this.tabBar.onTabSelect = (id) => this.switchTab(id);
    this.tabBar.onTabClose = (id) => this.closeTab(id);
    this.tabBar.onNewTab = () => this.newTab();

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

    // Create initial tab
    this.newTab();
  }

  newTab(shell?: string, cwd?: string): string {
    const id = generateId();
    const theme = this.themeManager.getCurrentTheme();

    const tab = new TerminalTab(id, this.terminalContainer, theme, shell, cwd);
    tab.onExit = (t) => {
      if (this.tabs.size > 1) {
        this.closeTab(t.id);
      }
    };
    tab.onTitleChange = (t, title) => {
      this.tabBar.updateTitle(t.id, title);
    };

    this.tabs.set(id, tab);
    this.tabBar.addTab(id, 'Terminal');
    this.switchTab(id);

    return id;
  }

  switchTab(id: string): void {
    if (!this.tabs.has(id)) return;

    // Hide current
    if (this.activeTabId) {
      const current = this.tabs.get(this.activeTabId);
      if (current) current.hide();
    }

    // Show new
    this.activeTabId = id;
    const tab = this.tabs.get(id);
    if (tab) {
      tab.show();
      this.tabBar.setActive(id);
    }
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    tab.dispose();
    this.tabs.delete(id);
    this.tabBar.removeTab(id);

    // Switch to another tab if we closed the active one
    if (this.activeTabId === id) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
        // No tabs left - create a new one
        this.newTab();
      }
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Ctrl+Shift+T: New tab
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      this.newTab();
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
