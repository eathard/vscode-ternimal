// verify-registry.mjs — automated verification for SessionRegistry
// (verification standard §2, deliverable D8). Injects a fake PtyHost so the
// suite runs under plain node without the Electron-ABI node-pty module.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/sessionRegistry.ts --outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { SessionRegistry } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href
);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run each case with a fresh registry; dispose in finally so pending
// timers never leak between cases.
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function withRegistry(fn) {
  const host = new FakePtyHost();
  const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
  try {
    await fn({ host, registry });
  } finally {
    registry.dispose();
  }
}

test('create returns server-generated SessionInfo and emits tabs (leading)', () =>
  withRegistry(async ({ registry }) => {
    const tabsEvents = [];
    registry.on('tabs', (t) => tabsEvents.push(t));
    const info = registry.create({ cols: 90, rows: 30 });

    assert.match(info.id, /^tab-\d+-1$/);
    assert.equal(info.title, 'Terminal');
    assert.ok(info.pid > 0);
    assert.equal(info.cols, 90);
    assert.equal(info.rows, 30);
    assert.equal(registry.list().length, 1);
    assert.equal(tabsEvents.length, 1, 'leading tabs emit is synchronous');
    assert.equal(tabsEvents[0][0].id, info.id);
  }));

test('write routes to pty; data event fires; replay buffer fills', () =>
  withRegistry(async ({ host, registry }) => {
    const dataEvents = [];
    registry.on('data', (p) => dataEvents.push(p));
    const info = registry.create({ cols: 80, rows: 24 });

    registry.write(info.id, 'ls -la');
    assert.deepEqual([...host.ptys.keys()], [info.id]);
    assert.equal(dataEvents.length, 1);
    assert.equal(dataEvents[0].data, '<ls -la>');
    assert.equal(registry.getReplay(info.id), '<ls -la>');
  }));

test('resize: leading edge immediate, trailing coalesced, clamped >= 1', () =>
  withRegistry(async ({ host, registry }) => {
    const info = registry.create({ cols: 80, rows: 24 });
    const pty = host.ptys.get(info.id);

    registry.resize(info.id, 100, 30);
    assert.equal(pty.resizeCalls.length, 1, 'first resize applies immediately');
    assert.deepEqual(pty.resizeCalls[0], [100, 30]);

    registry.resize(info.id, 120, 40); // within debounce window → pending
    registry.resize(info.id, 130, 50); // overwrites pending (last writer)
    assert.equal(pty.resizeCalls.length, 1, 'burst coalesces');
    assert.deepEqual(registry.list()[0].cols, 100, 'info updated on apply only');

    await sleep(350); // trailing fires at ~200ms
    assert.equal(pty.resizeCalls.length, 2);
    assert.deepEqual(pty.resizeCalls[1], [130, 50]);
    assert.equal(registry.list()[0].cols, 130);

    registry.resize(info.id, 130, 50); // same dims → no-op
    await sleep(300);
    assert.equal(pty.resizeCalls.length, 2, 'identical resize skipped');

    registry.resize(info.id, 0, -5); // clamp guard (VS Code pattern)
    await sleep(300);
    assert.deepEqual(pty.resizeCalls.at(-1), [1, 1]);
  }));

test('kill: exactly-once exit, list emptied, tabs broadcast', () =>
  withRegistry(async ({ registry }) => {
    const exits = [];
    const tabsEvents = [];
    registry.on('exit', (p) => exits.push(p));
    registry.on('tabs', (t) => tabsEvents.push(t));

    const a = registry.create({ cols: 80, rows: 24 });
    const b = registry.create({ cols: 80, rows: 24 });
    await sleep(700); // let the create-burst tabs throttle settle

    registry.kill(a.id);
    await sleep(700); // late pty exit must be ignored (already removed)

    assert.equal(exits.filter((e) => e.id === a.id).length, 1, 'exit exactly once');
    assert.deepEqual(
      registry.list().map((s) => s.id),
      [b.id]
    );
  }));

test('natural exit: propagated with real exitCode', () =>
  withRegistry(async ({ host, registry }) => {
    const exits = [];
    registry.on('exit', (p) => exits.push(p));
    const info = registry.create({ cols: 80, rows: 24 });

    host.emit('exit', { id: info.id, exitCode: 3 });
    assert.equal(exits.length, 1);
    assert.equal(exits[0].exitCode, 3);
    assert.equal(registry.list().length, 0);
    assert.equal(registry.getReplay(info.id), '');
  }));

test('title polling: process-name change → title event + info update', () =>
  withRegistry(async ({ host, registry }) => {
    const titles = [];
    registry.on('title', (p) => titles.push(p));
    const info = registry.create({ cols: 80, rows: 24 });

    host.ptys.get(info.id).process = 'node'; // claude would show as node/claude
    await sleep(1500); // poll interval is 1s

    assert.equal(titles.length, 1);
    assert.equal(titles[0].title, 'node');
    assert.equal(registry.list()[0].title, 'node');
  }));

test('replay buffer respects configured cap', () =>
  withRegistry(async ({ host }) => {
    const tiny = new FakePtyHost();
    const registry = new SessionRegistry({ ptyHost: tiny, replayBytes: 200 });
    try {
      const info = registry.create({ cols: 80, rows: 24 });
      for (let i = 0; i < 10; i++) tiny.ptys.get(info.id).write('x'.repeat(50));
      assert.ok(registry.getReplay(info.id).length <= 250, 'replay capped near 200');
    } finally {
      registry.dispose();
    }
    void host;
  }));

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
console.log(`registry: ${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
