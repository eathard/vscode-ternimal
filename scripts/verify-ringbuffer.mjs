// verify-ringbuffer.mjs — automated verification for the replay ring buffer
// (verification standard §2, deliverable D8). Compiles the TS modules it
// needs into dist/verify with plain tsc, then asserts behavior.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/ringBuffer.ts --outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { RingBuffer } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/ringBuffer.js')).href
);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('append + snapshot preserves chunk order', () => {
  const rb = new RingBuffer(1024);
  rb.append('hello ');
  rb.append('world');
  assert.equal(rb.snapshot(), 'hello world');
  assert.equal(rb.byteLength, 11);
});

test('evicts oldest chunks past the cap', () => {
  const rb = new RingBuffer(100);
  rb.append('A'.repeat(40)); // 40B
  rb.append('B'.repeat(40)); // 80B total
  rb.append('C'.repeat(40)); // 120B → oldest 'A...' evicted
  assert.ok(rb.byteLength <= 100, `byteLength ${rb.byteLength} <= 100`);
  const snap = rb.snapshot();
  assert.ok(!snap.startsWith('A'), 'oldest chunk evicted');
  assert.ok(snap.endsWith('C'.repeat(40)), 'newest chunk kept');
  assert.equal(snap.length, 80);
});

test('single oversized chunk keeps only itself', () => {
  const rb = new RingBuffer(50);
  rb.append('old');
  rb.append('X'.repeat(60)); // >= cap → replaces everything
  assert.equal(rb.snapshot(), 'X'.repeat(60));
  assert.equal(rb.byteLength, 60);
});

test('clear resets state', () => {
  const rb = new RingBuffer(100);
  rb.append('data');
  rb.clear();
  assert.equal(rb.snapshot(), '');
  assert.equal(rb.byteLength, 0);
});

test('multi-byte UTF-8 counted by bytes not chars', () => {
  const rb = new RingBuffer(9); // '你好世' = 3 CJK chars = 9 UTF-8 bytes
  rb.append('你好'); // 6B
  rb.append('世'); // 9B total, at cap
  assert.equal(rb.byteLength, 9);
  // one byte over cap → the OLDEST CHUNK '你好' (6B) is evicted whole
  // (eviction granularity is the appended chunk, by design)
  rb.append('!');
  assert.equal(rb.byteLength, 4);
  assert.equal(rb.snapshot(), '世!');
});

test('rejects non-positive cap', () => {
  assert.throws(() => new RingBuffer(0));
  assert.throws(() => new RingBuffer(-1));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
console.log(`ringbuffer: ${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
