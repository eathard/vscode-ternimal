#!/usr/bin/env node
// verify-relay-matrix.mjs — R-M4 / WBS-R4-C：重连·背压·接管·容量矩阵（D-R4 补充）。
//
// 对应验收标准 §3.4：
//   TC-R4-03 重连矩阵（自动化子集）：
//     M-01 relay 重启 → 插件退避重注册 + transport 重连 + 会话 replay 兜底
//     M-02 断网 30s（缩尺）→ 恢复后 replay 补齐断网期输出（ring buffer 兜底）
//     M-03 插件被杀 → 新插件同主码接管（旧控制通道收割）→ 隧道恢复
//   TC-R4-04 背压/容量矩阵（自动化子集；真 20 会话×10min×tc 3MB/s 为人工项）：
//     M-04 慢消费者背压 → 只终止该客户端，不扩散（对齐方案书 §3.8）
//     M-05 容量：全链路（relay+插件+两跳 TLS）≥3MB/s + relay 字节计数器一致
//     M-06 并发：单通道第 5 管道拒收；16 客户端 × 4 通道并发交互全通
//
// 自包含（同 verify-relay-e2e.mjs 惯例：无框架、严格退出码）。
import { execSync, fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
process.env.TERNIMAL_LOCALE = 'en';

execSync(
  'npx tsc src/main/remoteServer.ts src/main/certManager.ts src/renderer/transport/webSocketTransport.ts ' +
    '--outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { RemoteServer } = await import(pathToFileURL(path.join(root, 'dist/verify/main/remoteServer.js')).href);
const { SessionRegistry } = await import(pathToFileURL(path.join(root, 'dist/verify/main/sessionRegistry.js')).href);
const { AuthManager } = await import(pathToFileURL(path.join(root, 'dist/verify/main/authManager.js')).href);
const { ensureCertificate } = await import(pathToFileURL(path.join(root, 'dist/verify/main/certManager.js')).href);
const { FakePtyHost } = await import(pathToFileURL(path.join(root, 'scripts/lib/fake-pty-host.mjs')).href);
const { WebSocketTransport } = await import(
  pathToFileURL(path.join(root, 'dist/verify/renderer/transport/webSocketTransport.js')).href
);
const { newMasterCode, sha256Hex } = await import(pathToFileURL(path.join(root, 'relay/src/protocol.mjs')).href);
const { RelayServer } = await import(pathToFileURL(path.join(root, 'relay/src/server.mjs')).href);

const TOKEN = 'relay-matrix-token-32-chars-!!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(pred, label, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await pred()) return;
    } catch {
      /* keep polling */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** 收集 JSON 消息的 ws 客户端（含谓词等待）。 */
function jsonWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { m = null; }
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    ws.on('open', () => resolve({
      ws, inbox,
      nextWhere: (pred, timeoutMs = 8000) => {
        const hit = () => {
          const i = inbox.findIndex(pred);
          return i >= 0 ? inbox.splice(i, 1)[0] : null;
        };
        const found = hit();
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`nextWhere timeout (${String(pred).slice(0, 40)})`)), timeoutMs);
          const iv = setInterval(() => {
            const f = hit();
            if (f) { clearTimeout(t); clearInterval(iv); res(f); }
          }, 20);
        });
      },
    }));
    ws.on('error', reject);
  });
}

