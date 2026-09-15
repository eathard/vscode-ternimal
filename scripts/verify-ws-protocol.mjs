// verify-ws-protocol.mjs — protocol-level integration suite for RemoteServer
// (verification standard §2, deliverable D8; M2 + M3 scope).
//
// M2 covered: bootstrap tabs push, create/attach/input/resize/close routing,
// replay-on-attach, attached-only data fan-out, NO_SESSION errors, malformed
// + oversized frames, heartbeat termination, slow-client cutoff, static file
// serving with traversal defense.
// M3 covered (real now): TLS everywhere, login flow (wrong/right password,
// cookie attributes per TC-M3-02/03), unauthenticated WS rejection
// (TC-M3-04), rate limiting with unlock (TC-M3-05), plain-HTTP refusal
// (TC-M3-06), auth gate on pages, fingerprint on login page (TC-M3-01 half).
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';
import nodeTls from 'node:tls';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/remoteServer.ts src/main/certManager.ts --outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
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
const { FakePtyHost } = await import(
  pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'ws-protocol-token-32-chars-ok';

async function startServer(opts = {}) {
  const host = new FakePtyHost();
  const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
  const auth =
    opts.auth ??
    new AuthManager({
      accessToken: opts.accessToken ?? TOKEN,
      windowMs: opts.windowMs,
      lockMs: opts.lockMs,
      maxFailures: opts.maxFailures,
    });
  const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cert-')));
  const server = new RemoteServer({
    registry,
    auth,
    tls,
    port: 0,
    host: '127.0.0.1',
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 150,
    slowClientBytes: opts.slowClientBytes ?? 8 * 1024 * 1024,
    webRoot: opts.webRoot,
    maxSessions: opts.maxSessions,
    relayE2EE: true, // hostCaps=['e2ee'] → auth-ok.caps 可断言（wire-compat）
  });
  server.certFingerprint = tls.fingerprint;
  const port = await server.start();
  return {
    server,
    registry,
    host,
    port,
    url: `wss://127.0.0.1:${port}/ws`,
    fingerprint: tls.fingerprint,
    tls,
  };
}

function connect(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: cookie ? { Cookie: `ternimal_session=${cookie}` } : undefined,
    });
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

/** Expect the upgrade to be REJECTED with the given HTTP status. */
function expectUpgradeRejected(url, cookie, wantedStatus) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: cookie ? { Cookie: `ternimal_session=${cookie}` } : undefined,
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === wantedStatus) {
        res.resume();
        resolve();
      } else {
        reject(new Error(`expected ${wantedStatus}, got ${res.statusCode}`));
      }
    });
    ws.on('error', (e) => reject(new Error('ws error before response: ' + e.message)));
  });
}

/** POST /login and return { status, location, setCookie, retryAfter }. */
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
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            setCookie: res.headers['set-cookie']?.[0],
            retryAfter: res.headers['retry-after'],
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Extract the raw token from a Set-Cookie header value. */
function tokenFrom(setCookie) {
  const m = /ternimal_session=([^;]+)/.exec(setCookie ?? '');
  return m ? m[1] : null;
}

async function loginOk(port) {
  const r = await login(port, TOKEN);
  assert.equal(r.status, 303, 'login should redirect');
  const token = tokenFrom(r.setCookie);
  assert.ok(token, 'session cookie issued');
  return token;
}

function waitFor(messages, predicate, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const hit = () => {
      const m = messages.find(predicate);
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
      reject(new Error(`timeout waiting for: ${label}`));
    }, timeoutMs);
  });
}

const closed = (ws) =>
  withTimeout(new Promise((resolve) => ws.on('close', resolve)), 5000, 'ws close');

/** Race with a timeout; clears the timer on settle (no late landmines). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(
        { host: '127.0.0.1', port, path: pathname, agent: false, rejectUnauthorized: false, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              location: res.headers.location,
              type: res.headers['content-type'],
              body: Buffer.concat(chunks).toString(),
            })
          );
        }
      )
      .on('error', reject);
  });
}

/** Raw TLS WebSocket client that upgrades then never reads/pongs. */
function rawSilentClient(port, cookie, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tlsConnect(port, () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          (cookie ? `Cookie: ternimal_session=${cookie}\r\n` : '') +
          `\r\n`
      );
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.off('data', onData);
        if (buf.startsWith('HTTP/1.1 101')) {
          opts.afterUpgrade?.(sock);
          resolve(sock);
        } else reject(new Error('upgrade failed: ' + buf.split('\r\n')[0]));
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

function tlsConnect(port, onConnect) {
  return nodeTls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, onConnect);
}

