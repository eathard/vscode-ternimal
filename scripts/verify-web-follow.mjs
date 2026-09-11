// verify-web-follow — 手机仿真验收「观看端跟随宿主几何」（docs/phone-display-issue.md）
// 断言：A 自建会话旋转改变 stty；B 跟随旋转×5 stty 不变；C 接管旋转变；D 还回旋转不变。
// 依赖：打包 App 正在运行（本机 deb 拉起即可）；对活动会话只读不改（自建标签用后即删）。
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 用法：node scripts/verify-web-follow.mjs [accessURL]
// 缺省从 /tmp/prod-dbg.log 提取（本机打包 App 的启动日志）。
const url = process.argv[2]
  ?? readFileSync('/tmp/prod-dbg.log', 'utf8').split('\n').find((l) => l.includes('access URL'))?.split('access URL: ')[1]?.trim();
if (!url) { console.error('需要 accessURL 参数或 /tmp/prod-dbg.log'); process.exit(1); }
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
const geoLogs = [];
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[geo')) geoLogs.push(t); });
const VP = (w, h) => page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await VP(390, 844);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
for (let i = 0; i < 40; i++) { if (await page.evaluate("!!document.querySelector('.tab-bar-add')")) break; await sleep(700); }
await sleep(2000);

const FOCUS = "(() => { const el = document.querySelector('.terminal-instance[style*=\"block\"] textarea, .terminal-instance[style*=\"block\"] .xterm-helper-textarea'); if (el) { el.focus(); return true; } return false; })()";
let mark = 0;
const stty = async () => {
  mark++;
  const ok = await page.evaluate(FOCUS);
  await page.keyboard.type(`echo M${mark}K; stty size\r`);
  await sleep(1300);
  const txt = await page.evaluate("Array.from(document.querySelectorAll('.xterm-rows')).map(r=>r.textContent).join('|')");
  const seg = (txt.split(`M${mark}K`).pop() || '');
  const m = seg.match(/(\d+ \d+)/);
  return `${m ? m[1] : '(无输出)'}${ok ? '' : ' [焦点失败]'}`;
};
const chip = () => page.evaluate("document.querySelector('.web-adapt-chip')?.textContent || '(无chip)'");

// A. 自建会话 = 拥有者
const n0 = await page.evaluate("document.querySelectorAll('.tab-bar-tab').length");
await page.evaluate("document.querySelector('.tab-bar-add')?.click()");
let grew = false;
for (let i = 0; i < 30; i++) { if (await page.evaluate(`document.querySelectorAll('.tab-bar-tab').length > ${n0}`)) { grew = true; break; } await sleep(500); }
console.log('F A0 新标签已建:', grew);
console.log('F A1 chip(自建):', await chip(), '| stty:', await stty());
await VP(844, 390); await sleep(1800);
console.log('F A2 自建旋转后 stty(应变):', await stty());
await VP(390, 844); await sleep(1800);

// B. 桌面创建的会话（跟随）：旋转 5 次 stty 不变
await page.evaluate("(() => { const t = document.querySelectorAll('.tab-bar-tab')[0]; t.click(); })()");
await sleep(1800);
console.log('F B1 chip(跟随):', await chip(), '| stty:', await stty());
for (let i = 0; i < 5; i++) { await VP(844, 390); await sleep(700); await VP(390, 844); await sleep(700); }
console.log('F B2 跟随旋转5次 stty(应不变):', await stty());

// C. 接管：点 chip → 旋转应变
await page.evaluate("document.querySelector('.web-adapt-chip')?.click()");
await sleep(1200);
console.log('F C1 chip(接管):', await chip());
await VP(844, 390); await sleep(1800);
console.log('F C2 接管旋转 stty(应变):', await stty());
await VP(390, 844); await sleep(1800);

// D. 还回：点 chip → 旋转不变
await page.evaluate("document.querySelector('.web-adapt-chip')?.click()");
await sleep(1200);
console.log('F D1 chip(还回):', await chip());
await VP(844, 390); await sleep(1800);
console.log('F D2 还回旋转 stty(应不变):', await stty());

console.log('F geo日志: ' + JSON.stringify(geoLogs));
await page.evaluate("(() => { const t = document.querySelectorAll('.tab-bar-tab'); t[t.length - 1].querySelector('.tab-bar-tab-close')?.click(); })()");
await browser.close();