async function startRemoteServer(opts = {}) {
  const host = new FakePtyHost();
  const registry = new SessionRegistry({ ptyHost: host, replayBytes: 1024 * 1024 });
  const auth = new AuthManager({ accessToken: TOKEN });
  const tls = await ensureCertificate(fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-mx-cert-')));
  const server = new RemoteServer({
    registry, auth, tls, port: 0, host: '127.0.0.1',
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 60_000,
    slowClientBytes: opts.slowClientBytes ?? 8 * 1024 * 1024,
    maxSessions: opts.maxSessions ?? 16,
    allowRelayFirstFrameAuth: true,
  });
  server.certFingerprint = tls.fingerprint;
  const port = await server.start();
  return { server, registry, host, port, fingerprint: tls.fingerprint };
}

/** port/master 可指定（重连矩阵需要在原端口、同主码复活 relay——
 * 真实部署读同一份盘上配置，行为一致）。 */
async function startRelay(port = 0, master = newMasterCode(), limits = {}) {
  const server = new RelayServer({
    host: '127.0.0.1', port, log: process.env.MLOG === '1',
    config: { masterHashes: [sha256Hex(master)], limits },
    heartbeatIntervalMs: 60_000,
  });
  const actual = await server.start();
  return { server, master, port: actual };
}

/** 插件「已注册」状态次数（重启判重用：累加而非存在）。 */
const regCount = (plugin) => plugin.inbox.filter((m) => m.type === 'status' && m.state === 'registered').length;

function forkPlugin({ relayUrl, masterCode, localPort, fingerprint }) {
  const child = fork(path.join(root, 'relay/src/plugin/relayPlugin.mjs'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const inbox = [];
  const exitP = new Promise((res) => child.once('exit', (code, sig) => res({ code, sig })));
  child.on('message', (m) => inbox.push(m));
  child.on('error', () => { /* IPC 通道关闭等：清理路径自愈 */ });
  const api = {
    inbox,
    post: (m) => { if (child.connected) child.send(m); },
    exited: () => exitP,
    killHard: () => child.kill('SIGKILL'),
    waitFor: (pred, timeoutMs = 12_000) => pollUntil(
      () => inbox.some(pred), 'plugin status', timeoutMs
    ),
  };
  child.send({ type: 'config', config: { relayUrl, masterCode, localPort, fingerprint } });
  return api;
}

/** 远端假客户端（挑战应答）——与 e2e 套件同语义。 */
async function remoteClient(relayPort, subCode, token = TOKEN) {
  const c = await jsonWs(`ws://127.0.0.1:${relayPort}/join`);
  c.ws.send(JSON.stringify({ v: 1, type: 'join', subCode }));
  const ch = await c.nextWhere((m) => m.type === 'auth-challenge');
  const mac = crypto.createHmac('sha256', token).update(ch.nonce).digest('hex');
  c.ws.send(JSON.stringify({ type: 'auth-response', mac }));
  await c.nextWhere((m) => m.type === 'auth-ok');
  return c;
}

async function issueSub(relay, label) {
  return fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then((r) => r.json());
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------

test('M-01 TC-R4-03 重连矩阵·relay 重启 → 插件重注册 + transport 重连 + replay 兜底', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const sub = await issueSub(relay, 'm1');

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket, relay: { subCode: sub.subCode, token: TOKEN },
  });
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'initial ready');
    const created = await tp.createTab({});
    tp.attach(created.id);
    tp.input(created.id, 'before-restart');
    await new Promise((res) => {
      const un = tp.onData((p) => { if (String(p.data).includes('<before-restart>')) { un(); res(); } });
    });

    // relay 宕机（原端口、同主码复活 = 真实部署读同一份配置）
    const port = relay.port;
    const regs0 = regCount(plugin);
    await relay.server.stop();
    await sleep(1600); // 越过首次退避（1s）后 connect() 会把 gate 置回 connecting
    assert.ok(tp.relayGate !== 'ready', '断开后 gate 非 ready');

    const relay2 = await startRelay(port, relay.master);
    try {
      await pollUntil(() => regCount(plugin) > regs0, '插件退避后重注册', 30_000);
      // relay 内存 store 已清空：旧子码必然失效 → 4001 致命关闭码，
      // transport 停止重试并给出明确提示（TC-R4-03「明确提示」分支）
      await pollUntil(() => tp.relayGate === 'denied', '旧子码 4001 → gate denied（不无限重试）', 30_000);
      tp.dispose();
      // 运维侧重新签发子码（真实流程：tray 分享链接随之刷新）
      const sub2 = await issueSub(relay2, 'm1-after');
      const tp2 = new WebSocketTransport(`ws://127.0.0.1:${relay2.port}/join`, {
        wsImpl: WebSocket, relay: { subCode: sub2.subCode, token: TOKEN },
      });
      try {
        await pollUntil(() => tp2.relayGate === 'ready', '新子码 ready', 30_000);
        // 会话未丢：re-attach 后 replay 兜底含重启前输出
        const replay = new Promise((res) => {
          const un = tp2.onAttached((p) => { un(); res(p); });
        });
        tp2.attach(created.id);
        const att = await replay;
        assert.ok(String(att.replay ?? '').includes('<before-restart>'), 'replay 兜底了重启前输出');
      } finally {
        tp2.dispose();
      }
    } finally {
      await relay2.server.stop();
    }
  } finally {
    tp.dispose();
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await rs.server.stop();
  }
});

