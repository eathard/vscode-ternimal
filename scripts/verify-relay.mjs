// verify-relay.mjs — R-M1 验收套件（relay-verification-standard.md §2/§3.1）。
//
// 覆盖 TC-R1-01～12：主码哈希签发、register/join/pipe 全流程、字节级透传、
// 错码拒绝与限速锁定、子码过期/吊销、挂起超时、接管收割、并发上限、
// 背压终止、管理 API、静态托管与路径穿越、心跳收割。
//
// 前置：node ≥18 + 仓库 node_modules（ws）；自起 --insecure relay 实例，
// 时序参数注入使秒级跑完分钟级语义（对齐 verify-ratelimit 的先例）。

import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  newMasterCode, sha256Hex, deriveChannelId,
} = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);
const { MemoryStore } = await import(pathToFileURL(path.join(root, 'relay/src/store.mjs')).href);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opened = (ws) => new Promise((res, rej) => {
  ws.once('open', () => res(ws));
  ws.once('error', rej);
});
const closed = (ws, timeoutMs = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('close timeout')), timeoutMs);
  ws.once('close', (code) => { clearTimeout(t); res(code); });
  ws.once('error', (err) => { clearTimeout(t); rej(err); });
});
const nextMessage = (ws, timeoutMs = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('message timeout')), timeoutMs);
  ws.once('message', (data) => { clearTimeout(t); res(data); });
});
/** 收集到的帧（供透传完整性比对）。 */
const collect = (ws) => {
  const out = { frames: [], done: null, bytes: 0 };
  out.done = new Promise((res) => {
    ws.on('message', (data) => { out.frames.push(data); out.bytes += data.length; res(); });
  });
  return out;
};

/** 起一个独立 relay 实例（每用例独立，参数量身注入）。 */
async function makeRelay(overrides = {}) {
  const master = newMasterCode();
  const store = new MemoryStore();
  const server = new RelayServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    store,
    config: { masterHashes: [sha256Hex(master)], limits: {}, trustedProxy: false },
    // 默认放宽时序避免用例间干扰；个别用例显式收紧
    heartbeatIntervalMs: 60_000,
    joinPendingMs: 5_000,
    firstFrameTimeoutMs: 3_000,
    ...overrides,
  });
  const port = await server.start();
  const url = (p) => `ws://127.0.0.1:${port}${p}`;
  const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return { server, store, master, port, url, http };
}

/** host 侧：注册控制通道，返回 offer 等待器。 */
async function hostDial(url, master) {
  const ws = new WebSocket(url('/control'));
  await opened(ws);
  ws.send(JSON.stringify({ v: 1, type: 'register', masterCode: master }));
  const reg = JSON.parse((await nextMessage(ws)).toString());
  assert.equal(reg.type, 'registered');
  const offers = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'client-offer') (waiters.shift() ?? offers.push(m));
  });
  return {
    ws, channelId: reg.channelId,
    waitOffer: () => new Promise((res) => {
      const t = setInterval(() => { if (offers.length) { res(offers.shift()); clearInterval(t); } }, 5);
    }),
  };
}

/** 客户端 join（不发首帧以外的任何内容）。 */
async function clientJoin(url, subCode) {
  const ws = new WebSocket(url('/join'));
  await opened(ws);
  ws.send(JSON.stringify({ v: 1, type: 'join', subCode }));
  return ws;
}

/** host 拨管道。 */
async function hostPipe(url, master, clientId) {
  const ws = new WebSocket(url('/pipe'));
  await opened(ws);
  ws.send(JSON.stringify({ type: 'pipe', masterCode: master, clientId }));
  return ws;
}

