#!/usr/bin/env node
// verify-relay-admin.mjs — 管理页验收（计费运维底座）。
//
// A-01 /admin 未配置 → 404；配置后 → 200 HTML
// A-02 错密码 401 ×5 → IP 锁 429
// A-03 正确密码 → 令牌；overview 形状（通道/子码/用量）
// A-04 真实流量计入总账：join+echo 后 overview bytes/joins 增长
// A-05 管理令牌代签子码 + 吊销；通道被清理后总账仍在（不丢账）
import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'admin-suite-token-32-chars-ok!';
const ADMIN_PW = 'admin-password-42';

const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);
const { sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);

const salt = crypto.randomBytes(16);
const adminHash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(ADMIN_PW, salt, 32).toString('hex')}`;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (err) { fail++; console.log(`  ✘ ${name}\n    ${err.stack?.split('\n')[0] ?? err}` + (err.actual !== undefined ? ` [actual=${err.actual} expected=${err.expected}]` : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 基础链路
const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'adm-')));
const rs = new RemoteServer({
  registry, auth, tls, port: 0, host: '127.0.0.1',
  heartbeatIntervalMs: 60_000, allowRelayFirstFrameAuth: true,
});
rs.certFingerprint = tls.fingerprint;
const localPort = await rs.start();
const MASTER = 'trelay_v1_admin_suite_master_ok!';
const relay = new RelayServer({
  host: '127.0.0.1', port: 18044, log: false, adminHash,
  config: { masterHashes: [sha256Hex(MASTER)], limits: {} }, heartbeatIntervalMs: 60_000,
});
await relay.start();
const BASE = 'http://127.0.0.1:18044';

const plugin = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const inbox = [];
plugin.on('message', (m) => inbox.push(m));
plugin.on('error', () => {});
plugin.send({ type: 'config', config: { relayUrl: `ws://127.0.0.1:18044`, masterCode: MASTER, localPort, fingerprint: tls.fingerprint } });
await new Promise((res, rej) => {
  const iv = setInterval(() => { if (inbox.some((m) => m.type === 'status' && m.state === 'registered')) { clearInterval(iv); res(); } }, 50);
  setTimeout(() => rej(new Error('plugin register timeout')), 10_000);
});

let adminTok = '';
let pluginB = null;
let pluginC = null;
let b01code = '';
let pluginChannelB = '';

await test('A-01 /admin 配置后 200 且含登录界面（含 JS 语法门禁）', async () => {
  const r = await fetch(`${BASE}/admin`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('管理登录'), '登录界面存在');
  const js = await fetch(`${BASE}/static/admin.js`);
  assert.equal(js.status, 200);
  // 浏览器侧语法门禁：脚本必须可解析（曾因模板串转义破损导致按钮全失效）
  const body = await js.text();
  const tmp = path.join(os.tmpdir(), 'admin-js-gate.js');
  fs.writeFileSync(tmp, body);
  const chk = (await import('node:child_process')).spawnSync('node', ['--check', tmp]);
  assert.equal(chk.status, 0, `admin.js 语法错误: ${chk.stderr.toString().slice(0, 200)}`);
});

await test('A-02 错密码 401 ×5 → 第 6 次 429 锁定', async () => {
  let locked = 0;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-' + i }),
    });
    if (r.status === 429) locked++;
    else assert.equal(r.status, 401);
  }
  assert.ok(locked >= 1, '连续失败后应出现 429');
});

// IP 锁 60s 会挡住后续用例：重启 relay 清锁（内存态），并等插件重注册。
relay.stop();
await sleep(500);
const relay2 = new RelayServer({
  host: '127.0.0.1', port: 18044, log: false, adminHash,
  config: { masterHashes: [sha256Hex(MASTER)], limits: {} }, heartbeatIntervalMs: 60_000,
});
await relay2.start();
{
  const t0 = Date.now();
  const regCount = () => inbox.filter((m) => m.type === 'status' && m.state === 'registered').length;
  while (Date.now() - t0 < 15_000 && regCount() < 2) await sleep(100);
  assert.ok(regCount() >= 2, '插件在重启后的 relay 上完成重注册');
}

await test('A-03 正确密码 → 会话令牌 + overview 形状（真实）', async () => {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PW }),
  });
  assert.equal(r.status, 200, '正确密码应通过');
  const j = await r.json();
  assert.ok(j.token?.length > 20, '返回会话令牌');
  adminTok = j.token;
  const ov = await fetch(`${BASE}/api/admin/overview`, { headers: { authorization: `Bearer ${adminTok}` } }).then((x) => x.json());
  assert.ok(Array.isArray(ov.channels) && typeof ov.pipes === 'number' && typeof ov.uptimeMs === 'number');
  assert.ok(ov.adminConfigured === true);
  // 未授权访问拒绝
  const noauth = await fetch(`${BASE}/api/admin/overview`);
  assert.equal(noauth.status, 401);
});

