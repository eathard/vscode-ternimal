import { XtermWrapper } from './xtermWrapper';

declare global {
  interface Window {
    electronAPI: {
      ptySpawn: (request: { id: string; shell?: string; cwd?: string; cols: number; rows: number }) => Promise<{ pid: number }>;
      ptyWrite: (id: string, data: string) => void;
      ptyResize: (id: string, cols: number, rows: number) => void;
      ptyKill: (id: string) => void;
      onPtyData: (callback: (payload: { id: string; data: string }) => void) => () => void;
      onPtyExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
      onPtyTitle: (callback: (payload: { id: string; title: string }) => void) => () => void;
      getDefaultShell: () => Promise<string>;
      clipboardWrite: (text: string) => void;
      clipboardRead: () => Promise<string>;
    };
  }
}

export class TerminalTab {
  readonly id: string;
  readonly wrapper: XtermWrapper;
  readonly container: HTMLElement;
  private title: string = 'Terminal';
  private alive: boolean = true;
  private unsubs: (() => void)[] = [];

  onExit: ((tab: TerminalTab) => void) | null = null;
  onTitleChange: ((tab: TerminalTab, title: string) => void) | null = null;

  constructor(
    id: string,
    parentContainer: HTMLElement,
    theme?: Record<string, string>,
    shell?: string,
    cwd?: string
  ) {
    this.id = id;

    // Create wrapper
    this.wrapper = new XtermWrapper({ theme });

    // Create DOM container
    this.container = document.createElement('div');
    this.container.className = 'terminal-instance';
    this.container.dataset.tabId = id;
    parentContainer.appendChild(this.container);

    // Attach xterm to DOM
    this.wrapper.attachToDom(this.container);

    // Wire bidirectional data flow (VS Code terminalInstance.ts:856-862 pattern)
    // xterm -> PTY (user input)
    this.wrapper.onData((data) => {
      if (this.alive) {
        window.electronAPI.ptyWrite(id, data);
      }
    });

    // PTY -> xterm (shell output)
    const unsubData = window.electronAPI.onPtyData((payload) => {
      if (payload.id === id) {
        this.wrapper.write(payload.data);
      }
    });
    this.unsubs.push(unsubData);

    // PTY exit
    const unsubExit = window.electronAPI.onPtyExit((payload) => {
      if (payload.id === id) {
        this.alive = false;
        this.wrapper.write(`\r\n[Process exited with code ${payload.exitCode}]\r\n`);
        if (this.onExit) {
          this.onExit(this);
        }
      }
    });
    this.unsubs.push(unsubExit);

    // PTY title
    const unsubTitle = window.electronAPI.onPtyTitle((payload) => {
      if (payload.id === id) {
        this.title = payload.title;
        if (this.onTitleChange) {
          this.onTitleChange(this, payload.title);
        }
      }
    });
    this.unsubs.push(unsubTitle);

    // Resize -> PTY
    this.wrapper.onResize((cols, rows) => {
      if (this.alive) {
        window.electronAPI.ptyResize(id, cols, rows);
      }
    });

    // Spawn the PTY process
    const dims = this.wrapper.getDimensions();
    window.electronAPI.ptySpawn({
      id,
      shell,
      cwd,
      cols: dims.cols,
      rows: dims.rows,
    }).catch((err) => {
      console.error('[Ternimal] PTY spawn failed:', err);
    });
  }

  getTitle(): string {
    return this.title;
  }

  show(): void {
    this.container.style.display = 'block';
    this.wrapper.focus();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  focus(): void {
    this.wrapper.focus();
  }

  dispose(): void {
    this.alive = false;
    this.unsubs.forEach((unsub) => unsub());
    window.electronAPI.ptyKill(this.id);
    this.wrapper.dispose();
    this.container.remove();
  }
}