/** 签发子码（走管理 API，主码鉴权）。 */
async function issueSubcode(http, master, body = {}) {
  const res = await http('/api/channels/subcodes', {
    method: 'POST',
    headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, 'issue subcode 201');
  return await res.json();
}

/** 裸 TCP WS 握手（不回 pong，用于心跳收割用例）。 */
function rawWsHandshake(port, pathname) {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    sock.once('data', (d) => {
      if (d.toString().startsWith('HTTP/1.1 101')) res(sock);
      else rej(new Error('handshake rejected: ' + d.toString().split('\r\n')[0]));
    });
    sock.once('error', rej);
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- TC-R1-01 主码签发 CLI ----------

test('TC-R1-01 add-master：哈希落盘、明文仅显示一次、可验证', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cfg-'));
  const cfgFile = path.join(dir, 'relay-config.json');
  const run = () => execFileSync('node', [path.join(root, 'relay/cli.mjs'), 'add-master', '--config', cfgFile], { encoding: 'utf8' });
  const out1 = run();
  const code = out1.match(/trelay_v1_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(code, 'CLI 输出含主码明文');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  // 计费生命周期后：主码入 masters[]（缺省永久）；哈希/明文断言语义不变
  assert.equal(cfg.masters.length, 1);
  assert.equal(cfg.masters[0].hash, sha256Hex(code), '配置只存 SHA-256 哈希');
  assert.equal(cfg.masters[0].expiresAt, null, '缺省永久（不带 --days）');
  assert.ok(!JSON.stringify(cfg).includes(code), '明文不落盘');
  const out2 = run();
  const code2 = out2.match(/trelay_v1_[A-Za-z0-9_-]+/)?.[0];
  assert.notEqual(code2, code, '两次签发不同码');
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).masters.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- TC-R1-02 管道贯通 + 字节级透传 ----------

test('TC-R1-02 register/join/pipe 全流程，二进制+文本帧逐字节透传', async () => {
  const r = await makeRelay();
  const host = await hostDial(r.url, r.master);
  const { subCode } = await issueSubcode(r.http, r.master);

  const client = await clientJoin(r.url, subCode);
  const offer = await host.waitOffer();
  assert.equal(offer.type, 'client-offer');
  assert.ok(offer.clientId);

  const pipeWs = await hostPipe(r.url, r.master, offer.clientId);
  await sleep(50); // 等对接完成

  const c2h = crypto.randomBytes(4096);
  const h2c = crypto.randomBytes(4096);
  const textUp = JSON.stringify({ type: 'input', id: 'tab-1', data: 'ls -la\n' });
  const textDown = JSON.stringify({ type: 'data', id: 'tab-1', data: 'total 0\n' });

  const pipeGot = collect(pipeWs);
  const clientGot = collect(client);
  client.send(c2h);
  client.send(textUp);
  pipeWs.send(h2c);
  pipeWs.send(textDown);
  await Promise.all([pipeGot.done, clientGot.done]);

  assert.deepEqual(pipeGot.frames[0], c2h, 'client→host 二进制逐字节一致');
  assert.equal(pipeGot.frames[1].toString(), textUp, 'client→host 文本一致');
  assert.deepEqual(clientGot.frames[0], h2c, 'host→client 二进制逐字节一致');
  assert.equal(clientGot.frames[1].toString(), textDown, 'host→client 文本一致');

  const ch = r.store.getChannel(host.channelId);
  assert.ok(ch.stats.bytesIn >= c2h.length + textUp.length, '字节计数(client→host)');
  assert.ok(ch.stats.bytesOut >= h2c.length + textDown.length, '字节计数(host→client)');

  await r.server.stop();
});

// ---------- TC-R1-03 错主码 + 限速锁定 ----------

test('TC-R1-03 错主码 register：前 5 次 BAD_CODE，第 6 次 RATE_LIMITED', async () => {
  const r = await makeRelay();
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const ws = new WebSocket(r.url('/control'));
    await opened(ws);
    ws.send(JSON.stringify({ v: 1, type: 'register', masterCode: 'trelay_v1_wrong' }));
    await nextMessage(ws); // error 帧
    codes.push(await closed(ws));
  }
  assert.deepEqual(
    codes.map((c, i) => (i < 5 ? 4001 : c)),
    [4001, 4001, 4001, 4001, 4001, 4002],
    '前 5 次 BAD_CODE(4001)，第 6 次 RATE_LIMITED(4002)'
  );
  await r.server.stop();
});

// ---------- TC-R1-04 过期 / 吊销子码 ----------

test('TC-R1-04 过期与已吊销子码 join 被拒，不产生 offer', async () => {
  const r = await makeRelay();
  const host = await hostDial(r.url, r.master);
  const exp = await issueSubcode(r.http, r.master, { ttlHours: 1 });
  r.store.getChannel(host.channelId).subcodes.get(exp.id).expiresAt = Date.now() - 1; // 人工过期
  const ws1 = await clientJoin(r.url, exp.subCode);
  await nextMessage(ws1);
  assert.equal(await closed(ws1), 4008, '过期 → 4008');

  const rev = await issueSubcode(r.http, r.master);
  const del = await r.http(`/api/channels/subcodes/${rev.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${r.master}` },
  });
  assert.equal(del.status, 200, '吊销 200');
  const ws2 = await clientJoin(r.url, rev.subCode);
  await nextMessage(ws2);
  assert.equal(await closed(ws2), 4009, '已吊销 → 4009');
  await sleep(100);
  assert.equal(host.ws.readyState, WebSocket.OPEN, 'host 控制通道不受影响');
  await r.server.stop();
});

// ---------- TC-R1-05 挂起超时 ----------

