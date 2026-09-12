// GeoArbiter — 会话几何所有权仲裁（B+ 所有权流动自适应，docs/design §follow-mode）。
//
// 模型：任一时刻一个会话恰有一个几何所有者（'local' = Electron 桌面窗口，
// 其余 = web 客户端 id）。全屏 TUI 的输出字节内嵌网格坐标，多个尺寸无法
// 同时成立（tmux window-size 同构）；「自适应」= 所有权随注意力流动：
//
//   手机页面可见且聚焦 → 自动申请（桌面未聚焦时获准，防乒乓 5s 驻留）
//   桌面窗口聚焦 / 本地 resize → 立即夺回（桌面是主场，豁免驻留）
//   手动 chip → force 申请（豁免驻留与聚焦检查）
//   web 失焦/隐藏/断开 → 释放回 'local'
//
// 纯逻辑、无 IO：remoteServer 提供 ws 客户端集合并接线广播；
// verify-geo-arbiter.mjs 覆盖全部规则。

export type GeoOwnerId = string; // 'local' | ws clientId

export interface GeoClaimResult {
  granted: boolean;
  owner: GeoOwnerId;
  /** 所有权是否发生变化（决定是否广播）。 */
  changed: boolean;
}

export interface GeoArbiterOptions {
  /** 防乒乓：非强制所有权切换的最小间隔（ms）。 */
  dwellMs?: number;
  now?: () => number;
}

interface SessionGeo {
  owner: GeoOwnerId;
  switchedAt: number;
}

const DWELL_MS = 5_000;

export class GeoArbiter {
  private readonly sessions = new Map<string, SessionGeo>();
  private readonly dwellMs: number;
  private readonly now: () => number;
  /** Electron 窗口是否聚焦（渲染进程 focus/blur 上报）。 */
  private localFocus = true;

  constructor(opts: GeoArbiterOptions = {}) {
    this.dwellMs = opts.dwellMs ?? DWELL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  getOwner(id: string): GeoOwnerId {
    return this.sessions.get(id)?.owner ?? 'local';
  }

  isLocalFocused(): boolean {
    return this.localFocus;
  }

  setLocalFocus(focused: boolean): Array<{ id: string; res: GeoClaimResult }> {
    this.localFocus = focused;
    // 桌面聚焦即夺回：所有被 web 持有的会话立即回到 'local'（豁免驻留）。
    if (!focused) return [];
    const changes: Array<{ id: string; res: GeoClaimResult }> = [];
    for (const [id, geo] of this.sessions) {
      if (geo.owner !== 'local') {
        const res = this.claim(id, 'local', { force: true });
        if (res.changed) changes.push({ id, res });
      }
    }
    return changes;
  }

  /** 申请所有权。规则见类注释；同 owner 重复申请为无害成功。 */
  claim(id: string, who: GeoOwnerId, opts: { force?: boolean } = {}): GeoClaimResult {
    const cur = this.sessions.get(id) ?? { owner: 'local', switchedAt: -Infinity };
    if (cur.owner === who) return { granted: true, owner: who, changed: false };

    const dwellOk = this.now() - cur.switchedAt >= this.dwellMs;
    const desktopIdle = cur.owner === 'local' && !this.localFocus;
    const webToWeb = cur.owner !== 'local';
    // 'local' 申求是桌面聚焦/本地 resize = 意图明确，始终放行。
    const allowed =
      opts.force === true || who === 'local' || (dwellOk && (desktopIdle || webToWeb));
    if (!allowed) return { granted: false, owner: cur.owner, changed: false };

    this.sessions.set(id, { owner: who, switchedAt: this.now() });
    return { granted: true, owner: who, changed: true };
  }

  /** 释放（仅当前所有者有效）→ 回到 'local'。 */
  release(id: string, who: GeoOwnerId): GeoClaimResult {
    const cur = this.sessions.get(id);
    if (!cur || cur.owner !== who || who === 'local') {
      return { granted: false, owner: cur?.owner ?? 'local', changed: false };
    }
    this.sessions.set(id, { owner: 'local', switchedAt: this.now() });
    return { granted: true, owner: 'local', changed: true };
  }

  /** web 客户端断开：其持有的全部会话回落 'local'。返回发生变化的会话。 */
  dropClient(who: GeoOwnerId): Array<{ id: string; res: GeoClaimResult }> {
    const out: Array<{ id: string; res: GeoClaimResult }> = [];
    for (const [id, geo] of this.sessions) {
      if (geo.owner === who) {
        this.sessions.set(id, { owner: 'local', switchedAt: this.now() });
        out.push({ id, res: { granted: true, owner: 'local', changed: true } });
      }
    }
    return out;
  }

  forget(id: string): void {
    this.sessions.delete(id);
  }
}
