// verify-relay-e2e.mjs — R-M2 核心链路 e2e（relay-verification-standard §2，
// TC-R2-09/10 的可脚本化子集；Electron GUI 用例走 smoke-e2e，另轮扩展）。
//
// 链路：远端假客户端 → relay（进程内）→ relayPlugin（fork 子进程）→
// RemoteServer（进程内，loopback TLS）→ SessionRegistry(FakePtyHost)。
//
// 覆盖：
//   E2E-01 全隧道贯通：join → 首帧 auth(TOKEN) → auth-ok → create/attach →
//          input 回显经两跳返回（字节经 relay+plugin 两次拼接）
//   E2E-02 Token 独立性（TC-R2-09 核心）：子码正确 + Token 错误 → AUTH_DENIED
//   E2E-03 未认证先行业务消息 → AUTH_REQUIRED 断链
//   E2E-04 插件管理 API 代理：fork 消息 → relay 子码签发
//   E2E-05 证书指纹钉扎：错误指纹 → 本机连接中止 → 客户端管道断开
//   E2E-06 relay 首帧认证失败限速：连续 5 次错 Token → 后续连接锁定
//   E2E-07 插件关闭语义：shutdown 消息 → 进程退出、管道全断（fork 形态）
// 前置：node ≥18 + 仓库 node_modules；自编译 TS 至 dist/verify（同 ws-protocol 套件）。

import { execSync } from 'node:child_process';
import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/remoteServer.ts src/main/certManager.ts src/renderer/transport/webSocketTransport.ts ' +
    '--outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);
const { WebSocketTransport } = await import(
  pathToFileURL(path.join(root, 'dist/verify/renderer/transport/webSocketTransport.js')).href
);
const { deriveSessionKey, sealFrame, openFrame } = await import(
  pathToFileURL(path.join(root, 'dist/verify/shared/e2ee.js')).href
);
const {
  newMasterCode, sha256Hex,
} = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'relay-e2e-token-32-chars-okk';

/** 收集 JSON 消息的 ws 客户端。 */
function jsonWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { m = null; }
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    ws.on('open', () => resolve({
      ws, inbox,
      next: (timeoutMs = 6000) => new Promise((res, rej) => {
        if (inbox.length) return res(inbox.shift());
        const t = setTimeout(() => rej(new Error('message timeout')), timeoutMs);
        waiters.push((m) => { clearTimeout(t); res(m); });
      }),
      nextWhere: (pred, timeoutMs = 6000) => {
        const hit = () => {
          const i = inbox.findIndex(pred);
          return i >= 0 ? inbox.splice(i, 1)[0] : null;
        };
        const found = hit();
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('nextWhere timeout')), timeoutMs);
          const iv = setInterval(() => {
            const f = hit();
            if (f) { clearTimeout(t); clearInterval(iv); res(f); }
          }, 20);
        });
      },
    }));
    ws.on('error', reject);
  });
}

async function startRemoteServer(opts = {}) {
  const host = new FakePtyHost();
  const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
  const auth = opts.auth ?? new AuthManager({ accessToken: TOKEN, ...(opts.authOpts) });
  const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-e2e-cert-')));
  const server = new RemoteServer({
    registry, auth, tls, port: 0, host: '127.0.0.1',
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 60_000,
    allowRelayFirstFrameAuth: true,
    relayE2EE: opts.relayE2EE ?? false,
  });
  server.certFingerprint = tls.fingerprint;
  const port = await server.start();
  return { server, registry, host, auth, port, fingerprint: tls.fingerprint };
}

async function startRelay() {
  const master = newMasterCode();
  const server = new RelayServer({
    host: '127.0.0.1', port: 0, log: false,
    config: { masterHashes: [sha256Hex(master)], limits: {} },
    heartbeatIntervalMs: 60_000, joinPendingMs: 5_000, firstFrameTimeoutMs: 5_000,
  });
  const port = await server.start();
  return { server, master, port };
}

