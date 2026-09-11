import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { getTransport } from './transport';

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

    // Right-click copy/paste — via the transport seam so the web client
    // (M2) gets clipboard behavior too, not just Electron.
    this.terminal.element?.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      // Resolved lazily: transport is installed by the entry point before
      // user interaction, and this keeps module-load order forgiving.
      const transport = getTransport();
      if (this.terminal.hasSelection()) {
        transport.clipboardWrite(this.terminal.getSelection());
        this.terminal.clearSelection();
      } else {
        transport.clipboardRead().then((text: string) => {
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
    // 手机/触屏端强制 DOM 渲染器：WebGL 画布在移动端常见三类故障——
    // 键盘弹出引发的 resize 重排竞态（画面撕裂/错位）、GPU 频繁回收 WebGL
    // 上下文（闪烁/花屏）、高分屏 devicePixelRatio 缩放残影。DOM 渲染器在
    // 这些场景像素级稳定，小屏幕性能完全够用（390px 视口实测内容完整）。
    try {
      const coarse =
        typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      const mobileUA = /Android|iPhone|iPad|Mobile|HarmonyOS/i.test(navigator.userAgent);
      if (coarse || mobileUA) {
        XtermWrapper.webglFailed = true; // 本会话后续终端也不再尝试 WebGL
        return;
      }
    } catch {
      /* 检测失败则维持原策略（尝试 WebGL） */
    }
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

  /** DECCKM state — soft-keyboard arrows send SS3 sequences when the
   *  running program (vim/less/htop…) switched to application cursor mode. */
  isApplicationCursorMode(): boolean {
    try {
      return this.terminal.modes.applicationCursorKeysMode === true;
    } catch {
      return false;
    }
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
