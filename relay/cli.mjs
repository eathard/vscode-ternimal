#!/usr/bin/env node
// relay/cli.mjs — relay 管理命令行（relay-plan.md WBS-R1-B / D-R2）。
//
// 用法：
//   node relay/cli.mjs add-master [--config relay/relay-config.json]
//       签发主码：生成 → 哈希落盘 → 明文【仅显示一次】（方案书 §8-Q1）
//   node relay/cli.mjs serve [--config …] [--host H] [--port P]
//                            [--webroot DIR] [--insecure]
//       启动服务。默认 127.0.0.1 明文（Caddy 前置形态，方案书 §3.7）；
//       非 loopback 明文监听必须显式 --insecure；TLS 证书在 config.tls 配置。

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { newMasterCode, sha256Hex } from './src/protocol.mjs';
import { loadConfig, saveConfig } from './src/config.mjs';
import { RelayServer } from './src/server.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '--host' || a === '--port' || a === '--webroot' || a === '--days' || a === '--label' || a === '--url' || a === '--ca-file') {
      out[a.slice(2)] = argv[++i];
    } else if (a === '--insecure') {
      out.insecure = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function die(msg) {
  console.error(`[relay-cli] ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'serve';
const configFile = path.resolve(args.config ?? 'relay/relay-config.json');

if (cmd === 'add-master') {
  // 计费生命周期：--days 30（支持小数 0.5=12h）；--label 客户名；缺省=永久
  const days = args.days ? Number(args.days) : null;
  const label = args.label ?? '(unnamed)';
  if (days != null && (!Number.isFinite(days) || days <= 0 || days > 3650)) die('--days 取值 (0, 3650]，支持小数');
  const cfg = loadConfig(configFile);
  const code = newMasterCode();
  const hash = sha256Hex(code);
  cfg.masters = cfg.masters ?? [];
  if ([...cfg.masters, ...cfg.masterHashes.map((h) => ({ hash: h }))].some((m) => m.hash === hash)) {
    die('哈希碰撞（概率可忽略），请重试');
  }
  const entry = {
    hash, label,
    createdAt: Date.now(),
    expiresAt: days ? Date.now() + days * 86_400_000 : null,
    revoked: false,
  };
  cfg.masters.push(entry);
  saveConfig(configFile, cfg);
  console.log('主码已签发（明文仅此一次显示，请立即复制保存）：');
  console.log('  ' + code);
  console.log(`  标签=${label}  有效期=${days ? days + ' 天' : '永久'}  id=${hash.slice(0, 8)}`);
  console.log(`已写入 ${configFile}`);
  process.exit(0);
}

if (cmd === 'list-masters') {
  const cfg = loadConfig(configFile);
  const all = [
    ...(cfg.masters ?? []).map((m) => ({ ...m, permanent: false })),
    ...(cfg.masterHashes ?? []).map((h) => ({ hash: h, label: '(legacy)', permanent: true, revoked: false, expiresAt: null })),
  ];
  if (!all.length) { console.log('（无主码）'); process.exit(0); }
  const now = Date.now();
  for (const m of all) {
    const st = m.permanent ? '永久' : m.revoked ? '已吊销' : m.expiresAt <= now ? '已过期' : '有效';
    const until = m.expiresAt ? new Date(m.expiresAt).toISOString().replace('T', ' ').slice(0, 16) : '-';
    console.log(`${m.hash.slice(0, 8)}  ${st.padEnd(4)}  到期=${until}  ${m.label}`);
  }
  process.exit(0);
}

if (cmd === 'renew-master') {
  const id = args._[1];
  const days = args.days ? Number(args.days) : 30;
  if (!id) die('用法: renew-master <id前8位> [--days 30]');
  const cfg = loadConfig(configFile);
  const m = (cfg.masters ?? []).find((x) => x.hash.startsWith(id));
  if (!m) die('未找到该主码（或为 legacy 永久码，无需续期）');
  m.revoked = false;
  m.expiresAt = Math.max(Date.now(), m.expiresAt ?? 0) + days * 86_400_000;
  saveConfig(configFile, cfg);
  console.log(`已续期 ${days} 天 → ${new Date(m.expiresAt).toISOString()}`);
  process.exit(0);
}

if (cmd === 'revoke-master') {
  const id = args._[1];
  if (!id) die('用法: revoke-master <id前8位>');
  const cfg = loadConfig(configFile);
  const m = (cfg.masters ?? []).find((x) => x.hash.startsWith(id));
  if (!m) die('未找到该主码（或为 legacy 永久码，请直接编辑配置）');
  m.revoked = true;
  saveConfig(configFile, cfg);
  console.log(`主码 ${id} 已吊销（重启 relay 或等 sweep 生效；管理页吊销则立即生效）`);
  process.exit(0);
}

if (cmd === 'set-admin') {
  // 管理页密码：scrypt$salt$hash 落盘（与主码体系独立；会话内存 12h）
  const pw = args._[1];
  if (!pw || pw.length < 8) die('用法: set-admin <密码（至少 8 位）>');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  const cfg2 = loadConfig(configFile);
  cfg2.adminHash = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  saveConfig(configFile, cfg2);
  console.log(`管理密码已设置（scrypt 哈希写入 ${configFile}）`);
  console.log('管理页地址：https://<relay>/admin （重启 relay 后生效）');
  process.exit(0);
}

if (cmd === 'bind-access') {
  const file = args.config ?? path.resolve('relay/relay-config.json');
  const cfg = loadConfig(file);
  if (args.url) {
    const u = String(args.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(u)) die('--url must be http(s)://…');
    cfg.publicUrl = u;
  }
  if (args['ca-file']) {
    const pem = fs.readFileSync(args['ca-file'], 'utf8').trim();
    if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) die('ca file is not a PEM certificate');
    try { new crypto.X509Certificate(pem); } catch (e) { die(`invalid certificate: ${e.message}`); }
    cfg.publicCaPem = pem;
  }
  if (!cfg.publicUrl) die('publicUrl not set — pass --url https://<ip-or-domain>');
  saveConfig(file, cfg);
  console.log(`[relay-cli] access bound: url=${cfg.publicUrl} ca=${cfg.publicCaPem ? 'yes' : 'none'}`);
  process.exit(0);
}

if (cmd === 'conf-token') {
  const file = args.config ?? path.resolve('relay/relay-config.json');
  const cfg = loadConfig(file);
  const code = args._[1];
  if (!code || !code.startsWith('trelay_v1_')) die('usage: conf-token <主码明文 trelay_v1_…>');
  if (!cfg.publicUrl) die('publicUrl not bound — run bind-access first');
  const { encodeAccessToken } = await import('./src/token.mjs');
  const token = encodeAccessToken({ url: cfg.publicUrl, master: code, caPem: cfg.publicCaPem, label: args.label });
  console.log(token);
  process.exit(0);
}

if (cmd === 'serve') {
  const cfg = loadConfig(configFile);
  const host = args.host ?? cfg.host;
  const port = args.port ? Number(args.port) : cfg.port;
  const webRoot = args.webroot ?? cfg.webRoot ?? '';
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!cfg.tls && !isLoopback && !args.insecure) {
    die('明文监听非 loopback 地址需显式 --insecure（生产请用 Caddy 前置或 config.tls，见 relay/README.md）');
  }
  if (cfg.masterHashes.length === 0 && !args.insecure) {
    console.warn('[relay-cli] 警告：配置中无主码，先运行 add-master（当前仅 --insecure 模式可空跑）');
  }
  const server = new RelayServer({ config: cfg, host, port, webRoot: webRoot || undefined, configFile });
  // P0-兜底：任何漏网的未捕获异常（尤其 ws 协议错误路径）不允许直接崩掉
  // 全部客户的管道——记日志保活，交给 sweep/心跳去清理死连接。
  process.on('uncaughtException', (err) => {
    console.error('[relay-cli] uncaughtException (suppressed):', err?.stack ?? err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[relay-cli] unhandledRejection (suppressed):', err?.stack ?? err);
  });
  server.start().then((actual) => {
    console.log(`[relay-cli] serving http://${host}:${actual}  webRoot=${webRoot || '(无)'}`);
  }).catch((err) => die(`启动失败: ${err.message}`));
  const shutdown = () => { server.stop().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  die(`未知命令：${cmd}（可用：add-master | serve）`);
}
