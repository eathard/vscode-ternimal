// verify-geo-arbiter.mjs — B+ 几何所有权仲裁规则回归。
// 纯逻辑单测：编译 geoArbiter.ts 后直接驱动（注入时钟），覆盖
// 自动接管资格 / 防乒乓驻留 / 桌面聚焦夺回 / 断线回落 / 手动 force。
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/geoArbiter.ts --outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { GeoArbiter } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/geoArbiter.js')).href
);

let clock = 1_000;
const mk = (dwellMs = 5_000) => new GeoArbiter({ dwellMs, now: () => clock });
let passed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { console.error(`  FAIL  ${name}\n    ${err.message}`); process.exitCode = 1; }
};

console.log('B+ geo-arbiter ownership rules:');

ok('GC-01 默认所有权为 local', () => {
  assert.equal(mk().getOwner('s1'), 'local');
});

ok('GC-02 桌面聚焦时手机自动申请被拒（你在看桌面）', () => {
  const a = mk(); // localFocus 默认 true
  const r = a.claim('s1', 'gc-1');
  assert.equal(r.granted, false);
  assert.equal(a.getOwner('s1'), 'local');
});

ok('GC-03 桌面失焦 + 手机申请 → 获准', () => {
  const a = mk();
  a.setLocalFocus(false);
  const r = a.claim('s1', 'gc-1');
  assert.equal(r.granted, true);
  assert.equal(a.getOwner('s1'), 'gc-1');
});

ok('GC-04 获准后手机原生几何生效（changed 广播一次）', () => {
  const a = mk();
  a.setLocalFocus(false);
  const r1 = a.claim('s1', 'gc-1');
  const r2 = a.claim('s1', 'gc-1'); // 同 owner 重复申请无害
  assert.equal(r1.changed, true);
  assert.equal(r2.changed, false);
});

ok('GC-05 防乒乓：切换后 5s 内另一手机申请被拒', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  clock += 2_000; // < dwell 5s
  const r = a.claim('s1', 'gc-2');
  assert.equal(r.granted, false);
  assert.equal(a.getOwner('s1'), 'gc-1');
});

ok('GC-06 驻留期满后另一手机可接（web→web）', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  clock += 5_001;
  const r = a.claim('s1', 'gc-2');
  assert.equal(r.granted, true);
  assert.equal(a.getOwner('s1'), 'gc-2');
});

ok('GC-07 桌面聚焦即夺回（豁免驻留）', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  clock += 100; // 远小于驻留
  const changes = a.setLocalFocus(true);
  assert.equal(a.getOwner('s1'), 'local');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, 's1');
});

ok('GC-08 手动 chip force 豁免一切检查', () => {
  const a = mk(); // 桌面聚焦中
  a.claim('s1', 'gc-1', { force: true });
  assert.equal(a.getOwner('s1'), 'gc-1');
});

ok('GC-09 本地 resize 夺回（who=local 始终放行）', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  const r = a.claim('s1', 'local');
  assert.equal(r.granted, true);
  assert.equal(a.getOwner('s1'), 'local');
});

ok('GC-10 手机主动释放 → 回 local', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  const r = a.release('s1', 'gc-1');
  assert.equal(r.changed, true);
  assert.equal(a.getOwner('s1'), 'local');
});

ok('GC-11 非所有者释放无效', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  const r = a.release('s1', 'gc-2');
  assert.equal(r.changed, false);
  assert.equal(a.getOwner('s1'), 'gc-1');
});

ok('GC-12 手机断线 → 其持有会话全部回落 local', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  a.claim('s2', 'gc-1');
  a.claim('s3', 'gc-2');
  const dropped = a.dropClient('gc-1');
  assert.equal(a.getOwner('s1'), 'local');
  assert.equal(a.getOwner('s2'), 'local');
  assert.equal(a.getOwner('s3'), 'gc-2'); // 他人不受影响
  assert.equal(dropped.length, 2);
});

ok('GC-13 会话退出 → 状态清理（forget）', () => {
  const a = mk();
  a.setLocalFocus(false);
  a.claim('s1', 'gc-1');
  a.forget('s1');
  assert.equal(a.getOwner('s1'), 'local'); // 缺省语义
});

ok('GC-14 桌面失焦本身不改变所有权', () => {
  const a = mk();
  a.setLocalFocus(false);
  const changes = a.setLocalFocus(false);
  assert.equal(changes.length, 0);
});

console.log(`geo-arbiter: ${passed}/14 passed${process.exitCode ? ' — FAILED' : ''}`);
process.exit(process.exitCode ? 1 : 0);