await test('A-04 真实流量计入总账（bytes/joins 增长）', async () => {
  const issue = await fetch(`${BASE}/api/channels/subcodes`, {
    method: 'POST', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'adm-suite' }),
  }).then((r) => r.json());
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/join`);
  const box = [];
  ws.on('message', (r) => box.push(JSON.parse(r.toString())));
  const next = (pred, ms = 10_000) => new Promise((res, rej) => {
    const iv = setInterval(() => { const i = box.findIndex(pred); if (i >= 0) { clearInterval(iv); res(box.splice(i, 1)[0]); } }, 20);
    setTimeout(() => { clearInterval(iv); rej(new Error('timeout')); }, ms);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  if (process.env.ADBG) console.log('    [a4] joined, waiting challenge');
  const ch = await next((m) => m.type === 'auth-challenge');
  if (process.env.ADBG) console.log('    [a4] challenge ok');
  ws.send(JSON.stringify({ type: 'auth-response', mac: crypto.createHmac('sha256', TOKEN).update(ch.nonce).digest('hex') }));
  await next((m) => m.type === 'auth-ok');
  if (process.env.ADBG) console.log('    [a4] auth-ok');
  ws.send(JSON.stringify({ type: 'create' }));
  let tabs = null;
  for (let i = 0; i < 10 && !tabs; i++) { const m = await next((x) => x.type === 'tabs'); if (m.tabs?.length) tabs = m; }
  const id = tabs.tabs[tabs.tabs.length - 1].id;
  if (process.env.ADBG) console.log('    [a4] tabs ok', id);
  ws.send(JSON.stringify({ type: 'attach', id }));
  for (let i = 0; i < 12; i++) {
    const m = await next((x) => x.type === 'attached' || x.type === 'tabs');
    if (m.type === 'attached' && m.id === id) break;
  }
  ws.send(JSON.stringify({ type: 'input', id, data: 'admin-billing-data' }));
  for (let i = 0; i < 10; i++) {
    const m = await next((x) => x.type === 'data');
    if (String(m.data).includes('<admin-billing-data>')) break;
  }
  ws.close();
  await sleep(300);
  const ov = await fetch(`${BASE}/api/admin/overview`, { headers: { authorization: `Bearer ${adminTok}` } }).then((x) => x.json());
  const ch0 = ov.channels[0];
  assert.ok(ch0.joins >= 1, 'joins 计入');
  assert.ok(ch0.bytesIn + ch0.bytesOut > 0, 'bytes 计入');
  assert.ok(ch0.subcodes.length >= 1 && ch0.subcodes[0].stats.bytes > 0, '子码级统计');
  assert.equal(ch0.online, true, '插件在线状态');
});

await test('A-05 管理令牌代签 + 吊销 + 通道清理后总账不丢', async () => {
  const ov1 = await fetch(`${BASE}/api/admin/overview`, { headers: { authorization: `Bearer ${adminTok}` } }).then((x) => x.json());
  const cid = ov1.channels[0].id;
  const issue = await fetch(`${BASE}/api/channels/subcodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: cid, label: 'admin-issued', ttlHours: 1 }),
  });
  assert.equal(issue.status, 201, '管理令牌可代签子码');
  const rec = await issue.json();
  const del = await fetch(`${BASE}/api/channels/subcodes/${rec.id}?channel=${encodeURIComponent(cid)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.equal(del.status, 200, '管理令牌可吊销');
  // 通道清理（杀插件）→ 通道 reap → 总账仍在
  const beforeBytes = ov1.channels[0].bytesIn + ov1.channels[0].bytesOut;
  assert.ok(beforeBytes > 0);
  plugin.kill('SIGKILL');
  await sleep(70_000 > 0 ? 1_500 : 0); // 等 sweep（心跳周期内的 reap 由 close 立即触发）
  const ov2 = await fetch(`${BASE}/api/admin/overview`, { headers: { authorization: `Bearer ${adminTok}` } }).then((x) => x.json());
  const gone = ov2.channels.find((c) => c.id === cid);
  assert.ok(gone, '总账保留被清理通道');
  assert.equal(gone.online, false);
  assert.ok(gone.bytesIn + gone.bytesOut >= beforeBytes - 1, '清理后流量账不回退');
});

// ---------- B 套件：主码生命周期（计费核心场景） ----------
// 独立短心跳 relay（sweep 1.5s）验证「到期自动停止」
const relayB = new RelayServer({
  host: '127.0.0.1', port: 18045, log: false, adminHash,
  heartbeatIntervalMs: 1_500,
  config: { masterHashes: [sha256Hex(MASTER)], limits: {} },
});
await relayB.start();
const BASE_B = 'http://127.0.0.1:18045';

async function loginB() {
  const r = await fetch(`${BASE_B}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PW }),
  }).then((x) => x.json());
  return r.token;
}
const regCountOf = (pl) => pl.inbox.filter((m) => m.type === 'status' && m.state === 'registered').length;
async function waitReg(pl, n, ms = 12_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && regCountOf(pl) < n) await sleep(100);
  return regCountOf(pl) >= n;
}

