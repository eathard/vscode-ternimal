// smoke-e2e.mjs — real end-to-end check of the remote data plane:
// launches the ACTUAL Electron app (real node-pty + real bash) behind the
// M3 security stack (TLS + token login), authenticates over HTTPS,
// connects an authenticated WebSocket client, drives a shell roundtrip,
// verifies replay, and confirms unauthenticated handshakes are refused.
//
// Usage: node scripts/smoke-e2e.mjs   (repo root; needs a display for the
// Electron window — it flashes briefly on the desktop).
import { spawn } from 'node:child_process';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8790;
const TOKEN = 'smoke-test-token-32-chars-ok';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('RemoteServer never became healthy');
}

/** POST /login; returns { status, location, setCookie }. */
function login(token) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ token }).toString();
    const req = https.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/login',
        method: 'POST',
        agent: false,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            setCookie: res.headers['set-cookie']?.[0],
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function connect(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: { Cookie: `ternimal_session=${token}` },
    });
    const messages = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      messages.push(m);
      if (process.env.SMOKE_DEBUG) {
        console.error('    [msg]', JSON.stringify(m).slice(0, 160));
      }
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

/** Expect the upgrade to be rejected with the given status. */
function expectRejected() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { rejectUnauthorized: false });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      res.statusCode === 401 ? resolve() : reject(new Error(`got ${res.statusCode}`));
    });
    ws.on('error', (e) => reject(new Error('error before response: ' + e.message)));
  });
}

function waitFor(messages, pred, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const hit = () => {
      const m = messages.find(pred);
      if (m) {
        resolve(m);
        return true;
      }
      return false;
    };
    if (hit()) return;
    const timer = setInterval(() => hit() && clearInterval(timer), 20);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`timeout: ${label}`));
    }, timeoutMs);
  });
}

// ---- launch the real app ----
const electron = spawn(
  path.join(root, 'node_modules', '.bin', 'electron'),
  ['.', '--no-sandbox'],
  {
    cwd: root,
    env: {
      ...process.env,
      TERNIMAL_PORT: String(PORT),
      TERNIMAL_HOST: '127.0.0.1',
      TERNIMAL_TOKEN: TOKEN,
      TERNIMAL_DEBUG: process.env.TERNIMAL_DEBUG ? '1' : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
const appLog = [];
electron.stdout.on('data', (d) => appLog.push(d.toString()));
electron.stderr.on('data', (d) => appLog.push(d.toString()));
// stderr is unbuffered for pipes — progress survives hangs
const log = (...a) => console.error(...a);

async function killApp() {
  // .bin/electron is a shim; the real binary is its child — kill by path.
  electron.kill('SIGTERM');
  try {
    spawn('pkill', ['-f', 'electron/dist/electro[n]']);
  } catch {}
  await sleep(800);
  electron.kill('SIGKILL');
}

let failed = 0;
try {
  await waitHealthy();
  log(`  PASS  real app launched, /health=200 over TLS on :${PORT}`);

  // M3: auth surface
  await expectRejected();
  log('  PASS  unauthenticated WS handshake refused with 401 (TC-M3-04)');

  const bad = await login('definitely-wrong');
  assert.ok(!bad.setCookie && (bad.status === 303 || bad.status === 401));
  const good = await login(TOKEN);
  assert.equal(good.status, 303);
  const token = /ternimal_session=([0-9a-f]+)/.exec(good.setCookie ?? '')?.[1];
  assert.ok(token, 'session cookie issued');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict']) {
    assert.ok(good.setCookie.includes(attr), `cookie has ${attr}`);
  }
  log('  PASS  token login over HTTPS issues hardened cookie (TC-M3-02/03)');

  const a = await connect(`wss://127.0.0.1:${PORT}/ws`, token);
  // The local window auto-created its initial tab; ours adds a second.
  const initial = await waitFor(a.messages, (m) => m.type === 'tabs', 'initial tabs');
  log(`  PASS  authenticated ws connect; ${initial.tabs.length} existing tab(s)`);

  a.ws.send(JSON.stringify({ type: 'create' }));
  const created = await waitFor(
    a.messages,
    (m) => m.type === 'tabs' && m.tabs.length === initial.tabs.length + 1,
    'new session'
  );
  const ours = created.tabs.find((t) => !initial.tabs.some((i) => i.id === t.id));
  assert.ok(ours.pid > 0, 'real pid assigned');
  log(`  PASS  created real session ${ours.id} (pid ${ours.pid})`);

  a.ws.send(JSON.stringify({ type: 'attach', id: ours.id }));
  await waitFor(a.messages, (m) => m.type === 'attached' && m.id === ours.id, 'attached');

  a.ws.send(JSON.stringify({ type: 'input', id: ours.id, data: 'echo hello-ternimal\r' }));
  await waitFor(
    a.messages,
    (m) => m.type === 'data' && m.data.includes('hello-ternimal'),
    'real bash roundtrip'
  );
  log('  PASS  input→PTY→bash→output roundtrip over WSS');

  // Replay: a fresh client attaching sees prior output from the ring buffer
  const b = await connect(`wss://127.0.0.1:${PORT}/ws`, token);
  b.ws.send(JSON.stringify({ type: 'attach', id: ours.id }));
  const att = await waitFor(b.messages, (m) => m.type === 'attached' && m.id === ours.id, 'replay attach');
  assert.ok(att.replay.includes('hello-ternimal'), 'replay contains history');
  log('  PASS  second client got ring-buffer replay (M2-F)');

  a.ws.send(JSON.stringify({ type: 'close', id: ours.id }));
  await waitFor(a.messages, (m) => m.type === 'exit' && m.id === ours.id, 'exit');
  log('  PASS  session closed cleanly');
} catch (err) {
  failed++;
  console.error(`  FAIL  ${err.message}`);
  console.error('---- app log ----\n' + appLog.join('').slice(-2000));
} finally {
  await killApp();
}

log(`smoke-e2e: ${failed ? 'FAILED' : 'ALL PASS'}`);
process.exit(failed ? 1 : 0);
