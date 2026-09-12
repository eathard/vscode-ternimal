import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9335', defaultViewport: null });
const page = (await b.pages()).find(p => p.url().includes('8443'));
const c = await page.createCDPSession();
await c.send('Network.enable');
await c.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.reload({ waitUntil: 'load' });
await new Promise(r => setTimeout(r, 9000)); // attach + 自动申请（3s 兜底）+ chip 刷新
const st = await page.evaluate(() => ({
  chip: document.querySelector('.web-adapt-chip')?.textContent ?? '(无)',
  hasXterm: !!document.querySelector('.xterm'),
}));
console.log('强刷后手机:', JSON.stringify(st));
await b.disconnect();