test('TC-R1-05 join 后 host 不拨管道 → 挂起超时清理、无残留', async () => {
  const r = await makeRelay({ joinPendingMs: 200 });
  const host = await hostDial(r.url, r.master);
  const { subCode } = await issueSubcode(r.http, r.master);
  const client = await clientJoin(r.url, subCode);
  const offer = await host.waitOffer();
  assert.ok(offer.clientId);
  await nextMessage(client); // error 帧
  assert.equal(await closed(client), 4005, 'PENDING_TIMEOUT(4005)');
  await sleep(50);
  const ch = r.store.getChannel(host.channelId);
  assert.equal(ch.pending.size, 0, '挂起表已清理');
  await r.server.stop();
});

// ---------- TC-R1-06 同主码重复注册 → 接管收割 ----------

test('TC-R1-06 重复 register：旧控制连接与旧管道全部收割', async () => {
  const r = await makeRelay();
  const hostA = await hostDial(r.url, r.master);
  const { subCode } = await issueSubcode(r.http, r.master);
  const client = await clientJoin(r.url, subCode);
  const offer = await hostA.waitOffer();
  const pipeA = await hostPipe(r.url, r.master, offer.clientId);
  await sleep(50);

  // 先挂监听再触发接管（避免 close 事件先于监听器注册的竞态）
  const oldControlClosed = closed(hostA.ws);
  const tunnelClosed = Promise.all([closed(client), closed(pipeA)]);
  const hostB = await hostDial(r.url, r.master); // 同主码 → 接管
  assert.equal(await oldControlClosed, 4010, '旧控制连接 TAKEOVER(4010)');
  await tunnelClosed;
  const ch = r.store.getChannel(hostA.channelId);
  assert.equal(ch.pipes.size, 0);
  assert.equal(ch.pending.size, 0);
  assert.equal(hostB.ws.readyState, WebSocket.OPEN, '新控制通道存活');
  // 子码保留（接管不动子码记录）
  assert.equal(ch.subcodes.size, 1);
  await r.server.stop();
});

// ---------- TC-R1-07 并发管道上限 ----------

test('TC-R1-07 每通道 4 条管道，第 5 个 join → BUSY', async () => {
  const r = await makeRelay();
  const host = await hostDial(r.url, r.master);
  const { subCode } = await issueSubcode(r.http, r.master);
  for (let i = 0; i < 4; i++) {
    const c = await clientJoin(r.url, subCode);
    const offer = await host.waitOffer();
    await hostPipe(r.url, r.master, offer.clientId);
    await sleep(30);
  }
  const fifth = await clientJoin(r.url, subCode);
  await nextMessage(fifth);
  assert.equal(await closed(fifth), 4004, 'BUSY(4004)');
  await r.server.stop();
});

// ---------- TC-R1-08 背压终止 ----------

test('TC-R1-08 慢客户端背压：仅该管道终止，其余连接不受影响', async () => {
  const r = await makeRelay({ backpressureBytes: 32 * 1024 });
  const host = await hostDial(r.url, r.master);
  const { subCode } = await issueSubcode(r.http, r.master);
  const client = await clientJoin(r.url, subCode);
  const offer = await host.waitOffer();
  const pipeWs = await hostPipe(r.url, r.master, offer.clientId);
  await sleep(50);

  // 第二对客户端（对照组，应存活）
  const client2 = await clientJoin(r.url, subCode);
  const offer2 = await host.waitOffer();
  const pipe2 = await hostPipe(r.url, r.master, offer2.clientId);
  await sleep(50);

  client._socket.pause(); // 停止读取 → TCP 背压 → relay 发送队列膨胀
  const chunk = crypto.randomBytes(64 * 1024);
  for (let i = 0; i < 64; i++) pipeWs.send(chunk); // 4MB 突发

  await Promise.race([closed(pipeWs), sleep(8000).then(() => assert.fail('管道未被终止'))]);
  await closed(client).catch(() => {});
  assert.equal(pipe2.readyState, WebSocket.OPEN, '对照管道不受波及');
  assert.equal(host.ws.readyState, WebSocket.OPEN, '控制通道不受波及');
  await r.server.stop();
});

// ---------- TC-R1-09 子码管理 API ----------