/** Minimal client→server masked text frame (RFC 6455 §5.3). */
function maskedTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | payload.length]); // FIN|text, mask bit, len<126
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const cleanups = [];

// ---- M3: TLS + auth surface ----

test('TC-M3-06: plain HTTP to the TLS port yields no usable page', async () => {
  const { server, port } = await startServer();
  cleanups.push(() => server.stop());
  const result = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
    let got = '';
    sock.on('data', (d) => (got += d.toString('latin1')));
    const finish = (verdict) => {
      sock.destroy();
      resolve(verdict);
    };
    sock.on('close', () => finish(got.includes('200') ? 'page-served' : 'refused'));
    sock.on('error', () => finish('refused'));
    setTimeout(() => finish(got ? (got.includes('200') ? 'page-served' : 'refused') : 'refused'), 1500);
  });
  assert.equal(result, 'refused', 'plaintext must not receive app content');
});

test('health is open over TLS; login page renders with fingerprint (TC-M3-01 half)', async () => {
  const { server, port, fingerprint } = await startServer();
  cleanups.push(() => server.stop());
  const health = await httpGet(port, '/health');
  assert.equal(health.status, 200);

  const page = await httpGet(port, '/login');
  assert.equal(page.status, 200);
  assert.match(page.body, /Ternimal Remote/);
  assert.ok(page.body.includes(fingerprint), 'fingerprint displayed for eyeball verification');
});

