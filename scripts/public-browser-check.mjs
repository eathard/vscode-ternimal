#!/usr/bin/env node
// public-browser-check.mjs — 真浏览器（Chrome/CDP）公网验收（TC-R3-01/03/04 浏览器侧）。
//
// 链路：本机 Chrome(headless, --ignore-certificate-errors)
//   → https://VPS/#S=<子码>&T=<Token>（片段零配置）
//   → /health 探测区分 relay 宿主 → gate 自动跳过（#S/#T 命中）
//   → 挑战应答 + E2EE（安全上下文下 crypto.subtle）
//   → 终端挂载（.xterm DOM 出现 = 全链路贯通的最终证据）
//
// 用法：node scripts/public-browser-check.mjs <relayOrigin> <masterCode> [chromeBin]
//   --local  本机复现模式：忽略前两参，起本机 relay(127.0.0.1:18080, 托管
//            dist/web) + 插件 + host，Chrome 打 http://127.0.0.1:18080（安全上下文）。
import { fork, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const LOCAL = argv.includes('--local');
const li = argv.indexOf('--local'); if (li >= 0) argv.splice(li, 1);
const [RELAY = 'https://146.56.214.137', MASTER = '', CHROME = '/usr/bin/google-chrome'] = argv;
const TOKEN = 'browser-accept-token-32-chars!';
if (!MASTER && !LOCAL) {
  console.error('用法: node scripts/public-browser-check.mjs <relayOrigin> <masterCode> [chromeBin] [--local]');
  process.exit(1);
}

const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(pred, label, timeoutMs = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}
/** 值返回轮询（pred 返回真值即作为结果）。 */
async function pollFor(pred, label, timeoutMs = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

// ① 本机 host（E2EE 开）
const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'pub-chrome-')));
const rs = new RemoteServer({
  registry, auth, tls, port: 0, host: '127.0.0.1',
  heartbeatIntervalMs: 60_000, allowRelayFirstFrameAuth: true, relayE2EE: true,
});
rs.certFingerprint = tls.fingerprint;
const localPort = await rs.start();
console.log(`[1] host 就绪 127.0.0.1:${localPort}（E2EE 开）`);

let relay = null;
let RELAY_URL = RELAY;
let MASTER_CODE = MASTER;
if (LOCAL) {
  const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);
  const { sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);
  MASTER_CODE = 'trelay_v1_local_repro_master_code_okok';
  relay = new RelayServer({
    config: { masterHashes: [sha256Hex(MASTER_CODE)], limits: {} },
    host: '127.0.0.1', port: 18080, webRoot: path.join(root, 'dist/web'),
  });
  await relay.start();
  RELAY_URL = 'http://127.0.0.1:18080';
  console.log('[1b] 本机 relay 127.0.0.1:18080（托管 dist/web，明文 loopback=安全上下文）');
}

// ② 插件 → 公网 relay
const plugin = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, NODE_EXTRA_CA_CERTS: '/tmp/caddy-root.crt' },
});
const inbox = [];
plugin.on('message', (m) => inbox.push(m));
plugin.on('error', () => {});
plugin.send({
  type: 'config',
  config: { relayUrl: RELAY_URL, masterCode: MASTER_CODE, localPort, fingerprint: tls.fingerprint },
});
await pollUntil(() => inbox.some((m) => m.type === 'status' && m.state === 'registered'), '插件公网注册');
console.log('[2] 插件已注册（wss → VPS）');

// ③ 预建一个会话（浏览器进来就能看到 tab）
const created = registry.create({ cols: 80, rows: 24 });
console.log(`[3] 预建会话 ${created.id}`);

// ④ 子码
const issue = await fetch(`${RELAY_URL}/api/channels/subcodes`, {
  method: 'POST',
  headers: { authorization: `Bearer ${MASTER_CODE}`, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'browser-accept' }),
}).then((r) => r.json());
assert.ok(issue.subCode, `子码签发失败: ${JSON.stringify(issue)}`);
const url = `${RELAY_URL}/#S=${encodeURIComponent(issue.subCode)}&T=${encodeURIComponent(TOKEN)}`;
console.log(`[4] 分享链接（片段零配置）已构造`);

