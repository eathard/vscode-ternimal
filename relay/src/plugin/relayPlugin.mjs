// relay/src/plugin/relayPlugin.mjs — Ternimal 中继插件（子进程侧，WBS-R2-B）。
//
// 纯管道职责（方案书 §4.2），无任何终端业务逻辑：
//   1. 控制通道：拨 relay /control、register、接收 client-offer、断线退避重连
//   2. 管道对接：收到 offer → 出站拨 relay /pipe + 本机 loopback RemoteServer
//      （自签证书指纹钉扎）→ 双向字节拼接
//   3. 管理 API 代理：替主进程调 relay 子码 API（主码只在本进程与配置文件中出现）
//
// 运行形态：Electron utilityProcess（process.parentPort）或 node fork
// （process.send）——二者消息语义在此统一封装。
//
// 配置来源：父进程启动后第一条 {type:'config', config} 消息（避免依赖 env 传递）。

import * as crypto from 'crypto';
import { WebSocket } from 'ws';

const OPEN = WebSocket.OPEN;

// ---------- 父进程消息封装（utilityProcess / fork 双模式） ----------

function makeParentChannel() {
  if (process.parentPort) {
    return {
      post(msg) { process.parentPort.postMessage(msg); },
      onMessage(handler) { process.parentPort.on('message', (e) => handler(e.data)); },
    };
  }
  if (typeof process.send === 'function') {
    return {
      post(msg) { process.send(msg); },
      onMessage(handler) { process.on('message', handler); },
    };
  }
  // 无父进程（手工调试）：从 argv[2] 读 JSON 配置，打印事件
  return {
    post(msg) { console.log('[plugin:parentless]', JSON.stringify(msg)); },
    onMessage() { /* no-op */ },
  };
}
const parent = makeParentChannel();

// ---------- 状态 ----------

let cfg = null; // { relayUrl, masterCode, localPort, fingerprint }
let control = null; // WebSocket | null
let state = 'starting';
let backoffMs = 1000;
const pipes = new Set(); // { relayWs, localWs, closed }
const pendingReqs = new Map(); // id → {resolve, reject}
let reqSeq = 0;

const LOOP_RETRIES_BEFORE_SLOW = 3;
let connectAttempts = 0;

function setState(next, detail = '') {
  state = next;
  parent.post({ type: 'status', state: next, detail, pipes: pipes.size, pid: process.pid });
}

// ---------- URL 工具 ----------

function wsBase(httpBase) {
  return httpBase.replace(/^http/, 'ws').replace(/\/+$/, '');
}