/** fork 插件子进程（node 形态；utilityProcess 形态由 smoke-e2e 覆盖）。 */
function forkPlugin(config) {
  const child = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], { stdio: 'pipe' });
  const inbox = [];
  child.on('message', (m) => inbox.push(m));
  const takeWhere = (pred) => {
    const i = inbox.findIndex(pred);
    return i >= 0 ? inbox.splice(i, 1)[0] : null;
  };
  const api = {
    child,
    post: (m) => child.send(m),
    events: inbox,
    waitFor: (pred, timeoutMs = 8000) => new Promise((res, rej) => {
      const found = takeWhere(pred);
      if (found) return res(found);
      const iv = setInterval(() => {
        const f = takeWhere(pred);
        if (f) { clearTimeout(t); clearInterval(iv); res(f); }
      }, 20);
      const t = setTimeout(() => {
        clearInterval(iv);
        rej(new Error(`plugin event timeout (inbox=${JSON.stringify(inbox.map((m) => m.type))})`));
      }, timeoutMs);
    }),
    exited: () => new Promise((res) => child.once('exit', res)),
  };
  child.send({ type: 'config', config });
  return api;
}

/** 远端假客户端经 relay 全链路接入并完成挑战应答认证（R-M4-A）。
 * token=null → 不应答（测未认证门）；token 错 → MAC 错（测 4005）。
 * 注意：必须在返回前 await 挑战并应答——否则调用方的 next() 会抢走
 * auth-challenge 消息导致应答永不发出。 */
