// smoke-e2e.mjs — real end-to-end check of the remote data plane:
// launches the ACTUAL Electron app (real node-pty + real bash) behind the
// M3 security stack (TLS + token login), authenticates over HTTPS,
// connects an authenticated WebSocket client, drives a shell roundtrip,
// verifies replay, and confirms unauthenticated handshakes are refused.
//
// R2-H relay scenes (relay-verification-standard §3.2.1): with the in-process
// relay + env channel (TERNIMAL_RELAY_URL/MASTER), the app spawns the plugin
// as a REAL utilityProcess —
//   SCENE-R2H-01 registered log (RR1 spike)
//   SCENE-R2H-02 full tunnel: fake browser → relay → utilityProcess →
//              loopback TLS → real bash roundtrip
//   SCENE-R2H-03 kill -9 the plugin child → PluginHost backoff restart
//   SCENE-R2H-04 app quit → no orphan plugin process
//
// Usage: node scripts/smoke-e2e.mjs   (repo root; needs a display for the
// Electron window — it flashes briefly on the desktop).
import { spawn } from 'node:child_process';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8790;
const RELAY_PORT = 8791;
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

/** Expect the auth gate: direct 401 (LAN mode) OR first-frame gate
 * (relay mode — loopback upgrades without a cookie but every business
 * frame is refused with AUTH_REQUIRED until `auth` succeeds). */
function expectAuthGate() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { rejectUnauthorized: false });
    const bail = setTimeout(() => reject(new Error('auth gate: no verdict')), 10_000);
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      if (res.statusCode === 401) {
        clearTimeout(bail);
        resolve('401');
      } else {
        clearTimeout(bail);
        reject(new Error(`got ${res.statusCode}`));
      }
    });
    ws.on('open', () => {
      // relay mode: upgrade accepted (pending auth) → business frame refused
      ws.send(JSON.stringify({ type: 'create' }));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error' && m.code === 4001) {
          clearTimeout(bail);
          ws.terminate();
          resolve('auth-required');
        }
      });
      ws.on('close', (code) => {
        if (code === 4001) {
          clearTimeout(bail);
          resolve('auth-required-close');
        }
      });
    });
    ws.on('error', (e) => {
      clearTimeout(bail);
      reject(new Error('error before verdict: ' + e.message));
    });
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

// ---- launch the real app (plus the in-process relay for R2-H scenes) ----

