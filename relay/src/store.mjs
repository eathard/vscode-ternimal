// relay/src/store.mjs — ChannelStore：通道/子码状态的唯一存储层（方案书 §3.6）。
//
// v1 为内存实现；接口形状按未来 Redis 多节点扩展预留：
//   - 全部方法为同步小粒度操作，可平移为 Redis 命令序列；
//   - 字节统计在内存中累加（背压本就需要），未来由配额钩子消费。
//
// 数据模型：
//   channel（由主码哈希派生 id，register 时惰性创建）
//     ├ control 连接（0/1）           —— 由 server.mjs 持有引用
//     ├ pendingClients: Map<clientId> —— join 挂起等待 host 拨管道
//     ├ pipes: Set                    —— 已对接的客户端管道
//     ├ subcodes: Map<subCodeId>
//     └ stats { bytesIn, bytesOut, pipesOpened }

import { newSubCode, sha256Hex } from './protocol.mjs';

let subSeq = 0;

export class MemoryStore {
  constructor() {
    /** P2：明文子码 → 记录 的哈希索引（join 热路径 O(1)，且以
     * sha256 定长键替代明文遍历比较，顺带消除计时侧信道）。 */
    this.byCode = new Map();
    /** @type {Map<string, any>} channelId → channel */
    this.channels = new Map();
  }

  /** @param {string} channelId */
  getOrCreateChannel(channelId) {
    let ch = this.channels.get(channelId);
    if (!ch) {
      ch = {
        id: channelId,
        control: null,
        pending: new Map(),
        pipes: new Set(),
        subcodes: new Map(),
        stats: { bytesIn: 0, bytesOut: 0, pipesOpened: 0 },
      };
      this.channels.set(channelId, ch);
    }
    return ch;
  }

  /** @param {string} channelId */
  getChannel(channelId) {
    return this.channels.get(channelId) ?? null;
  }

  /**
   * 签发子码（方案书 §3.3/§3.5：TTL 默认 6h，范围 1h–7d）。
   * @param {string} channelId
   * @param {{ttlHours?: number, label?: string}} [opts]
   */
  issueSubCode(channelId, opts = {}) {
    const ch = this.getOrCreateChannel(channelId);
    const ttl = Math.min(168, Math.max(1, opts.ttlHours ?? 6));
    const id = `sc${++subSeq}`;
    const rec = {
      id,
      code: newSubCode(),
      channelId,
      label: typeof opts.label === 'string' ? opts.label.slice(0, 64) : '',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 3600_000,
      revoked: false,
      stats: { bytes: 0, joins: 0 },
    };
    ch.subcodes.set(id, rec);
    this.byCode.set(sha256Hex(rec.code), rec);
    return rec;
  }

  /** 按 id 跨通道查子码（管理页续期用）。 @param {string} id */
  findSubCodeById(id) {
    for (const ch of this.channels.values()) {
      const sc = ch.subcodes.get(id);
      if (sc) return sc;
    }
    return null;
  }

  /**
   * 子码续期（管理页 +1天/+7天/长期）。
   * - {days: N}：从 max(now, 当前到期) 顺延 N 天；已过期的从当下复活。
   * - {permanent: true}：置为长期（expiresAt = null，永不过期）。
   * 已吊销不可续期（吊销即终态）。@param {{days?: number, permanent?: boolean}} [opts]
   */
  renewSubCode(id, opts = {}) {
    const rec = this.findSubCodeById(id);
    if (!rec || rec.revoked) return null;
    if (opts.permanent) {
      rec.expiresAt = null;
      return rec;
    }
    const days = Math.min(365, Math.max(1, Number(opts.days) || 1));
    const base = rec.expiresAt && rec.expiresAt > Date.now() ? rec.expiresAt : Date.now();
    rec.expiresAt = base + days * 86_400_000;
    return rec;
  }

  /**
   * 按明文子码查找（哈希索引 O(1)；子码 24 字符高熵随机）。
   * P2：曾为 O(全部子码) 明文遍历——错码洪峰下即 CPU DoS 放大器。
   * @param {string} code
   */
  findSubCode(code) {
    return this.byCode.get(sha256Hex(code)) ?? null;
  }

  /** P2：驱逐「已过期/已吊销且无管道」的子码记录（sweep 周期调用）。 */
  gcSubCodes() {
    const now = Date.now();
    for (const ch of this.channels.values()) {
      for (const [id, sc] of ch.subcodes) {
        const dead = sc.revoked || (sc.expiresAt !== null && sc.expiresAt <= now);
        if (dead) ch.subcodes.delete(id);
      }
    }
    for (const [hash, sc] of this.byCode) {
      const dead = sc.revoked || (sc.expiresAt !== null && sc.expiresAt <= now);
      if (dead) this.byCode.delete(hash);
    }
  }

  /**
   * 吊销子码；返回被吊销记录（不存在为 null）。
   * @param {string} channelId @param {string} subCodeId
   */
  revokeSubCode(channelId, subCodeId) {
    const ch = this.getChannel(channelId);
    const sc = ch?.subcodes.get(subCodeId);
    if (!sc) return null;
    sc.revoked = true;
    return sc;
  }

  /** 删除子码记录（吊销后的清理：从内存表移除，管道已死）。 */
  purgeSubCode(channelId, subCodeId) {
    const ch = this.getChannel(channelId);
    const sc = ch?.subcodes.get(subCodeId);
    if (!sc) return null;
    this.byCode.delete(sha256Hex(sc.code));
    ch.subcodes.delete(subCodeId);
    return { id: subCodeId, purged: true };
  }

  /** 状态快照（/health 与调试用）。 */
  snapshot() {
    return {
      channels: this.channels.size,
      controls: [...this.channels.values()].filter((c) => c.control).length,
      pipes: [...this.channels.values()].reduce((n, c) => n + c.pipes.size, 0),
    };
  }
}