async function remoteClient(relayPort, subCode, token = TOKEN) {
  const c = await jsonWs(`ws://127.0.0.1:${relayPort}/join`);
  c.ws.send(JSON.stringify({ v: 1, type: 'join', subCode }));
  if (token !== null) {
    const ch = await c.nextWhere((m) => m.type === 'auth-challenge', 8000);
    const mac = crypto.createHmac('sha256', token).update(ch.nonce).digest('hex');
    c.ws.send(JSON.stringify({ type: 'auth-response', mac }));
  }
  return c;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('E2E-01 全隧道贯通：首帧 auth → create/attach → input 回显两跳返回', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    masterCode: relay.master,
    localPort: rs.port,
    fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');

  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'e2e' }),
  }).then((r) => r.json());

  const c = await remoteClient(relay.port, issue.subCode);
  const okMsg = await c.next();
  assert.equal(okMsg.type, 'auth-ok', '首帧认证成功');
  const tabs = await c.next();
  assert.equal(tabs.type, 'tabs');

  c.ws.send(JSON.stringify({ type: 'create' }));
  const tabs2 = await c.next();
  assert.equal(tabs2.type, 'tabs');
  const id = tabs2.tabs.at(-1).id;
  c.ws.send(JSON.stringify({ type: 'attach', id }));
  const attached = await c.next();
  assert.equal(attached.type, 'attached');

  c.ws.send(JSON.stringify({ type: 'input', id, data: 'hello-relay' }));
  const data = await c.next();
  assert.equal(data.type, 'data');
  assert.equal(data.data, '<hello-relay>', 'PTY 回显经 relay+plugin 两跳返回');

  c.ws.close();
  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-02 Token 独立性（TC-R2-09）：子码正确 + Token 错误 → AUTH_DENIED', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.master}` }, body: '{}',
  }).then((r) => r.json());

  const c = await remoteClient(relay.port, issue.subCode, 'wrong-token-entirely-xxxx');
  const err = await c.next();
  assert.equal(err.type, 'error', '收到错误帧');
  assert.equal(err.code, 4005, 'AUTH_DENIED(4005)：授权码正确也进不了终端');
  await new Promise((res) => c.ws.once('close', res));

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-03 未认证先发业务消息 → AUTH_REQUIRED 断链', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}` }, body: '{}',
  }).then((r) => r.json());

  const c = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  // close 监听必须在触发错误前挂好（4001 会立即断链）
  const closedP = new Promise((res) => c.ws.once('close', res));
  c.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  await sleep(150);
  c.ws.send(JSON.stringify({ type: 'list' })); // 未认证先行业务（挑战亦不应答）
  const err = await c.nextWhere((m) => m.type === 'error');
  assert.equal(err.code, 4001, 'AUTH_REQUIRED(4001)');
  await closedP;
  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-04 插件管理 API 代理：主进程消息 → 子码签发/列表', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');

  const reqId = (cmd, extra = {}) => {
    const id = crypto.randomUUID();
    plugin.post({ type: 'cmd', id, cmd, ...extra });
    return plugin.waitFor((m) => m.type === 'cmd-reply' && m.id === id, 8000);
  };

  const issued = await reqId('issue-subcode', { label: 'proxy', ttlHours: 2 });
  assert.equal(issued.ok, true);
  assert.ok(issued.subCode.startsWith('tsub_v1_'), '代理签发成功');
  const list = await reqId('list-subcodes');
  assert.equal(list.ok, true);
  assert.ok(list.subcodes.some((s) => s.label === 'proxy'), '列表含新子码');

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-05 证书指纹钉扎：错误指纹 → 管道中止 → 客户端断开', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay(); // 独立 relay，避免与正确指纹用例互相接管
  const wrongFp = ('00'.repeat(32).match(/.{2}/g) ?? []).join(':');
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: wrongFp,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}` }, body: '{}',
  }).then((r) => r.json());

  const c = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  c.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const aborted = await plugin.waitFor((m) => m.type === 'pipe-aborted' && /fingerprint/.test(String(m.why)), 5000)
    .catch(() => null);
  await new Promise((res) => { c.ws.once('close', res); setTimeout(res, 2000); });
  c.ws.close();
  assert.ok(aborted, `钉扎失败中止（why=${aborted?.why}）且客户端被断开`);

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-06 首帧认证失败限速：5 次错 Token → 后续连接锁定', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}` }, body: '{}',
  }).then((r) => r.json());

  // AuthManager 语义与 HTTP login() 一致：第 5 次失败（达阈值）即上锁并返回 429，
  // 锁定期间连正确 Token 也进不来
  for (let i = 0; i < 4; i++) {
    const c = await remoteClient(relay.port, issue.subCode, 'bruteforce-attempt-nope');
    const err = await c.next();
    assert.equal(err.code, 4005, `第 ${i + 1} 次 AUTH_DENIED`);
    await new Promise((res) => c.ws.once('close', res));
  }
  const c5 = await remoteClient(relay.port, issue.subCode, 'bruteforce-attempt-nope');
  assert.equal((await c5.next()).code, 4002, '第 5 次（达阈值）RATE_LIMITED(4002)');
  await new Promise((res) => c5.ws.once('close', res));
  // 锁定期间：本机侧 upgrade 直接 401（插件 localWs 被拒 → 管道中止）。
  // 远端客户端的表现 = 管道被断开/收到错误，且绝不能收到 auth-ok。
  // close 监听必须在 join 之前挂好（管道可能在 auth 发出前就已中止）。
  const c6 = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  const c6Closed = new Promise((res) => c6.ws.once('close', () => res({ closed: true })));
  c6.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  await sleep(150);
  c6.ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  const outcome = await Promise.race([
    c6.next(4000).then((m) => ({ msg: m })).catch(() => ({ msg: null })),
    c6Closed,
  ]);
  assert.ok(outcome.closed || outcome.msg?.type === 'error', `锁定期间管道被拒（${JSON.stringify(outcome)}）`);
  assert.notEqual(outcome.msg?.type, 'auth-ok', '锁定期间不得通过认证');
  c6.ws.close();

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-07 插件关闭语义：shutdown → 进程退出 + 既有管道全断', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}` }, body: '{}',
  }).then((r) => r.json());
  const c = await remoteClient(relay.port, issue.subCode);
  assert.equal((await c.next()).type, 'auth-ok');

  const closed = new Promise((res) => c.ws.once('close', res));
  plugin.post({ type: 'shutdown' });
  const [exitCode] = await Promise.all([plugin.exited(), closed]);
  assert.equal(exitCode, 0, '插件进程干净退出');
  assert.ok(plugin.child.killed || exitCode === 0, '无残留进程');

  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-08 relay 重启后插件自动重连（TC-R2-08 fork 子集）：退避重连 → 再注册 → 隧道恢复', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');

  // 拉起一条活跃管道，随后杀掉 relay（控制通道断开 → 管道 reap + 重连排程）
  const issue0 = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}` }, body: '{}',
  }).then((r) => r.json());
  const c0 = await remoteClient(relay.port, issue0.subCode);
  assert.equal((await c0.next()).type, 'auth-ok');

  const port = relay.port;
  const master = relay.master;
  await relay.server.stop();
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'reconnecting', 10_000);

  // 同端口重启 relay（同主码 → channelId 一致，注册即接管）
  const relay2 = new RelayServer({
    host: '127.0.0.1', port, log: false,
    config: { masterHashes: [sha256Hex(master)], limits: {} },
    heartbeatIntervalMs: 60_000, joinPendingMs: 5_000, firstFrameTimeoutMs: 5_000,
  });
  await relay2.start();
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered', 20_000);

  // 重连后全链路恢复：新子码 + 新客户端走通认证与回显
  const issue = await fetch(`http://127.0.0.1:${port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'e2e-08' }),
  }).then((r) => r.json());
  const c = await remoteClient(port, issue.subCode);
  assert.equal((await c.next()).type, 'auth-ok', '重连后首帧认证恢复');
  await c.next(); // 初始 tabs 推送
  c.ws.send(JSON.stringify({ type: 'create' }));
  const tabs2 = await c.next();
  const id = tabs2.tabs.at(-1).id;
  c.ws.send(JSON.stringify({ type: 'attach', id }));
  await c.next(); // attached
  c.ws.send(JSON.stringify({ type: 'input', id, data: 'hi' }));
  const data = await c.next();
  assert.equal(data.data, '<hi>', '重连后回显经全隧道恢复');

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay2.stop();
  await rs.server.stop();
});

