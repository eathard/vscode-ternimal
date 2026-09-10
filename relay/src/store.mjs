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

import { newSubCode } from './protocol.mjs';

let subSeq = 0;

export class MemoryStore {
  constructor() {
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
   * 签发子码（方案书 §3.3/§3.5：TTL 默认 24h，范围 1h–7d）。
   * @param {string} channelId
   * @param {{ttlHours?: number, label?: string}} [opts]
   */
  issueSubCode(channelId, opts = {}) {
    const ch = this.getOrCreateChannel(channelId);
    const ttl = Math.min(168, Math.max(1, opts.ttlHours ?? 24));
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
    return rec;
  }

  /**
   * 按明文子码查找（遍历小规模内存表；子码 24 字符高熵随机）。
   * @param {string} code
   */
  findSubCode(code) {
    for (const ch of this.channels.values()) {
      for (const sc of ch.subcodes.values()) {
        if (sc.code === code) return sc;
      }
    }
    return null;
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

  /** 状态快照（/health 与调试用）。 */
  snapshot() {
    return {
      channels: this.channels.size,
      controls: [...this.channels.values()].filter((c) => c.control).length,
      pipes: [...this.channels.values()].reduce((n, c) => n + c.pipes.size, 0),
    };
  }
}
