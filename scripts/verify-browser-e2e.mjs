// verify-browser-e2e.mjs — REAL browser verification of the web client
// (the layer raw WS/HTTP clients cannot see: asset loading, login form UX,
// xterm rendering, cookie hardening in an actual browser context).
//
// Drives system Chrome (headless) via puppeteer-core/CDP against the real
// Electron app over HTTPS:
//   / → 302 /login → fingerprint check → wrong token → error page →
//   QR-style URL fragment (#T=...) auto-exchange → web terminal renders →
//   cookie flags → new tab via UI
//   → type into xterm → see bash echo → screenshots for the report.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'os';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793;
const TOKEN = 'browser-e2e-token-32-chars!';
const SHOT_DIR = path.join(root, 'docs', 'test-reports', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

// ---- launch the real app (same recipe as smoke-e2e) ----
const electron = spawn(path.join(root, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox'], {
  cwd: root,
  env: {
    ...process.env,
    TERNIMAL_PORT: String(PORT),
    TERNIMAL_HOST: '127.0.0.1',
    TERNIMAL_TOKEN: TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const appLog = [];
electron.stdout.on('data', (d) => appLog.push(d.toString()));
electron.stderr.on('data', (d) => appLog.push(d.toString()));

async function killApp() {
  electron.kill('SIGTERM');
  try {
    spawn('pkill', ['-f', 'electron/dist/electro[n]']);
  } catch {}
  await sleep(800);
  electron.kill('SIGKILL');
}

async function waitHealthy(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const code = await new Promise((resolve, reject) => {
        https
          .get(
            { host: '127.0.0.1', port: PORT, path: '/health', agent: false, rejectUnauthorized: false },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            }
          )
          .on('error', reject);
      });
      if (code === 200) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('app never became healthy');
}

function certFingerprintFromDisk() {
  const home = os.homedir();
  for (const cfg of [path.join(home, '.config', 'ternimal'), path.join(home, '.config', 'Ternimal')]) {
    const certFile = path.join(cfg, 'certs', 'ternimal-cert.pem');
    if (fs.existsSync(certFile)) {
      const pem = fs.readFileSync(certFile, 'utf8');
      const der = Buffer.from(
        pem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, ''),
        'base64'
      );
      return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
    }
  }
  return null;
}

/** Poll a page predicate until truthy (returns value) or timeout. */
async function poll(page, jsExpr, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await page.evaluate(jsExpr).catch(() => null);
    if (val) return val;
    await sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}

const checks = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  checks.push([name, !!ok, detail]);
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

let browser;
try {
  await waitHealthy();
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Mirrors the human "proceed anyway" click on the self-signed warning
      // (the fingerprint check below stands in for eyeball verification).
      '--ignore-certificate-errors',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 700 });
  page.on('pageerror', (e) => appLog.push(`[pageerror] ${e.message}\n`));
  page.on('websocketframe', (fr) => {
    try {
      const data = fr.response?.payloadData ?? '';
      if (data.includes('"tabs"')) {
        log('  wsrx  tabs(' + (data.match(/tab-/g) || []).length + ')');
      } else if (data.length < 90) {
        log('  wsrx ', data.slice(0, 80));
      }
    } catch {}
  });
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) appLog.push(`[console:${m.type()}] ${m.text()}\n`);
  });

  // 1. Unauthenticated / redirects to the login page with the form.
  await page.goto(`https://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0', timeout: 20000 });
  check('unauthenticated / redirects to /login', page.url().endsWith('/login'), page.url());
  check(
    'auth form present (token input)',
    await page.$('input[type=text][name=token]') !== null
  );

  // 2. Fingerprint on the login page matches the server certificate.
  const pageFp = await poll(page, `document.querySelector('.fp')?.textContent || ''`, 'fingerprint node', 5000);
  const diskFp = certFingerprintFromDisk();
  check(
    'login page fingerprint matches server cert',
    !!diskFp && pageFp.includes(diskFp),
    `${diskFp ? diskFp.slice(0, 17) + '…' : 'cert not found'}`
  );
  await page.screenshot({ path: path.join(SHOT_DIR, 'login.png') });

  // 3. Wrong token → redirected back with the error flag.
  await page.type('input[type=text][name=token]', 'totally-wrong-token');
  await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('button')]);
  check('wrong token rejected', page.url().includes('/login?e=1'), page.url());
  check(
    'error hint rendered',
    (await page.content()).includes('Wrong token')
  );

  // 4. QR-style flow: open the access URL with the token in the URL
  //    FRAGMENT (#T=...). The auth page auto-exchanges it for a session
  //    cookie and strips the fragment — exactly what a phone sees after
  //    scanning the tray QR code. No typing at all.
  await page.goto(`https://127.0.0.1:${PORT}/#T=${encodeURIComponent(TOKEN)}`, {
    waitUntil: 'networkidle0',
    timeout: 20000,
  });
  await sleep(800); // auto-exchange fetch + redirect
  check(
    'QR-style fragment URL auto-authenticates',
    page.url().endsWith('/') && !page.url().includes('#'),
    page.url()
  );
  const tabs1 = await poll(
    page,
    `document.querySelectorAll('.tab-bar-tab').length`,
    'tab bar renders with initial tab',
    15000
  );
  check('tab bar + initial tab rendered', tabs1 >= 1, `${tabs1} tab(s)`);
  // Web assets actually loaded (the layer WS-only tests never see).
  check(
    'web.js/style.css served (not a blank page)',
    await poll(
      page,
      `(() => {
        const term = document.querySelector('.terminal-instance');
        const rows = document.querySelectorAll('.xterm-rows');
        return (term && rows.length >= 1 && getComputedStyle(document.body).backgroundColor) ? 'ok' : '';
      })()`,
      'xterm mounted',
      15000
    ) === 'ok'
  );

  // 5. Cookie hardening as the browser actually stored it.
  const cookie = (await page.cookies()).find((c) => c.name === 'ternimal_session');
  check(
    'browser cookie: HttpOnly+Secure+SameSite=Strict',
    cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict',
    cookie ? `sameSite=${cookie.sameSite}` : 'no cookie'
  );

  // 6. New tab via the UI button (let init/activation settle first — a
  //    human never clicks + in the same millisecond the page loads).
  await sleep(1500);
  await page.click('.tab-bar-add');
  // Poll CONDITIONALLY: the generic poll() resolves on any truthy value, so
  // the expression must return 0 until the count exceeds the baseline.
  const tabs2 = await poll(
    page,
    `(() => { const n = document.querySelectorAll('.tab-bar-tab').length; return n >= ${tabs1} + 1 ? n : 0; })()`,
    'second tab appears',
    30000 // fork() under load can be slow — generous window
  );
  check('new tab via UI button', tabs2 >= tabs1 + 1, `${tabs1}→${tabs2}`);

  // 7. Type into xterm and see real bash echo output in the DOM renderer.
  //    Target the VISIBLE instance; headless Chrome's geometry click can
  //    flake, so focus xterm's helper textarea directly — the exact input
  //    path a real keystroke takes.
  const visibleSel = '.terminal-instance:not([style*="none"])';
  try {
    await page.click(visibleSel);
  } catch {
    /* headless geometry quirk — explicit focus below */
  }
  await page.evaluate(
    `document.querySelector('${visibleSel} .xterm-helper-textarea')?.focus()`
  );
  await sleep(500);
  await page.keyboard.type('echo browser-e2e-ok\r');
  const echoed = await poll(
    page,
    `Array.from(document.querySelectorAll('.xterm-rows'))
       .map(r => r.textContent).join('').includes('browser-e2e-ok') ? 'yes' : ''`,
    'bash echo appears in xterm rows',
    30000
  );
  check('input→PTY→bash→xterm render roundtrip', echoed === 'yes');

  // 7.5 Soft keyboard: Ctrl tap + letter must deliver a REAL Ctrl+C to
  //     bash (one-shot: the modifier resets after the keystroke).
  check(
    'softkeys floating bar rendered (Ctrl/Alt/Shift/Esc/Tab + arrows)',
    (await page.$('#softkeys')) !== null &&
      (await page.$$('#softkeys .sk-mod')).length === 3 &&
      (await page.$$('#softkeys .sk-direct')).length === 2 &&
      (await page.$$('#softkeys .sk-arrow')).length === 4
  );
  await page.keyboard.type('sleep 30\r');
  await poll(
    page,
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').includes('sleep 30') ? 'y' : ''`,
    'sleep command echoed',
    15000
  );
  await page.click('#softkeys .sk-mod[data-mod=ctrl]');
  const ctrlLit = await page.evaluate(
    `document.querySelector('#softkeys .sk-mod[data-mod=ctrl]').classList.contains('sk-active')`
  );
  // Belt and braces: the tap must never have stolen terminal focus.
  await page.evaluate(
    `document.querySelector('.terminal-instance:not([style*="none"]) .xterm-helper-textarea')?.focus()`
  );
  await sleep(200);
  await page.keyboard.type('c');
  const interrupted = await poll(
    page,
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').includes('^C') ? 'y' : ''`,
    'bash reports ^C interrupt',
    15000
  );
  check(
    'softkey Ctrl+c interrupts sleep (^C shown, button lit then reset)',
    ctrlLit === true &&
      interrupted === 'y' &&
      (await page.evaluate(
        `!document.querySelector('#softkeys .sk-mod[data-mod=ctrl]').classList.contains('sk-active')`
      ))
  );
  // Arrow keys: type a marker, move left x3, insert X → readline re-renders
  // the line as Xqzq (only real CSI arrows can do this).
  await page.keyboard.type('qzq');
  await sleep(400);
  for (let i = 0; i < 3; i++) {
    await page.click('#softkeys .sk-arrow[data-dir=left]');
    await sleep(120);
  }
  await page.keyboard.type('X');
  const arrowWorked = await poll(
    page,
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').includes('Xqzq') ? 'y' : ''`,
    'arrow-left moved the cursor (Xqzq rendered)',
    12000
  );
  check('softkey arrows navigate readline (Xqzq rendered)', arrowWorked === 'y');
  await page.keyboard.type('\r'); // execute, keep prompt clean

  // One-shot: the NEXT plain letter must arrive unmodified (no ^X junk).
  await page.keyboard.type('x');
  const plainX = await poll(
    page,
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').split('x').length - 1 > 0 && !Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').includes('^X') ? 'y' : ''`,
    'plain x echoed, no ^X',
    10000
  );
  check('one-shot reset: next keystroke arrives unmodified (no ^X)', plainX === 'y');
  await page.keyboard.type('\x15'); // Ctrl+U: clear the pending line (pure input, no assertion)

  // 8. Reload regression: a page refresh must RESTORE sessions, never
  //    spawn a new one (listTabs used to resolve from an empty cache while
  //    the socket was still connecting). Also: seed a stale DA query in
  //    the buffer (like Claude Code does on startup) — after reload the
  //    fresh xterm must NOT auto-answer it into PTY input ("1;2c" junk).
  const visibleSel2 = '.terminal-instance:not([style*="none"])';
  await page.evaluate(
    `document.querySelector('${visibleSel2} .xterm-helper-textarea')?.focus()`
  );
  await sleep(300);
  await page.keyboard.type("printf '\\033[c' # seed stale DA query\r");
  await poll(
    page,
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').includes('seed stale DA query') ? 'y' : ''`,
    'seed command echoed',
    15000
  );
  const beforeReload = await page.evaluate(
    `document.querySelectorAll('.tab-bar-tab').length`
  );
  // NOTE: clients attached when the query was LIVE (the old web page AND
  // the local Electron window) each auto-answered it once — those echoes
  // are already in the buffer and legitimately replay. What must NOT
  // happen: the REFRESH adding NEW answers. Differential assertion:
  await sleep(1200);
  const junkBefore = await page.evaluate(
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').split('1;2c').length - 1`
  );
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await poll(
    page,
    `(() => { const n = document.querySelectorAll('.tab-bar-tab').length; return n >= ${beforeReload} ? n : 0; })()`,
    'tabs restored after reload',
    20000
  );
  await sleep(1500); // any spurious create would land well within this window
  const afterReload = await page.evaluate(
    `document.querySelectorAll('.tab-bar-tab').length`
  );
  check(
    'page reload restores tabs without creating a new one',
    afterReload === beforeReload,
    `${beforeReload}→${afterReload}`
  );
  await sleep(1000); // a stale-query auto-answer would echo within this window
  const junkAfter = await page.evaluate(
    `Array.from(document.querySelectorAll('.xterm-rows')).map(r => r.textContent).join('').split('1;2c').length - 1`
  );
  check(
    'reload does not inject stale-query responses (no new "1;2c" junk)',
    junkAfter === junkBefore,
    `junk ${junkBefore}→${junkAfter}`
  );

  await page.screenshot({ path: path.join(SHOT_DIR, 'terminal.png') });
} catch (err) {
  failed++;
  log(`  FAIL  scenario crashed: ${err.message}`);
  log('---- app log tail ----\n' + appLog.join('').slice(-1500));
} finally {
  try {
    await browser?.close();
  } catch {}
  await killApp();
}

log(`browser-e2e: ${failed ? 'FAILED' : 'ALL PASS'} (${checks.length - failed}/${checks.length})`);
process.exit(failed ? 1 : 0);
