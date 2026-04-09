import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';

export interface IXtermWrapper {
  terminal: Terminal;
  attachToDom(container: HTMLElement): void;
  write(data: string): void;
  focus(): void;
  dispose(): void;
  getDimensions(): { cols: number; rows: number };
  onResize: (callback: (cols: number, rows: number) => void) => void;
  onData: (callback: (data: string) => void) => void;
  searchAddon: SearchAddon;
}

export class XtermWrapper implements IXtermWrapper {
  readonly terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon: WebglAddon | null = null;
  readonly searchAddon: SearchAddon;
  private unicode11Addon: Unicode11Addon;
  private resizeCallbacks: ((cols: number, rows: number) => void)[] = [];
  private dataCallbacks: ((data: string) => void)[] = [];
  private static webglFailed = false;

  constructor(options?: {
    cols?: number;
    rows?: number;
    theme?: Record<string, string>;
  }) {
    this.terminal = new Terminal({
      cols: options?.cols || 80,
      rows: options?.rows || 24,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Cascadia Code, Fira Code, Consolas, Courier New, monospace',
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.2,
      scrollback: 5000,
      allowProposedApi: true,
      allowTransparency: false,
      theme: options?.theme as any,
      wordSeparator: ' ()[]{}\'\"`,;:|',
    });

    // Core addons - always loaded
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.unicode11Addon = new Unicode11Addon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(this.unicode11Addon);

    // Enable unicode version
    this.terminal.unicode.activeVersion = '11';

    // Wire data callback
    this.terminal.onData((data) => {
      this.dataCallbacks.forEach((cb) => cb(data));
    });
  }

  attachToDom(container: HTMLElement): void {
    this.terminal.open(container);

    // Try WebGL renderer with fallback (pattern from VS Code xtermTerminal.ts:835-872)
    if (!XtermWrapper.webglFailed) {
      this.enableWebgl();
    }

    // Initial fit
    this.fitAddon.fit();

    // Right-click copy/paste
    this.terminal.element?.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      if (this.terminal.hasSelection()) {
        window.electronAPI.clipboardWrite(this.terminal.getSelection());
        this.terminal.clearSelection();
      } else {
        window.electronAPI.clipboardRead().then((text: string) => {
          if (text) {
            this.terminal.paste(text);
          }
        });
      }
    });

    // Listen for container resize
    const resizeObserver = new ResizeObserver(() => {
      this.refit();
    });
    resizeObserver.observe(container);

    // Listen for terminal resize events (from fitAddon)
    this.terminal.onResize(({ cols, rows }) => {
      this.resizeCallbacks.forEach((cb) => cb(cols, rows));
    });
  }

  private enableWebgl(): void {
    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss(() => {
        this.disposeWebgl();
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch {
      XtermWrapper.webglFailed = true;
      this.disposeWebgl();
    }
  }

  private disposeWebgl(): void {
    if (this.webglAddon) {
      try {
        this.webglAddon.dispose();
      } catch {
        // Already disposed
      }
      this.webglAddon = null;
    }
  }

  private refit(): void {
    try {
      this.fitAddon.fit();
    } catch {
      // Terminal not ready yet
    }
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  focus(): void {
    this.terminal.focus();
  }

  dispose(): void {
    this.disposeWebgl();
    this.terminal.dispose();
  }

  getDimensions(): { cols: number; rows: number } {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  onResize(callback: (cols: number, rows: number) => void): void {
    this.resizeCallbacks.push(callback);
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  applyTheme(theme: Record<string, string>): void {
    this.terminal.options.theme = theme as any;
  }

  updateOptions(options: Record<string, any>): void {
    Object.assign(this.terminal.options, options);
  }
}