// ⑤ Chrome headless + CDP（每 run 独立调试端口，防残留实例抢占串台）
const DEBUG_PORT = 9300 + (process.pid % 400);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`,
  '--ignore-certificate-errors', // 内部 CA：接受后仍是安全上下文（crypto.subtle 可用）
  '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-accept-')),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => { /* chrome 噪音 */ });

const target = await pollFor(async () => {
  const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
  return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
}, 'CDP target');
console.log('[5] Chrome headless 已启动（CDP 连接）');
if (!LOCAL) console.log(`    → ${url.slice(0, 60)}…`);

const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const events = [];
cdp.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method) events.push(m);
});
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej); });
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  cdp.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
// 注入 WS 探针：捕获 close code/reason 与小帧内容（诊断 relay 路径挂点）
const inj = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    console.warn('[probe] installed');
    const OWS = WebSocket;
    window.__wsLog = [];
    window.WebSocket = function (...a) {
      const w = a.length > 1 ? new OWS(a[0], a[1]) : new OWS(a[0]);
      Object.setPrototypeOf(w, OWS.prototype);
      window.__wsLog.push(['open-url', String(a[0]).slice(0, 100)]);
      w.addEventListener('close', (e) => {
        window.__wsLog.push(['close', e.code, (e.reason || '').slice(0, 160)]);
        console.warn('[probe] ws close', e.code, e.reason);
      });
      w.addEventListener('error', () => console.warn('[probe] ws error'));
      w.addEventListener('message', (e) => {
        const s = String(e.data);
        window.__wsLog.push(['msg', s.slice(0, 220)]);
      });
      return w;
    };
    window.WebSocket.prototype = OWS.prototype;
    window.WebSocket.OPEN = OWS.OPEN;
    window.WebSocket.CONNECTING = OWS.CONNECTING;
    window.WebSocket.CLOSING = OWS.CLOSING;
    window.WebSocket.CLOSED = OWS.CLOSED;
  })()`,
});
if (inj.error) console.error('[diag] inject failed:', JSON.stringify(inj.error));
else console.log('[probe] CDP 注入已注册 identifier=', inj.result?.identifier);

// 回路自检：CDP console 事件能否送达
await send('Runtime.evaluate', { expression: "console.warn('[diag-loopback] cdp-ok')" });
await new Promise((r) => setTimeout(r, 300));

const t0 = Date.now();
await send('Page.navigate', { url });
// ⑥ 断言：gate 卡片消失 + .xterm 挂载（= 挑战应答+E2EE+attach 全链路贯通）
let dom = null;
try {
  await pollUntil(async () => {
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        xterm: !!document.querySelector('.xterm'),
        gateCard: !!document.querySelector('.rg-card, .rg-overlay'),
        banner: !!document.querySelector('.rg-banner'),
        bodyLen: document.body ? document.body.innerHTML.length : 0,
      })`,
      returnByValue: true,
    });
    try { dom = JSON.parse(r.result?.result?.value ?? '{}'); } catch { dom = null; }
    return dom && dom.xterm;
  }, '终端挂载（.xterm 出现）');
} catch (e) {
  // 诊断转储：页面状态 + 控制台输出（一次性，便于定位 gate 卡在哪一步）
  const st = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title, href: location.href,
      sec: window.isSecureContext, subtle: typeof crypto?.subtle?.importKey,
      overlay: document.querySelector('.rg-status')?.textContent ?? '',
      body: document.body ? document.body.innerHTML.slice(0, 300) : '',
    })`,
    returnByValue: true,
  }).catch(() => null);
  console.error('[diag] page:', st?.result?.result?.value);
  const ver = await send('Runtime.evaluate', {
    expression: `(async () => {
      const src = document.scripts[0]?.src ?? '(none)';
      const txt = await fetch(src, { cache: 'no-store' }).then((r) => r.text());
      return JSON.stringify({ src, bytes: txt.length, hasDiagRx: txt.includes('diag-rx'), hasDiagMac: txt.includes('diag-mac-sent') });
    })()`,
    returnByValue: true, awaitPromise: true,
  }).catch(() => null);
  console.error('[diag] served-script:', ver?.result?.result?.value);
  const wl = await send('Runtime.evaluate', {
    expression: 'JSON.stringify((window.__wsLog ?? []).slice(-12))',
    returnByValue: true,
  }).catch(() => null);
  console.error('[diag] wsLog:', wl?.result?.result?.value);
  for (const ev of events.filter((m) => m.method === 'Runtime.consoleAPICalled')) {
    const line = (ev.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200);
    if (/diag|probe|Ternimal/.test(line)) console.error('[diag] console:', ev.params.type, line);
  }
  for (const ev of events.filter((m) => m.method === 'Log.entryAdded').slice(-5)) {
    console.error('[diag] log:', ev.params.entry?.text?.slice(0, 200));
  }
  throw e;
}
assert.ok(!dom.gateCard, 'gate 卡片应已隐藏（零配置命中）');
console.log(`[6] Chrome 终端已挂载（公网+E2EE，${Date.now() - t0}ms）：gateCard=${dom.gateCard} banner=${dom.banner}`);

// ⑦ 键入回显（真实输入事件 → xterm → transport → 公网密文 → PTY）
await send('Input.insertText', { text: 'hi-browser' });
await sleep(1200);
const pty = host.ptys.get(created.id);
const typed = pty ? pty.writeCalls.join('') : '';
assert.ok(typed.includes('hi-browser'), `浏览器键入已抵达 PTY（got: ${typed.slice(0, 40)}）`);
console.log(`[7] 浏览器键入 → 公网密文 → PTY 回显 OK（"${typed}"）`);

cdp.close();
chrome.kill('SIGKILL');
plugin.send({ type: 'shutdown' });
await pollUntil(() => inbox.some((m) => m.type === 'status' && m.state === 'stopped'), '插件退出', 5000).catch(() => plugin.kill('SIGKILL'));
await rs.stop();
if (relay) relay.stop();
console.log('[8] 浏览器验收 PASS（' + (LOCAL ? '本机复现' : '公网 TC-R3-01/03 浏览器侧 + TC-R3-04 核心链路') + '）');
process.exit(0);
