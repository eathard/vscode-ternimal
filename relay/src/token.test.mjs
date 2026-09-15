// token.test.mjs — tconf_v1 混合口令编解码单元测试（纯函数，无网络/进程）。
// 覆盖：往返保真、防截断/防篡改/防伪造、容错清洗、入参校验、CA 指纹。
// PEM 用 selfsigned 生成（无需 openssl CLI，Windows 可跑）。
import { describe, expect, it } from 'vitest';
import selfsigned from 'selfsigned';
import { encodeAccessToken, decodeAccessToken, caFingerprint, TOKEN_PREFIX } from './token.mjs';

// selfsigned.generate returns a Promise
const PEM = (await selfsigned.generate([{ name: 'commonName', value: 'Ternimal' }], {
  days: 2,
  keySize: 2048,
})).cert.trim();

const VALID = { url: 'https://1.2.3.4/', master: 'trelay_v1_ABC', caPem: PEM, label: 'L' };

describe('encodeAccessToken / decodeAccessToken', () => {
  it('T-01 往返保真：url/主码/CA/E2EE 完整保真，尾部 url 斜杠归一', async () => {
    const tok = encodeAccessToken(VALID);
    expect(tok.startsWith(TOKEN_PREFIX)).toBe(true);
    const d = await decodeAccessToken(tok);
    expect(d.ok).toBe(true);
    expect(d.config.url).toBe('https://1.2.3.4');
    expect(d.config.master).toBe('trelay_v1_ABC');
    expect(d.config.ca).toBe(PEM);
    expect(d.config.e2ee).toBe(true);
  });

  it('T-02 防截断：校验和拦截，文案可读', async () => {
    const tok = encodeAccessToken({ url: 'https://a.b', master: 'trelay_v1_X' });
    const cut = await decodeAccessToken(tok.slice(0, -3));
    expect(cut.ok).toBe(false);
    expect(cut.error).toMatch(/截断|校验/);
  });

  it('T-03 防篡改：首字符替换被校验和拦截', async () => {
    const tok = encodeAccessToken({ url: 'https://a.b', master: 'trelay_v1_X' });
    const i = tok.indexOf('_') + 1; // 前缀后第一个 b64 字符
    const evil = tok.slice(0, i) + (tok[i] === 'A' ? 'B' : 'A') + tok.slice(i + 1);
    expect((await decodeAccessToken(evil)).ok).toBe(false);
  });

  it('T-04 防伪造：错误前缀直接拒绝', async () => {
    expect((await decodeAccessToken('trelay_v1_not_a_token')).ok).toBe(false);
  });

  it('T-05 容错清洗：首尾空白/换行/全角空格不影响解码', async () => {
    const tok = encodeAccessToken({ url: 'https://a.b', master: 'trelay_v1_X' });
    const d = await decodeAccessToken(`  \n${tok}　\n `);
    expect(d.ok).toBe(true);
    expect(d.config.master).toBe('trelay_v1_X');
  });

  it('T-06 入参校验：非 http(s) url / 非 trelay 主码 / 非对象均拒绝', () => {
    expect(() => encodeAccessToken({ url: 'ftp://x', master: 'trelay_v1_X' })).toThrow();
    expect(() => encodeAccessToken({ url: 'https://x', master: 'wrong_prefix' })).toThrow();
    expect(() => encodeAccessToken(null)).toThrow();
  });

  it('T-07 口令可选字段：无 CA / e2ee=false / label 截断到 64', async () => {
    const d = await decodeAccessToken(encodeAccessToken({ url: 'https://a.b', master: 'trelay_v1_X', e2ee: false }));
    expect(d.config.ca).toBe('');
    expect(d.config.e2ee).toBe(false);
    const long = await decodeAccessToken(encodeAccessToken({ url: 'https://a.b', master: 'trelay_v1_X', label: 'x'.repeat(100) }));
    expect(long.config.label.length).toBe(64);
  });
});

describe('caFingerprint', () => {
  it('真实 PEM → 16 位十六进制指纹', () => {
    const fp = caFingerprint(PEM);
    expect(fp).toMatch(/^[0-9A-F]{16}$/);
  });
  it('垃圾输入 → null（不抛异常）', () => {
    expect(caFingerprint('not a pem')).toBeNull();
    expect(caFingerprint('')).toBeNull();
  });
});
