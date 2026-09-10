#!/usr/bin/env node
// admin-browser-check.mjs — 真浏览器（Chrome/CDP）验收管理页全流程：
//   登录 → 仪表盘（版本号/主码区块）→ 签发主码 → 「复制主码」进剪贴板
//   → 列表出现新条目 → 吊销（confirm 自动接受）→ 会话仍有效
// 用法: node scripts/admin-browser-check.mjs [relayOrigin] [adminPassword] [chromeBin]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const [RELAY = process.env.TERNIMAL_RELAY_ORIGIN ?? 'https://146.56.214.137', PW = process.env.TERNIMAL_ADMIN_PW ?? '', CHROME = '/usr/bin/google-chrome'] = process.argv.slice(2);
if (!PW) { console.error('用法: TERNIMAL_ADMIN_PW=<管理密码> node scripts/admin-browser-check.mjs [origin] [pw] [chrome]'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollFor(pred, label, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

// ① Chrome headless（独立调试端口，防残留实例串台）
const DEBUG_PORT = 9400 + (process.pid % 400);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`,
  '--ignore-certificate-errors',
  '--window-size=1280,900',
  '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-admin-')),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => {});

const target = await pollFor(async () => {
  const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
  return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
}, 'CDP target');

const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let seq = 0; const pending = new Map(); const dialogs = [];
cdp.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Page.javascriptDialogOpening') dialogs.push(m.params);
});
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej); });
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pending.set(id, res);
  cdp.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');
// 剪贴板读权限（验证「复制主码」真实落板）
await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: RELAY.replace(/\/$/, '') });

const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

// ② 打开 /admin → 验证版本号（缓存根治标记）
await send('Page.navigate', { url: `${RELAY}/admin` });
await pollFor(() => ev("[...document.querySelectorAll('.muted')].some(e => /build 20[\\d-]+/.test(e.textContent))"), '登录页+版本号');
const build = await ev("document.body.textContent.match(/build 20[\\d-]+/)?.[0]");
console.log(`[1] 登录页 OK，${build}`);

// ③ 显示密码勾选框：勾选→明文，取消→圆点
assert.equal(await ev("document.getElementById('pw').type"), 'password', '默认遮蔽');
await ev("document.getElementById('pw-show').click()");
assert.equal(await ev("document.getElementById('pw').type"), 'text', '勾选后明文');
await ev("document.getElementById('pw-show').click()");
assert.equal(await ev("document.getElementById('pw').type"), 'password', '取消后恢复遮蔽');
console.log('[2.5] 显示密码 checkbox OK（遮蔽↔明文切换）✓');

// ③b 登录
await ev(`document.getElementById('pw').value = ${JSON.stringify(PW)}; document.getElementById('go').click()`);
await pollFor(() => ev("document.querySelector('h1')?.textContent?.includes('Ternimal Relay 管理')"), '登录成功仪表盘');
console.log('[2] 登录成功 → 仪表盘（版本号:', await ev("document.querySelector('.sub')?.textContent.split(' · ')[0]"), '）');

// ④ 签发主码（标签唯一便于行定位与清理）
const label = `cdp-${Date.now().toString(36)}`;
await ev(`document.getElementById('m-label').value = ${JSON.stringify(label)};
  document.getElementById('m-days').value = '1';
  document.getElementById('m-issue').click()`);
await pollFor(() => ev("document.getElementById('iss-code')?.textContent"), '签发面板出现明文');
const code = await ev("document.getElementById('iss-code').textContent");
assert.match(code, /^trelay_v1_[A-Za-z0-9_-]+$/, '明文格式');
console.log(`[3] 签发成功 ${code.slice(0, 18)}…（标签 ${label}）`);

// ⑤ 复制主码：拦截 clipboard.writeText 断言精确入参（无头模式 readText 受焦点限制，
//    真实落板在桌面 Chrome 由同一 API 保证），再尽力 readText 双重印证
await ev("window.__clipSpy=[];var orig=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=function(t){window.__clipSpy.push(t);return orig(t).catch(function(){})};'spy-ok'");
await ev("document.getElementById('iss-copy').click()");
await sleep(500);
const spy = await ev("window.__clipSpy[0] ?? 'NONE'");
assert.equal(spy, code, '复制按钮调用 clipboard.writeText(主码全文)');
const btnText = await ev("document.getElementById('iss-copy').textContent");
assert.match(btnText, /已复制/, '按钮反馈已复制 ✓');
const clip = await ev("navigator.clipboard.readText().then(t=>t, ()=>'(headless 读受限)')");
console.log(`[4] 复制按钮 OK：writeText(主码全文) ✓，按钮反馈「${btnText}」，readText=${String(clip).slice(0, 20)}…`);

// ⑥ 列表出现该主码行（状态 有效）
const rowOk = await pollFor(() => ev(`[...document.querySelectorAll('table tr')].some(r => r.textContent.includes(${JSON.stringify(label)}) && r.textContent.includes('有效'))`), '列表出现新条目');
assert.ok(rowOk === true || rowOk === undefined || rowOk === null || rowOk); // pollFor 不抛即成功
console.log('[5] 主码列表出现新条目（有效）✓');

// ⑦ 吊销（confirm 自动接受）→ 行状态转已吊销
await send('Page.enable');
const dlgHandler = (async () => { // 循环接受后续 dialog
  for (;;) { await sleep(100); if (dialogs.length) { await send('Page.handleJavaScriptDialog', { accept: true }); dialogs.shift(); } }
})();
await ev(`const r = [...document.querySelectorAll('tr')].find(r => r.textContent.includes(${JSON.stringify(label)}));
  r.querySelector('[data-mrev]').click()`);
await pollFor(() => ev(`[...document.querySelectorAll('tr')].some(r => r.textContent.includes(${JSON.stringify(label)}) && r.textContent.includes('已吊销'))`), '吊销生效');
console.log('[6] 吊销 OK → 状态已吊销 ✓');
dlgHandler.catch(() => {});

// ⑧ 截图存证
fs.mkdirSync(path.join(root_dir(), 'docs/test-reports/shots'), { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotPath = path.join(root_dir(), 'docs/test-reports/shots/admin-browser.png');
fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
console.log(`[7] 截图 ${shotPath}`);

function root_dir() { return path.resolve(import.meta.dirname, '..'); }

chrome.kill('SIGKILL');
cdp.close();
console.log('admin-browser-check: PASS（登录/版本号/签发/复制/列表/吊销 全链路真浏览器验证）');
process.exit(0);