// ---------- R-M3：真实 WebSocketTransport（中继模式，WBS-R3-B/C） ----------

/** 轮询断言（transport 事件用）。 */
async function pollUntil(pred, label, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(30);
  }
}

test('E2E-09 TC-R3-01 子集：真实 transport 中继模式 join+首帧 auth → 全流程交互', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'e2e-09' }),
  }).then((r) => r.json());

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket,
    relay: { subCode: issue.subCode, token: TOKEN },
  });
  const states = [];
  tp.onRelayState((s) => states.push(s));
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'gate ready (auth-ok)');
    assert.ok(states.includes('connecting') && states.includes('ready'), `gate 轨迹 ${states}`);

    const tabs = await tp.listTabs();
    assert.ok(Array.isArray(tabs.tabs ?? tabs), 'listTabs 返回数组');
    const created = await tp.createTab({});
    assert.ok(String(created.id).startsWith('tab-'), `createTab → ${created.id}`);

    const attached = new Promise((res) => tp.onAttached((p) => res(p)));
    tp.attach(created.id);
    assert.equal((await attached).id, created.id);

    const echo = new Promise((res) => tp.onData((p) => res(p)));
    tp.input(created.id, 'hi-web');
    const data = await echo;
    assert.ok(String(data.data).includes('<hi-web>'), `transport 回显 ${JSON.stringify(data.data)}`);
  } finally {
    tp.dispose();
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

test('E2E-10 TC-R3-03 子集：坏子码 → 4001 → gate denied 且不无限重试', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket,
    relay: { subCode: 'tsub_v1_totally-wrong-code', token: TOKEN },
  });
  const states = [];
  tp.onRelayState((s) => states.push(s));
  try {
    await pollUntil(() => tp.relayGate === 'denied', 'gate denied after BAD_CODE');
    // 4001 为终态：退避重连不得启动（若重连 gate 会翻回 connecting）
    await sleep(2500);
    assert.equal(tp.relayGate, 'denied', `2.5s 后仍为 denied（无重连），轨迹 ${states}`);
    assert.ok(!states.includes('ready'), '坏子码绝不应就绪');
  } finally {
    tp.dispose();
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

test('E2E-11 TC-R3-05 子集：管道被切断 → 自动重连 → attach replay 补齐断线期输出', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'e2e-11' }),
  }).then((r) => r.json());

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket,
    relay: { subCode: issue.subCode, token: TOKEN },
  });
  tp.onRelayState(() => {});
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'gate ready');
    const created = await tp.createTab({});
    const attached1 = new Promise((res) => tp.onAttached((p) => res(p)));
    tp.attach(created.id);
    await attached1;

    // 切断 relay 侧管道（子码保持有效 → 非终态 → transport 应重连）
    const ch = [...relay.server.store.channels.values()][0];
    assert.ok(ch && ch.pipes.size >= 1, '找到活跃管道');
    for (const pipe of [...ch.pipes]) pipe.kill('severed by test');

    // 断线期间由第二个直连客户端驱动 PTY 产生输出（进 ring buffer）
    await sleep(150);
    const c2 = await remoteClient(relay.port, issue.subCode);
    assert.equal((await c2.next()).type, 'auth-ok');
    c2.ws.send(JSON.stringify({ type: 'attach', id: created.id }));
    await c2.nextWhere((m) => m.type === 'attached' && m.id === created.id);
    c2.ws.send(JSON.stringify({ type: 'input', id: created.id, data: 'during-gap' }));
    const gapEcho = await c2.nextWhere((m) => m.type === 'data' && String(m.data).includes('<during-gap>'));
    assert.ok(gapEcho, '断线期输出已产生');

    // transport 自动重连（1s 基线退避）→ re-attach → replay 含断线期输出
    const replayAttached = new Promise((res) => tp.onAttached((p) => p.id === created.id && res(p)));
    const got = await replayAttached;
    assert.ok(String(got.replay).includes('<during-gap>'), `replay 补齐（${String(got.replay).slice(0, 80)}…）`);
    await pollUntil(() => tp.relayGate === 'ready', '重连后 gate ready');
  } finally {
    tp.dispose();
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

test('E2E-12 TC-R4-01 挑战应答：Token 不明文过中继 + nonce 单次有效 + 明文 auth 拒收', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'e2e-12' }),
  }).then((r) => r.json());

  // ① 正常挑战应答：nonce 到 → 回正确 MAC → auth-ok
  const a = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  a.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const chA = await a.nextWhere((m) => m.type === 'auth-challenge');
  assert.ok(chA.nonce?.length >= 32, 'nonce 已下发');
  a.ws.send(JSON.stringify({
    type: 'auth-response',
    mac: crypto.createHmac('sha256', TOKEN).update(chA.nonce).digest('hex'),
  }));
  assert.equal((await a.next()).type, 'auth-ok', '挑战应答成功');
  a.ws.close();

  // ② nonce 每连接不同 + 旧 MAC 重放无效（单次有效）
  const b = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  b.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const chB = await b.nextWhere((m) => m.type === 'auth-challenge');
  assert.notEqual(chB.nonce, chA.nonce, '两次连接 nonce 不同');
  const staleMac = crypto.createHmac('sha256', TOKEN).update(chA.nonce).digest('hex');
  const bClosed = new Promise((res) => b.ws.once('close', res));
  b.ws.send(JSON.stringify({ type: 'auth-response', mac: staleMac }));
  const errB = await b.nextWhere((m) => m.type === 'error');
  assert.equal(errB.code, 4005, `重放旧 MAC 被拒（${errB.code}）`);
  await bClosed;

  // ③ 明文 auth 不再被接受：Token 不得以明文经过中继
  const c = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  c.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  await c.nextWhere((m) => m.type === 'auth-challenge');
  const cClosed = new Promise((res) => c.ws.once('close', res));
  c.ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  const errC = await c.nextWhere((m) => m.type === 'error');
  assert.equal(errC.code, 4001, `明文 auth 被拒 AUTH_REQUIRED（${errC.code}）`);
  await cClosed;

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

