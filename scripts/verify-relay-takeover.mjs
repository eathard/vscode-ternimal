// B-08 意图抢占语义（方案一：踢人需人工意图，被踢者驻停 —— 战争结构性终止）
// 覆盖：legacy last-wins 兼容 / 占用拒绝 / 强制接管+taken-over / 僵尸自动接管 / 占用后自愈
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const { MemoryStore } = await import(pathToFileURL(path.join(root, 'relay/src/store.mjs')).href);
const { newMasterCode, sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opened = (ws) => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const closed = (ws) => new Promise((res) => ws.once('close', res));
const nextMessage = (ws, timeout = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('message timeout')), timeout);
  ws.once('message', (d) => { clearTimeout(t); res(d); });
});

async function makeRelay() {
  const master = newMasterCode();
  const server = new RelayServer({
    host: '127.0.0.1', port: 0, log: false, store: new MemoryStore(),
    config: { masterHashes: [sha256Hex(master)], limits: {}, trustedProxy: false },
    heartbeatIntervalMs: 60_000,
  });
  const port = await server.start();
  const url = (p) => `ws://127.0.0.1:${port}${p}`;
  return { server, master, url, port };
}

/** 注册一条控制连接；frame 里可带 proto/force 附加字段。 */
async function register(url, master, frame = {}) {
  const ws = new WebSocket(url('/control'));
  await opened(ws);
  ws.send(JSON.stringify({ v: 1, type: 'register', masterCode: master, ...frame }));
  return { ws, first: JSON.parse((await nextMessage(ws)).toString()) };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✘ ${name}\n    ${err?.stack ?? err}`); }
}

console.log('B-08 intent-preempt takeover semantics');

await test('T-01 legacy（无 proto/force）注册维持 last-wins：新踢旧（滚动升级兼容）', async () => {
  const { server, url, master } = await makeRelay();
  const a = await register(url, master);
  const aErrP = nextMessage(a.ws); // 先挂监听再触发（EventEmitter 不缓存已发事件）
  const b = await register(url, master); // legacy 帧
  assert.equal(b.first.type, 'registered');
  const aMsg = JSON.parse((await aErrP).toString());
  assert.equal(aMsg.type, 'error'); // 旧端被踢（superseded）
  await closed(a.ws);
  b.ws.close(); await server.stop();
});

await test('T-02 新客户端非 force 撞上活连接 → occupied 拒绝，持有方不受影响', async () => {
  const { server, url, master } = await makeRelay();
  const a = await register(url, master, { proto: 2 });
  const b = await register(url, master, { proto: 2 }); // 非 force，旧端活着（ws 自动回 pong）
  assert.equal(b.first.type, 'occupied');
  await closed(b.ws);
  // A 仍是持有方：再来一个 legacy 注册照样踢 A 成功（A 活着但 legacy 直接接管）
  const c = await register(url, master);
  assert.equal(c.first.type, 'registered');
  await closed(a.ws); c.ws.close(); await server.stop();
});

await test('T-03 force 接管：旧端先收 taken-over 再被踢；新端注册成功', async () => {
  const { server, url, master } = await makeRelay();
  const a = await register(url, master, { proto: 2 });
  const aTakenP = nextMessage(a.ws); // 先挂监听再触发
  const b = await register(url, master, { proto: 2, force: true });
  assert.equal(b.first.type, 'registered');
  const aTaken = JSON.parse((await aTakenP).toString());
  assert.equal(aTaken.type, 'taken-over', '旧端必须收到 taken-over 以驻停');
  await closed(a.ws);
  b.ws.close(); await server.stop();
});

await test('T-04 僵尸旧连接（ping 不回）→ 非 force 注册 ≤3.5s 自动接管（换机零感知）', async () => {
  const { server, url, master } = await makeRelay();
  const a = await register(url, master, { proto: 2 });
  // 构造僵尸：吞掉 pong（探测 ping 无响应）——挂一次性监听器拦截法不可行，直接摧毁传输层但保服务端 control 记录
  // 最贴近真实的模拟：socket 暂停（内核不再回任何帧，连接半开）
  a.ws._socket.pause();
  await sleep(50);
  const t0 = Date.now();
  const b = await register(url, master, { proto: 2 });
  assert.equal(b.first.type, 'registered', '僵尸必须被自动接管');
  assert.ok(Date.now() - t0 < 3500, `接管耗时应 ≤3.5s（探测窗 2.5s），实际 ${Date.now() - t0}ms`);
  b.ws.close();
  a.ws.terminate();
  await server.stop();
});

await test('T-05 占用自愈：持有方退出后，下一个非 force 注册直接成功', async () => {
  const { server, url, master } = await makeRelay();
  const a = await register(url, master, { proto: 2 });
  const b1 = await register(url, master, { proto: 2 });
  assert.equal(b1.first.type, 'occupied');
  await closed(b1.ws);
  a.ws.close(); // 持有方主动退出
  await sleep(300);
  const b2 = await register(url, master, { proto: 2 });
  assert.equal(b2.first.type, 'registered', '无持有方时非 force 也应直接注册');
  b2.ws.close(); await server.stop();
});

console.log(`verify-relay-takeover: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
