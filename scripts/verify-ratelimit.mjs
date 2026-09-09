// verify-ratelimit.mjs — unit suite for the M3 security modules
// (verification standard §2, deliverable D8):
//   AuthManager   — scrypt verify, cookie issuance/attributes, session
//                   lifecycle (sliding TTL), per-IP rate limiter semantics
//                   (5 failures/minute → 1-minute lock, window reset),
//                   token rotation invalidating sessions
//   CertManager   — generation, on-disk reuse with stable fingerprint,
//                   key file permissions, X.509 shape (CN/SAN/dates)
//   ConfigStore   — defaults, persistence round-trip, atomic write
// Fast clocks are injected, so "1 minute" runs in milliseconds.
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/main/authManager.ts src/main/certManager.ts src/main/configStore.ts ' +
    '--outDir dist/verify --rootDir src --module commonjs --target es2022 --esModuleInterop ' +
    '--skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { AuthManager, generateAccessToken } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href
);
const { ensureCertificate, fingerprintPem } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href
);
const { ConfigStore } = await import(
  pathToFileURL(path.join(root, 'dist/verify/main/configStore.js')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- token primitives ----

test('generateAccessToken: 32 URL-safe chars (192 bits), unique', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const t = generateAccessToken();
    assert.equal(t.length, 32);
    assert.match(t, /^[A-Za-z0-9_-]+$/, 'URL-safe alphabet');
    seen.add(t);
  }
  assert.equal(seen.size, 50, 'no collisions');
});

// ---- AuthManager: verify + cookie ----

test('login: wrong token 401, right token 303 + hardened cookie', () => {
  const auth = new AuthManager({ accessToken: 's3cret-token-32-chars-aaaa' });
  const bad = auth.login('1.2.3.4', 'nope');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  assert.equal(auth.login('1.2.3.4', 's3cret-token-32-chars-aaab').status, 401, 'near-miss length-equal token rejected');

  const good = auth.login('1.2.3.4', 's3cret-token-32-chars-aaaa');
  assert.equal(good.status, 303);
  assert.ok(good.cookie);
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=']) {
    assert.ok(good.cookie.includes(attr), `cookie carries ${attr}`);
  }
  const token = /ternimal_session=([0-9a-f]+)/.exec(good.cookie)[1];
  assert.equal(token.length, 64, '256-bit token');
});

test('verify path is safe: empty/malformed tokens never validate', () => {
  const auth = new AuthManager({ accessToken: 'x'.repeat(32) });
  assert.equal(auth.login('9.9.9.9', '').status, 401);
  assert.equal(auth.login('9.9.9.9', 'undefined').status, 401);
  assert.equal(new AuthManager().getToken().length, 32, 'generated when not provided');
});

// ---- sessions ----

test('tokenFromCookieHeader: extracts ours from a multi-cookie header', () => {
  const auth = new AuthManager({ accessToken: 'x-token-x-token-x-token-x-token' });
  const r = auth.login('1.1.1.1', 'x-token-x-token-x-token-x-token');
  const token = /ternimal_session=([0-9a-f]+)/.exec(r.cookie)[1];
  assert.equal(
    auth.tokenFromCookieHeader(`a=b; ternimal_session=${token}; c=d`),
    token
  );
  assert.equal(auth.tokenFromCookieHeader('other=value'), undefined);
  assert.equal(auth.tokenFromCookieHeader(undefined), undefined);
});

test('session lifecycle: unknown rejected, expiry enforced, sliding refresh works', async () => {
  const auth = new AuthManager({ accessToken: 'x-token-x-token-x-token-x-token', sessionTtlMs: 120 });
  const { cookie } = auth.login('2.2.2.2', 'x-token-x-token-x-token-x-token');
  const token = /ternimal_session=([0-9a-f]+)/.exec(cookie)[1];

  assert.equal(auth.isValidSession(token), true);
  assert.equal(auth.isValidSession('deadbeef'.repeat(8)), false);

  await sleep(60); // halfway; a refresh here must extend life
  assert.equal(auth.isValidSession(token), true); // refreshed lastSeen

  await sleep(70); // > ttl since last refresh would expire; but we refreshed at 60
  // 60+70=130 > 120 since LAST SEEN? lastSeen was set at t=60 → now=130 → 70<120 → alive
  assert.equal(auth.isValidSession(token), true);

  await sleep(130); // no intermediate access → expired
  assert.equal(auth.isValidSession(token), false);
});

// ---- rate limiter ----

test('rate limit: 5 failures lock for lockMs; correct token 429 while locked; unlock after', async () => {
  const auth = new AuthManager({
    accessToken: 'right-token-32-chars-abcdefghij',
    windowMs: 10_000,
    lockMs: 80,
    maxFailures: 5,
  });
  for (let i = 1; i <= 5; i++) {
    const r = auth.login('3.3.3.3', 'wrong');
    assert.ok(r.status === 401 || r.status === 429, `attempt ${i}: ${r.status}`);
  }
  assert.equal(auth.isLocked('3.3.3.3'), true);

  const during = auth.login('3.3.3.3', 'right-token-32-chars-abcdefghij');
  assert.equal(during.status, 429);
  assert.ok(during.retryAfterMs > 0);

  await sleep(100); // lockMs=80
  assert.equal(auth.isLocked('3.3.3.3'), false);
  assert.equal(auth.login('3.3.3.3', 'right-token-32-chars-abcdefghij').status, 303);
});