const { newMasterCode, sha256Hex } = await import(
  path.join(root, 'relay/src/protocol.mjs')
);
const { RelayServer } = await import(path.join(root, 'relay/src/server.mjs'));
const RELAY_MASTER = newMasterCode();
const relay = new RelayServer({
  host: '127.0.0.1',
  port: RELAY_PORT,
  log: false,
  config: { masterHashes: [sha256Hex(RELAY_MASTER)], limits: {} },
  heartbeatIntervalMs: 60_000,
  joinPendingMs: 5_000,
  firstFrameTimeoutMs: 5_000,
});
await relay.start();

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
      TERNIMAL_RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`,
      TERNIMAL_RELAY_MASTER: RELAY_MASTER,
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
/** SCENE-R2H-04: plugin pids that must be gone after app exit. */
const relayExitChecks = [];
try {
  await waitHealthy();
  log(`  PASS  real app launched, /health=200 over TLS on :${PORT}`);

  // M3: auth surface — relay 模式下 loopback 升级免 cookie 但首帧门兜底
  const verdict = await expectAuthGate();
  log(`  PASS  unauthenticated client gated (${verdict}) (TC-M3-04/R2 relay-mode)`);

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

  // ---- R2-H relay scenes (§3.2.1) ----

  /** Poll the captured app output for a regex hit. */
  const waitLog = (re, label, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const hit = () => {
        const m = re.exec(appLog.join(''));
        if (m) return m;
        return null;
      };
      const found = hit();
      if (found) return resolve(found);
      const timer = setInterval(() => {
        const f = hit();
        if (f) {
          clearInterval(timer);
          resolve(f);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`timeout: ${label}`));
      }, timeoutMs);
    });

  // SCENE-R2H-01: utilityProcess child registers with the relay (RR1 spike)
  const reg1 = await waitLog(
    /\[Ternimal\] relay: registered[^\n]*pid=(\d+)/,
    'relay registered log'
  );
  const pluginPid1 = Number(reg1[1]);
  assert.ok(pluginPid1 > 0, 'plugin pid parsed from status log');
  log(`  PASS  SCENE-R2H-01 utilityProcess plugin registered (pid ${pluginPid1})`);

  // SCENE-R2H-02: fake browser → relay → plugin → loopback TLS → real bash
  const issue = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/channels/subcodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RELAY_MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'smoke' }),
  }).then((r) => r.json());
  assert.ok(issue.subCode, 'subcode issued');

  const rc = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/join`);
  const rmsgs = [];
  rc.on('message', (raw) => {
    rmsgs.push(JSON.parse(raw.toString()));
    // R-M4-A 挑战应答：Token 明文不再过中继
    const m = JSON.parse(raw.toString());
    if (m.type === 'auth-challenge') {
      rc.send(JSON.stringify({
        type: 'auth-response',
        mac: crypto.createHmac('sha256', TOKEN).update(m.nonce).digest('hex'),
      }));
    }
  });
  await new Promise((res, rej) => {
    rc.on('open', res);
    rc.on('error', rej);
  });
  rc.send(JSON.stringify({ v: 1, type: 'join', subCode: issue.subCode }));
  await waitFor(rmsgs, (m) => m.type === 'auth-ok', 'relay first-frame auth');
  rc.send(JSON.stringify({ type: 'create' }));
  const rtabs = await waitFor(rmsgs, (m) => m.type === 'tabs' && m.tabs.length > 0, 'relay create');
  const rid = rtabs.tabs.at(-1).id;
  rc.send(JSON.stringify({ type: 'attach', id: rid }));
  await waitFor(rmsgs, (m) => m.type === 'attached' && m.id === rid, 'relay attach');
  rc.send(JSON.stringify({ type: 'input', id: rid, data: 'echo hello-relay-smoke\r' }));
  await waitFor(
    rmsgs,
    (m) => m.type === 'data' && m.data.includes('hello-relay-smoke'),
    'relay tunnel real-bash roundtrip'
  );
  log('  PASS  SCENE-R2H-02 full tunnel roundtrip via relay+utilityProcess (real bash)');

  // SCENE-R2H-03: kill -9 the plugin child → PluginHost backoff restart
  process.kill(pluginPid1, 'SIGKILL');
  const pluginPid2 = await new Promise((resolve, reject) => {
    const bail = setTimeout(() => {
      clearInterval(iv);
      reject(new Error('timeout: plugin restart (no new registered pid)'));
    }, 25_000);
    const iv = setInterval(() => {
      const pids = [...appLog.join('').matchAll(/\[Ternimal\] relay: registered[^\n]*pid=(\d+)/g)].map(
        (m) => Number(m[1])
      );
      const next = pids.find((p) => p !== pluginPid1);
      if (next) {
        clearInterval(iv);
        clearTimeout(bail);
        resolve(next);
      }
    }, 100);
  });
  log(`  PASS  SCENE-R2H-03 plugin crash-restarted (pid ${pluginPid1} → ${pluginPid2})`);

  // Restarted plugin must serve a fresh client again (recovery, not zombie)
  const issue2 = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/channels/subcodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RELAY_MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'smoke-2' }),
  }).then((r) => r.json());
  const rc2 = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/join`);
  const rmsgs2 = [];
  rc2.on('message', (raw) => {
    rmsgs2.push(JSON.parse(raw.toString()));
    const m = JSON.parse(raw.toString());
    if (m.type === 'auth-challenge') {
      rc2.send(JSON.stringify({
        type: 'auth-response',
        mac: crypto.createHmac('sha256', TOKEN).update(m.nonce).digest('hex'),
      }));
    }
  });
  await new Promise((res, rej) => {
    rc2.on('open', res);
    rc2.on('error', rej);
  });
  rc2.send(JSON.stringify({ v: 1, type: 'join', subCode: issue2.subCode }));
  await waitFor(rmsgs2, (m) => m.type === 'auth-ok', 'post-restart auth-ok');
  log('  PASS  SCENE-R2H-03b restarted plugin serves new tunnels');

  // SCENE-R2H-04: app quit → no orphan plugin process (checked in finally
  // after killApp(); assert deferred there via this hook)
  relayExitChecks.push(pluginPid1, pluginPid2);
} catch (err) {
  failed++;
  console.error(`  FAIL  ${err.message}`);
  console.error('---- app log ----\n' + appLog.join('').slice(-2000));
} finally {
  await killApp();
  // SCENE-R2H-04: zero residue — every plugin pid must be dead (ESRCH).
  try {
    if (relayExitChecks.length > 0) {
      await sleep(300);
      for (const pid of relayExitChecks) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        assert.ok(!alive, `plugin pid ${pid} still alive after app exit`);
      }
      log(`  PASS  SCENE-R2H-04 no orphan plugin process (${relayExitChecks.join(', ')} all gone)`);
    }
  } catch (err) {
    failed++;
    console.error(`  FAIL  SCENE-R2H-04 ${err.message}`);
  }
  await relay.stop();
}

log(`smoke-e2e: ${failed ? 'FAILED' : 'ALL PASS'}`);
process.exit(failed ? 1 : 0);