test('TC-R1-09 子码 API：签发/列表/吊销/鉴权失败', async () => {
  const r = await makeRelay();
  const host = await hostDial(r.url, r.master);
  const issued = await issueSubcode(r.http, r.master, { label: 'phone', ttlHours: 2 });
  assert.ok(issued.subCode.startsWith('tsub_v1_'));
  assert.ok(issued.expiresAt > Date.now());

  const bad = await r.http('/api/channels/subcodes', {
    method: 'POST',
    headers: { authorization: 'Bearer trelay_v1_nope', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(bad.status, 401, '错主码 API 401');

  const listRes = await r.http('/api/channels/subcodes', { headers: { authorization: `Bearer ${r.master}` } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.subcodes.length, 1);
  assert.equal(list.subcodes[0].label, 'phone');
  assert.equal(list.subcodes[0].code, issued.subCode);

  const del = await r.http(`/api/channels/subcodes/${issued.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${r.master}` },
  });
  assert.equal(del.status, 200);
  const miss = await r.http('/api/channels/subcodes/unknown', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${r.master}` },
  });
  assert.equal(miss.status, 404, '吊销不存在 → 404');
  assert.equal(host.ws.readyState, WebSocket.OPEN);
  await r.server.stop();
});

// ---------- TC-R1-10 静态托管 / 路径穿越 / health ----------

test('TC-R1-10 静态托管与路径穿越守卫', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-webroot-'));
  const dir = path.join(base, 'web');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>relay web</html>');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'TOPSECRET'); // webRoot 之外
  const r = await makeRelay({ webRoot: dir });

  const home = await r.http('/');
  assert.equal(home.status, 200);
  assert.equal(await home.text(), '<html>relay web</html>');

  const health = await r.http('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  // fetch 会先规范化路径，穿越语义必须用裸 TCP 原样发送
  for (const evil of ['/static/../secret.txt', '/../secret.txt', '/static/%2e%2e/secret.txt']) {
    const resp = await new Promise((res) => {
      const sock = net.connect(r.port, '127.0.0.1', () => {
        sock.write(`GET ${evil} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => res(buf));
      setTimeout(() => { sock.destroy(); res(buf); }, 2000);
    });
    const status = Number(resp.split(' ')[1]);
    assert.ok(status === 403 || status === 404, `${evil} 被拒（got ${status}）`);
    assert.ok(!resp.includes('TOPSECRET'), `${evil} 未泄露内容`);
  }
  fs.rmSync(base, { recursive: true, force: true });
  await r.server.stop();
});

// ---------- TC-R1-11 心跳收割 ----------

test('TC-R1-11 两周期无 pong → 连接与挂起状态收割', async () => {
  const r = await makeRelay({ heartbeatIntervalMs: 120 });
  const host = await hostDial(r.url, r.master);
  const { subCode } = await issueSubcode(r.http, r.master);
  // 裸握手客户端：完成 join 首帧（自织 WS 帧）后对 relay 的 ping 永不回应
  const sock = await rawWsHandshake(r.port, '/join');
  const payload = Buffer.from(JSON.stringify({ v: 1, type: 'join', subCode }));
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload).map((b, i) => b ^ mask[i % 4]);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81; // FIN + text
  frame[1] = 0x80 | payload.length; // mask + len（<126）
  mask.copy(frame, 2);
  masked.copy(frame, 6);
  sock.write(frame);

  const offer = await host.waitOffer();
  assert.ok(offer.clientId, 'join 已挂起并产生 offer');
  await new Promise((res) => sock.once('close', res).once('end', res));
  await sleep(100);
  const ch = r.store.getChannel(host.channelId);
  assert.equal(ch.pending.size, 0, '挂起状态已收割');
  assert.equal(host.ws.readyState, WebSocket.OPEN, '正常回 pong 的控制通道存活');
  await r.server.stop();
});

// ---------- 首帧超时（FIRST_FRAME_TIMEOUT，TC-R1-02 附带语义） ----------

test('首帧守卫：静默连接超时断链（400x）', async () => {
  const r = await makeRelay({ firstFrameTimeoutMs: 150 });
  const ws = new WebSocket(r.url('/control'));
  await opened(ws);
  const code = await closed(ws, 3000);
  assert.ok(code === 4012 || code === 1006, `超时断链（got ${code}）`);
  await r.server.stop();
});

// ---------- 控制通道首帧后续消息 → BAD_MESSAGE ----------

test('register 后控制通道再发消息 → BAD_MESSAGE 断链', async () => {
  const r = await makeRelay();
  const host = await hostDial(r.url, r.master);
  host.ws.send(JSON.stringify({ v: 1, type: 'register', masterCode: r.master }));
  await nextMessage(host.ws);
  assert.equal(await closed(host.ws), 4006, 'BAD_MESSAGE(4006)');
  await r.server.stop();
});

// ---------- 未知路径 upgrade 拒绝 ----------

test('未知路径 WS upgrade 被拒', async () => {
  const r = await makeRelay();
  const ws = new WebSocket(r.url('/nope'));
  await assert.rejects(() => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }));
  await r.server.stop();
});

// ---------- 汇总 ----------

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✘ ${name}`);
    console.error(`    ${err?.stack?.split('\n').slice(0, 4).join('\n    ') ?? err}`);
  }
}
console.log(`\nverify-relay: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
