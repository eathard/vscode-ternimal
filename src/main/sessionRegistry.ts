// SessionRegistry (technical design §2.2) — the server-side owner of terminal
// sessions. Lives in the Electron main process; the local window and (M2)
// remote WebSocket clients are mere consumers of its events.
//
// Responsibilities:
//   - generate authoritative session IDs (format tab-{timestamp}-{counter})
//   - own PTY lifecycle via a PtyHost (default: the existing PtyManager)
//   - mirror every output chunk into a per-session RingBuffer for replay
//   - resize: last-writer-wins, leading edge immediate + 200ms trailing
//   - title tracking: 1s polling of pty.process (fixes the never-scheduled
//     checkTitle bug from ptyManager.ts)
//   - 'tabs' broadcast, leading+trailing throttled to 500ms

import { EventEmitter } from 'events';
import { RingBuffer } from './ringBuffer';
import {
  SpawnRequest,
  SessionInfo,
  DataPayload,
  ExitPayload,
  TitlePayload,
} from '../shared/ipcChannels';

/** Minimal structural surface of a PTY that a session needs. */
export interface MinimalPty {
  pid: number;
  process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * The PTY lifecycle host the registry drives. The existing PtyManager
 * satisfies this structurally (including the ConPTY kill-timeout guard we
 * must preserve); verification scripts inject an in-memory fake.
 */
export type PtyHost = EventEmitter & {
  spawn(request: SpawnRequest): MinimalPty;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  killAll(): void;
};

interface SessionEntry {
  info: SessionInfo;
  pty: MinimalPty;
  buffer: RingBuffer;
  pendingResize: { cols: number; rows: number } | null;
  resizeTimer: NodeJS.Timeout | null;
}

const TABS_THROTTLE_MS = 500;
const RESIZE_DEBOUNCE_MS = 200;
const TITLE_POLL_MS = 1000;
const DEFAULT_REPLAY_BYTES = 1024 * 1024;

// Stale terminal-capability QUERIES captured in a replay buffer must not be
// re-delivered to a fresh xterm: xterm auto-answers them (e.g. DA1 "ESC[c"
// -> "ESC[?1;2c"), and that answer is injected as PTY input — visible as
// junk like "1;2c" typed into the running program (bash echo; Claude Code
// sends DA/XTVERSION/OSC-color queries on startup, so refresh used to
// reproduce this every time). Strip every known query form at replay time.
// (Responses never occur in the buffer: it mirrors PTY OUTPUT only.)
const STALE_QUERY_PATTERNS: RegExp[] = [
  /\x1b\[[0-9;]*c/g, // Primary DA (incl. "ESC[c")
  /\x1b\[>[0-9;]*c/g, // Secondary DA
  /\x1b\[>[0-9;]*q/g, // XTVERSION (DCS-form answer would confuse parsers)
  /\x1b\[[0-9]*n/g, // DSR (incl. cursor-position request "ESC[6n")
  /\x1b\[\??[0-9;]*\$p/g, // DECRQM
  /\x1b\](10|11|12);\?[^\x07\x1b]*(\x07|\x1b\\)/g, // OSC color QUERY
];

function sanitizeReplay(data: string): string {
  let out = data;
  for (const re of STALE_QUERY_PATTERNS) out = out.replace(re, '');
  return out;
}

export interface SessionRegistryOptions {
  /** Injectable PTY host (tests pass a fake; default = PtyManager). */
  ptyHost?: PtyHost;
  /** Per-session replay buffer cap in bytes. */
  replayBytes?: number;
}

export class SessionRegistry extends EventEmitter {
  private sessions: Map<string, SessionEntry> = new Map();
  private ptyHost: PtyHost;
  private replayBytes: number;
  private counter = 0;
  private titleTimer: NodeJS.Timeout | null = null;
  private tabsTimer: NodeJS.Timeout | null = null;
  private tabsDirty = false;

  constructor(options: SessionRegistryOptions = {}) {
    super();
    this.ptyHost = options.ptyHost ?? createDefaultPtyHost();
    this.replayBytes = options.replayBytes ?? DEFAULT_REPLAY_BYTES;

    this.ptyHost.on('data', (payload: DataPayload) => {
      const entry = this.sessions.get(payload.id);
      if (entry) {
        entry.buffer.append(payload.data);
        this.emit('data', payload);
      }
    });

    this.ptyHost.on('exit', (payload: ExitPayload) => {
      // Natural exit path; kill() removes the entry first, so a late exit
      // event after kill is ignored here (exactly-once semantics).
      this.removeSession(payload.id, payload.exitCode ?? 0);
    });
  }

  /** Create a session; returns the authoritative SessionInfo. */
  create(request: SpawnRequest): SessionInfo {
    const id = `tab-${Date.now()}-${++this.counter}`;
    if (process.env.TERNIMAL_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[Registry:debug] spawning pty for ${id}...`);
    }
    const info: SessionInfo = {
      id,
      title: 'Terminal',
      pid: 0,
      cols: request.cols || 80,
      rows: request.rows || 24,
      shell: request.shell,
      cwd: request.cwd,
      createdAt: Date.now(),
    };
    const ptyProcess = this.ptyHost.spawn({ ...request, id });
    if (process.env.TERNIMAL_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[Registry:debug] spawn returned pid=${ptyProcess.pid}`);
    }
    info.pid = ptyProcess.pid;

    this.sessions.set(id, {
      info,
      pty: ptyProcess,
      buffer: new RingBuffer(this.replayBytes),
      pendingResize: null,
      resizeTimer: null,
    });
    this.startTitlePolling();
    this.scheduleTabs();
    return info;
  }

  write(id: string, data: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      this.ptyHost.write(id, data);
    }
  }

  /**
   * Resize with last-writer-wins + debounce: first call applies immediately
   * (keeps local drag UX snappy), calls within the debounce window coalesce
   * into one trailing apply of the latest dimensions. Values clamped to >= 1.
   */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.sessions.get(id);
    if (!entry) return;

    entry.pendingResize = { cols, rows };
    if (entry.resizeTimer) return; // trailing apply already scheduled

    this.applyResize(id, entry);
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = null;
      if (entry.pendingResize) this.applyResize(id, entry);
    }, RESIZE_DEBOUNCE_MS);
  }