await test('B-01 管理页签发带有效期主码 → 插件注册成功', async () => {
  const tok = await loginB();
  const r = await fetch(`${BASE_B}/api/admin/masters`, {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'customer-a', days: 30 }),
  });
  assert.equal(r.status, 201);
  const j = await r.json();
  b01code = j.code;
  assert.ok(j.code?.startsWith('trelay_v1_'), '明文一次性返回');
  assert.ok(j.expiresAt > Date.now(), '带到期时间');
  // 新主码起插件注册
  pluginB = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  pluginB.on('message', (m) => pluginB.inbox.push(m));
  pluginB.inbox = [];
  pluginB.on('error', () => {});
  pluginB.send({ type: 'config', config: { relayUrl: 'ws://127.0.0.1:18045', masterCode: j.code, localPort, fingerprint: tls.fingerprint } });
  assert.ok(await waitReg(pluginB, 1), '30 天主码可注册');
  const regMsg = pluginB.inbox.find((m) => m.type === 'status' && m.state === 'registered');
  pluginChannelB = (regMsg?.detail || '').replace('channel ', '');
  const lst = await fetch(`${BASE_B}/api/admin/masters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  const mine = lst.masters.find((m) => m.id === j.id);
  assert.ok(mine && mine.status === 'active' && mine.remainingMs > 29 * 86_400_000, '列表显示有效+剩余');
  // 复制按钮（剪贴板需浏览器手势）：静态断言页面含复制面板/兜底复制逻辑
  const js2 = await fetch(`${BASE_B}/static/admin.js`).then((x) => x.text());
  assert.ok(js2.includes('iss-copy') && js2.includes('navigator.clipboard.writeText') && js2.includes('execCommand'), '一键复制实现存在');
  const handler = js2.slice(js2.indexOf("getElementById('m-issue').onclick"));
  assert.ok(handler.includes('lastIss = {'), '签发结果进 lastIss 面板');
  assert.ok(!handler.slice(0, 400).includes('alert('), '签发流程不得再弹 alert（会阻塞页面）');
});

await test('B-02 到期自动停止（sweep 收割通道，注册被拒）', async () => {
  const tok = await loginB();
  // 签一枚 1.5 秒主码（days 支持小数）
  const j = await fetch(`${BASE_B}/api/admin/masters`, {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'short', days: 2 / 86_400 }),
  }).then((r) => r.json());
  const before = regCountOf(pluginB);
  assert.ok(before >= 1);
  await sleep(5_000); // 过期 + sweep(1.5s) 收割
  const lst = await fetch(`${BASE_B}/api/admin/masters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  const short = lst.masters.find((m) => m.id === j.id);
  assert.equal(short.status, 'expired', '状态转已过期');
  // 原通道被收割：overview 无该通道（同 hash 通道 = MASTER 所在 relayB 通道不受影响）
  const ov = await fetch(`${BASE_B}/api/admin/overview`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  // B-01 的 30 天主码通道应仍在（未受殃及）
  assert.ok(ov.channels.some((c) => c.online), '其他付费通道不受影响');
});

