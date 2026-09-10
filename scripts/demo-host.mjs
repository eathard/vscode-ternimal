#!/usr/bin/env node
// demo-host.mjs — 公网演示宿主：本机起 RemoteServer(E2EE) + 插件连 VPS，
// 供「完整访问链接」立即可用（FakePtyHost：输入回显为 <输入>）。
// 用法：nohup node scripts/demo-host.mjs <relayOrigin> <masterCode> <token> &
import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const [RELAY, MASTER, TOKEN] = process.argv.slice(2);
if (!RELAY || !MASTER || !TOKEN) {
  console.error('用法: node scripts/demo-host.mjs <relayOrigin> <masterCode> <token>');
  process.exit(1);
}

const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);

const host = new FakePtyHost();
const registry = new SessionRegistry({ ptyHost: host, replayBytes: 64 * 1024 });
const auth = new AuthManager({ accessToken: TOKEN });
const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-host-')));
const rs = new RemoteServer({
  registry, auth, tls, port: 0, host: '127.0.0.1',
  heartbeatIntervalMs: 30_000, allowRelayFirstFrameAuth: true, relayE2EE: true,
});
rs.certFingerprint = tls.fingerprint;
const localPort = await rs.start();

const plugin = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, NODE_EXTRA_CA_CERTS: '/tmp/caddy-root.crt' },
});
const inbox = [];
plugin.on('message', (m) => inbox.push(m));
plugin.on('error', () => {});
plugin.send({
  type: 'config',
  config: { relayUrl: RELAY, masterCode: MASTER, localPort, fingerprint: tls.fingerprint },
});

const t0 = Date.now();
while (Date.now() - t0 < 15_000 && !inbox.some((m) => m.type === 'status' && m.state === 'registered')) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!inbox.some((m) => m.type === 'status' && m.state === 'registered')) {
  console.error('demo-host: 插件注册失败');
  process.exit(1);
}
console.log(`demo-host: 已注册到 ${RELAY}（token=${TOKEN}）— 保持运行以维持链接可用`);
console.log(`demo-host: pid=${process.pid}`);

const shutdown = () => {
  try { plugin.send({ type: 'shutdown' }); } catch { /* gone */ }
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => { /* keep alive; heartbeat 由各层自理 */ }, 60_000);
