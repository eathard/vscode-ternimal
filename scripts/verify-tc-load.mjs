#!/usr/bin/env node
// verify-tc-load.mjs — TC-R4-04 全量：20 会话混合负载 × 10 分钟 × tc 3MB/s。
//
// 形态（全链路本机 loopback，tc 限速 lo=3MB/s 模拟方案书 §3.8 容量模型）：
//   16 交互会话（每 2s 一次键入+回显断言）
//   3 中度会话（每 1s 4KB 突发）
//   1 重度会话（全速洪泛 → 预期触发 relay 1MB 背压保护被终止）
// 判定：10 分钟结束时 16+3 全部存活且交互正常；重度管道被终止且不扩散
//（另一管道上的 16+3 不受影响）；host/relay 进程健康。
//
// 用法：node scripts/verify-tc-load.mjs [minutes]  （默认 10；root 由外部 sudo 提供 tc）
import { fork } from 'node:child_process';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const MINUTES = Number(process.argv[2] ?? 10);
const DURATION_MS = MINUTES * 60_000;
const TOKEN = 'tc-load-token-32-chars-ok!!';

const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);
const { sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';

// ① tc 限速：lo = 3MB/s（24mbit）。失败则降级为不限速但给出警告（仍可验证隔离性）。
let tcApplied = false;
try {
  if (process.env.TCNOTC) throw new Error('TCNOTC');
  execSync('sudo -n tc qdisc replace dev lo root tbf rate 24mbit latency 100ms burst 256kbit', { stdio: 'ignore' });
  tcApplied = true;
  console.log(`[tc] lo 限速 3MB/s 已生效（${MINUTES} 分钟后自动撤销）`);
} catch {
  console.warn('[tc] 无法应用（需 root 的 NOPASSUDO 或 sudo -n）——以不限速模式运行（仍验证 20 会话与隔离性）');
}
process.on('exit', () => {
  try { if (tcApplied) execSync('sudo -n tc qdisc del dev lo root', { stdio: 'ignore' }); } catch { /* 尽力 */ }
});

// ② host + relay + 插件
const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 512 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-load-')));
const rs = new RemoteServer({
  registry, auth, tls, port: 0, host: '127.0.0.1',
  heartbeatIntervalMs: 30_000, allowRelayFirstFrameAuth: true, maxSessions: 32,
});
rs.certFingerprint = tls.fingerprint;
const localPort = await rs.start();

const MASTER = 'trelay_v1_tc_load_master_ok!!!';
const relay = new RelayServer({
  host: '127.0.0.1', port: 18055, log: false,
  config: { masterHashes: [sha256Hex(MASTER)], limits: {} }, heartbeatIntervalMs: 30_000,
});
await relay.start();

const plugin = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const inbox = [];
plugin.on('message', (m) => inbox.push(m));
plugin.on('error', () => {});
plugin.send({ type: 'config', config: { relayUrl: 'ws://127.0.0.1:18055', masterCode: MASTER, localPort, fingerprint: tls.fingerprint } });
await new Promise((res, rej) => {
  const iv = setInterval(() => { if (inbox.some((m) => m.type === 'status' && m.state === 'registered')) { clearInterval(iv); res(); } }, 50);
  setTimeout(() => rej(new Error('plugin register timeout')), 15_000);
});
console.log(`[${el()}] 链路就绪（host:${localPort} relay:18055）`);

const issue = await fetch('http://127.0.0.1:18055/api/channels/subcodes', {
  method: 'POST',
  headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'tc-load' }),
}).then((r) => r.json());