test('M-02 TC-R4-03 重连矩阵·断网期输出 → 恢复后 replay 补齐（ring buffer 兜底）', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const sub = await issueSub(relay, 'm2');

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket, relay: { subCode: sub.subCode, token: TOKEN },
  });
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'initial ready');
    const created = await tp.createTab({});
    tp.attach(created.id);
    tp.input(created.id, 'pre-outage');
    await new Promise((res) => {
      const un = tp.onData((p) => { if (String(p.data).includes('<pre-outage>')) { un(); res(); } });
    });

    const port = relay.port;
    const regs0 = regCount(plugin);
    await relay.server.stop();
    // “断网 30s”缩尺为 2s；期间 PTY 自行产出（长任务输出进 ring buffer）
    rs.host.ptys.get(created.id).emitOutput('during-outage-data\n');
    await sleep(2000);

    const relay2 = await startRelay(port, relay.master);
    try {
      await pollUntil(() => regCount(plugin) > regs0, '插件退避后重注册', 30_000);
      // 断网恢复后旧子码已随 store 清空失效：换新子码重建（同真实运维流程）
      await pollUntil(() => tp.relayGate === 'denied', '旧子码失效明确提示', 30_000);
      tp.dispose();
      const sub2 = await issueSub(relay2, 'm2-after');
      const tp2 = new WebSocketTransport(`ws://127.0.0.1:${relay2.port}/join`, {
        wsImpl: WebSocket, relay: { subCode: sub2.subCode, token: TOKEN },
      });
      try {
        await pollUntil(() => tp2.relayGate === 'ready', '新子码 ready', 30_000);
        const replay = new Promise((res) => {
          const un = tp2.onAttached((p) => { un(); res(p); });
        });
        tp2.attach(created.id);
        const att = await replay;
        assert.ok(String(att.replay ?? '').includes('during-outage-data'), '断网期输出经 replay 补齐');
      } finally {
        tp2.dispose();
      }
    } finally {
      await relay2.server.stop();
    }
  } finally {
    tp.dispose();
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await rs.server.stop();
  }
});

