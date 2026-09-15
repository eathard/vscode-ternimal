// relay/src/config.mjs — relay 配置读写（原子写：tmp + rename，对齐主项目
// configStore 的哲学）。主码只存 SHA-256 哈希（方案书 §8-Q1）。

import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_CONFIG = {
  /** 主码 SHA-256 hex 列表（CLI add-master 追加）。 */
  masterHashes: [],
  /**
   * 结构化主码（计费生命周期）：{ hash, label, createdAt, expiresAt|null, revoked }
   * 旧 masterHashes 字符串在加载后视为永久主码（兼容存量部署）。
   */
  masters: [],
  host: '127.0.0.1',
  port: 8080,
  /** { cert: <pem路径>, key: <pem路径> }；null = 明文（Caddy 前置或 --insecure）。 */
  tls: null,
  /** 仅 true 时采信 X-Forwarded-For（方案书 §3.7）。 */
  trustedProxy: false,
  /** 对外接入地址（混合口令用，如 https://1.2.3.4 —— Caddy 前置的公网 IP/域名）。 */
  publicUrl: '',
  /** 接入 CA 公钥 PEM（混合口令嵌入；自建部署=Caddy 内部 CA 的 root.crt 内容）。 */
  publicCaPem: '',
  webRoot: '',
  limits: {
    subcodeTtlHours: 6,         // 签发默认 TTL（§3.5；管理页/客户端不传时生效）
    maxPipesPerChannel: 4,      // 每通道并发管道上限（§3.5）
    joinPendingMs: 10_000,      // join 挂起等待 host 拨管道（§3.5）
    firstFrameTimeoutMs: 10_000,
    heartbeatIntervalMs: 30_000, // 心跳间隔，两周期无 pong 收割（§3.4）
    backpressureBytes: 1024 * 1024, // 单管道 bufferedAmount 上限（§3.5）
    maxPayloadBytes: 1024 * 1024,   // 单帧上限，对齐 WS.MAX_MESSAGE_BYTES
    rateWindowMs: 60_000,
    rateLockMs: 60_000,
    rateMaxFailures: 5,
  },
};

/**
 * 加载配置（缺省合并；文件不存在返回默认值的深拷贝）。
 * @param {string} file
 */
export function loadConfig(file) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // P2：区分「不存在」（正常首启，用默认）与「存在但损坏」（必须拒
    // 启——静默降级为默认后，首次管理写盘会把真实主码/管理凭据全部
    // 抹掉，属于灾难性数据丢失路径）。
    if (err?.code !== 'ENOENT') {
      throw new Error(`relay-config.json 解析失败（拒绝启动以防配置被默认值覆盖重写）: ${err.message}`);
    }
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...raw,
    limits: { ...DEFAULT_CONFIG.limits, ...(raw.limits) },
  };
}

/**
 * 原子保存配置。
 * @param {string} file @param {any} cfg
 */
export function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