function sha256ColonHex(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

// ---------- 控制通道 ----------

function dialControl(opts = {}) {
  if (!cfg) return;
  const url = `${wsBase(cfg.relayUrl)}/control`;
  const ws = new WebSocket(url);
  let registered = false;
  control = ws;

  // 心跳失活看门狗：服务端以 ws 协议层 ping（30s/次）保活，不是 JSON 消息！
  // 活性必须追踪协议层：ping/pong/message 任一到达即视为活着。
  // 仅统计消息会把「空闲但健康」的连接在 100s 时误杀（每隔百秒假重连）。
  // 超过 3 个周期无任何帧（中继冻结/代理半开，不会收到 close）→ 主动断开走重连。
  let lastAliveAt = Date.now();
  const touchAlive = () => { lastAliveAt = Date.now(); };
  const watchdog = setInterval(() => {
    if (state !== 'registered') return;
    if (Date.now() - lastAliveAt > 100_000) {
      try { ws.terminate(); } catch { /* 已死 */ }
    }
  }, 15_000);
  ws.on('close', () => clearInterval(watchdog));
  ws.on('ping', touchAlive);
  ws.on('pong', touchAlive);

  ws.on('open', () => {
    touchAlive();
    const reg = { v: 1, proto: 2, type: 'register', masterCode: cfg.masterCode };
    if (opts.force) reg.force = true; // 强制接管/夺回：面板人工点击才会传
    ws.send(JSON.stringify(reg));
  });

  ws.on('message', (raw) => {
    touchAlive();
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'registered') {
      registered = true;
      backoffMs = 1000;
      connectAttempts = 0;
      setState('registered', `channel ${m.channelId}`);
    } else if (m.type === 'client-offer') {
      dialPipe(m.clientId);
    } else if (m.type === 'occupied') {
      // 主码已有活跃实例（服务器 ping 探测确认活着）。不做战争式重连：
      // 驻留等待，每 30s 静默探测一次（持有方退出后自动接管，零人工）。
      setState('occupied', 'master in use elsewhere');
    } else if (m.type === 'taken-over') {
      // 被人工强制接管：驻停，停止一切自动重连——战争结构性终止。
      // 面板显示「已被接管」，是否夺回由人决定（force-register）。
      setState('parked', 'taken over by another device');
    } else if (m.type === 'error') {
      parent.post({ type: 'relay-error', code: m.code, message: m.message });
    }
  });

  ws.on('close', () => {
    if (control === ws) control = null;
    reapAllPipes();
    if (state === 'stopped' || state === 'parked') return; // 驻停：等人工夺回
    if (state === 'occupied') { scheduleOccupiedProbe(); return; } // 占用：30s 静默探测
    scheduleReconnect(registered ? 'reconnecting' : 'starting');
  });
  ws.on('error', () => { /* close 紧随其后，统一在 close 处理 */ });
}

function scheduleReconnect(nextState) {
  connectAttempts += 1;
  const cap = connectAttempts > LOOP_RETRIES_BEFORE_SLOW ? 30_000 : 4_000;
  const jitter = Math.random() * 0.3 * Math.min(backoffMs, cap);
  const delay = Math.min(backoffMs, cap) * (0.7 + Math.random() * 0.6);
  backoffMs = Math.min(backoffMs * 2, 30_000);
  setState(nextState, `retry in ${Math.round(delay + jitter)}ms`);
  setTimeout(() => { if (state !== 'stopped') dialControl(); }, delay + jitter);
}

let occupiedProbeTimer = null;
function scheduleOccupiedProbe() {
  clearTimeout(occupiedProbeTimer);
  setState('occupied', 'probe in 30s');
  occupiedProbeTimer = setTimeout(() => {
    if (state === 'occupied') dialControl(); // 非 force 探测：持有方已退则自动接管
  }, 30_000);
}

/** 人工意图：强制接管（occupied 时）或夺回（parked 时）。面板按钮触发。 */
function forceRegister() {
  clearTimeout(occupiedProbeTimer);
  setState('starting', 'force register');
  dialControl({ force: true });
}

// ---------- 管道对接 ----------