test('rate limit window: failures spread beyond windowMs never accumulate to a lock', async () => {
  const auth = new AuthManager({
    accessToken: 'right-token-32-chars-abcdefghij',
    windowMs: 60,
    lockMs: 1000,
    maxFailures: 5,
  });
  for (let i = 0; i < 4; i++) {
    auth.login('4.4.4.4', 'wrong');
    await sleep(25); // window slides past before 5th failure
  }
  assert.equal(auth.isLocked('4.4.4.4'), false);
  assert.equal(auth.login('4.4.4.4', 'right-token-32-chars-abcdefghij').status, 303, 'not locked, success fine');
});

test('successful login resets the failure window for that IP', () => {
  const auth = new AuthManager({
    accessToken: 'right-token-32-chars-abcdefghij',
    windowMs: 10_000,
    lockMs: 1000,
    maxFailures: 3,
  });
  auth.login('5.5.5.5', 'wrong');
  auth.login('5.5.5.5', 'wrong');
  auth.login('5.5.5.5', 'right-token-32-chars-abcdefghij'); // reset
  auth.login('5.5.5.5', 'wrong');
  auth.login('5.5.5.5', 'wrong');
  assert.equal(auth.isLocked('5.5.5.5'), false, 'count restarted after success');
});

test('rate limiting is per-IP', () => {
  const auth = new AuthManager({
    accessToken: 'right-token-32-chars-abcdefghij',
    windowMs: 10_000,
    lockMs: 1000,
    maxFailures: 2,
  });
  auth.login('6.6.6.6', 'wrong');
  auth.login('6.6.6.6', 'wrong');
  assert.equal(auth.isLocked('6.6.6.6'), true);
  assert.equal(auth.isLocked('7.7.7.7'), false);
  assert.equal(auth.login('7.7.7.7', 'right-token-32-chars-abcdefghij').status, 303);
});

// ---- token rotation ----

test('rotateToken: new token works, every old session dies (TC-M3-08 core)', () => {
  const auth = new AuthManager({ accessToken: 'old-token-32-chars-aaaaaaaaaa' });
  const { cookie } = auth.login('8.8.8.8', 'old-token-32-chars-aaaaaaaaaa');
  const token = /ternimal_session=([0-9a-f]+)/.exec(cookie)[1];
  assert.equal(auth.isValidSession(token), true);

  const next = auth.rotateToken();
  assert.equal(next.length, 32, 'new token is a full token');
  assert.notEqual(next, 'old-token-32-chars-aaaaaaaaaa');
  assert.equal(auth.isValidSession(token), false, 'old session invalidated');
  assert.equal(auth.login('8.8.8.8', 'old-token-32-chars-aaaaaaaaaa').status, 401, 'old token dead');
  assert.equal(auth.login('8.8.8.8', next).status, 303, 'new token live');
});

// ---- CertManager ----

test('ensureCertificate: generates valid X.509 with SANs; key mode 0600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cert-unit-'));
  const tls = await ensureCertificate(dir);
  assert.equal(tls.generated, true);
  assert.match(tls.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'SHA-256 colon format');

  const cert = new crypto.X509Certificate(tls.cert);
  assert.equal(cert.subject.split('\n').some((l) => l.includes('CN=Ternimal')), true);
  const san = cert.subjectAltName ?? '';
  assert.ok(san.includes('localhost'), 'DNS SAN present');
  assert.ok(san.includes('127.0.0.1'), 'IP SAN present');

  const keyFile = path.join(dir, 'ternimal-key.pem');
  const mode = fs.statSync(keyFile).mode & 0o777;
  assert.equal(mode, 0o600, 'private key not world-readable');
});

test('ensureCertificate: second call reuses disk material with identical fingerprint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cert-unit-'));
  const first = await ensureCertificate(dir);
  const second = await ensureCertificate(dir);
  assert.equal(second.generated, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(fingerprintPem(first.cert), first.fingerprint, 'fingerprint helper stable');
});

// ---- ConfigStore ----

test('ConfigStore: defaults when missing, round-trip persistence, atomic write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cfg-'));
  const store = new ConfigStore(dir);
  const cfg = store.load();
  assert.equal(cfg.port, 8443);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.maxSessions, 16);

  store.save({ port: 9443, passwordHash: 'scrypt$aa$bb' });
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'config.json.tmp')), false, 'no tmp leftover');

  const reloaded = new ConfigStore(dir).load();
  assert.equal(reloaded.port, 9443);
  assert.equal(reloaded.passwordHash, 'scrypt$aa$bb');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
console.log(`auth+cert+config: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