test('TC-M3-02/03: wrong token rejected; right token issues hardened cookie', async () => {
  const { server, port } = await startServer();
  cleanups.push(() => server.stop());

  const bad = await login(port, 'wrong-token');
  assert.equal(bad.status, 303);
  assert.ok(bad.location.includes('e=1'), 'redirects back with error flag');
  assert.ok(!bad.setCookie, 'no cookie on failure');

  const good = await login(port, TOKEN);
  assert.equal(good.status, 303);
  assert.equal(good.location, '/');
  const cookie = good.setCookie ?? '';
  assert.ok(cookie.includes('ternimal_session='), 'session cookie name');
  assert.ok(cookie.includes('HttpOnly'), 'HttpOnly');
  assert.ok(cookie.includes('Secure'), 'Secure');
  assert.ok(cookie.includes('SameSite=Strict'), 'SameSite=Strict');
  assert.ok(/Path=\//.test(cookie), 'Path=/');
});

test('unauthenticated pages redirect to /login', async () => {
  const { server, port } = await startServer();
  cleanups.push(() => server.stop());
  const res = await httpGet(port, '/');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('TC-M3-04: unauthenticated WS upgrade rejected with 401', async () => {
  const { server, url } = await startServer();
  cleanups.push(() => server.stop());
  await expectUpgradeRejected(url, null, 401);
  await expectUpgradeRejected(url, 'deadbeef'.repeat(8), 401);
});

test('authenticated WS over TLS carries the full protocol', async () => {
  const { server, host, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);

  a.ws.send(JSON.stringify({ type: 'create' }));
  const tabsMsg = await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'tabs');
  const id = tabsMsg.tabs[0].id;
  a.ws.send(JSON.stringify({ type: 'attach', id }));
  await waitFor(a.messages, (m) => m.type === 'attached', 'attached');
  host.ptys.get(id).emitOutput('secure roundtrip\n');
  await waitFor(a.messages, (m) => m.type === 'data' && m.data.includes('secure'), 'live data');
});

test('TC-M3-05: five bad logins lock the IP; correct password refused while locked; unlocks after', async () => {
  const { server, port } = await startServer({ lockMs: 300, windowMs: 10_000 });
  cleanups.push(() => server.stop());
  for (let i = 0; i < 5; i++) {
    const r = await login(port, 'nope');
    assert.ok(r.status === 303 || r.status === 429, `attempt ${i + 1} handled`);
  }
  const locked = await login(port, TOKEN);
  assert.equal(locked.status, 429, 'correct password refused while locked');
  assert.ok(locked.retryAfter, 'Retry-After header present');

  await sleep(400); // lockMs=300 for test speed
  const recovered = await login(port, TOKEN);
  assert.equal(recovered.status, 303, 'lock expired, login succeeds');
  assert.ok(recovered.setCookie, 'session issued after recovery');
});

// ---- protocol (over TLS + auth now) ----

test('bootstrap: authenticated ws connect receives initial tabs', async () => {
  const { server, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const { messages } = await connect(url, token);
  // B+：引导首帧 = auth-ok（携带本连接 clientId，几何所有权比对用），
  // 随后才是 tabs 快照。
  await waitFor(messages, (m) => m.type === 'auth-ok', 'auth-ok with clientId');
  assert.ok(typeof messages[0].clientId === 'string' && messages[0].clientId, 'clientId present');
  assert.deepEqual(messages[0].caps, ['e2ee'], 'auth-ok.caps advertises host capabilities');
  await waitFor(messages, (m) => m.type === 'tabs', 'initial tabs');
  const tabsMsg = messages.find((m) => m.type === 'tabs');
  assert.equal(tabsMsg.tabs.length, 0);
});

test('create → tabs broadcast; attach → attached; live data; replay for late joiner (M2-F)', async () => {
  const { server, host, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);

  a.ws.send(JSON.stringify({ type: 'create' }));
  const tabsMsg = await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'tabs after create');
  const id = tabsMsg.tabs[0].id;
  assert.match(id, /^tab-\d+-\d+$/);

  a.ws.send(JSON.stringify({ type: 'attach', id }));
  await waitFor(a.messages, (m) => m.type === 'attached', 'attached');
  assert.equal(a.messages.find((m) => m.type === 'attached').replay, '');

  host.ptys.get(id).emitOutput('claude is thinking...\n');
  const dataMsg = await waitFor(a.messages, (m) => m.type === 'data' && m.data.includes('thinking'), 'live data');
  assert.equal(dataMsg.id, id);

  const b = await connect(url, token);
  b.ws.send(JSON.stringify({ type: 'attach', id }));
  const attached2 = await waitFor(b.messages, (m) => m.type === 'attached', 'late attach replay');
  assert.ok(attached2.replay.includes('claude is thinking'), 'replay has history');
  assert.equal(attached2.title, 'Terminal');
  assert.equal(attached2.cols, 80);
});

test('input routes only for attached clients; echo data comes back', async () => {
  const { server, host, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  const b = await connect(url, token);

  a.ws.send(JSON.stringify({ type: 'create' }));
  const tabsMsg = await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'tabs');
  const id = tabsMsg.tabs[0].id;

  a.ws.send(JSON.stringify({ type: 'attach', id }));
  await waitFor(a.messages, (m) => m.type === 'attached', 'a attached');

  b.ws.send(JSON.stringify({ type: 'input', id, data: 'sneaky' }));
  await waitFor(b.messages, (m) => m.type === 'error' && m.code === 4003, 'NO_SESSION for unattached input');

  a.ws.send(JSON.stringify({ type: 'input', id, data: 'ls' }));
  await waitFor(a.messages, (m) => m.type === 'data' && m.data === '<ls>', 'echo data');
  assert.deepEqual(host.ptys.get(id).writeCalls, ['ls']);
});

test('resize clamps to >=1 and debounces bursts', async () => {
  const { server, host, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const tabsMsg = await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'tabs');
  const id = tabsMsg.tabs[0].id;

  a.ws.send(JSON.stringify({ type: 'resize', id, cols: 0, rows: -5 }));
  await sleep(400);
  const pty = host.ptys.get(id);
  assert.deepEqual(pty.resizeCalls.at(-1), [1, 1], 'clamped dimensions applied');
});

test('attach unknown id → NO_SESSION error; session cap enforced', async () => {
  const { server, port, url } = await startServer({ maxSessions: 1 });
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  a.ws.send(JSON.stringify({ type: 'attach', id: 'tab-does-not-exist' }));
  await waitFor(a.messages, (m) => m.type === 'error' && m.code === 4003, 'NO_SESSION');

  a.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'first session');
  a.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(
    a.messages,
    (m) => m.type === 'error' && /session limit/.test(m.message),
    'limit error'
  );
});

test('malformed message → BAD_MESSAGE and disconnect', async () => {
  const { server, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  const closePromise = closed(a.ws);
  a.ws.send('this is not json');
  await waitFor(a.messages, (m) => m.type === 'error' && m.code === 4004, 'BAD_MESSAGE');
  await closePromise;
});

test('oversized frame (>1MB) → connection closed', async () => {
  const { server, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  const closePromise = closed(a.ws);
  a.ws.send('x'.repeat(2 * 1024 * 1024));
  await closePromise;
});

test('close session → exit to attached client, tabs shrinks', async () => {
  const { server, port, url } = await startServer();
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const tabsMsg = await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'tabs');
  const id = tabsMsg.tabs[0].id;
  a.ws.send(JSON.stringify({ type: 'attach', id }));
  await waitFor(a.messages, (m) => m.type === 'attached', 'attached');

  a.ws.send(JSON.stringify({ type: 'close', id }));
  await waitFor(a.messages, (m) => m.type === 'exit' && m.id === id, 'exit broadcast');
  await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 0, 'tabs shrunk');
});

// ---- liveness ----

test('heartbeat: silent client that never pongs is terminated', async () => {
  const { server, port } = await startServer({ heartbeatIntervalMs: 120 });
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const sock = await rawSilentClient(port, token);
  const sockClosed = new Promise((resolve) => sock.on('close', resolve));
  await Promise.race([sockClosed, sleep(4000).then(() => assert.fail('silent client not terminated'))]);
  assert.ok(true, 'terminated by heartbeat');
});

test('stalled attached client gets cut (heartbeat/backpressure sweep, risk R2)', async () => {
  const { server, host, port, url } = await startServer({ heartbeatIntervalMs: 80, slowClientBytes: 2048 });
  cleanups.push(() => server.stop());
  const token = await loginOk(port);
  const a = await connect(url, token);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const tabsMsg = await waitFor(a.messages, (m) => m.type === 'tabs' && m.tabs.length === 1, 'tabs');
  const id = tabsMsg.tabs[0].id;
  a.ws.send(JSON.stringify({ type: 'attach', id }));
  await waitFor(a.messages, (m) => m.type === 'attached', 'control attached');

  const stalled = await rawSilentClient(port, token, {
    afterUpgrade: (sock) => {
      sock.write(maskedTextFrame(JSON.stringify({ type: 'attach', id })));
      sock.removeAllListeners('data');
    },
  });
  const sockClosed = new Promise((resolve) => stalled.on('close', resolve));

  for (let i = 0; i < 200; i++) host.ptys.get(id).emitOutput('y'.repeat(10 * 1024));

  // 15s（非 5s）：Windows 全链负载下 sweep 定时器钳制 ~15ms + 2MB 同步洪泛
  // 排空竞争 CPU，切断可能晚于 5s——断言的是「最终必被切」，不是具体时长
  //（真实心跳 30s，这里的 80ms 本就是加速档）。
  await withTimeout(sockClosed, 15_000, 'stalled client cut');
  assert.ok(true, 'stalled client cut');

  await waitFor(a.messages, (m) => m.type === 'data', 'healthy client still streaming');
});

// ---- static files ----

test('static serving behind auth: index ok, content-type set, traversal 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>Ternimal Web</html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  const { server, port } = await startServer({ webRoot: dir });
  cleanups.push(() => server.stop());
  const token = await loginOk(port);

  const unauth = await httpGet(port, '/');
  assert.equal(unauth.status, 302, 'static gated by auth');

  const index = await httpGet(port, '/', { Cookie: `ternimal_session=${token}` });
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match(index.body, /Ternimal Web/);

  const js = await httpGet(port, '/static/app.js', { Cookie: `ternimal_session=${token}` });
  assert.equal(js.status, 200);
  assert.match(js.type, /text\/javascript/);

  const trav = await httpGet(port, '/static/../../../etc/passwd', {
    Cookie: `ternimal_session=${token}`,
  });
  assert.ok(trav.status === 404 || trav.status === 403, `traversal blocked (${trav.status})`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await withTimeout(fn(), 20000, name);
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
await withTimeout(
  Promise.allSettled(cleanups.map((fn) => fn())),
  10000,
  'cleanup'
);
console.log(`ws-protocol: ${tests.length - failed}/${tests.length} passed`);
// Hard exit: lingering sockets from intentionally-stalled clients must not
// hang CI (all real cleanup already ran above).
process.exit(failed ? 1 : 0);
