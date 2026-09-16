import { describe, it, expect, beforeEach } from 'vitest';
import { Keychain, KVStorage } from './keychain';

class MemStorage implements KVStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

describe('Keychain（多电脑书签凭据串）', () => {
  let store: MemStorage;

  beforeEach(() => { store = new MemStorage(); });

  it('多主机互不覆盖：两台电脑各存各的、各自命中', () => {
    const kc = new Keychain(store);
    kc.remember('sub-hostA', 'tokA');
    kc.remember('sub-hostB', 'tokB');
    expect(kc.lookup('sub-hostA')).toBe('tokA');
    expect(kc.lookup('sub-hostB')).toBe('tokB');
  });

  it('TTL 过期即失效并清扫', () => {
    const kc = new Keychain(store, 1000);
    const t0 = Date.now();
    kc.remember('sub-x', 'tok', t0);
    expect(kc.lookup('sub-x', t0 + 500)).toBe('tok');      // 期内
    expect(kc.lookup('sub-x', t0 + 2000)).toBeNull();      // 过期
    expect(kc.list(t0 + 2000)).toHaveLength(0);            // 已清扫
  });

  it('滑动续期：期内每次命中刷新 savedAt', () => {
    const kc = new Keychain(store, 1000);
    const t0 = Date.now();
    kc.remember('sub-x', 'tok', t0);
    expect(kc.lookup('sub-x', t0 + 900)).toBe('tok');       // 续期点
    expect(kc.lookup('sub-x', t0 + 1700)).toBe('tok');      // 若无续期此点已过期
    expect(kc.lookup('sub-x', t0 + 2800)).toBeNull();       // 停止访问后才过期
  });

  it('forget 逐条移除、不影响其他主机', () => {
    const kc = new Keychain(store);
    kc.remember('sub-a', 'tokA');
    kc.remember('sub-b', 'tokB');
    kc.forget('sub-a');
    expect(kc.lookup('sub-a')).toBeNull();
    expect(kc.lookup('sub-b')).toBe('tokB');
  });

  it('list 报告剩余天数并按子码排序', () => {
    const kc = new Keychain(store, 10 * 86400000);
    const t0 = Date.now();
    kc.remember('sub-b', 'tokB', t0 - 86400000);
    kc.remember('sub-a', 'tokA', t0 - 2 * 86400000);
    const list = kc.list(t0);
    expect(list.map((e) => e.subCode)).toEqual(['sub-a', 'sub-b']);
    expect(list[0].daysLeft).toBe(8);
    expect(list[1].daysLeft).toBe(9);
  });

  it('损坏的存储内容按空串处理（不抛）', () => {
    store.setItem('ternimal.keychain.v1', '{not json');
    const kc = new Keychain(store);
    expect(kc.lookup('sub-x')).toBeNull();
    kc.remember('sub-x', 'tok'); // 可继续写入恢复
    expect(kc.lookup('sub-x')).toBe('tok');
  });

  it('存储不可用（隐私模式）→ 全部操作静默降级', () => {
    const kc = new Keychain(null);
    expect(() => {
      kc.remember('sub-x', 'tok');
      expect(kc.lookup('sub-x')).toBeNull();
      kc.forget('sub-x');
      expect(kc.list()).toEqual([]);
    }).not.toThrow();
  });

  it('空子码/空令牌不落盘', () => {
    const kc = new Keychain(store);
    kc.remember('', 'tok');
    kc.remember('sub-x', '');
    expect(kc.list()).toHaveLength(0);
  });
});