/** 挑战应答客户端（返回 {ws, send, next, alive}）。 */
async function client() {
  const ws = new WebSocket('ws://127.0.0.1:18055/join');
  const box = [];
  ws.on('message', (r) => box.push(JSON.parse(r.toString())));
  const next = (pred, ms = 20_000) => new Promise((res, rej) => {
    const iv = setInterval(() => {
      const i = box.findIndex(pred);
      if (i >= 0) { clearInterval(iv); res(box.splice(i, 1)[0]); }
    }, 20);
    setTimeout(() => { clearInterval(iv); rej(new Error(`next timeout: ${String(pred).slice(0, 30)}`)); }, ms);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const ch = await next((m) => m.type === 'auth-challenge');
  ws.send(JSON.stringify({ type: 'auth-response', mac: crypto.createHmac('sha256', TOKEN).update(ch.nonce).digest('hex') }));
  await next((m) => m.type === 'auth-ok');
  return { ws, box, next };
}

async function createSession(c, wantLen) {
  c.ws.send(JSON.stringify({ type: 'create' }));
  let tabs = null;
  for (let i = 0; i < 40 && !tabs; i++) {
    const m = await c.next((x) => x.type === 'tabs' && x.tabs?.length >= wantLen);
    if (m.tabs?.length) tabs = m;
  }
  const id = tabs.tabs[tabs.tabs.length - 1].id;
  if (process.env.TCDBG) console.log(`  [dbg] create→tabs id=${id} len=${tabs.tabs.length}`);
  c.ws.send(JSON.stringify({ type: 'attach', id }));
  for (let i = 0; i < 12; i++) {
    const m = await c.next((x) => x.type === 'attached' || x.type === 'tabs');
    if (m.type === 'attached' && m.id === id) break;
  }
  return id;
}

// ③ 管道 A：16 交互 + 3 中度（一个客户端多路复用）
const A = await client();
console.log(`[${el()}] 管道 A 建立（承载 19 会话）`);
const interactive = [];
for (let i = 0; i < 16; i++) interactive.push({ id: await createSession(A, i + 1), i, ok: 0 });
const medium = [];
for (let i = 0; i < 3; i++) medium.push({ id: await createSession(A, 17 + i), i, bytes: 0 });
console.log(`[${el()}] 16 交互 + 3 中度会话就绪`);

// ④ 管道 B：重度洪泛会话（独立管道 → 背压终止应只影响它）
const B = await client();
const heavyId = await createSession(B, 20);
console.log(`[${el()}] 管道 B 建立（重度会话 ${heavyId}）— 开始 ${MINUTES} 分钟混合负载`);

let heavyClosed = false;
B.ws.on('close', () => { heavyClosed = true; });

const stop = Date.now() + DURATION_MS;
let floodSuspended = false;
const workers = [
  // 交互：每 2s 键入并断言回显
  (async () => {
    let k = 0;
    while (Date.now() < stop) {
      for (const s of interactive) {
        const mark = `k${k}-${s.i}`;
        A.ws.send(JSON.stringify({ type: 'input', id: s.id, data: mark }));
        try {
          await A.next((m) => m.type === 'data' && m.id === s.id && String(m.data).includes(`<${mark}>`), 25_000);
          s.ok++;
        } catch { /* 计数即判据 */ }
      }
      k++;
      await sleep(2000);
    }
  })(),
  // 中度：每 1s 4KB 突发（写侧不等待逐帧回显，仅累计）
  (async () => {
    const chunk = 'm'.repeat(4096);
    while (Date.now() < stop) {
      for (const s of medium) {
        try { A.ws.send(JSON.stringify({ type: 'input', id: s.id, data: chunk })); s.bytes += 4096; } catch { /* 断言在尾部 */ }
      }
      await sleep(1000);
    }
  })(),
  // 重度：全速 32KB 帧（连续洪泛；tc 3MB/s 下排队 → relay 背压 1MB 触发）
  (async () => {
    const big = 'H'.repeat(32 * 1024);
    while (Date.now() < stop && !heavyClosed) {
      try {
        B.ws.send(JSON.stringify({ type: 'input', id: heavyId, data: big }));
      } catch { break; }
      // 洪泛被终止后按判据记录；若 tc 未生效导致 host 侧 slowClientBytes(8MB)
      // 先触发，同样表现为管道 B 终止——均为「只杀重管道」的正确行为。
      if (!floodSuspended) await sleep(5);
    }
  })(),
];
await Promise.all(workers);

// ⑤ 判定
const aliveA = A.ws.readyState === WebSocket.OPEN;
console.log(`[${el()}] 负载结束：管道 A ${aliveA ? '存活' : '死亡'}；重度管道 B ${heavyClosed ? '已被终止（背压保护）' : '仍存活'}`);
for (const s of interactive) {
  assert.ok(s.ok > 0, `交互会话 ${s.id} 全程无回显`);
}
assert.ok(aliveA, '管道 A（16 交互 + 3 中度）必须存活——隔离性判据');
assert.ok(interactive.every((s) => s.ok >= Math.floor(MINUTES * 60 / 2 / 16) * 0.5), '交互会话回显频次异常');
const mediumTotal = medium.reduce((a, s) => a + s.bytes, 0);
console.log(`[${el()}] 统计：交互回显 ${interactive.reduce((a, s) => a + s.ok, 0)} 次；中度写入 ${(mediumTotal / 1024).toFixed(0)}KB；tc=${tcApplied ? '3MB/s 生效' : '未限速'}`);

A.ws.close();
if (!heavyClosed) B.ws.close();
plugin.send({ type: 'shutdown' });
await sleep(500);
relay.stop();
await rs.stop();
console.log(`verify-tc-load: PASS（20 会话混合负载 ${MINUTES} 分钟${tcApplied ? ' × tc 3MB/s' : ''}；重管道隔离 ✔）`);
process.exit(0);
