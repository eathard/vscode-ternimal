// TerminalTab (M1 refactor): one tab = one xterm bound to a server-side
// session. The session is created by TerminalApp via transport.createTab();
// this class only wires UI ⇄ transport streams. No window.electronAPI use.
import { SessionInfo } from '../shared/ipcChannels';
import { getTransport } from './transport';
import { XtermWrapper } from './xtermWrapper';

// Optional input transform (web soft-keyboard modifier mapping, one-shot
// Ctrl/Alt/Shift combos). Set by TerminalApp once; null locally.
let inputTransform: ((data: string) => string) | null = null;

export function setInputTransform(fn: ((data: string) => string) | null): void {
  inputTransform = fn;
}

export class TerminalTab {
  readonly id: string;
  readonly wrapper: XtermWrapper;
  readonly container: HTMLElement;
  private title: string;
  private alive: boolean = true;
  /** Geometry owner: may resize the shared PTY. Viewers (follow mode) may not. */
  geometryOwner = true;

  /** Switch geometry ownership; taking ownership immediately syncs our size. */
  setGeometryOwner(owner: boolean): void {
    this.geometryOwner = owner;
    if (owner) {
      this.wrapper.clearFixedGeometry();
      if (this.alive) {
        const dims = this.wrapper.getDimensions();
        getTransport().resize(this.id, dims.cols, dims.rows);
      }
    }
  }

  /** Follow-mode rendering geometry = the session's own PTY size. */
  applyFollowGeometry(cols: number, rows: number): void {
    if (!this.geometryOwner) this.wrapper.setFixedGeometry(cols, rows);
  }
  private unsubs: (() => void)[] = [];

  onExit: ((tab: TerminalTab) => void) | null = null;
  onTitleChange: ((tab: TerminalTab, title: string) => void) | null = null;
  /** True once any output (live or replay) has been written — replay guard. */
  hasOutput = false;

  constructor(
    info: SessionInfo,
    parentContainer: HTMLElement,
    theme?: Record<string, string>,
    opts?: { follower?: boolean }
  ) {
    this.id = info.id;
    this.title = info.title || 'Terminal';
    // Follower flag must be set BEFORE attachToDom: the initial fit inside
    // attach fires onResize synchronously — a follower must never send it.
    this.geometryOwner = !opts?.follower;

    // Create wrapper
    this.wrapper = new XtermWrapper({ theme });

    // Create DOM container
    this.container = document.createElement('div');
    this.container.className = 'terminal-instance';
    this.container.dataset.tabId = this.id;
    parentContainer.appendChild(this.container);

    // Attach xterm to DOM
    this.wrapper.attachToDom(this.container);

    const transport = getTransport();

    // Wire bidirectional data flow (VS Code terminalInstance.ts:856-862 pattern)
    // xterm -> session (user input; passes the soft-keyboard transform)
    this.wrapper.onData((data) => {
      if (this.alive) {
        transport.input(this.id, inputTransform ? inputTransform(data) : data);
      }
    });

    // session -> xterm (shell output), filtered by id (broadcast semantics)
    this.unsubs.push(
      transport.onData((payload) => {
        if (payload.id === this.id) {
          this.hasOutput = true;
          this.wrapper.write(payload.data);
        }
      })
    );

    // session exit
    this.unsubs.push(
      transport.onExit((payload) => {
        if (payload.id === this.id) {
          this.alive = false;
          this.wrapper.write(`\r\n[Process exited with code ${payload.exitCode}]\r\n`);
          if (this.onExit) {
            this.onExit(this);
          }
        }
      })
    );

    // session title
    this.unsubs.push(
      transport.onTitle((payload) => {
        if (payload.id === this.id) {
          this.title = payload.title;
          if (this.onTitleChange) {
            this.onTitleChange(this, payload.title);
          }
        }
      })
    );

    // xterm resize -> session (fit fires right after attachToDom, syncing
    // the registry's initial 80x24 to the real viewport).
    // Geometry ownership (phone follow-mode): followers render the shared
    // stream at their own fitted width but NEVER resize the PTY — rotation
    // and keyboard-open stay pure display changes on the viewer.
    this.wrapper.onResize((cols, rows) => {
      if (this.alive && this.geometryOwner) {
        transport.resize(this.id, cols, rows);
      }
    });
  }

  getTitle(): string {
    return this.title;
  }

  /** Write scrollback/history directly (M4 replay restore on reopen). */
  write(data: string): void {
    if (data) this.hasOutput = true;
    this.wrapper.write(data);
  }

  /** P2：重连补齐——重置渲染状态后全量重写回放（服务端环形缓冲）。 */
  reset(): void {
    this.hasOutput = false;
    this.wrapper.reset();
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

  /** Local UI teardown only — session kill is TerminalApp's decision. */
  dispose(): void {
    this.alive = false;
    this.unsubs.forEach((unsub) => unsub());
    this.wrapper.dispose();
    this.container.remove();
  }
}
