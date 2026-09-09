// release-login-bootstrap.mjs — phase 1: establish a persistent GitHub
// session in the dedicated release profile. The user signs in inside the
// opened window; we then close Chrome GRACEFULLY so cookies flush to disk
// (a hard kill loses them), and re-launch once to prove persistence.
import puppeteer from 'puppeteer-core';

const PROFILE = `${process.env.HOME}/.config/chrome-release-profile`;
const log = (m) => console.log(`[login] ${m}`);

async function launch() {
  return puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    userDataDir: PROFILE,
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,960'],
  });
}

let browser = await launch();
let page = (await browser.pages())[0] ?? (await browser.newPage());
log('opening github.com/login — sign in in the opened window (5 min)');
await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 90_000 });

const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const url = page.url();
  const ok = await page
    .evaluate(() => !!document.querySelector('img[src*="avatars.githubusercontent"], summary img.avatar'))
    .catch(() => false);
  if (!url.includes('/login') && !url.includes('/session') && ok) break;
}
const stillLogin = page.url().includes('/login');
if (stillLogin) throw new Error('login timeout (5 min) — rerun this script');

log('session detected — dwelling 12s so cookies settle');
await new Promise((r) => setTimeout(r, 12_000));
await browser.close(); // graceful: flushes cookies to disk
log('closed gracefully, re-launching to verify persistence');

browser = await launch();
page = (await browser.pages())[0] ?? (await browser.newPage());
await page.goto('https://github.com/eathard/vscode-ternimal', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await new Promise((r) => setTimeout(r, 4000));
const loggedIn = await page
  .evaluate(() => !!document.querySelector('img[src*="avatars.githubusercontent"], summary img.avatar'))
  .catch(() => false);
log(`persistent session: ${loggedIn ? 'YES' : 'NO'}`);
await browser.close();
if (!loggedIn) throw new Error('session did not persist — try again and dwell longer');
log('OK — profile ready for publish');
