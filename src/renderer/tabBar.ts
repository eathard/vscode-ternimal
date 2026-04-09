export class TabBar {
  private container: HTMLElement;
  private tabsContainer: HTMLElement;
  private addButton: HTMLElement;
  private tabElements: Map<string, HTMLElement> = new Map();
  private activeTabId: string | null = null;

  onTabSelect: ((id: string) => void) | null = null;
  onTabClose: ((id: string) => void) | null = null;
  onNewTab: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'tab-bar';

    this.tabsContainer = document.createElement('div');
    this.tabsContainer.className = 'tab-bar-tabs';

    this.addButton = document.createElement('button');
    this.addButton.className = 'tab-bar-add';
    this.addButton.textContent = '+';
    this.addButton.title = 'New Terminal (Ctrl+Shift+T)';
    this.addButton.addEventListener('click', () => {
      if (this.onNewTab) this.onNewTab();
    });

    this.container.appendChild(this.tabsContainer);
    this.container.appendChild(this.addButton);
    parent.appendChild(this.container);
  }

  addTab(id: string, title: string): void {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab-bar-tab';
    tabEl.dataset.tabId = id;

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-bar-tab-title';
    titleEl.textContent = title;

    const closeEl = document.createElement('button');
    closeEl.className = 'tab-bar-tab-close';
    closeEl.textContent = 'x';
    closeEl.title = 'Close (Ctrl+W)';
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onTabClose) this.onTabClose(id);
    });

    tabEl.appendChild(titleEl);
    tabEl.appendChild(closeEl);

    tabEl.addEventListener('click', () => {
      if (this.onTabSelect) this.onTabSelect(id);
    });

    this.tabsContainer.appendChild(tabEl);
    this.tabElements.set(id, tabEl);
  }

  removeTab(id: string): void {
    const tabEl = this.tabElements.get(id);
    if (tabEl) {
      tabEl.remove();
      this.tabElements.delete(id);
    }
    if (this.activeTabId === id) {
      this.activeTabId = null;
    }
  }

  setActive(id: string): void {
    if (this.activeTabId) {
      const prev = this.tabElements.get(this.activeTabId);
      if (prev) prev.classList.remove('active');
    }
    this.activeTabId = id;
    const current = this.tabElements.get(id);
    if (current) current.classList.add('active');
  }

  updateTitle(id: string, title: string): void {
    const tabEl = this.tabElements.get(id);
    if (tabEl) {
      const titleEl = tabEl.querySelector('.tab-bar-tab-title');
      if (titleEl) titleEl.textContent = title;
    }
  }
}
