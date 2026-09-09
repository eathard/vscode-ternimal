// release-github.mjs — one-shot publisher for the v1.1.0 GitHub Release.
// Drives the user's REAL Chrome profile over CDP (puppeteer-core) so the
// existing GitHub login is reused. Headful on DISPLAY=:0 — if a login is
// required, the script parks and the user signs in inside the window.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const REPO = 'eathard/vscode-ternimal';
const TAG = 'v1.1.0';
const TITLE = 'Ternimal v1.1.0 — remote layer, soft keyboard, open-source readiness';
const NOTES = readFileSync('release/RELEASE-NOTES-v1.1.0.md', 'utf8');
const ASSETS = ['release/Ternimal-1.1.0.AppImage', 'release/ternimal_1.1.0_amd64.deb'];
const log = (m) => console.log(`[rel] ${m}`);

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  userDataDir: `${process.env.HOME}/.config/chrome-release-profile`,
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,960'],
  protocolTimeout: 300_000,
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.setViewport({ width: 1280, height: 960 });
page.setDefaultNavigationTimeout(120_000);

const gotoRetry = async (url) => {
  for (let i = 1; i <= 4; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      return;
    } catch (e) {
      log(`goto attempt ${i} failed (${e.message.split('\n')[0]}) — retrying`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`navigation failed after retries: ${url}`);
};

// Count completed asset uploads via network responses (no page polling —
// the renderer main thread is saturated during a 109MB POST).
let uploadsDone = 0;
page.on('response', (res) => {
  if (/uploads\.(githubusercontent|github)\.com/.test(res.url()) && res.status() === 201) {
    uploadsDone++;
    log(`asset upload complete (${uploadsDone}/2): ${res.url().split('/').pop()?.slice(0, 40)}`);
  }
});

log('opening releases/new');
await gotoRetry(`https://github.com/${REPO}/releases/new?tag=${TAG}`);

// Park for interactive login if the session is gone.
if (page.url().includes('/login')) {
  log('NEED LOGIN — sign in inside the opened Chrome window (up to 3 min)...');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && page.url().includes('/login')) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (page.url().includes('/login')) throw new Error('login timeout');
  await gotoRetry(`https://github.com/${REPO}/releases/new?tag=${TAG}`);
  log('login detected, back on the form');
}

await page.waitForSelector('input[name="release[name]"]', { timeout: 60_000 }).catch(async () => {
  log('form not ready — dumping state and retrying once');
  await page.screenshot({ path: 'release/form-retry.png' });
  log(`url=${page.url()}`);
  log(`inputs=${await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((n) => n.name || n.id).join(',')).catch(() => '?')}`);
  await gotoRetry(`https://github.com/${REPO}/releases/new?tag=${TAG}`);
  await page.waitForSelector('input[name="release[name]"]', { timeout: 60_000 });
});

const setReactValue = (el, value) =>
  el.evaluate((node, v) => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

log('filling title + body');
await setReactValue(await page.$('input[name="release[name]"]'), TITLE);
await setReactValue(await page.$('textarea[name="release[body]"]'), NOTES);

log('attaching assets (109M + 75M — allow a couple of minutes)');
const fileInput = await page.$('input[type=file]');
await fileInput.uploadFile(...ASSETS);

// Wait (node-side) until both uploads return 201.
const upDeadline = Date.now() + 900_000;
while (Date.now() < upDeadline && uploadsDone < 2) {
  await new Promise((r) => setTimeout(r, 3000));
}
if (uploadsDone < 2) throw new Error(`only ${uploadsDone}/2 assets uploaded`);
log('assets attached');

const formOk =
  (await page.$eval('input[name="release[name]"]', (n) => n.value)) === TITLE &&
  (await page.$eval('textarea[name="release[body]"]', (n) => n.value.length)) === NOTES.length;
if (!formOk) throw new Error('form verification failed — not publishing');
await page.screenshot({ path: 'release/publish-staged.png' });
log('staged & verified (screenshot: release/publish-staged.png)');

log('clicking Publish release');
let btn = null;
for (let i = 0; i < 5 && !btn; i++) {
  try {
    const h = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Publish release')
    );
    if (h && (await h.asElement())) btn = h.asElement();
  } catch {
    log(`button lookup attempt ${i + 1} failed — retrying`);
  }
  if (!btn) await new Promise((r) => setTimeout(r, 4000));
}
if (!btn) throw new Error('publish button not found');
await btn.click();

await page.waitForFunction(
  () => location.pathname.endsWith(`/releases/tag/${TAG}`) || location.pathname.includes(`/releases/tag/${TAG}`),
  { timeout: 60_000 }
);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'release/publish-done.png' });
log(`PUBLISHED — ${page.url()}`);
await browser.close();