  /** Kill a session and emit a synthetic exit (real pty exit is ignored later). */
  kill(id: string): void {
    this.removeSession(id, 0);
    this.ptyHost.kill(id);
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((e) => ({ ...e.info }));
  }

  /** Replay snapshot for attach flows (M2 remote, M4 window reopen). */
  getReplay(id: string): string {
    return sanitizeReplay(this.sessions.get(id)?.buffer.snapshot() ?? '');
  }

  dispose(): void {
    if (this.titleTimer) clearTimeout(this.titleTimer);
    if (this.tabsTimer) clearTimeout(this.tabsTimer);
    this.sessions.forEach((entry) => {
      if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    });
  }

  // ---- internals ----

  private applyResize(id: string, entry: SessionEntry): void {
    const pending = entry.pendingResize;
    if (!pending) return;
    // Guard against zero/negative dimensions (from VS Code terminalProcess.ts:532-568)
    // P2：上界钳制（1..1000）——1e9 传给 node-pty 的 ioctl/ConPTY 会被
    // 截断为 unsigned short（可能归零），TUI 状态直接损坏。
    const cols = Math.min(Math.max(pending.cols, 1), 1000);
    const rows = Math.min(Math.max(pending.rows, 1), 1000);
    entry.pendingResize = null;
    if (cols === entry.info.cols && rows === entry.info.rows) return;

    entry.info.cols = cols;
    entry.info.rows = rows;
    this.ptyHost.resize(id, cols, rows);
    this.scheduleTabs();
  }

  private removeSession(id: string, exitCode: number): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    this.sessions.delete(id);
    if (this.sessions.size === 0 && this.titleTimer) {
      clearInterval(this.titleTimer);
      this.titleTimer = null;
    }
    this.emit('exit', { id, exitCode } as ExitPayload);
    this.scheduleTabs();
  }

  private startTitlePolling(): void {
    if (this.titleTimer || process.env.TERNIMAL_NO_TITLE_POLL) return;
    this.titleTimer = setInterval(() => {
      let changed = false;
      this.sessions.forEach((entry, id) => {
        let current: string;
        try {
          current = entry.pty.process;
        } catch {
          return; // PTY may be mid-teardown
        }
        if (current && current !== entry.info.title) {
          entry.info.title = current;
          this.emit('title', { id, title: current } as TitlePayload);
          changed = true;
        }
      });
      if (changed) this.scheduleTabs();
    }, TITLE_POLL_MS);
  }

  /**
   * Leading+trailing throttle: emit immediately when idle, coalesce bursts
   * into one trailing emit at most every TABS_THROTTLE_MS.
   */
  private scheduleTabs(): void {
    if (this.tabsTimer) {
      this.tabsDirty = true;
      return;
    }
    this.emitTabsNow();
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = null;
      if (this.tabsDirty) this.scheduleTabs();
    }, TABS_THROTTLE_MS);
  }

  private emitTabsNow(): void {
    this.tabsDirty = false;
    if (process.env.TERNIMAL_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[Registry:debug] emit tabs n=${this.sessions.size}`);
    }
    this.emit('tabs', this.list());
  }
}

/**
 * Lazy default host construction. `require` (not import) keeps node-pty out
 * of the module-load graph so plain-node verification scripts can inject a
 * fake host without touching the Electron-ABI native module.
 */
function createDefaultPtyHost(): PtyHost {
  const { PtyManager } = require('./ptyManager');
  return new PtyManager() as PtyHost;
}
