// RelayController (WBS-R2-E/F) — 主进程侧的中继编排面。
//
// 职责：合并配置与环境覆盖（测试/恢复通道）→ 驱动 RelayPluginHost 生命周期 →
// 组装分享链接（子码 + 本启动 Token）→ 向设置面板与 tray 广播状态。
//
// 关键语义：
//   - 运行时启用中继：配置立即落盘，但 RemoteServer 的 loopback 收窄与首帧
//     auth 门控在启动时已定 → 需重启生效（restartRequired=true，面板明示）；
//   - 已在中继就绪状态下的 URL/主码微调：插件立即重启重连，无需应用重启；
//   - 分享链接 = `${relayUrl}/#S=<子码>&T=<Token>`，两段都在片段里（§2.2）。

import { ipcMain, BrowserWindow } from 'electron';
import { RelayPluginHost, type RelayPluginConfig } from './plugins/pluginHost';
import type { ConfigStore } from './configStore';
import type { AuthManager } from './authManager';
import {
  IPC,
  RelaySettingsDto,
  RelayStatusEvent,
  RelayShareLink,
  RelaySubcodeInfo,
} from '../shared/ipcChannels';

export interface RelayControllerDeps {
  configStore: ConfigStore;
  auth: AuthManager;
  /** Actual listen port of the (already started) RemoteServer. */
  getPort: () => number;
  /** TLS cert fingerprint for loopback pinning. */
  fingerprint: string;
  /** Server start facts (host + whether first-frame auth was enabled at boot). */
  serverHost: string;
  serverRelayAuth: boolean;
  getWindow: () => BrowserWindow | null;
  /** Optional hook so tray can refresh on status change. */
  onStatus?: (e: RelayStatusEvent) => void;
  /** R-M4-B：E2E 加密开关下发 RemoteServer（运行时热切换）。 */
  setE2EE?: (v: boolean) => void;
}

export class RelayController {
  private readonly deps: RelayControllerDeps;
  private readonly host = new RelayPluginHost();
  private lastStatus: RelayStatusEvent = { state: 'stopped', detail: '', pipes: 0, pid: 0 };

  constructor(deps: RelayControllerDeps) {
    this.deps = deps;
    this.host.on('status', (e) => {
      this.lastStatus = e;
      this.broadcast(e);
      this.deps.onStatus?.(e);
    });
  }

  // ---------- effective settings（配置 + 环境覆盖合并） ----------

  /** 环境覆盖（smoke-e2e / 恢复通道）：显式给定即视为启用。 */
  private envOverride(): { url: string; masterCode: string } | null {
    const url = process.env.TERNIMAL_RELAY_URL;
    const masterCode = process.env.TERNIMAL_RELAY_MASTER;
    return url && masterCode ? { url, masterCode } : null;
  }

  effective(): RelaySettingsDto {
    const cfg = this.deps.configStore.load().relay;
    const env = this.envOverride();
    const enabled = env ? true : cfg.enabled && !!cfg.url && !!cfg.masterCode;
    const url = env?.url ?? cfg.url;
    const masterCode = env?.masterCode ?? cfg.masterCode;
    // loopback 收窄仅当 server 以 0.0.0.0 配置且未显式双开（§8-Q3 fail-secure）
    const desiredHost =
      enabled && !cfg.lanDirect && this.deps.configStore.load().host === '0.0.0.0'
        ? '127.0.0.1'
        : this.deps.configStore.load().host;
    const bindingChanged = desiredHost !== this.deps.serverHost;
    // 运行时才启用的中继：首帧门控未开 → 必须重启（除非 env 覆盖且 server 已带门控）
    const authChanged = enabled && !this.deps.serverRelayAuth;
    return {
      enabled,
      url,
      masterCode,
      clearMasterCodeOnExit: cfg.clearMasterCodeOnExit,
      lanDirect: cfg.lanDirect,
      e2ee: process.env.TERNIMAL_RELAY_E2EE === '1' || cfg.e2ee,
      caPath: cfg.caPath || '',
      state: this.host.currentState,
      hostBinding: this.deps.serverHost,
      restartRequired: enabled && (bindingChanged || authChanged),
    };
  }

  // ---------- lifecycle ----------

  /** Boot-time start when the app already came up relay-ready. */
  ensureStarted(): void {
    const eff = this.effective();
    if (!eff.enabled || eff.restartRequired) return;
    this.startPlugin(eff.url, eff.masterCode);
  }

  private startPlugin(url: string, masterCode: string): void {
    const cfg: RelayPluginConfig = {
      relayUrl: url,
      masterCode,
      localPort: this.deps.getPort(),
      fingerprint: this.deps.fingerprint,
      caPath: this.deps.configStore.load().relay.caPath || '',
    };
    this.host.start(cfg);
  }

