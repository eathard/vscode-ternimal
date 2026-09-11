// relay/src/token.mjs — 混合接入口令（tconf_v1）：IP+主码+CA公钥 一贴即配
//
// 国内无域名是常态：自建 CA + 裸 IP 的手动三件套（地址/主码/存证书填路径）
// 对首购用户过于苛刻。本模块把三者压成一条可经微信传输的口令：
//
//   tconf_v1_<base64url(deflate(JSON))>.<sha256 前 8 位>
//
// 设计要点：
// - 自包含 CA 公钥（决策 a）：证书随口令走，App 解码后落盘 userData/certs 并自动设 caPath；
//   Caddy 将来换叶子证书也不失效（信任锚在根 CA）。
// - zlib 压缩（决策 b）：证书 PEM 压缩率高，整条口令 ~1.2KB，微信文本可传。
// - 尾部校验和（防微信吞字符截断），'.' 分隔便于人眼定位。
// - 无有效期/一次性（决策 e）：口令=配置快照，可重复使用（换机重贴）；
//   生命周期完全由主码本身管理。
// - base64 ≠ 加密：口令敏感度 ≈ 主码，仅经购买渠道传输。
//
// 双端共用：relay（CLI/管理 API 生成）与 App 主进程（解码应用）import 同一实现。

import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';

export const TOKEN_PREFIX = 'tconf_v1_';

/**
 * 编码混合口令。
 * @param {{ url: string, master: string, caPem?: string, e2ee?: boolean, label?: string }} cfg
 * @returns {string} tconf_v1_… 口令
 */
export function encodeAccessToken(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('token cfg required');
  if (typeof cfg.url !== 'string' || !/^https?:\/\//.test(cfg.url)) {
    throw new Error('token url must be http(s)://…');
  }
  if (typeof cfg.master !== 'string' || !cfg.master.startsWith('trelay_v1_')) {
    throw new Error('token master must be trelay_v1_…');
  }
  const body = {
    v: 1,
    url: cfg.url.replace(/\/+$/, ''),
    master: cfg.master,
    ca: typeof cfg.caPem === 'string' ? cfg.caPem.trim() : '',
    e2ee: cfg.e2ee !== false,
    label: String(cfg.label ?? '').slice(0, 64),
    iat: Date.now(),
  };
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(body), 'utf8'));
  const b64 = payload.toString('base64url');
  const chk = crypto.createHash('sha256').update(b64).digest('hex').slice(0, 8);
  return TOKEN_PREFIX + b64 + '.' + chk;
}

/**
 * 解码并校验混合口令（容错：首尾空白/全角空格/换行；截断与篡改由校验和拦截）。
 * @param {string} raw
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function decodeAccessToken(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'token must be a string' };
  const s = raw.replace(/\s+/g, '').replace(/\u3000/g, '');
  if (!s.startsWith(TOKEN_PREFIX)) return { ok: false, error: `口令须以 ${TOKEN_PREFIX} 开头` };
  const rest = s.slice(TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0 || dot !== rest.length - 9) {
    return { ok: false, error: '口令不完整（缺少校验段，可能被截断）' };
  }
  const b64 = rest.slice(0, dot);
  const chk = rest.slice(dot + 1);
  const expect = crypto.createHash('sha256').update(b64).digest('hex').slice(0, 8);
  if (chk !== expect) return { ok: false, error: '校验失败：口令被截断或篡改' };
  let body;
  try {
    body = JSON.parse(zlib.inflateRawSync(Buffer.from(b64, 'base64url')).toString('utf8'));
  } catch {
    return { ok: false, error: '口令内容无法解压解析' };
  }
  if (body?.v !== 1) return { ok: false, error: `不支持的口令版本 v=${body?.v}` };
  if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) {
    return { ok: false, error: '口令内地址无效' };
  }
  if (typeof body.master !== 'string' || !body.master.startsWith('trelay_v1_')) {
    return { ok: false, error: '口令内主码无效' };
  }
  return { ok: true, config: body };
}

/** 证书指纹（供预览/核对；PEM 无效返回 null）。 */
export function caFingerprint(pem) {
  try {
    const cert = new crypto.X509Certificate(pem);
    return cert.fingerprint256.replace(/:/g, '').slice(0, 16).toUpperCase();
  } catch {
    return null;
  }
}