function dialPipe(clientId) {
  const relayWs = new WebSocket(`${wsBase(cfg.relayUrl)}/pipe`);
  const localWs = new WebSocket(`wss://127.0.0.1:${cfg.localPort}/ws`, {
    rejectUnauthorized: false, // 自签证书 → 指纹钉扎代替 CA 校验
  });

  let relayReady = false;
  let localReady = false;
  let fingerprintOk = !cfg.fingerprint; // 未提供指纹（开发模式）则跳过
  const pipe = { relayWs, localWs, closed: false, spliced: false };
  pipes.add(pipe);

  // 早期帧缓冲：relay 在收到 pipe 帧后会立即冲放 join 等待期缓存的首帧
  // （如 {type:'auth-response'}），而本机侧 TLS 握手可能尚未完成——先缓冲
  // （≤64KB，超限视为滥用中止），splice 后按序冲放（R-M3 真实 transport 暴露的竞态）。
  // 对称地，host 在本机 upgrade 后立即下发 auth-challenge，也可能先于
  // relayWs 就绪到达 → localWs 侧同样需要早期缓冲（R-M4-A 暴露）。
  const earlyFromRelay = [];
  const earlyFromLocal = [];
  let earlyBytes = 0;
  relayWs.on('message', (data, isBinary) => {
    if (pipe.closed || pipe.spliced) return;
    earlyBytes += data.length;
    if (earlyBytes > 64 * 1024) {
      abort('early frame overflow');
      return;
    }
    earlyFromRelay.push([data, isBinary]);
  });
  localWs.on('message', (data, isBinary) => {
    if (pipe.closed || pipe.spliced) return;
    earlyBytes += data.length;
    if (earlyBytes > 64 * 1024) {
      abort('early frame overflow');
      return;
    }
    earlyFromLocal.push([data, isBinary]);
  });

  const abort = (why) => {
    if (pipe.closed) return;
    pipe.closed = true;
    pipes.delete(pipe);
    try { relayWs.terminate(); } catch { /* gone */ }
    try { localWs.terminate(); } catch { /* gone */ }
    parent.post({ type: 'pipe-aborted', clientId, why });
  };

  // 证书指纹钉扎：握手响应里核对服务端证书（WBS-R2-B 安全项）
  localWs.on('upgrade', (res) => {
    try {
      const cert = res.socket.getPeerCertificate();
      const fp = sha256ColonHex(cert.raw);
      if (cfg.fingerprint && fp !== cfg.fingerprint.toUpperCase()) {
        abort(`fingerprint mismatch: got ${fp}`);
        return;
      }
      fingerprintOk = true;
    } catch (err) {
      abort(`fingerprint check failed: ${err.message}`);
    }
  });

  relayWs.on('open', () => {
    relayWs.send(JSON.stringify({ type: 'pipe', masterCode: cfg.masterCode, clientId }));
    relayReady = true;
    maybeSplice();
  });
  localWs.on('open', () => {
    localReady = true;
    maybeSplice();
  });

  function maybeSplice() {
    if (pipe.closed || !relayReady || !localReady || !fingerprintOk) return;
    splice(pipe, clientId, earlyFromRelay, earlyFromLocal);
  }

  relayWs.on('error', () => abort('relay pipe error'));
  localWs.on('error', () => abort('local ws error'));
  relayWs.on('close', () => abort('relay pipe closed'));
  localWs.on('close', () => abort('local ws closed'));
}

/** 双向字节拼接：任何帧原样转发，任何一侧关闭 → 管道整体终止。 */
function splice(pipe, clientId, earlyFromRelay = [], earlyFromLocal = []) {
  const { relayWs, localWs } = pipe;
  pipe.spliced = true;
  parent.post({ type: 'pipe-open', clientId, pipes: pipes.size });
  const fwd = (src, dst) => {
    src.on('message', (data, isBinary) => {
      if (pipe.closed || dst.readyState !== OPEN) return;
      try { dst.send(data, { binary: isBinary }); } catch { /* 下游处理 */ }
    });
  };
  fwd(relayWs, localWs); // 远端客户端 → 内网 RemoteServer（首帧即 {type:'auth-response', mac}）
  fwd(localWs, relayWs); // RemoteServer → 远端客户端（含 auth-challenge）
  // 冲放两侧早到帧（新到帧由 fwd 处理；早期监听器见到 spliced 即返回，
  // splice 同步完成，无事件可插入 → 顺序保持）
  for (const [data, isBinary] of earlyFromRelay) {
    if (localWs.readyState !== OPEN || pipe.closed) break;
    try { localWs.send(data, { binary: isBinary }); } catch { /* 关闭路径处理 */ }
  }
  for (const [data, isBinary] of earlyFromLocal) {
    if (relayWs.readyState !== OPEN || pipe.closed) break;
    try { relayWs.send(data, { binary: isBinary }); } catch { /* 关闭路径处理 */ }
  }
  const done = (why) => {
    if (pipe.closed) return;
    pipe.closed = true;
    pipes.delete(pipe);
    // 优雅关闭：close() 会先冲放在途发送队列再握手关闭——terminate() 会
    // 立即销毁 socket，可能截断尚未发出的错误帧（如 AUTH_DENIED）
    try { relayWs.close(1000, why); } catch { try { relayWs.terminate(); } catch { /* gone */ } }
    try { localWs.close(1000, why); } catch { try { localWs.terminate(); } catch { /* gone */ } }
    parent.post({ type: 'pipe-closed', clientId, why, pipes: pipes.size });
  };
  relayWs.once('close', () => done('relay closed'));
  localWs.once('close', () => done('local closed'));
  relayWs.once('error', () => done('relay error'));
  localWs.once('error', () => done('local error'));
}

