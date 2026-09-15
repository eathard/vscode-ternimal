// ringBuffer.test.ts — replay ring buffer semantics
// (migrated from scripts/verify-ringbuffer.mjs, verification standard D8).
import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer', () => {
  it('append + snapshot preserves chunk order', () => {
    const rb = new RingBuffer(1024);
    rb.append('hello ');
    rb.append('world');
    expect(rb.snapshot()).toBe('hello world');
    expect(rb.byteLength).toBe(11);
  });

  it('evicts oldest chunks past the cap', () => {
    const rb = new RingBuffer(100);
    rb.append('A'.repeat(40)); // 40B
    rb.append('B'.repeat(40)); // 80B total
    rb.append('C'.repeat(40)); // 120B → oldest 'A...' evicted
    expect(rb.byteLength).toBeLessThanOrEqual(100);
    const snap = rb.snapshot();
    expect(snap.startsWith('A')).toBe(false);
    expect(snap.endsWith('C'.repeat(40))).toBe(true);
    expect(snap.length).toBe(80);
  });

  it('single oversized chunk keeps only itself', () => {
    const rb = new RingBuffer(50);
    rb.append('old');
    rb.append('X'.repeat(60)); // >= cap → replaces everything
    expect(rb.snapshot()).toBe('X'.repeat(60));
    expect(rb.byteLength).toBe(60);
  });

  it('clear resets state', () => {
    const rb = new RingBuffer(100);
    rb.append('data');
    rb.clear();
    expect(rb.snapshot()).toBe('');
    expect(rb.byteLength).toBe(0);
  });

  it('multi-byte UTF-8 counted by bytes not chars', () => {
    const rb = new RingBuffer(9); // '你好世' = 3 CJK chars = 9 UTF-8 bytes
    rb.append('你好'); // 6B
    rb.append('世'); // 9B total, at cap
    expect(rb.byteLength).toBe(9);
    // one byte over cap → the OLDEST CHUNK '你好' (6B) is evicted whole
    // (eviction granularity is the appended chunk, by design)
    rb.append('!');
    expect(rb.byteLength).toBe(4);
    expect(rb.snapshot()).toBe('世!');
  });

  it('rejects non-positive cap', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
  });
});