  /** Settings panel save: persist + immediate plugin restart when possible. */
  async applySettings(patch: Partial<RelaySettingsDto>): Promise<RelaySettingsDto> {
    const cfg = this.deps.configStore.load();
    const next = {
      ...cfg.relay,
      enabled: patch.enabled ?? cfg.relay.enabled,
      url: (patch.url ?? cfg.relay.url).trim(),
      masterCode: (patch.masterCode ?? cfg.relay.masterCode).trim(),
      clearMasterCodeOnExit: patch.clearMasterCodeOnExit ?? cfg.relay.clearMasterCodeOnExit,
      lanDirect: patch.lanDirect ?? cfg.relay.lanDirect,
      e2ee: patch.e2ee ?? cfg.relay.e2ee,
      caPath: (patch.caPath ?? cfg.relay.caPath).trim(),
    };
    if (next.enabled && (!next.url || !next.masterCode)) {
      throw new Error('relay enabled but url/masterCode missing');
    }
    this.deps.configStore.save({ relay: next });
    // R-M4-B：热切换（新会话生效）；env 覆盖时保持强制开
    this.deps.setE2EE?.(process.env.TERNIMAL_RELAY_E2EE === '1' || next.e2ee);

    const eff = this.effective();
    if (this.envOverride()) {
      // 测试/恢复通道：环境优先，仅重启插件对齐
      await this.host.stop();
      this.startPlugin(eff.url, eff.masterCode);
      return this.effective();
    }
    if (!eff.enabled) {
      await this.host.stop();
      return this.effective();
    }
    if (eff.restartRequired) {
      // 监听/门控面变化：插件先停，重启应用后由 ensureStarted 拉起
      await this.host.stop();
      return this.effective();
    }
    await this.host.stop();
    this.startPlugin(eff.url, eff.masterCode);
    return this.effective();
  }

  async stopForShutdown(): Promise<void> {
    await this.host.stop();
  }

  /** 退出时清除主码（偏执模式，§4.1）— 由唯一退出路径调用。 */
  handleExitClearMaster(): void {
    const eff = this.effective();
    if (!eff.enabled || !eff.clearMasterCodeOnExit) return;
    const raw = this.deps.configStore.load().relay;
    if (raw.masterCode) {
      this.deps.configStore.save({ relay: { ...raw, masterCode: '' } });
      console.warn('[Ternimal] relay masterCode cleared on exit (clearMasterCodeOnExit)');
    }
  }

  get pluginRunning(): boolean {
    return this.host.currentState !== 'stopped';
  }

  /** tray 摘要：off=未启用 / conn=已启用连接中 / on=已注册。 */
  get stateSummary(): 'off' | 'conn' | 'on' {
    if (!this.effective().enabled) return 'off';
    return this.lastStatus.state === 'registered' ? 'on' : 'conn';
  }

  // ---------- 分享链接与子码管理（经插件代理，主码不出子进程） ----------

  async shareLink(label?: string, ttlHours?: number): Promise<RelayShareLink> {
    if (this.host.currentState !== 'registered') {
      throw new Error('relay plugin not registered');
    }
    const eff = this.effective();
    const sub = await this.host.issueSubCode(label ?? 'share', ttlHours);
    const url = `${eff.url.replace(/\/+$/, '')}/#S=${sub.subCode}&T=${encodeURIComponent(this.deps.auth.getToken())}`;
    return { url, subCode: sub.subCode, expiresAt: sub.expiresAt };
  }

  async listSubCodes(): Promise<RelaySubcodeInfo[]> {
    return (await this.host.listSubCodes()) as RelaySubcodeInfo[];
  }

  async revokeSubCode(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    await this.host.revokeSubCode(id, opts);
  }

  /** 子码续期（+N 天 / 转长期）；返回新 expiresAt。 */
  async renewSubCode(id: string, opts: { days?: number; permanent?: boolean }): Promise<number | null> {
    return this.host.renewSubCode(id, opts);
  }

  // ---------- IPC ----------

  private broadcast(e: RelayStatusEvent): void {
    const win = this.deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.RELAY_ON_STATUS, e);
  }

  registerIpc(): void {
    ipcMain.handle(IPC.RELAY_GET_SETTINGS, () => this.effective());
    ipcMain.handle(IPC.RELAY_APPLY_SETTINGS, (_e, patch: Partial<RelaySettingsDto>) =>
      this.applySettings(patch)
    );
    ipcMain.handle(IPC.RELAY_SHARE_LINK, (_e, label?: string, ttlHours?: number) =>
      this.shareLink(label, ttlHours)
    );
    ipcMain.handle(IPC.RELAY_LIST_SUBCODES, () => this.listSubCodes());
    ipcMain.handle(IPC.RELAY_REVOKE_SUBCODE, (_e, id: string, purge?: boolean) =>
      this.revokeSubCode(id, { purge: purge === true })
    );
    ipcMain.handle(IPC.RELAY_RENEW_SUBCODE, (_e, id: string, opts: { days?: number; permanent?: boolean }) =>
      this.renewSubCode(id, opts)
    );
  }

  unregisterIpc(): void {
    for (const ch of [
      IPC.RELAY_GET_SETTINGS,
      IPC.RELAY_APPLY_SETTINGS,
      IPC.RELAY_SHARE_LINK,
      IPC.RELAY_LIST_SUBCODES,
      IPC.RELAY_REVOKE_SUBCODE,
      IPC.RELAY_RENEW_SUBCODE,
    ]) {
      ipcMain.removeAllListeners(ch);
    }
  }
}