function reapAllPipes() {
  for (const pipe of [...pipes]) {
    pipe.closed = true;
    pipes.delete(pipe);
    try { pipe.relayWs.terminate(); } catch { /* gone */ }
    try { pipe.localWs.terminate(); } catch { /* gone */ }
  }
}

// ---------- 管理 API 代理 ----------

async function apiCall(method, pathname, body) {
  const res = await fetch(`${cfg.relayUrl.replace(/\/+$/, '')}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.masterCode}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, ...json };
}

async function handleCommand(msg) {
  // 注意：id 必须放在展开之后 —— 子码签发结果的 r.id 会覆盖请求 id
  const reply = (fields) => parent.post({ type: 'cmd-reply', ...fields, id: msg.id });
  try {
    if (!cfg) return reply({ ok: false, error: 'not configured' });
    if (msg.cmd === 'issue-subcode') {
      const r = await apiCall('POST', '/api/channels/subcodes', { ttlHours: msg.ttlHours, label: msg.label });
      return reply(r.ok ? { ok: true, subCode: r.subCode, id: r.id, expiresAt: r.expiresAt } : { ok: false, status: r.status });
    }
    if (msg.cmd === 'list-subcodes') {
      const r = await apiCall('GET', '/api/channels/subcodes');
      return reply(r.ok ? { ok: true, subcodes: r.subcodes } : { ok: false, status: r.status });
    }
    if (msg.cmd === 'revoke-subcode') {
      const qs = msg.purge === true ? '?purge=1' : '';
      const r = await apiCall('DELETE', `/api/channels/subcodes/${encodeURIComponent(msg.subCodeId)}${qs}`);
      return reply(r.ok ? { ok: true, purged: r.purged === true } : { ok: false, status: r.status });
    }
    if (msg.cmd === 'renew-subcode') {
      const body = msg.permanent === true ? { permanent: true } : { days: msg.days };
      const r = await apiCall('POST', `/api/channels/subcodes/${encodeURIComponent(msg.subCodeId)}/renew`, body);
      return reply(r.ok ? { ok: true, expiresAt: r.expiresAt } : { ok: false, status: r.status });
    }
    if (msg.cmd === 'force-register') {
      // 人工意图的强制接管/夺回：occupied（在别处使用）与 parked（被接管）均可触发
      if (state === 'registered') return reply({ ok: true, state });
      forceRegister();
      return reply({ ok: true, state });
    }
    if (msg.cmd === 'ping') return reply({ ok: true, state, pipes: pipes.size });
    return reply({ ok: false, error: `unknown cmd ${msg.cmd}` });
  } catch (err) {
    return reply({ ok: false, error: err.message });
  }
}

// ---------- 生命周期 ----------

parent.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'config' && !cfg) {
    cfg = msg.config;
    setState('starting');
    dialControl();
    return;
  }
  if (msg.type === 'shutdown') {
    state = 'stopped';
    if (control) { try { control.terminate(); } catch { /* gone */ } }
    reapAllPipes();
    // 给父进程留出接收最终事件的时间
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (msg.type === 'cmd') {
    await handleCommand(msg);
  }
});

// 父进程消失即退出（fork 模式的孤儿保护；utilityProcess 随父进程死亡）
process.on('disconnect', () => process.exit(0));

parent.post({ type: 'ready', pid: process.pid });
