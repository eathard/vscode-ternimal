// 旋转实测：单客户端旋转的完整行为 + 双客户端共享几何演示
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = readFileSync('/tmp/prod-fix2.log','utf8').split('\n').find(l=>l.includes('access URL')).split('access URL: ')[1].trim();
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--ignore-certificate-errors'] });
const phone = await browser.newPage();
await phone.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'iPhone Safari Mobile' });
await phone.goto(url, { waitUntil: 'networkidle2' }); await sleep(2000);
await phone.click('.tab-bar-add'); await sleep(2000);
await phone.evaluate("document.querySelector('.terminal-instance:not([style*=\"none\"]) textarea')?.focus()");
await phone.keyboard.type("echo ROTATE-TEST-0; stty size\r"); await sleep(1500);
const sttyP = await phone.evaluate("Array.from(document.querySelectorAll('.xterm-rows')).map(r=>r.textContent).join('|').match(/\\d+ \\d+/)?.[0]");
console.log('R 竖屏 stty(行 列):', sttyP);
// 旋转横屏
await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await sleep(1800);
await phone.keyboard.type("stty size\r"); await sleep(1200);
const sttyL = await phone.evaluate("Array.from(document.querySelectorAll('.xterm-rows')).map(r=>r.textContent).join('|').match(/(\\d+ \\d+)/g)?.slice(-1)[0]");
console.log('R 横屏 stty(行 列):', sttyL);
// 旋转回竖屏
await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await sleep(1800);
await phone.keyboard.type("echo ROTATE-BACK-OK\r"); await sleep(1200);
const txt = await phone.evaluate("Array.from(document.querySelectorAll('.xterm-rows')).map(r=>r.textContent).join('\\n')");
console.log('R 旋转往返后: END在=', txt.includes('ROTATE-BACK-OK'), '乱码=', (txt.match(/\ufffd/g)||[]).length, 'ESC泄漏=', txt.split(String.fromCharCode(27)).length-1);
console.log('R ROTATE-TEST-0 仍可见(历史保留):', txt.includes('ROTATE-TEST-0'));
// 双客户端：桌面页同会话，手机再旋转→桌面几何也变（共享 PTY 证明）
const desk = await browser.newPage();
await desk.setViewport({ width: 1280, height: 800 });
await desk.goto(url, { waitUntil: 'networkidle2' }); await sleep(2500);
await desk.keyboard.type("stty size\r"); await sleep(1200);
const sttyD1 = await desk.evaluate("Array.from(document.querySelectorAll('.xterm-rows')).map(r=>r.textContent).join('|').match(/(\\d+ \\d+)/g)?.slice(-1)[0]");
console.log('R 桌面视角 stty(手机竖屏时):', sttyD1);
await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await sleep(1800);
await desk.keyboard.type("stty size\r"); await sleep(1200);
const sttyD2 = await desk.evaluate("Array.from(document.querySelectorAll('.xterm-rows')).map(r=>r.textContent).join('|').match(/(\\d+ \\d+)/g)?.slice(-1)[0]");
console.log('R 桌面视角 stty(手机转横后):', sttyD2, '← 共享PTY：手机旋转改变了桌面几何');
// 清理我的标签
await phone.evaluate("(() => { const t=document.querySelectorAll('.tab-bar-tab'); t[t.length-1].querySelector('.tab-bar-tab-close').click(); })()");
await browser.close();
