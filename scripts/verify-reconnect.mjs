// verify-reconnect.mjs — TC-M4-08 (M4-D): drive the REAL WebSocketTransport
// against a TLS+auth RemoteServer (fake PTY host) through a hard socket drop:
//   attach → live data → network-style kill (no close frame) → output keeps
//   accumulating server-side → transport auto-reconnects with backoff →
//   re-attaches → replay catches up everything missed → input keeps flowing.
// Exit code 0 = pass (verification standard §3.4 mandates this script).
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ws from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/remoteServer.ts src/main/certManager.ts src/renderer/transport/webSocketTransport.ts ' +
    '--outDir dist/verify --rootDir src --module commonjs --target es2022 --esModuleInterop ' +
    '--skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { RemoteServer } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href
);
const { SessionRegistry } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href
);
const { AuthManager } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href
);
const { ensureCertificate } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href
);
const { WebSocketTransport } = await import(
  pathToFileURL(path.join(root, 'dist/verify/renderer/transport/webSocketTransport.js')).href
);
const { FakePtyHost } = await import(
  pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href
);

const TOKEN = 'reconnect-token-32-chars-okay';

function hashOf(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function login(port, token) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ token }).toString();
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
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
          resolve({ status: res.statusCode, setCookie: res.headers['set-cookie']?.[0] })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function eventCollector() {
  const items = [];
  return {
    items,
    push: (x) => items.push(x),
    waitFor: (pred, label, timeoutMs = 15000) => {
      const poll = setInterval(() => {
        const hit = items.find(pred);
        if (hit) {
          clearInterval(poll);
          clearTimeout(guard);
          resolveHit(hit);
        }
      }, 20);
      let resolveHit;
      const done = new Promise((r) => (resolveHit = r));
      const guard = setTimeout(() => {
        clearInterval(poll);
        resolveHit = resolveHit; // keep ref
        resolveHit?.(undefined);
      }, timeoutMs);
      return withTimeout(
        done.then((hit) => {
          assert.ok(hit, `timeout waiting for: ${label}`);
          return hit;
        }),
        timeoutMs + 500,
        label
      );
    },
  };
}

let failed = 0;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok, detail]);
  if (!ok) failed++;
};

// ---- scenario ----
const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-rc-')));
const server = new RemoteServer({
  registry,
  auth,
  tls,
  port: 0,
  host: '127.0.0.1',
  heartbeatIntervalMs: 60_000, // long grace: reconnect happens well within
});
const port = await server.start();

try {
  const session = registry.create({ cols: 80, rows: 24 });
  const lg = await login(port, TOKEN);
  const token = /ternimal_session=([0-9a-f]+)/.exec(lg.setCookie ?? '')?.[1];
  assert.ok(token, 'login for cookie');

  const transport = new WebSocketTransport(`wss://127.0.0.1:${port}/ws`, {
    wsImpl: ws.WebSocket,
    wsOptions: {
      rejectUnauthorized: false,
      headers: { Cookie: `ternimal_session=${token}` },
    },
  });

  const tabsEv = eventCollector();
  const dataEv = eventCollector();
  const attEv = eventCollector();
  transport.onTabsChange((t) => tabsEv.push(t));
  transport.onData((d) => dataEv.push(d));
  transport.onAttached((a) => attEv.push(a));

  // 1. bootstrap + attach + live data
  const tabs1 = await tabsEv.waitFor((t) => t.some((x) => x.id === session.id), 'bootstrap tabs');
  check('bootstrap tabs visible', tabs1.some((t) => t.id === session.id));

  transport.attach(session.id);
  await attEv.waitFor((a) => a.id === session.id, 'first attach');
  check('attach acknowledged', true);

  host.ptys.get(session.id).emitOutput('before-drop: stable\r\n');
  await dataEv.waitFor((d) => d.data.includes('before-drop'), 'live data pre-drop');
  check('live data pre-drop', true);

  // 2. hard network-style drop: RST the client socket, no close frame
  const rawWs = transport.ws; // test reaches into the private socket on purpose
  assert.ok(rawWs, 'socket present');
  rawWs.terminate();

  // 3. output keeps flowing server-side while the client is "offline"
  await new Promise((r) => setTimeout(r, 300));
  host.ptys.get(session.id).emitOutput('while-away-1\r\n');
  host.ptys.get(session.id).emitOutput('while-away-2\r\n');

  // 4. transport heals itself: backoff (1s base) → reconnect → re-attach
  const reattach = await attEv.waitFor(
    (a, idx) => idx > 0 && a.id === session.id && a.replay.includes('while-away-2'),
    'reconnect + replay catch-up'
  );
  check(
    'replay includes pre-drop AND missed output',
    reattach.replay.includes('before-drop') &&
      reattach.replay.includes('while-away-1') &&
      reattach.replay.includes('while-away-2'),
    `replay=${reattach.replay.length}B`
  );

  // 5. live data flows again after healing
  host.ptys.get(session.id).emitOutput('after-reconnect\r\n');
  await dataEv.waitFor((d) => d.data.includes('after-reconnect'), 'live data post-reconnect');
  check('live data post-reconnect', true);

  // 6. input path works over the healed connection
  transport.input(session.id, 'echo healed\r');
  await new Promise((r) => setTimeout(r, 400));
  check(
    'input delivered over healed socket',
    host.ptys.get(session.id).writeCalls.includes('echo healed\r'),
    JSON.stringify(host.ptys.get(session.id).writeCalls)
  );

  // 7. listTabs answered by the server (request/response still alive)
  const listed = await withTimeout(transport.listTabs(), 5000, 'listTabs');
  check(
    'listTabs post-reconnect',
    listed.some((t) => t.id === session.id) && listed.length === 1,
    `got ${listed.length}`
  );

  // 8. no session duplication from the reconnect
  check('no duplicate sessions', registry.list().length === 1);

  transport.dispose();
} catch (err) {
  failed++;
  checks.push(['scenario crashed', false, err.message]);
  console.error(err);
} finally {
  await server.stop();
}

for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(`reconnect: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
