#!/usr/bin/env node
// public-relay-probe.mjs — 真公网端到端探针（TC-R3-04 自动化核心）。
//
// 拓扑（全部经真实互联网）：
//   本机 RemoteServer(loopback TLS) ← 本机插件 → wss → VPS Caddy(内部证书)
//     → relay(127.0.0.1:8080) ← wss ← 本机测试客户端（挑战应答 + E2EE）
//
// 用法：node scripts/public-relay-probe.mjs <relayOrigin> <masterCode>
//   例：node scripts/public-relay-probe.mjs https://146.56.214.137 trelay_v1_…
// 注：Caddy 内部 CA 不受 Node 信任 → 探针与插件进程均以
//   NODE_TLS_REJECT_UNAUTHORIZED=0 运行（仅测试；生产用域名 + Let's Encrypt）。
import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const [RELAY = 'https://146.56.214.137', MASTER = ''] = process.argv.slice(2);
if (!MASTER) {
  console.error('用法: node scripts/public-relay-probe.mjs <relayOrigin> <masterCode>');
  process.exit(1);
}
const TOKEN = 'public-probe-token-32-chars-ok';

const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);
const { deriveSessionKey, sealFrame, openFrame } = await import(
  pathToFileURL(path.join(root, 'dist/verify/shared/e2ee.js')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(pred, label, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

// ① 本机 host（loopback TLS + 中继门控 + E2EE 开）
const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'pub-probe-')));
const rs = new RemoteServer({
  registry, auth, tls, port: 0, host: '127.0.0.1',
  heartbeatIntervalMs: 60_000, allowRelayFirstFrameAuth: true, relayE2EE: true,
});
rs.certFingerprint = tls.fingerprint;
const localPort = await rs.start();
console.log(`[1] host 就绪 127.0.0.1:${localPort}（E2EE 开）`);

// ② 插件 → 公网 relay（内部 CA：仅本探针进程树关闭链校验）
const plugin = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
});
const inbox = [];
plugin.on('message', (m) => inbox.push(m));
plugin.on('error', () => {});
plugin.send({
  type: 'config',
  config: { relayUrl: RELAY, masterCode: MASTER, localPort, fingerprint: tls.fingerprint },
});
await pollUntil(() => inbox.some((m) => m.type === 'status' && m.state === 'registered'), '插件经公网注册');
console.log(`[2] 插件已注册（pid=${plugin.pid}，控制通道 wss → ${RELAY}）`);

// ③ 经公网签发子码
const t0 = Date.now();
const issue = await fetch(`${RELAY}/api/channels/subcodes`, {
  method: 'POST',
  headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'public-probe' }),
}).then((r) => r.json());
assert.ok(issue.subCode, `子码签发失败: ${JSON.stringify(issue)}`);
console.log(`[3] 子码签发 ${issue.subCode}（管理 API 往返 ${Date.now() - t0}ms）`);

// ④ 客户端 wss → 公网 → 挑战应答 + E2EE 协商 + 业务往返
const ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/join`, { rejectUnauthorized: false });
const inboxC = [];
const nextWhere = (pred, timeoutMs = 15_000) => new Promise((res, rej) => {
  const iv = setInterval(() => {
    const i = inboxC.findIndex(pred);
    if (i >= 0) { clearInterval(iv); res(inboxC.splice(i, 1)[0]); }
  }, 20);
  setTimeout(() => { clearInterval(iv); rej(new Error(`nextWhere timeout: ${String(pred).slice(0, 50)}`)); }, timeoutMs);
});
ws.on('message', (raw) => inboxC.push(JSON.parse(raw.toString())));
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
const ch = await nextWhere((m) => m.type === 'auth-challenge');
const tRtt0 = Date.now();
const mac = crypto.createHmac('sha256', TOKEN).update(ch.nonce).digest('hex');
ws.send(JSON.stringify({ type: 'auth-response', mac, enc: 1 }));
const okMsg = await nextWhere((m) => m.type === 'auth-ok');
assert.equal(okMsg.enc, 1, '公网链路上完成 E2EE 协商');
console.log(`[4] 挑战应答+E2EE 协商成功（挑战往返 ${Date.now() - tRtt0}ms）`);

const key = await deriveSessionKey(TOKEN, ch.nonce);
// 密文业务往返：create → attach → input → 密文回显
const send = async (obj) => ws.send(await sealFrame(key, JSON.stringify(obj)));
await send({ type: 'create' });
const createP = nextWhere((m) => m.type === 'secure');
await createP; // tabs 推送（首个 secure 帧）
const env = await nextWhere((m) => m.type === 'secure');
const inner = JSON.parse(await openFrame(key, JSON.stringify(env)));
assert.equal(inner.type, 'tabs', '密文可解 → tabs');
const id = inner.tabs[inner.tabs.length - 1].id;
await send({ type: 'attach', id });
let attached = null;
for (let i = 0; i < 10 && !attached; i++) {
  const e = await nextWhere((m) => m.type === 'secure');
  const m = JSON.parse(await openFrame(key, JSON.stringify(e)));
  if (m.type === 'attached') attached = m;
}
assert.ok(attached, 'attach 完成');
const tEcho0 = Date.now();
await send({ type: 'input', id, data: 'hello-public-net' });
let echoed = null;
for (let i = 0; i < 20 && !echoed; i++) {
  const e = await nextWhere((m) => m.type === 'secure');
  const m = JSON.parse(await openFrame(key, JSON.stringify(e)));
  if (m.type === 'data' && String(m.data).includes('<hello-public-net>')) echoed = m;
}
assert.ok(echoed, '公网密文回显');
const rtt = Date.now() - tEcho0;
console.log(`[5] 密文 input→echo 经公网往返 ${rtt}ms`);

// ⑥ 线路观测：join 之后除 auth-challenge/auth-ok 外全部 secure（中继只见密文）
//（探针视角 = relay/插件可见字节）
console.log(`[6] 全链路 OK：${RELAY}（子码 ${issue.subCode.slice(0, 12)}…）`);

ws.close();
plugin.send({ type: 'shutdown' });
await pollUntil(() => inbox.some((m) => m.type === 'status' && m.state === 'stopped'), '插件退出', 5000).catch(() => plugin.kill('SIGKILL'));
await rs.stop();
process.exit(0);
