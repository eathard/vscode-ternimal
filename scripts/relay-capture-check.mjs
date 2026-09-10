#!/usr/bin/env node
// relay-capture-check.mjs — TC-R4-01/02 抓包断言（--insecure 明文 relay）。
//
// 在本机起明文 relay + tcpdump 抓 loopback，全程跑一次挑战应答 + E2EE 会话：
//   断言①（TC-R4-01）：抓包中无 Token 明文；可见 nonce 与 HMAC（MAC 无 Token 不可逆）。
//   断言②（TC-R4-02）：auth-ok 之后业务流量全部为 {type:'secure', iv, ct} 密文信封，
//                      明文业务内容（探针标记串）在抓包中不可见。
// 用法：sudo -E node scripts/relay-capture-check.mjs（tcpdump 需 root；无 sudo 时跳过抓包仅跑链路）
import { fork } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'capture-check-token-32-chars-ok!';
const MARKER = 'SECRET-BUSINESS-DATA-MARKER-42';
const PORT = 18066;

const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);
const { deriveSessionKey, sealFrame, openFrame } = await import(
  pathToFileURL(path.join(root, 'dist/verify/shared/e2ee.js')).href
);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);
const { sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tcpdump = null;
let pcap = null;
let canCapture = false;
try {
  execSync('tcpdump --version', { stdio: 'ignore' });
  canCapture = process.getuid?.() === 0 || !!process.env.SUDO_USER;
} catch { /* tcpdump absent */ }
if (canCapture) {
  pcap = `/tmp/relay-capture-${process.pid}.pcap`;
  tcpdump = spawn('tcpdump', ['-i', 'lo', '-w', pcap, '-U', `tcp port ${PORT}`], { stdio: 'ignore' });
  await sleep(600); // tcpdump 起捕
}

// ① host（E2EE 开）+ 明文 relay + 插件
const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')));
const rs = new RemoteServer({
  registry, auth, tls, port: 0, host: '127.0.0.1',
  heartbeatIntervalMs: 60_000, allowRelayFirstFrameAuth: true, relayE2EE: true,
});
rs.certFingerprint = tls.fingerprint;
const localPort = await rs.start();

const MASTER = 'trelay_v1_capture_check_master_ok!';
const relay = new RelayServer({
  host: '127.0.0.1', port: PORT, log: false,
  config: { masterHashes: [sha256Hex(MASTER)], limits: {} }, heartbeatIntervalMs: 60_000,
});
await relay.start();

const plugin = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const inbox = [];
plugin.on('message', (m) => inbox.push(m));
plugin.on('error', () => {});
plugin.send({ type: 'config', config: { relayUrl: `ws://127.0.0.1:${PORT}`, masterCode: MASTER, localPort, fingerprint: tls.fingerprint } });
await new Promise((res, rej) => {
  const iv = setInterval(() => { if (inbox.some((m) => m.type === 'status' && m.state === 'registered')) { clearInterval(iv); res(); } }, 50);
  setTimeout(() => rej(new Error('plugin register timeout')), 10_000);
});

const issue = await fetch(`http://127.0.0.1:${PORT}/api/channels/subcodes`, {
  method: 'POST',
  headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'capture' }),
}).then((r) => r.json());

// ② 客户端：挑战应答 + E2EE + 密文业务（含标记串）
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/join`);
const inboxC = [];
const nextWhere = (pred, timeoutMs = 10_000) => new Promise((res, rej) => {
  const iv = setInterval(() => {
    const i = inboxC.findIndex(pred);
    if (i >= 0) { clearInterval(iv); res(inboxC.splice(i, 1)[0]); }
  }, 20);
  setTimeout(() => { clearInterval(iv); rej(new Error(`nextWhere timeout: ${String(pred).slice(0, 40)}`)); }, timeoutMs);
});
ws.on('message', (raw) => inboxC.push(JSON.parse(raw.toString())));
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
const ch = await nextWhere((m) => m.type === 'auth-challenge');
const mac = crypto.createHmac('sha256', TOKEN).update(ch.nonce).digest('hex');
ws.send(JSON.stringify({ type: 'auth-response', mac, enc: 1 }));
const ok = await nextWhere((m) => m.type === 'auth-ok' && m.enc === 1);
assert.ok(ok, 'E2EE 协商完成');
const key = await deriveSessionKey(TOKEN, ch.nonce);
const send = async (obj) => ws.send(await sealFrame(key, JSON.stringify(obj)));
await send({ type: 'create' });
let tabsMsg = null;
for (let i = 0; i < 10 && !tabsMsg; i++) {
  const e = await nextWhere((m) => m.type === 'secure');
  const m = JSON.parse(await openFrame(key, JSON.stringify(e)));
  if (m.type === 'tabs' && m.tabs?.length) tabsMsg = m;
}
assert.ok(tabsMsg, 'tabs 快照到达');
const id = tabsMsg.tabs[tabsMsg.tabs.length - 1].id;
await send({ type: 'attach', id });
let attached = null;
for (let i = 0; i < 10 && !attached; i++) {
  const e = await nextWhere((m) => m.type === 'secure');
  const m = JSON.parse(await openFrame(key, JSON.stringify(e)));
  if (m.type === 'attached') attached = m;
}
assert.ok(attached, 'attach 完成');
await send({ type: 'input', id, data: MARKER });
let echoed = null;
for (let i = 0; i < 20 && !echoed; i++) {
  const e = await nextWhere((m) => m.type === 'secure');
  const m = JSON.parse(await openFrame(key, JSON.stringify(e)));
  if (m.type === 'data' && String(m.data).includes(`<${MARKER}>`)) echoed = m;
}
assert.ok(echoed, '密文业务回显完成');
ws.close();
await sleep(400); // 尾包落盘

// ③ 抓包断言
if (!canCapture) {
  console.log('[capture] 无 root/tcpdump —— 链路自证完成（挑战应答+E2EE+密文往返），抓包断言跳过');
  console.log('relay-capture-check: PASS (link-only)');
  plugin.kill(); relay.stop(); rs.stop();
  process.exit(0);
}
try { tcpdump.kill('SIGINT'); } catch { /* gone */ }
await sleep(800);
const capText = execSync(
  `strings ${pcap} | head -c 20000000`, { maxBuffer: 64 * 1024 * 1024 }
).toString();

// TC-R4-01：Token 明文绝不上线路（挑战应答的意义）
assert.ok(!capText.includes(TOKEN), '断言①失败：抓包中出现 Token 明文！');
// nonce 与 MAC 可见（这正是挑战应答的设计：可见但不可逆）
assert.ok(/[A-Za-z0-9_-]{43}/.test(capText), 'nonce 可见');
// TC-R4-02：业务标记串（明文形态）不出现在线路上；密文信封字段存在
assert.ok(!capText.includes(MARKER), '断言②失败：抓包中出现明文业务数据！');
assert.ok(!capText.includes(`"data":"<${MARKER}>"`), '断言②失败：明文业务帧可见');
assert.ok(/"type":"secure"/.test(capText), 'secure 信封在线路可见（密文形态）');
console.log('[capture] ① Token 明文 0 次 ✔  ② 业务明文 0 次、secure 密文信封可见 ✔');
console.log('relay-capture-check: PASS (full)');
plugin.kill(); relay.stop(); rs.stop();
try { fs.unlinkSync(pcap); } catch { /* keep for debugging */ }
process.exit(0);
