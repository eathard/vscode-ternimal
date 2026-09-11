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
    // 2026-09-11 复盘（docs/phone-display-issue.md）：曾在此对手机/触屏
    // 一律禁用 WebGL 改走 DOM 渲染器——实测这是误伤。真正的移动端乱码
    // 根因是共享会话几何（跟随模式已修），而 WebGL 的画布字形光栅化能
    // 保留彩色 emoji 字形（claude 的黄色 ✳），DOM 文本路径在手机字体栈
    // 下会把 U+2733 解析成单色字形=「图标变灰白」回归。故恢复 v1.1 的
    // 行为：所有端优先 WebGL，初始化失败仍走 webglFailed 静态降级。
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
    if (this.fixedGeometry) {
      this.applyFollowScale();
      return;
    }
    try {
      this.fitAddon.fit();
    } catch {
      // Terminal not ready yet
    }
  }

  // ---- 观看端跟随几何（docs/phone-display-issue.md）----
  // TUI（vim/claude/htop）按 PTY 列宽做绝对光标定位：观看端若按自己的窄屏
  // 折行渲染，光标序列会落在错误位置=花屏。跟随模式因此固定使用会话自身
  // 的 cols/rows 渲染，仅对画面整体 transform:scale 适配屏幕——旋转/键盘
  // 弹出都只是重新算缩放系数，PTY 与 xterm 几何均不动。
  private fixedGeometry = false;

  /** 固定为会话几何（跟随模式）。 */
  setFixedGeometry(cols: number, rows: number): void {
    this.fixedGeometry = true;
    try {
      if (this.terminal.cols !== cols || this.terminal.rows !== rows) {
        this.terminal.resize(cols, rows);
      }
      this.applyFollowScale();
    } catch {
      /* terminal not ready yet */
    }
  }

  /** 解除固定（接管几何）：恢复 fit 行为。 */
  clearFixedGeometry(): void {
    this.fixedGeometry = false;
    const el = this.terminal.element;
    if (el) {
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.width = '';
    }
    this.refit();
  }

  private applyFollowScale(): void {
    const el = this.terminal.element;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    // 根元素宽度跟随容器（100%），真实自然尺寸在 .xterm-screen（cols×行高）。
    // 先把根宽固定为自然宽，再整体缩放——否则缩的是容器宽而非内容宽。
    const screen = el.querySelector<HTMLElement>('.xterm-screen');
    const natW = screen?.offsetWidth || el.offsetWidth || 1;
    const natH = screen?.offsetHeight || el.offsetHeight || 1;
    const k = Math.min(parent.clientWidth / natW, parent.clientHeight / natH);
    const scale = Math.max(0.15, Math.min(1, k));
    el.style.width = scale < 1 ? `${natW}px` : '';
    el.style.transformOrigin = '0 0';
    el.style.transform = scale < 1 ? `scale(${scale})` : '';
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