test('E2E-13 TC-R4-02 子集：E2E 加密（AES-256-GCM）—— 中继只见密文 + 违例/篡改被拒', async () => {
  const rs = await startRemoteServer({ relayE2EE: true });
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const issue = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'e2e-13' }),
  }).then((r) => r.json());

  // ①-④ 原始客户端：挑战应答 + enc 协商 + 密文往返 + 线路观察
  const c = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  const wire = []; // 旁观者视角（= relay/插件可见字节）
  c.ws.on('message', (raw) => wire.push(String(raw)));
  c.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const ch = await c.nextWhere((m) => m.type === 'auth-challenge');
  const mac = crypto.createHmac('sha256', TOKEN).update(ch.nonce).digest('hex');
  c.ws.send(JSON.stringify({ type: 'auth-response', mac, enc: 1 }));
  const okMsg = await c.next();
  assert.equal(okMsg.type, 'auth-ok', '认证成功');
  assert.equal(okMsg.enc, 1, 'host 确认启用加密');
  const key = await deriveSessionKey(TOKEN, ch.nonce);

  const tabsEnv = await c.nextWhere((m) => m.type === 'secure');
  const tabsInner = JSON.parse(await openFrame(key, JSON.stringify(tabsEnv)));
  assert.equal(tabsInner.type, 'tabs', '密文可解 → tabs');

  const listSealed = await sealFrame(key, JSON.stringify({ type: 'list' }));
  c.ws.send(listSealed);
  const env2 = await c.nextWhere((m) => m.type === 'secure');
  const inner2 = JSON.parse(await openFrame(key, JSON.stringify(env2)));
  assert.equal(inner2.type, 'tabs', '密文业务往返（list→tabs）');
  assert.notEqual(tabsEnv.iv, env2.iv, 'IV 每帧不同');

  const okIdx = wire.findIndex((w) => w.includes('"auth-ok"'));
  assert.ok(okIdx >= 0, 'auth-ok 在线路（明文控制面）');
  const after = wire.slice(okIdx + 1).map((w) => JSON.parse(w));
  assert.ok(after.length >= 2, 'auth-ok 后有数据帧');
  assert.ok(after.every((m) => m.type === 'secure'), 'auth-ok 后线路全部为 secure 信封（relay 只见密文）');
  c.ws.close();

  // ⑤ 加密连接上发明文业务帧 → BAD_MESSAGE 断链
  const b = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  const bClosed = new Promise((res) => b.ws.once('close', res));
  b.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const chB = await b.nextWhere((m) => m.type === 'auth-challenge');
  b.ws.send(JSON.stringify({
    type: 'auth-response',
    mac: crypto.createHmac('sha256', TOKEN).update(chB.nonce).digest('hex'),
    enc: 1,
  }));
  await b.nextWhere((m) => m.type === 'auth-ok' && m.enc === 1);
  const keyB = await deriveSessionKey(TOKEN, chB.nonce);
  b.ws.send(JSON.stringify({ type: 'list' })); // 明文违例
  let errInner = null;
  for (let i = 0; i < 10 && !errInner; i++) {
    const env = await b.nextWhere((m) => m.type === 'secure'); // 跳过 auth-ok 附带的 tabs 推送
    const inner = JSON.parse(await openFrame(keyB, JSON.stringify(env)));
    if (inner.type === 'error') errInner = inner;
  }
  assert.ok(errInner, '违例回应为密文 error');
  assert.equal(errInner.code, 4004, `BAD_MESSAGE（${errInner.code}）`);
  await bClosed;

  // ⑥ 密文篡改（GCM tag 校验失败）→ 断链
  const d = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
  const dClosed = new Promise((res) => d.ws.once('close', res));
  d.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  const chD = await d.nextWhere((m) => m.type === 'auth-challenge');
  d.ws.send(JSON.stringify({
    type: 'auth-response',
    mac: crypto.createHmac('sha256', TOKEN).update(chD.nonce).digest('hex'),
    enc: 1,
  }));
  await d.nextWhere((m) => m.type === 'auth-ok' && m.enc === 1);
  const keyD = await deriveSessionKey(TOKEN, chD.nonce);
  const tampered = JSON.parse(await sealFrame(keyD, JSON.stringify({ type: 'list' })));
  tampered.ct = (tampered.ct.slice(0, -2)) + (tampered.ct.endsWith('A=') ? 'B=' : 'A='); // 翻转尾部
  d.ws.send(JSON.stringify(tampered));
  await dClosed; // GCM 校验失败 → BAD_MESSAGE 断链

  // ⑦ 真实 transport 加密全流程（seal/open 内建）
  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket,
    relay: { subCode: issue.subCode, token: TOKEN },
  });
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'gate ready (encrypted)');
    const created = await tp.createTab({});
    assert.ok(String(created.id).startsWith('tab-'), `createTab → ${created.id}`);
    const attached = new Promise((res) => tp.onAttached((p) => res(p)));
    tp.attach(created.id);
    assert.equal((await attached).id, created.id);
    const echo = new Promise((res) => tp.onData((p) => res(p)));
    tp.input(created.id, 'hi-e2ee');
    const data = await echo;
    assert.ok(String(data.data).includes('<hi-e2ee>'), `加密通道回显 ${JSON.stringify(data.data)}`);
  } finally {
    tp.dispose();
  }

  plugin.post({ type: 'shutdown' });
  await plugin.exited();
  await relay.server.stop();
  await rs.server.stop();
});

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
    console.error(`    ${err?.stack?.split('\n').slice(0, 6).join('\n    ') ?? err}`);
  }
}
console.log(`\nverify-relay-e2e: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
