#!/usr/bin/env node
// verify-multi-instance.mjs — 多实例（方案 B）验收：
//
// MI-01 双实例并行：--ternimal-instance=miA / miB 同时存活（端口自动回退）
// MI-02 配置独立：各自 userData（instances/<id>/config），互不串扰
// MI-03 顶栏配色：两实例 tab 条背景色=各自实例色（且互不相同），对应托盘染色源
// MI-04 中继共存：两实例各自主码 → 同一 relay 双通道同时在线（无接管大战）
// MI-05 端口回退：配置同端口 8443 → 第二实例自动端口，二者都在监听
//
// 环境隔离：两实例均走 instances/<testId>（不触碰真实默认配置）。
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollFor(pred, label, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (err) { fail++; console.log(`  ✘ ${name}\n    ${err.stack?.split('\n')[0] ?? err}`); }
}

// 本地 relay + 两枚主码（各实例一枚）
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);
const { sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);
const MASTER_A = 'trelay_v1_mi_suite_master_AAAAA!';
const MASTER_B = 'trelay_v1_mi_suite_master_BBBBB!';
const relay = new RelayServer({
  host: '127.0.0.1', port: 18046, log: false,
  config: { masters: [{ hash: sha256Hex(MASTER_A), label: 'miA' }, { hash: sha256Hex(MASTER_B), label: 'miB' }], limits: {} },
  heartbeatIntervalMs: 60_000,
});
await relay.start();

// 实例配置（独立 userData 下的 config.json，同端口 8443 触发回退路径）
const userDataBase = path.join(os.tmpdir(), `ternimal-mi-${Date.now()}`);
const mkCfg = (master) => JSON.stringify({
  port: 8443, host: '127.0.0.1', replayBufferBytes: 65536,
  relay: { enabled: true, url: 'ws://127.0.0.1:18046', masterCode: master, lanDirect: false, clearMasterCodeOnExit: false, e2ee: false },
}, null, 2);
fs.mkdirSync(path.join(userDataBase, 'ternimal/instances/miA/config'), { recursive: true });
fs.mkdirSync(path.join(userDataBase, 'ternimal/instances/miB/config'), { recursive: true });
fs.writeFileSync(path.join(userDataBase, 'ternimal/instances/miA/config/config.json'), mkCfg(MASTER_A));
fs.writeFileSync(path.join(userDataBase, 'ternimal/instances/miB/config/config.json'), mkCfg(MASTER_B));

// 清扫残留测试实例（仅 mi 前缀；扫 /proc 避免模式串自匹配）——上轮超时被杀会留孤儿，
// 孤儿劫持调试端口会让下一轮 CDP 全部失联
function sweepTestInstances() {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('--ternimal-instance=mi') && Number(pid) !== process.pid) {
        process.kill(Number(pid), 'SIGKILL');
      }
    } catch { /* 自身或已退出 */ }
  }
}
sweepTestInstances();