test('M-03 TC-R4-03 重连矩阵·插件被杀 → 新插件同主码接管 → 隧道恢复', async () => {
  const rs = await startRemoteServer();
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const sub = await issueSub(relay, 'm3');

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket, relay: { subCode: sub.subCode, token: TOKEN },
  });
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'initial ready');
    // 插件被 SIGKILL（崩溃语义，无 shutdown 消息）
    plugin.killHard();
    await plugin.exited();
    await sleep(1600); // 越过首次退避（1s）
    assert.ok(tp.relayGate !== 'ready', '管道断开后 gate 非 ready');

    // 新插件、同主码 → relay 接管语义（旧控制通道收割）
    const plugin2 = forkPlugin({
      relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
      localPort: rs.port, fingerprint: rs.fingerprint,
    });
    try {
      await plugin2.waitFor((m) => m.type === 'status' && m.state === 'registered');
      await pollUntil(() => tp.relayGate === 'ready', 'takeover ready', 30_000);
      const created = await tp.createTab({});
      assert.ok(String(created.id).startsWith('tab-'), '接管后新会话可用');
      tp.attach(created.id);
      const echo = new Promise((res) => {
        const un = tp.onData((p) => { if (String(p.data).includes('<after-takeover>')) { un(); res(); } });
      });
      tp.input(created.id, 'after-takeover');
      await echo;
    } finally {
      plugin2.post({ type: 'shutdown' });
      await plugin2.exited();
    }
  } finally {
    tp.dispose();
    try { plugin.post({ type: 'shutdown' }); } catch { /* already dead */ }
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

test('M-04 TC-R4-04 子集·慢消费者背压 → 仅终止该客户端，不扩散', async () => {
  // 慢客户端的背压保护层在 relay（插件贪婪转发）。host 侧 slowClientBytes
  // 保持默认 8MB——同步突发会误伤插件连接（单 tick 内无法排出）。
  const rs = await startRemoteServer();
  const relay = await startRelay(0, undefined, { backpressureBytes: 256 * 1024 });
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const sub = await issueSub(relay, 'm4');

  try {
    const slow = await remoteClient(relay.port, sub.subCode);
    const healthy = await remoteClient(relay.port, sub.subCode);

    // 公共会话；慢客户端停止读取（pause）
    slow.ws.send(JSON.stringify({ type: 'create' }));
    const tabs = await slow.nextWhere((m) => m.type === 'tabs' && m.tabs.length > 0);
    const id = tabs.tabs[0].id;
    for (const c of [slow, healthy]) c.ws.send(JSON.stringify({ type: 'attach', id }));
    await slow.nextWhere((m) => m.type === 'attached');
    await healthy.nextWhere((m) => m.type === 'attached');
    // 停读 + 收紧接收缓冲（loopback 内核默认缓冲可达数 MB，需确定性触发）
    slow.ws._socket?.setRecvBufferSize?.(64 * 1024);
    slow.ws.pause(); // 停读 → TCP 窗口关闭 → relay 侧 userspace 缓冲上升

    // 洪泛期间以 relay 管道表为准观察回收（paused socket 无法就地观察
    // terminate）——这也是「不扩散」的直接证据
    const pipeCount = () => {
      const ch = [...relay.server.store.channels.values()][0];
      return ch ? ch.pipes.size : 0;
    };
    // 节流洪泛（32KB × 1024 上限，慢管道回收即止）：周期性让出事件循环，
    // 确保积压只出现在 relay→慢客户端一侧（而非 host→插件），触发 relay 硬
    // terminate。每次让出间的突发（2×32KB=64KB）必须 ≤ 内核 sndbuf 量级且
    // 远小于 relay 背压阈值（256KB）：fwd 的「发→查→杀」在同一事件循环轮次
    // 内同步执行，突发一旦逼近阈值，健康客户端的读事件来不及插队就会被误杀
    //（Windows 定时器钳制 sleep(1)≈15ms 进一步放大 gulp 粒度）。
    // 慢管道回收后立即停手：洪泛目的已达成，32MB 总量仅为 loopback 内核缓冲
    // 自动调优之上的余量，回收后继续写只会空耗 Windows 上的测试时长。
    const chunk = 'y'.repeat(32 * 1024);
    for (let i = 0; i < 1024; i++) {
      rs.host.write(id, chunk);
      if (i % 2 === 1) await sleep(1);
      if (pipeCount() === 1) break; // 仅慢管道被回收 → 成功路径提前收场
    }
    await pollUntil(() => pipeCount() === 1, '慢客户端管道被背压回收（健康管道保留）', 30_000);
    // 慢客户端恢复读取后观察到断链（terminate 语义）
    slow.ws.resume();
    await pollUntil(() => slow.ws.readyState === WebSocket.CLOSED, '慢客户端最终断链', 10_000);
    // 健康客户端不受影响（不扩散）
    healthy.ws.send(JSON.stringify({ type: 'input', id, data: 'still-alive' }));
    const ok = await healthy.nextWhere((m) => m.type === 'data' && String(m.data).includes('<still-alive>'));
    assert.ok(ok, '健康客户端交互不受慢客户端影响');
    healthy.ws.close();
  } finally {
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

test('M-05 TC-R4-04 子集·容量：全链路 ≥3MB/s + relay 字节计数一致', async () => {
  const rs = await startRemoteServer({ maxSessions: 32 });
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');
  const sub = await issueSub(relay, 'm5');

  const tp = new WebSocketTransport(`ws://127.0.0.1:${relay.port}/join`, {
    wsImpl: WebSocket, relay: { subCode: sub.subCode, token: TOKEN },
  });
  try {
    await pollUntil(() => tp.relayGate === 'ready', 'ready');
    const created = await tp.createTab({});
    const attachedP = new Promise((res) => {
      const un = tp.onAttached((p) => { un(); res(p); });
    });
    tp.attach(created.id);
    await attachedP; // 先确认 attach 生效，避免 input 抢跑导致无回显

    // 3072 × 4KiB 输入 → 回显约 12MiB（经 relay+插件+两跳本地 TLS）。
    // 采用真实终端尺度帧：512KiB 合成大帧会让接收端 JSON 解析停顿，
    // 在 relay 默认 1MB 背压阈值下仅有 2 帧余量，属超设计工况（发现已
    // 记录进 R4 报告与公开服务 checklist）。
    const CHUNK = 'z'.repeat(4 * 1024);
    const TOTAL = 3072;
    const TARGET = 12 * 1024 * 1024;
    let received = 0;
    if (process.env.MDBG === '1') setInterval(() => console.error(`    [dbg] received=${(received / 1048576).toFixed(2)}MiB`), 2000).unref();
    const done = new Promise((res) => {
      const un = tp.onData((p) => {
        received += Buffer.byteLength(String(p.data), 'utf8');
        if (received >= TARGET) { un(); res(); }
      });
    });
    const t0 = Date.now();
    for (let i = 0; i < TOTAL; i++) {
      tp.input(created.id, CHUNK);
      if (i % 64 === 63) await sleep(0); // 让事件循环喘息，避免灌入端自阻塞
    }
    await done;
    const secs = (Date.now() - t0) / 1000;
    const mbps = received / 1024 / 1024 / secs;
    assert.ok(mbps >= 3, `吞吐 ${mbps.toFixed(1)} MiB/s ≥ 3 MiB/s（${(received / 1048576).toFixed(1)} MiB / ${secs.toFixed(2)}s）`);
    console.log(`    容量实测：${(received / 1048576).toFixed(1)} MiB in ${secs.toFixed(2)}s = ${mbps.toFixed(1)} MiB/s`);

    // relay 字节计数器一致（流量统计可靠）
    const list = await fetch(`http://127.0.0.1:${relay.port}/api/channels/subcodes`, {
      headers: { authorization: `Bearer ${relay.master}` },
    }).then((r) => r.json());
    const entry = (list.subcodes ?? []).find((s) => s.code === sub.subCode);
    const counted = entry?.stats?.bytes ?? 0;
    assert.ok(counted >= received, `relay 字节计数 ${counted} ≥ 回显字节 ${received}`);
  } finally {
    tp.dispose();
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

test('M-06 TC-R4-04 子集·并发：单通道第 5 管道拒收；4 管道承载 16 交互会话', async () => {
  const rs = await startRemoteServer({ maxSessions: 32 });
  const relay = await startRelay();
  const plugin = forkPlugin({
    relayUrl: `http://127.0.0.1:${relay.port}`, masterCode: relay.master,
    localPort: rs.port, fingerprint: rs.fingerprint,
  });
  await plugin.waitFor((m) => m.type === 'status' && m.state === 'registered');

  try {
    // ① 单通道并发上限 4：第 5 个 join 拒收（4002/限速族关闭码）
    const subA = await issueSub(relay, 'm6a');
    const four = [];
    for (let i = 0; i < 4; i++) four.push(await remoteClient(relay.port, subA.subCode));
    const fifth = await jsonWs(`ws://127.0.0.1:${relay.port}/join`);
    const fifthClose = new Promise((res) => fifth.ws.once('close', (code) => res(code)));
    fifth.ws.send(JSON.stringify({ v: 1, type: 'join', subCode: subA.subCode }));
    const closeCode = await fifthClose;
    assert.equal(closeCode, 4004, `第 5 管道被拒 BUSY（close ${closeCode}）`);
    for (const c of four) c.ws.close();
    // 同一通道共享 maxPipesPerChannel：等 4 条管道完全回收再开 ②
    const pipesOf = () => {
      const ch = [...relay.server.store.channels.values()][0];
      return ch ? ch.pipes.size + ch.pending.size : 0;
    };
    await pollUntil(() => pipesOf() === 0, 'part① 管道回收', 15_000);

    // ② 通道容量边界内的真实模型：4 条并发管道（通道级上限）承载 16 个
    // 交互会话（TC-R4-04 的 20 会话缩尺——多会话经同一管道 JSON 复用）
    const subB = await issueSub(relay, 'm6b');
    const clients = [];
    for (let k = 0; k < 4; k++) clients.push(await remoteClient(relay.port, subB.subCode));
    const ids = [];
    for (let n = 0; n < 16; n++) {
      clients[0].ws.send(JSON.stringify({ type: 'create' }));
      const t = await clients[0].nextWhere((m) => m.type === 'tabs' && m.tabs.length === n + 1);
      ids.push(t.tabs[t.tabs.length - 1].id);
    }
    await Promise.all(clients.map(async (c, k) => {
      const mine = ids.slice(k * 4, k * 4 + 4);
      for (const id of mine) c.ws.send(JSON.stringify({ type: 'attach', id }));
      for (const id of mine) await c.nextWhere((m) => m.type === 'attached' && m.id === id);
      c.ws.send(JSON.stringify({ type: 'input', id: mine[0], data: `hi-${k}` }));
      await c.nextWhere((m) => m.type === 'data' && m.id === mine[0] && String(m.data).includes(`<hi-${k}>`));
    }));
    for (const c of clients) c.ws.close();
  } finally {
    plugin.post({ type: 'shutdown' });
    await plugin.exited();
    await relay.server.stop();
    await rs.server.stop();
  }
});

// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const only = process.env.MONLY ?? '';
for (const { name, fn } of tests) {
  if (only && !name.includes(only)) continue;
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✘ ${name}`);
    console.error(`    ${err?.stack?.split('\n').slice(0, 6).join('\n    ') ?? err}`);
    if (process.env.TERNIMAL_MATRIX_FAILFAST !== '0') break;
  }
}
console.log(`verify-relay-matrix: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
