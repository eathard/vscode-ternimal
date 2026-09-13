// B-09 混合接入口令（tconf_v1）：编解码/防篡改/绑定/签发即口令/鉴权
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const { MemoryStore } = await import(path.join(root, 'relay/src/store.mjs'));
const { newMasterCode, sha256Hex } = await import(path.join(root, 'relay/src/protocol.mjs'));
const { RelayServer } = await import(path.join(root, 'relay/src/server.mjs'));
const { encodeAccessToken, decodeAccessToken, caFingerprint } = await import(path.join(root, 'relay/src/token.mjs'));
const { loadConfig } = await import(path.join(root, 'relay/src/config.mjs'));

// 测试用自签证书（真实 X.509 结构，token.mjs 用 X509Certificate 解析指纹）
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
const scryptHash = (pw) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b09-'));
const KEY = path.join(tmp, 'k.pem'), CERT = path.join(tmp, 'c.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', KEY, '-out', CERT,
  '-days', '2', '-nodes', '-subj', '/CN=b09-test'], { stdio: 'ignore' });
const PEM = fs.readFileSync(CERT, 'utf8').trim();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✘ ${name}\n    ${err?.stack ?? err}`); }
}

async function makeRelay(cfgFile) {
  const master = newMasterCode();
  const server = new RelayServer({
    host: '127.0.0.1', port: 0, log: false, store: new MemoryStore(), configFile: cfgFile,
    config: { masterHashes: [sha256Hex(master)], limits: {}, trustedProxy: false },
    heartbeatIntervalMs: 60_000,
  });
  const port = await server.start();
  return { server, master, port };
}
const http = (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const j = (r) => r.json();

console.log('B-09 access token (tconf_v1)');

await test('T-01 编解码往返：url/主码/CA/E2EE 完整保真', async () => {
  const tok = encodeAccessToken({ url: 'https://1.2.3.4/', master: 'trelay_v1_ABC', caPem: PEM, label: 'L' });
  const d = await decodeAccessToken(tok);
  assert.equal(d.ok, true);
  assert.equal(d.config.url, 'https://1.2.3.4');
  assert.equal(d.config.master, 'trelay_v1_ABC');
  assert.equal(d.config.ca, PEM);
  assert.equal(d.config.e2ee, true);
});

await test('T-02 防截断/防篡改/防伪造：三者均拒绝且文案可读', async () => {
  const tok = encodeAccessToken({ url: 'https://a.b', master: 'trelay_v1_X' });
  assert.equal((await decodeAccessToken(tok.slice(0, -3))).ok, false);
  const i = tok.indexOf('_') + 1; // 前缀后第一个 b64 字符
  const evil = tok.slice(0, i) + (tok[i] === 'A' ? 'B' : 'A') + tok.slice(i + 1);
  assert.equal((await decodeAccessToken(evil)).ok, false);
  assert.equal((await decodeAccessToken('trelay_v1_not_a_token')).ok, false);
  assert.match((await decodeAccessToken(tok.slice(0, -3))).error, /截断|校验/);
});

await test('T-03 PUT/GET /api/admin/access：绑定地址+CA，落盘持久化', async () => {
  const cfgFile = path.join(tmp, 'relay-t3.json');
  const { server, port } = await makeRelay(cfgFile);
  const login = await j(await http(port, '/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'root' }) })).catch(() => null);
  // 无 admin 密码配置 → 404/400（adminHash 未设）；改用 server.setAdmin? 直接用 opts.adminHash
  await server.stop();
  const srv2 = new RelayServer({
    host: '127.0.0.1', port: 0, log: false, store: new MemoryStore(), configFile: cfgFile,
    config: { masterHashes: [], limits: {}, trustedProxy: false, adminHash: scryptHash('admin-pw-t3') },
  });
  const p2 = await srv2.start();
  const lg = await j(await http(p2, '/api/admin/login', { method: 'POST', body: '{"password":"admin-pw-t3"}' }));
  const H = { authorization: `Bearer ${lg.token}`, 'content-type': 'application/json' };
  const put = await j(await http(p2, '/api/admin/access', { method: 'PUT', headers: H, body: JSON.stringify({ publicUrl: 'https://9.9.9.9', caPem: PEM }) }));
  assert.equal(put.publicUrl, 'https://9.9.9.9');
  assert.equal(put.caBound, true);
  assert.equal(put.caFingerprint, caFingerprint(PEM));
  // 非法 PEM 拒绝
  const bad = await http(p2, '/api/admin/access', { method: 'PUT', headers: H, body: '{"caPem":"not a pem"}' });
  assert.equal(bad.status, 400);
  // 落盘
  const saved = loadConfig(cfgFile);
  assert.equal(saved.publicUrl, 'https://9.9.9.9');
  assert.ok(saved.publicCaPem.includes('BEGIN CERTIFICATE'));
  await srv2.stop();
});

await test('T-04 POST /api/admin/token：未知主码 404；有效主码出口令可解码含 CA', async () => {
  const cfgFile = path.join(tmp, 'relay-t4.json');
  const { server, master, port } = await makeRelay(cfgFile);
  const lg = await j(await http(port, '/api/admin/login', { method: 'POST', body: '{"password":"x"}' })).catch(() => null);
  await server.stop();
  const srv2 = new RelayServer({
    host: '127.0.0.1', port: 0, log: false, store: new MemoryStore(), configFile: cfgFile,
    config: { masterHashes: [sha256Hex(master)], limits: {}, trustedProxy: false, adminHash: scryptHash('pw4'), publicUrl: 'https://4.4.4.4', publicCaPem: PEM },
  });
  const p2 = await srv2.start();
  const lg2 = await j(await http(p2, '/api/admin/login', { method: 'POST', body: '{"password":"pw4"}' }));
  const H = { authorization: `Bearer ${lg2.token}`, 'content-type': 'application/json' };
  const nf = await http(p2, '/api/admin/token', { method: 'POST', headers: H, body: '{"code":"trelay_v1_unknown"}' });
  assert.equal(nf.status, 404);
  const ok = await j(await http(p2, '/api/admin/token', { method: 'POST', headers: H, body: JSON.stringify({ code: master }) }));
  const d = await decodeAccessToken(ok.token);
  assert.equal(d.ok, true);
  assert.equal(d.config.master, master);
  assert.equal(d.config.url, 'https://4.4.4.4');
  assert.equal(d.config.ca, PEM);
  await srv2.stop();
});

await test('T-05 签发主码即附带口令（一购即得）', async () => {
  const cfgFile = path.join(tmp, 'relay-t5.json');
  const { server, port } = await makeRelay(cfgFile);
  await server.stop();
  const srv2 = new RelayServer({
    host: '127.0.0.1', port: 0, log: false, store: new MemoryStore(), configFile: cfgFile,
    config: { masterHashes: [], limits: {}, trustedProxy: false, adminHash: scryptHash('pw5'), publicUrl: 'https://5.5.5.5', publicCaPem: PEM },
  });
  const p2 = await srv2.start();
  const lg = await j(await http(p2, '/api/admin/login', { method: 'POST', body: '{"password":"pw5"}' }));
  const iss = await j(await http(p2, '/api/admin/masters', { method: 'POST', headers: { authorization: `Bearer ${lg.token}`, 'content-type': 'application/json' }, body: '{"label":"t5","days":30}' }));
  assert.ok(iss.token, '签发响应应带 token');
  const d = await decodeAccessToken(iss.token);
  assert.equal(d.ok, true);
  assert.equal(d.config.master, iss.code);
  await srv2.stop();
});

await test('T-06 管理鉴权：无 token 访问 access/token 均 401', async () => {
  const { server, port } = await makeRelay(path.join(tmp, 'relay-t6.json'));
  await server.stop();
  const srv2 = new RelayServer({
    host: '127.0.0.1', port: 0, log: false, store: new MemoryStore(),
    config: { masterHashes: [], limits: {}, trustedProxy: false, adminHash: scryptHash('pw6'), publicUrl: 'https://6.6.6.6' },
  });
  const p2 = await srv2.start();
  assert.equal((await http(p2, '/api/admin/access')).status, 401);
  assert.equal((await http(p2, '/api/admin/token', { method: 'POST', body: '{"code":"trelay_v1_x"}' })).status, 401);
  await srv2.stop();
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`verify-relay-token: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