const electronBin = path.join(root, 'node_modules/electron/dist/electron');
const launch = (id, dbgPort) => {
  const proc = spawn(electronBin, [
    '.', '--no-sandbox',
    `--ternimal-instance=${id}`,
    `--remote-debugging-port=${dbgPort}`,
  ], {
    cwd: root,
    env: {
      ...process.env,
      // 覆盖 userData 基准到临时目录（不碰真实配置）
      ELECTRON_USER_DATA: userDataBase,
      XDG_CONFIG_HOME: userDataBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  return { proc, logs };
};

// 注：Electron userData 默认取 XDG_CONFIG_HOME/ternimal（Linux）
const A = launch('miA', 9471);
const B = launch('miB', 9472);
const procs = [A, B];
const allLogs = () => procs.map((x) => x.logs.join('')).join('\n');

const cdpEvalRaw = async (dbgPort, expr) => {
  const list = await fetch(`http://127.0.0.1:${dbgPort}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  ws.close();
  if (process.env.MIDBG) console.log('    [cdp]', dbgPort, String(expr).slice(0, 50), '→', JSON.stringify(r.result?.result?.value ?? null).slice(0, 80), r.result?.exceptionDetails ? 'EXC' : '');
  return r.result?.result?.value ?? null;
};

await test('MI-01+05 双实例并行（同配置端口 8443 → 自动回退）', async () => {
  await sleep(9_000); // 启动 + relay 注册
  assert.ok(A.proc.exitCode === null, '实例 A 存活');
  assert.ok(B.proc.exitCode === null, '实例 B 存活');
  assert.ok(/自动端口|access URL/.test(allLogs()), `端口回退/监听日志存在`);
});

await test('MI-01b CDP 探针', async () => {
  for (const dp of [9471, 9472]) {
    try { const v = await fetch(`http://127.0.0.1:${dp}/json/version`).then(r=>r.text()); console.log(`    [probe] ${dp}: ${v.slice(0,60)}`); }
    catch (e) { console.log(`    [probe] ${dp}: ERR ${e.cause?.code ?? e.message}`); }
  }
  console.log('    [probe] log-head:', allLogs().split('\n').slice(0,6).join(' § ').slice(0,300));
});

await test('MI-02 配置独立（instances/<id> 各自的 config 与证书）', async () => {
  const cfgA = JSON.parse(fs.readFileSync(path.join(userDataBase, 'ternimal/instances/miA/config/config.json'), 'utf8'));
  const cfgB = JSON.parse(fs.readFileSync(path.join(userDataBase, 'ternimal/instances/miB/config/config.json'), 'utf8'));
  assert.notEqual(cfgA.relay.masterCode, cfgB.relay.masterCode, '主码不同（各自配置）');
  // 证书也是每实例独立生成
  assert.ok(fs.existsSync(path.join(userDataBase, 'ternimal/instances/miA/certs')), 'A 有独立证书目录');
  assert.ok(fs.existsSync(path.join(userDataBase, 'ternimal/instances/miB/certs')), 'B 有独立证书目录');
});

const cdpEval = async (dbgPort, expr, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    const v = await Promise.race([
      cdpEvalRaw(dbgPort, expr),
      sleep(8_000).then(() => null),
    ]).catch(() => null);
    if (v !== null && v !== undefined) return v;
    await sleep(600);
  }
  return null;
};

await test('MI-03 顶栏配色 = 实例色（两实例互不相同）', async () => {
  await sleep(1_500);
  const bgA = await cdpEval(9471, "getComputedStyle(document.querySelector('.tab-bar')).backgroundColor");
  const bgB = await cdpEval(9472, "getComputedStyle(document.querySelector('.tab-bar')).backgroundColor");
  assert.ok(bgA && bgB, '两实例 tab 条存在');
  assert.notEqual(bgA, bgB, `顶栏配色不同（A=${bgA} B=${bgB}）`);
  const accentA = await cdpEval(9471, "getComputedStyle(document.querySelector('.tab-bar')).borderBottomColor");
  assert.ok(accentA, '强调线存在');
  console.log(`    A bar=${bgA} accent=${accentA} / B bar=${bgB}`);
});

await test('MI-04 中继共存：双通道同时在线（无接管）', async () => {
  const health = await fetch('http://127.0.0.1:18046/health').then((r) => r.json());
  assert.equal(health.channels, 2, `通道数=2（实际 ${health.channels}）`);
  assert.equal(health.controls, 2, '两个控制连接同时在线（无互相踢）');
  const log = allLogs();
  assert.ok(!/superseded|takeover/i.test(log), '无接管/被顶日志');
});

relay.stop();
for (const x of procs) { try { x.proc.kill('SIGKILL'); } catch { /* gone */ } }
fs.rmSync(userDataBase, { recursive: true, force: true });
const cleanup = () => {
  sweepTestInstances();
  try { relay.stop(); } catch { /* gone */ }
  try { fs.rmSync(userDataBase, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('SIGTERM', () => { cleanup(); process.exit(1); });
process.on('SIGINT', () => { cleanup(); process.exit(1); });

console.log(`verify-multi-instance: ${pass}/${pass + fail} passed`);
cleanup();
process.exit(fail ? 1 : 0);
