// wsProtocol.test.ts — codec-level mixed-version safety (wire-compat rules).
// The caps handshake: client announces via auth-response.caps, host echoes
// via auth-ok.caps. Old peers that never heard of caps ignore the field
// (Rule 1) — these tests pin the NEW parser's contract.
import { describe, expect, it } from 'vitest';
import { WS, parseClientMessage, encodeServerMessage, fitReplayToBudget } from './wsProtocol';
import type { WsAttachedMsg } from './wsProtocol';
import { estimateSealedWireBytes } from './e2ee';

const mac = 'ab';

describe('auth-response caps (client announcement)', () => {
  it('valid caps list parses through', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'auth-response', mac: 'ab'.repeat(32), caps: ['e2ee', 'softkeys'] }));
    expect(m).not.toBeNull();
    expect(m?.type).toBe('auth-response');
    if (m?.type === 'auth-response') expect(m.caps).toEqual(['e2ee', 'softkeys']);
  });

  it('frame WITHOUT caps stays byte-compatible (old client shape)', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'auth-response', mac: 'ab' }));
    expect(m).toEqual({ type: 'auth-response', mac: 'ab' });
  });

  it('malformed caps → null (BAD_MESSAGE on the wire)', () => {
    const mac = 'ab';
    const bad = (caps: unknown) => parseClientMessage(JSON.stringify({ type: 'auth-response', mac, caps }));
    expect(bad('e2ee')).toBeNull(); // not an array
    expect(bad([42])).toBeNull(); // non-string entry
    expect(bad(['E2EE'])).toBeNull(); // uppercase outside [a-z0-9-]
    expect(bad(['x'.repeat(33)])).toBeNull(); // entry too long
    expect(bad(Array.from({ length: 17 }, (_, i) => `c${i}`))).toBeNull(); // > 16 entries
  });

  it('valid caps at the boundary (16 entries, 32 chars) accepted', () => {
    const caps = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const m = parseClientMessage(JSON.stringify({ type: 'auth-response', mac, caps }));
    expect(m).not.toBeNull();
  });
  it('missing mac still rejected', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'auth-response', caps: ['e2ee'] }))).toBeNull();
  });
});

describe('mixed-version safety (wire-compat rules)', () => {
  it('server frames with caps re-encode losslessly', () => {
    // Host advertises caps on auth-ok; an old client JSON-parses and ignores
    // the unknown field, a new client reads it — the codec round-trips both.
    const frame = encodeServerMessage({ type: 'auth-ok', clientId: 'gc-1', caps: ['e2ee'] });
    const parsed = JSON.parse(frame);
    expect(parsed.caps).toEqual(['e2ee']);
    // old-client simulation: destructure without caps
    const { type, clientId } = parsed;
    expect(type).toBe('auth-ok');
    expect(clientId).toBe('gc-1');
  });

  it('auth-ok WITHOUT caps (old host) — new client must treat as no caps', () => {
    const parsed = JSON.parse('{"type":"auth-ok","clientId":"gc-2"}');
    const caps = Array.isArray(parsed.caps) ? parsed.caps : [];
    expect(caps).toEqual([]);
  });
});

// attach 回放裁剪：relay /pipe maxPayload（默认 1MB）是硬限，密封帧超限
// 即断管（2026-10-03 线上「重连风暴」根因）。这里钉住预算收敛性质。
describe('fitReplayToBudget (relay pipe frame cap)', () => {
  const budget = WS.MAX_SECURE_FRAME_BYTES; // 900KB — 留余量于 relay 1MB 之下
  const serialize = (replay: string) =>
    encodeServerMessage({
      type: 'attached', id: 'tab-1', replay, cols: 310, rows: 51, title: 'ping',
    } as WsAttachedMsg);

  it('小回放原样通过', () => {
    const small = 'hello\nworld\n';
    expect(fitReplayToBudget(small, serialize, budget)).toBe(small);
  });

  it('超大回放裁到预算内，且保留的是最新内容', () => {
    // 每行 60B，2 万行 ≈ 1.2MB 明文 — 必裁
    const lines = Array.from({ length: 20_000 }, (_, i) => `line-${i} ${'x'.repeat(50)}\n`);
    const out = fitReplayToBudget(lines.join(''), serialize, budget);
    expect(estimateSealedWireBytes(serialize(out))).toBeLessThanOrEqual(budget);
    expect(out.startsWith('line-0 ')).toBe(false); // 最老的被丢
    const last = lines[lines.length - 1];
    expect(out.endsWith(last)).toBe(true); // 最新的完整保留
    expect(out.startsWith('line-')).toBe(true); // 对齐到行首（无残缺行）
  });

  it('ANSI 转义密集（JSON unicode 转义膨胀最坏形态）仍收敛', () => {
    // ESC 在 JSON.stringify 中变 \u001b（6 字符/字节）——纯 ESC 流是膨胀上界
    const escHeavy = '\x1b[32m=\x1b[0m'.repeat(200_000); // 1.2MB
    const out = fitReplayToBudget(escHeavy, serialize, budget);
    expect(out.length).toBeGreaterThan(0);
    expect(estimateSealedWireBytes(serialize(out))).toBeLessThanOrEqual(budget);
  });

  it('CJK 回放（UTF-8 3 字节/字符）仍收敛', () => {
    const cjk = '中文输出行内容测试。'.repeat(100_000); // 900K 字符 → 2.7MB UTF-8
    const out = fitReplayToBudget(cjk, serialize, budget);
    expect(estimateSealedWireBytes(serialize(out))).toBeLessThanOrEqual(budget);
  });

  it('无换行的巨型单行硬切且收敛', () => {
    const one = 'y'.repeat(2_000_000);
    const out = fitReplayToBudget(one, serialize, budget);
    expect(estimateSealedWireBytes(serialize(out))).toBeLessThanOrEqual(budget);
    expect(out.length).toBeGreaterThan(0);
  });

  it('零预算/空回放/极短回放不死循环（len≤3 时 cut 下限修复前死循环）', () => {
    expect(fitReplayToBudget('', serialize, budget)).toBe('');
    for (const tiny of ['a', 'ab', 'abc']) {
      expect(fitReplayToBudget(tiny, serialize, 1)).toBe('');
    }
  });
});
