// relay/src/protocol.mjs — 控制面/数据面线上协议常量与凭证工具。
//
// 设计依据：docs/relay-design.md §3.2（协议）、§2.1（凭证）、§8-Q1（哈希存储）。
//
// 三个 WS 端点：
//   /control  host 出站控制通道：register → registered / client-offer
//   /join     客户端接入：join(子码) → 挂起等待 → 管道对接后【透传】
//   /pipe     host 出站管道（每客户端一条）：pipe(masterCode, clientId) → 对接
//
// 对接成功后 relay 对后续帧零解析零改写（哑管道原则），仅监控背压与心跳。

import * as crypto from 'crypto';

export const PROTOCOL_VERSION = 1;

/** 控制面消息类型（JSON text 帧）。 */
export const CTRL = {
  REGISTER: 'register',
  PIPE: 'pipe',
  REGISTERED: 'registered',
  CLIENT_OFFER: 'client-offer',
  ERROR: 'error',
  OCCUPIED: 'occupied',   // 注册被拒：主码已有活跃实例（新版非 force 注册撞上活连接）
  TAKEN_OVER: 'taken-over', // 被强制接管：收到方应驻停，不再自动重连
};

/** 客户端 → relay（/join 首帧）。 */
export const JOIN = 'join';

/** 关闭码（relay 自身语义，与内层 wsProtocol 无关）。 */
export const CLOSE = {
  BAD_CODE: 4001,
  RATE_LIMITED: 4002,
  HOST_OFFLINE: 4003,
  BUSY: 4004,
  PENDING_TIMEOUT: 4005,
  BAD_MESSAGE: 4006,
  UNKNOWN_CLIENT: 4007,
  SUBCODE_EXPIRED: 4008,
  SUBCODE_REVOKED: 4009,
  TAKEOVER: 4010,
  OCCUPIED: 4011,
  // P2：BACKPRESSURE 已删——与 OCCUPIED 撞号 4011（从未被发送：背压
  // 终止用 terminate()，不携带关闭码）；若未来需要，从 4012 起编号。
  FIRST_FRAME_TIMEOUT: 4012,
};

export const MASTER_PREFIX = 'trelay_v1_';
export const SUB_PREFIX = 'tsub_v1_';

/** 主码：24B 随机 → base64url（32 字符）+ 版本前缀。 */
export function newMasterCode() {
  return MASTER_PREFIX + crypto.randomBytes(24).toString('base64url');
}

/** 子码：18B 随机 → base64url（24 字符）+ 版本前缀。 */
export function newSubCode() {
  return SUB_PREFIX + crypto.randomBytes(18).toString('base64url');
}

/** @param {string} s @returns {string} sha256 十六进制摘要 */
export function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 通道号由主码哈希派生：同码必同通道（重复 register 即接管，见方案书 §3.4）。 */
export function deriveChannelId(masterCode) {
  return crypto.createHash('sha256').update(masterCode, 'utf8').digest('base64url').slice(0, 22);
}

/** 常数时间比较（防时序侧信道）；等长前提由调用方保证（均为 sha256 hex）。 */
export function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * 解析 /control 首帧（register 或 pipe）；非法返回 null（BAD_MESSAGE 断链）。
 * @param {string} raw
 */
export function parseControlFirst(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (typeof m !== 'object' || m === null) return null;
  if (m.type === CTRL.REGISTER && typeof m.masterCode === 'string') {
    // proto:2 = 意图抢占协议（occupied/taken-over 语义）；force = 人工强制接管。
    // 缺省 = 旧客户端 → 服务端按 last-wins 兼容（滚动升级不断服）。
    return {
      type: CTRL.REGISTER,
      masterCode: m.masterCode,
      proto: m.proto === 2 ? 2 : undefined,
      force: m.force === true ? true : undefined,
    };
  }
  if (m.type === CTRL.PIPE && typeof m.masterCode === 'string' && typeof m.clientId === 'string') {
    return { type: CTRL.PIPE, masterCode: m.masterCode, clientId: m.clientId };
  }
  return null;
}

/**
 * 解析 /join 首帧；非法返回 null。
 * @param {string} raw
 */
export function parseJoinFirst(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (typeof m !== 'object' || m === null) return null;
  return m.type === JOIN && typeof m.subCode === 'string'
    ? { type: JOIN, subCode: m.subCode }
    : null;
}