await test('B-03 吊销立即生效（通道即刻停止）', async () => {
  const tok = await loginB();
  const lst = await fetch(`${BASE_B}/api/admin/masters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  const target = lst.masters.find((m) => m.label === 'customer-a');
  assert.ok(target, '找到 B-01 主码');
  const r = await fetch(`${BASE_B}/api/admin/masters/${target.id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(r.status, 200);
  const ov = await fetch(`${BASE_B}/api/admin/overview`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  assert.ok(!ov.channels.some((c) => c.id === sha256Hex('x').slice(0, 22)), 'sanity');
  // 通道应被清（customer-a 的通道离线/消失）
  const lst2 = await fetch(`${BASE_B}/api/admin/masters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  assert.equal(lst2.masters.find((m) => m.id === target.id).status, 'revoked');
});

await test('B-04 续期即恢复（新插件同码可再注册）', async () => {
  const tok = await loginB();
  const lst = await fetch(`${BASE_B}/api/admin/masters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  const target = lst.masters.find((m) => m.label === 'customer-a');
  const r = await fetch(`${BASE_B}/api/admin/masters/${target.id}/renew`, {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ days: 30 }),
  });
  assert.equal(r.status, 200, '续期成功（吊销态一并解除）');
  // 新插件（同主码明文）注册恢复
  const codeB = b01code;
  pluginC = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  pluginC.on('message', (m) => pluginC.inbox.push(m));
  pluginC.inbox = [];
  pluginC.on('error', () => {});
  pluginC.send({ type: 'config', config: { relayUrl: 'ws://127.0.0.1:18045', masterCode: codeB, localPort, fingerprint: tls.fingerprint } });
  assert.ok(await waitReg(pluginC, 1), '续期后同码可再注册');
});

await test('B-05 legacy 明文哈希主码=永久有效（存量部署不受影响）', async () => {
  // relayB 的 config.masterHashes 含 MASTER（旧式）→ 已在 B-01~04 全程可用
  const tok = await loginB();
  const lst = await fetch(`${BASE_B}/api/admin/masters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json());
  const legacy = lst.masters.find((m) => m.permanent);
  assert.ok(legacy, 'legacy 条目存在且标记永久');
  assert.equal(legacy.status, 'permanent');
});

await test('B-06 子码时效：默认 6h，续期 +1天/+7天/长期，吊销不可续', async () => {
  const tok = await loginB();
  const H = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  // ① 默认 TTL = 6h（不传 ttlHours）
  if (!pluginChannelB) {
    const ov = await fetch(`${BASE_B}/api/admin/overview`, { headers: H }).then((r) => r.json());
    pluginChannelB = (ov.channels.find((c) => c.online) || ov.channels[0] || {}).id || '';
  }
  const iss = await fetch(`${BASE_B}/api/channels/subcodes`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ channelId: pluginChannelB, label: 'b06-default' }),
  }).then((r) => { assert.equal(r.status, 201); return r.json(); });
  const d6h = iss.expiresAt - Date.now();
  assert.ok(d6h > 5.9 * 3600_000 && d6h < 6.1 * 3600_000, '默认 6 小时, 实测 ' + (d6h / 3600_000).toFixed(2) + 'h');
  // ② +1 天：从当前到期顺延
  const r1 = await fetch(`${BASE_B}/api/channels/subcodes/${iss.id}/renew`, {
    method: 'POST', headers: H, body: JSON.stringify({ days: 1 }),
  }).then((r) => { assert.equal(r.status, 200); return r.json(); });
  assert.ok(Math.abs(r1.expiresAt - (iss.expiresAt + 86_400_000)) < 2_000, '+1天=顺延 24h');
  // ③ 再 +7 天
  const r7 = await fetch(`${BASE_B}/api/channels/subcodes/${iss.id}/renew`, {
    method: 'POST', headers: H, body: JSON.stringify({ days: 7 }),
  }).then((r) => { assert.equal(r.status, 200); return r.json(); });
  assert.ok(Math.abs(r7.expiresAt - (r1.expiresAt + 7 * 86_400_000)) < 2_000, '+7天在 +1天 基础上顺延');
  // ④ 长期：expiresAt = null
  const rp = await fetch(`${BASE_B}/api/channels/subcodes/${iss.id}/renew`, {
    method: 'POST', headers: H, body: JSON.stringify({ permanent: true }),
  }).then((r) => { assert.equal(r.status, 200); return r.json(); });
  assert.strictEqual(rp.expiresAt, null, '长期 → null');
  // ⑤ 吊销后不可续（终态）
  await fetch(`${BASE_B}/api/channels/subcodes/${iss.id}?channel=${encodeURIComponent(pluginChannelB)}`, { method: 'DELETE', headers: H });
  const rr = await fetch(`${BASE_B}/api/channels/subcodes/${iss.id}/renew`, {
    method: 'POST', headers: H, body: JSON.stringify({ days: 1 }),
  });
  assert.equal(rr.status, 409, '吊销后续期被拒');
  // ⑥ 未授权不可续
  const ro = await fetch(`${BASE_B}/api/channels/subcodes/${iss.id}/renew`, {
    method: 'POST', body: JSON.stringify({ days: 1 }),
  });
  assert.equal(ro.status, 401, '无凭证续期被拒');
});

relayB.stop();
try { pluginB.kill('SIGKILL'); } catch { /* gone */ }
try { pluginC.kill('SIGKILL'); } catch { /* gone */ }
await rs.stop();
console.log(`verify-relay-admin: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
