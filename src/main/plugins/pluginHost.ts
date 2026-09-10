// PluginHost (WBS-R2-A) — relay 插件的进程宿主。
//
// 隔离承诺（relay-design §4.1）：插件逻辑全部运行于 Electron
// utilityProcess 子进程，主进程只收发消息；关闭 = kill 子进程（超时强杀），
// socket 清理与代码卸载由 OS 一次完成；主进程退出时 utilityProcess 自动
// 跟随死亡（另挂 will-quit 兜底 + fork 模式的 disconnect 孤儿保护）。
//
// 崩溃韧性（TC-R2-07）：子进程意外退出 → 指数退避自动重启重连；
// 控制通道断链由插件子进程内部退避重连（TC-R2-08）。

import { utilityProcess, type UtilityProcess, app } from 'electron';

/** NODE_EXTRA_CA_CERTS 合并语义（多个来源用冒号拼接，保留既有值）。 */
function caEnvSet(env: NodeJS.ProcessEnv, caPath: string): void {
  const cur = env.NODE_EXTRA_CA_CERTS ?? '';
  if (cur.split(path.delimiter).includes(caPath)) return;
  env.NODE_EXTRA_CA_CERTS = cur ? `${cur}${path.delimiter}${caPath}` : caPath;
}
import * as path from 'path';
import { EventEmitter } from 'events';

export interface RelayPluginConfig {
  relayUrl: string;
  masterCode: string;
  localPort: number;
  /** 自签 relay 根证书 PEM（子进程 NODE_EXTRA_CA_CERTS 用）；空 = 公共 CA */
  caPath: string;
  /** 本机自签证书 SHA-256 指纹（colon-hex）；空 = 跳过钉扎（仅开发）。 */
  fingerprint: string;
}

export type RelayPluginState =
  | 'stopped'
  | 'starting'
  | 'registered'
  | 'reconnecting';

export interface RelayStatusEvent {
  state: RelayPluginState;
  detail: string;
  pipes: number;
  /** 插件子进程 pid（0 = 未知；崩溃重启观测用）。 */
  pid: number;
}

/** 插件子进程上报事件的父进程侧视图。 */
export interface RelayPluginEvents extends EventEmitter {
  on(event: 'status', listener: (e: RelayStatusEvent) => void): this;
  on(event: 'stopped', listener: () => void): this;
  emit(event: 'status', e: RelayStatusEvent): boolean;
  emit(event: 'stopped'): boolean;
}

export class RelayPluginHost extends (EventEmitter as new () => RelayPluginEvents) {
  private child: UtilityProcess | null = null;
  private cfg: RelayPluginConfig | null = null;
  private state: RelayPluginState = 'stopped';
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastPid = 0;
  private reqSeq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  get currentState(): RelayPluginState {
    return this.state;
  }

  /** 解析插件模块路径：打包形态优先，dev 回退到仓库源码。 */
  static modulePath(): string {
    const appPath = app.getAppPath();
    const candidates = [
      path.join(appPath, 'dist', 'plugins', 'relayPlugin.mjs'),
      path.join(appPath, 'relay', 'src', 'plugin', 'relayPlugin.mjs'),
    ];
    // 同步探测不可用于 asar 内文件存在性？app.getAppPath 下 fs 可用（asar 透明）。
    const fs = require('fs') as typeof import('fs');
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* asar/权限异常 → 试下一个 */
      }
    }
    return candidates[0];
  }

  start(cfg: RelayPluginConfig): void {
    if (this.child) return;
    this.cfg = cfg;
    this.stopping = false;
    this.spawn();
  }

  private spawn(): void {
    if (!this.cfg) return;
    this.state = 'starting';
    const childEnv = { ...process.env };
    if (this.cfg?.caPath) {
      // 自签 relay（如 Caddy internal CA）：子进程 Node 信任该根证书
      caEnvSet(childEnv, this.cfg.caPath);
    }
    const child = utilityProcess.fork(RelayPluginHost.modulePath(), [], {
      serviceName: 'ternimal-relay-plugin',
      stdio: 'inherit',
      env: childEnv,
    });
    this.child = child;

    child.on('message', (msg: Record<string, unknown>) => this.onChildMessage(msg));
    child.once('exit', (code) => {
      this.child = null;
      this.rejectAllPending(new Error(`relay plugin exited (${code})`));
      if (this.stopping) {
        this.setState('stopped', `exit ${code}`);
        this.emit('stopped');
        return;
      }
      // 崩溃韧性：退避重启（1s → 30s 封顶，抖动）
      this.restartAttempts += 1;
      const delay = Math.min(1000 * 2 ** (this.restartAttempts - 1), 30_000) * (0.7 + Math.random() * 0.6);
      this.setState('reconnecting', `plugin exited (${code}), restart in ${Math.round(delay)}ms`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopping) this.spawn();
      }, delay);
    });

    child.postMessage({ type: 'config', config: this.cfg });
  }

  private onChildMessage(msg: Record<string, unknown>): void {
    const type = msg['type'];
    const pid = Number(msg['pid'] ?? this.lastPid ?? 0);
    if (pid) this.lastPid = pid;
    if (type === 'status') {
      const s = msg['state'] as RelayPluginState;
      if (s === 'registered') this.restartAttempts = 0;
      this.setState(s, String(msg['detail'] ?? ''), Number(msg['pipes'] ?? 0), pid);
      return;
    }
    if (type === 'cmd-reply') {
      const id = Number(msg['id']);
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        msg['ok'] ? p.resolve(msg) : p.reject(new Error(String(msg['error'] ?? `status ${msg['status']}`)));
      }
      return;
    }
    // pipe-open/pipe-closed/pipe-aborted/relay-error/ready → 状态事件细节
    if (typeof type === 'string') {
      this.emit('status', { state: this.state, detail: type, pipes: Number(msg['pipes'] ?? 0), pid });
    }
  }

  private setState(state: RelayPluginState, detail: string, pipes = 0, pid = 0): void {
    this.state = state;
    if (pid) this.lastPid = pid;
    this.emit('status', { state, detail, pipes, pid: pid || this.lastPid });
  }

  /** 停止并卸载：通知 → 3s 宽限 → 强杀（TC-R2-03/04）。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      /* already dead */
    }
    const force = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    }, 3000);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3500))]);
    clearTimeout(force);
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    this.child = null;
    this.state = 'stopped';
    this.rejectAllPending(new Error('relay plugin stopped'));
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  // ---- 主进程 UI 面板所需的请求面（WBS-R2-F 由上层调用） ----

  async issueSubCode(label?: string, ttlHours?: number): Promise<{ subCode: string; id: string; expiresAt: number }> {
    const reply = (await this.request({ cmd: 'issue-subcode', label, ttlHours })) as Record<string, unknown>;
    return reply as unknown as { subCode: string; id: string; expiresAt: number };
  }

  async listSubCodes(): Promise<unknown[]> {
    const reply = (await this.request({ cmd: 'list-subcodes' })) as Record<string, unknown>;
    return (reply['subcodes'] as unknown[]) ?? [];
  }

  async revokeSubCode(subCodeId: string): Promise<void> {
    await this.request({ cmd: 'revoke-subcode', subCodeId });
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('relay plugin not running'));
      const id = ++this.reqSeq;
      this.pending.set(id, { resolve, reject });
      this.child!.postMessage({ type: 'cmd', id, ...payload });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('relay plugin request timeout'));
      }, 10_000);
    });
  }
}
