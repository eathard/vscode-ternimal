// E2EE codec (R-M4-B, design §2.5 挑战应答 + E2E 加密协议位).
//
// 会话密钥：HKDF-SHA256(ikm = Token, salt = auth-challenge 的 nonce,
// info = 'ternimal-relay-e2e-v1') → 256-bit AES-GCM 密钥。nonce 在挑战里
// 明文传输但单次有效，Token 从不出境 → relay/插件可观查到的材料不足以
// 重建密钥（这正是挑战应答顺带完成密钥协商的原因）。
//
// 数据面：auth-ok{enc:1} 之后的双向业务帧一律封装为
// `{type:'secure', iv, ct}`，ct = AES-256-GCM(iv, key, JSON(业务帧))，
// AEAD 同时提供机密性与完整性；IV 每帧随机 96-bit。控制面（auth-challenge/
// auth-response/auth-ok/错误）保持明文——加密建立前必须可读。
//
// 仅依赖 WebCrypto（浏览器与 Node≥18 主进程同码）；纯函数、无状态。

export const E2EE_INFO = 'ternimal-relay-e2e-v1';

/** 安全帧信封（业务帧的密文载体）。 */
export interface SecureEnvelope {
  type: 'secure';
  iv: string; // base64(12B)
  ct: string; // base64(AES-256-GCM 密文+tag)
}

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** HKDF(token, nonce) → AES-GCM 会话密钥。双方各自本地推导，密钥不上链路。 */
export async function deriveSessionKey(token: string, nonce: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable (insecure context)');
  const ikm = await subtle.importKey('raw', enc.encode(token), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(nonce), info: enc.encode(E2EE_INFO) },
    ikm,
    256
  );
  return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 封装一帧业务消息（JSON 字符串）。IV 每帧随机。 */
export async function sealFrame(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return JSON.stringify({
    type: 'secure',
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  } satisfies SecureEnvelope);
}

/**
 * 解封一帧安全信封（JSON 字符串）。返回内层业务帧 JSON 字符串；
 * 信封损坏 / GCM 校验失败 / base64 非法 → null（调用方按 BAD_MESSAGE 处理）。
 */
export async function openFrame(key: CryptoKey, wire: string): Promise<string | null> {
  let env: { iv?: unknown; ct?: unknown };
  try {
    env = JSON.parse(wire);
  } catch {
    return null;
  }
  if (typeof env.iv !== 'string' || typeof env.ct !== 'string') return null;
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(env.iv) },
      key,
      fromBase64(env.ct)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // GCM tag mismatch（篡改/错钥）
  }
}
