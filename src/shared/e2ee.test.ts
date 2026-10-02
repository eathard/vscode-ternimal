// e2ee.test.ts — estimateSealedWireBytes 是截断预算的依据（RemoteServer
// attach 裁剪用它保证不超 relay /pipe maxPayload），必须保守：任何输入下
// 估计值 ≥ sealFrame 实际输出长度，否则预算形同虚设。
import { describe, expect, it } from 'vitest';
import { estimateSealedWireBytes, sealFrame, deriveSessionKey } from './e2ee';

async function freshKey(): Promise<CryptoKey> {
  return deriveSessionKey('token', 'nonce');
}

describe('estimateSealedWireBytes (budget safety)', () => {
  it('估计值覆盖实际密封帧（ASCII / ANSI / CJK 混合）', async () => {
    const key = await freshKey();
    for (const plain of [
      JSON.stringify({ type: 'attached', id: 'tab-1', replay: 'plain ascii output\n'.repeat(1000) }),
      JSON.stringify({ type: 'attached', id: 'tab-1', replay: '\x1b[32mok\x1b[0m 中文字符输出\n'.repeat(500) }),
      '',
      JSON.stringify({ type: 'data', id: 'tab-1', data: 'x' }),
    ]) {
      const sealed = await sealFrame(key, plain);
      expect(estimateSealedWireBytes(plain)).toBeGreaterThanOrEqual(sealed.length);
    }
  });

  it('单调且贴近：估计不偏离实际超过信封余量（64B）', async () => {
    const key = await freshKey();
    const plain = JSON.stringify({ type: 'attached', id: 'tab-1', replay: 'a'.repeat(100_000) });
    const sealed = await sealFrame(key, plain);
    const estimate = estimateSealedWireBytes(plain);
    expect(estimate - sealed.length).toBeLessThanOrEqual(64);
    expect(estimate - sealed.length).toBeGreaterThanOrEqual(0);
  });
});
