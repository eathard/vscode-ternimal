// relay/src/server.mjs — RelayServer 核心（relay-plan.md WBS-R1-A/C/D/E/F/G）。
//
// 面向公网部署的独立服务；控制面（register/offer/管理API）与数据面（join/pipe
// 纯字节管道）在同一进程内按模块切分（方案书 §3.1），后续可拆分部署。
//
// 关键不变量（验收标准 §2 判定项）：
//   1. 管道对接后的帧【逐字节透传】——不解析、不改写、不重排序；
//   2. 单管道 bufferedAmount 超背压上限 → 终止该管道，不波及其他连接；
//   3. 同主码重复 register → 接管，旧控制连接与全部旧管道立即收割；
//   4. 主码/子码失败限速（5 次/窗口 → 锁定）；
//   5. 两心跳周期无 pong → 收割连接（及所属通道状态）；
//   6. 子码吊销/过期 → 其名下活跃管道随 sweep 终止。

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  CTRL, JOIN, CLOSE,
  sha256Hex, deriveChannelId, safeEqualHex, newMasterCode,
  parseControlFirst, parseJoinFirst,
} from './protocol.mjs';
import { ADMIN_PAGE_HTML, ADMIN_JS } from './adminPage.mjs';
import { RateLimiter } from './ratelimit.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { MemoryStore } from './store.mjs';
import { encodeAccessToken, caFingerprint } from './token.mjs';

/**
 * 宿主（App RemoteServer）终局性关闭码 → 中继侧致命码翻译表。
 * 见 splice() 内 hostWs 'close' 处理的注释（2026-09-12 重连风暴事故）。
 * 宿主码表见 src/shared/wsProtocol.ts；中继码表见 protocol.mjs CLOSE。
 */
// 宿主 4xxx → 中继客户端关闭码。**只映射终局性（同凭据重试必败且有害）
// 的码**；3001/4003/4004 刻意保持瞬态（重连可自愈或属协议误序自限）：
//   4001 AUTH_REQUIRED → 4001（认证窗口内业务帧=客户端缺陷，重试=风暴源）
//   4002 RATE_LIMITED  → 4002（锁定窗重试会续期锁，必须停）
//   4003 NO_SESSION    → 不映射（宿主重启后重连取新 tabs 即自愈）
//   4004 BAD_MESSAGE   → 不映射（单帧违规，重连无害且可能来自误序）
//   4005 AUTH_DENIED   → 4001（凭据错误）
const HOST_FATAL_TO_RELAY = {
  4001: 4001,
  4002: 4002,
  4005: 4001,
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.map': 'application/json', '.woff2': 'font/woff2',
};

const OPEN = WebSocket.OPEN;

export class RelayServer {
  /**
   * @param {{
   *   config?: any, store?: MemoryStore,
   *   host?: string, port?: number, webRoot?: string,
   *   heartbeatIntervalMs?: number, joinPendingMs?: number, firstFrameTimeoutMs?: number,
   *   backpressureBytes?: number, maxPipesPerChannel?: number,
   *   rateWindowMs?: number, rateLockMs?: number, rateMaxFailures?: number,
   *   maxPayloadBytes?: number, log?: boolean,
   * }} [opts] config 之外的字段为测试注入的时序/阈值覆盖
   */
  constructor(opts = {}) {
    const cfg = opts.config ?? { masterHashes: [], limits: {} };
    const L = { ...cfg.limits, ...opts };
    this.masterHashes = cfg.masterHashes ?? [];
    // 主码生命周期（计费）：结构化条目 + 旧式哈希（视为永久）。
    this.masters = [
      ...(cfg.masters ?? []).map((o) => ({ revoked: false, label: '', createdAt: null, expiresAt: null, ...o })),
      ...this.masterHashes.map((h) => ({ hash: h, label: '(legacy)', createdAt: null, expiresAt: null, revoked: false, permanent: true })),
    ];
    this.configFile = opts.configFile ?? null;
    this.tls = cfg.tls ?? null;
    this.trustedProxy = cfg.trustedProxy ?? false;
    this.publicUrl = String(cfg.publicUrl ?? '');
    this.publicCaPem = String(cfg.publicCaPem ?? '');
    this.host = opts.host ?? cfg.host ?? '127.0.0.1';
    this.port = opts.port ?? cfg.port ?? 0;
    this.webRoot = opts.webRoot ?? cfg.webRoot ?? '';
    this.heartbeatIntervalMs = L.heartbeatIntervalMs ?? 30_000;
    this.joinPendingMs = L.joinPendingMs ?? 10_000;
    this.firstFrameTimeoutMs = L.firstFrameTimeoutMs ?? 10_000;
    this.backpressureBytes = L.backpressureBytes ?? 1024 * 1024;
    this.maxPipesPerChannel = L.maxPipesPerChannel ?? 4;
    this.maxPayloadBytes = L.maxPayloadBytes ?? 1024 * 1024;
    this.log = opts.log ?? true;
    /** @type {MemoryStore} */
    this.store = opts.store ?? new MemoryStore();
    // 管理页（计费运维）：scrypt 密码哈希 + 内存会话；与主码体系独立。
    this.adminHash = cfg.adminHash ?? opts.adminHash ?? null;
    this.adminSessions = new Map(); // token → expiresAt
    this.adminTokenTtlMs = L.adminTokenTtlMs ?? 12 * 3600_000;
    // 进程级累计总账（通道被清理也不清零；relay 重启归零——持久化为 v1.1 计费项）
    this.totals = new Map(); // channelId → { bytesIn, bytesOut, pipes, joins, firstSeen, lastSeen }
    this.byIp = new RateLimiter({ windowMs: L.rateWindowMs, lockMs: L.rateLockMs, maxFailures: L.rateMaxFailures });
    this.byKey = new RateLimiter({ windowMs: L.rateWindowMs, lockMs: L.rateLockMs, maxFailures: L.rateMaxFailures });
    this.server = null;
    this.wss = null;
    this.sweepTimer = null;
    this.actualPort = 0;
    this.startedAt = 0;
  }

  info(...a) { if (this.log) console.log('[relay]', ...a); }

  /** 启动监听；resolve 实际端口（port 0 = 随机，测试用）。 */
  start() {
    if (this.server) return Promise.resolve(this.actualPort);
    const handler = (req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.info('http error:', err?.message ?? err);
        try { res.writeHead(500).end('internal error'); } catch { /* gone */ }
      });
    };
    this.server = this.tls
      ? https.createServer({ cert: fs.readFileSync(this.tls.cert), key: fs.readFileSync(this.tls.key) }, handler)
      : http.createServer(handler);

    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes });
    this.server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://relay.local').pathname;
      if (pathname !== '/control' && pathname !== '/join' && pathname !== '/pipe') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        // P0-崩溃面：ws 8.x 把协议层错误（坏 UTF-8/坏 opcode）re-emit 为
        // 'error' 事件；任何升级成功的 socket 若无 error 监听，一个未认证
        // 坏帧就会 uncaught 崩掉整个进程（所有客户管道陪葬）。此处统一兜底：
        // 记日志并关闭该连接，splice() 内部仍可附加更精细的 kill 逻辑。
        ws.on('error', (err) => {
          try { this.info(`ws error pre-route (${pathname}):`, err?.message ?? err); } catch { /* noop */ }
          try { ws.close(1011, 'protocol error'); } catch { try { ws.terminate(); } catch { /* gone */ } }
        });
        if (pathname === '/control') this.onControl(ws, req);
        else if (pathname === '/join') this.onJoin(ws, req);
        else this.onPipe(ws, req);
      });
    });

    this.sweepTimer = setInterval(() => this.sweep(), this.heartbeatIntervalMs);
    this.sweepTimer.unref?.();

    this.startedAt = Date.now();
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.actualPort = this.server.address().port;
        this.info(`listening on ${this.host}:${this.actualPort} (${this.tls ? 'tls' : 'plain'})`);
        resolve(this.actualPort);
      });
    });
  }

  /** 优雅停机：收割全部连接（含控制通道）后关闭监听。 */
  stop() {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const ch of this.store.channels.values()) {
      // 控制通道也必须显式断开——仅 close(http server) 不会动已建立的
      // upgrade 连接，插件将无法感知停机（E2E-08 暴露）
      if (ch.control) {
        const ws = ch.control.ws;
        ch.control = null;
        try { ws.terminate(); } catch { /* gone */ }
      }
      this.reapChannel(ch, 'server stopping');
    }
    this.store.channels.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      setTimeout(resolve, 200).unref?.(); // close 等连接排空的兜底
    });
  }

  // ---------- 工具 ----------

  /** 客户端 IP（trustedProxy 开启且来源为 loopback 时采信 XFF **末值**）。
   * P0：Caddy/nginx 等可信代理把真实 IP **追加**到 XFF 尾部；首值完全
   * 客户端可控——取首值=伪造一个新身份即可绕过 5 次锁定并无限增殖
   * 限流记录。末值才是代理亲手追加的那个。 */
  clientIp(req) {
    const remote = req.socket?.remoteAddress ?? '';
    if (this.trustedProxy && (remote === '127.0.0.1' || remote === '::1')) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.length > 0) {
        const parts = xff.split(',').map((x) => x.trim()).filter(Boolean);
        if (parts.length > 0) return parts[parts.length - 1];
      }
    }
    return remote;
  }

  /**
   * 主码校验：常数时间比对哈希；命中且未吊销未过期 → 返回条目，否则 null。
   * （返回值供注册通道挂接 masterEntry，sweep 据此执行到期自停。）
   */
  verifyMaster(code) {
    if (typeof code !== 'string' || code.length === 0 || code.length > 256) return null;
    const h = sha256Hex(code);
    for (const m of this.masters) {
      if (safeEqualHex(h, m.hash)) {
        if (m.revoked) return null;
        if (m.expiresAt && m.expiresAt <= Date.now()) return null;
        return m;
      }
    }
    return null;
  }

  /** 主码生命周期写盘（管理 API 变更后调用；无 configFile 则内存态）。 */
  /** 接入配置（对外地址+CA 公钥）持久化——混合口令的数据源。 */
  persistAccess() {
    if (!this.configFile) return;
    const cfg = loadConfig(this.configFile);
    cfg.publicUrl = this.publicUrl;
    cfg.publicCaPem = this.publicCaPem;
    saveConfig(this.configFile, cfg);
  }

  persistMasters() {
    if (!this.configFile) return;
    const cfg = loadConfig(this.configFile);
    cfg.masters = this.masters
      .filter((m) => !m.permanent)
      .map(({ hash, label, createdAt, expiresAt, revoked }) => ({ hash, label, createdAt, expiresAt, revoked }));
    saveConfig(this.configFile, cfg);
  }

  /** 立即停止一枚主码名下全部通道（吊销/到期共用的执行器）。 */
  killChannelsOfMaster(entry, why) {
    const want = sha256Hex; // noqa
    for (const ch of this.store.channels.values()) {
      if (ch.masterEntry !== entry) continue;
      for (const pipe of [...ch.pipes]) pipe.kill(why);
      for (const pending of [...ch.pending.values()]) {
        clearTimeout(pending.timer);
        ch.pending.delete(pending.id);
        try { pending.ws.terminate(); } catch { /* gone */ }
      }
      if (ch.control) {
        const ws = ch.control.ws;
        ch.control = null;
        try { ws.terminate(); } catch { /* gone */ }
      }
      this.reapChannel(ch, why);
    }
  }

  /**
   * 失败处理：记双维度（IP + key）失败。锁定在【第 maxFailures 次失败时上锁】，
   * 但本次仍返回具体错误（对齐 AuthManager：第 6 次起才 429，TC-R1-03）。
   */
  authFail(ws, ip, key, kindCode) {
    const lockedBefore = this.byIp.isLocked(ip) || this.byKey.isLocked(key);
    this.byIp.fail(ip);
    this.byKey.fail(key);
    this.errorThenClose(ws, lockedBefore ? CLOSE.RATE_LIMITED : kindCode, lockedBefore ? 'rate limited' : 'bad code');
  }

  errorThenClose(ws, code, message) {
    if (ws && ws.readyState === OPEN) {
      try { ws.send(JSON.stringify({ type: CTRL.ERROR, code, message })); } catch { /* gone */ }
      ws.close(code, message);
    }
  }

  /** 首帧守卫：超时未发首帧 → FIRST_FRAME_TIMEOUT 断链。 */
  firstFrameGuard(ws, onFrame) {
    const timer = setTimeout(() => this.errorThenClose(ws, CLOSE.FIRST_FRAME_TIMEOUT, 'first frame timeout'), this.firstFrameTimeoutMs);
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      onFrame(isBinary ? '' : data.toString('utf8'));
    });
  }

  // ---------- /control ----------

  onControl(ws, req) {
    const ip = this.clientIp(req);
    this.firstFrameGuard(ws, (raw) => {
      const msg = parseControlFirst(raw);
      // P1：锁定期零处理（同 join 路径）。
      if (this.byIp.isLocked(ip)) return this.errorThenClose(ws, CLOSE.RATE_LIMITED, 'rate limited');
      if (!msg || msg.type !== CTRL.REGISTER) {
        this.byIp.fail(ip); this.byKey.fail('control');
        return this.errorThenClose(ws, CLOSE.BAD_MESSAGE, 'expected register');
      }
      const entry = this.verifyMaster(msg.masterCode);
      if (!entry) {
        return this.authFail(ws, ip, sha256Hex(msg.masterCode), CLOSE.BAD_CODE);
      }
      const channelId = deriveChannelId(msg.masterCode);
      const ch = this.store.getOrCreateChannel(channelId);
      ch.masterEntry = entry; // 计费生命周期挂接（sweep 到期自停的依据）
      const acceptRegister = () => {
        if (ch.control && ch.control.ws.readyState === OPEN) {
          // 接管：旧控制连接断开、旧管道与挂起全部收割（方案书 §3.4；子码保留）
          this.errorThenClose(ch.control.ws, CLOSE.TAKEOVER, 'superseded');
          this.reapChannel(ch, 'takeover');
        }
        ch.control = { ws, alive: true };
        ws.on('pong', () => { if (ch.control?.ws === ws) ch.control.alive = true; });
        ws.on('message', () => this.errorThenClose(ws, CLOSE.BAD_MESSAGE, 'unexpected message on control'));
        ws.on('close', () => {
          if (ch.control?.ws === ws) {
            ch.control = null;
            this.reapChannel(ch, 'control closed');
          }
        });
        try { ws.send(JSON.stringify({ type: CTRL.REGISTERED, channelId })); } catch { /* gone */ }
        this.info(`channel ${channelId.slice(0, 8)}… registered (${ip})`);
      };
      const prev = ch.control;
      if (prev && prev.ws.readyState === OPEN) {
        const legacy = !(msg.proto === 2 || msg.force === true);
        if (legacy) {
          // 旧客户端（升级过渡期）：维持 last-wins，保证滚动升级不断服
          acceptRegister();
        } else if (msg.force === true) {
          // 强制接管（人工意图）：先告知旧端「被接管 → 驻停」再收割。战争结构性不可能：
          // 踢人必须有人在面板点击，被踢方收到 taken-over 后不再自动重连。
          try { prev.ws.send(JSON.stringify({ type: CTRL.TAKEN_OVER })); } catch { /* gone */ }
          acceptRegister();
          this.info(`channel ${channelId.slice(0, 8)}… force takeover (${ip})`);
        } else {
          // 新客户端非 force：活性探测。旧连接 2.5s 内回 pong = 真活着 → 占用；
          // 不回（僵尸/半开，即正常换机场景）→ 自动接管，用户零感知。
          prev.alive = false;
          try { prev.ws.ping(); } catch { /* gone */ }
          setTimeout(() => {
            if (ws.readyState !== OPEN) return;
            if (ch.control !== prev) {
              if (!ch.control) { acceptRegister(); return; } // 探测期间旧连接自然死亡
              try { ws.send(JSON.stringify({ type: CTRL.OCCUPIED })); } catch { /* gone */ }
              this.errorThenClose(ws, CLOSE.OCCUPIED, 'master in use');
              return; // 探测期间第三方注册成功 → 占用语义不变
            }
            if (prev.alive) {
              try { ws.send(JSON.stringify({ type: CTRL.OCCUPIED })); } catch { /* gone */ }
              this.errorThenClose(ws, CLOSE.OCCUPIED, 'master in use');
              this.info(`channel ${channelId.slice(0, 8)}… register rejected: occupied (${ip})`);
            } else {
              // 僵尸接管：与旧版 last-wins 同路径
              this.errorThenClose(prev.ws, CLOSE.TAKEOVER, 'superseded');
              this.reapChannel(ch, 'takeover');
              acceptRegister();
              this.info(`channel ${channelId.slice(0, 8)}… zombie takeover (${ip})`);
            }
          }, 2500);
        }
        return;
      }
      acceptRegister();
    });
  }

  // ---------- /join ----------

  onJoin(ws, req) {
    const ip = this.clientIp(req);
    // 单一 message 监听器：首帧=join，其后全部进早期帧缓冲。不能用
    // firstFrameGuard + 事后挂监听——join 与 auth 同一 TCP 段到达时，第二帧
    // 的 message 事件会在监听挂上之前发射而丢失（R-M3 真实 transport 暴露）。
    const guard = setTimeout(() => this.errorThenClose(ws, CLOSE.FIRST_FRAME_TIMEOUT, 'first frame timeout'), this.firstFrameTimeoutMs);
    let joinHandled = false;
    let earlySink = null;
    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== OPEN) return;
      if (!joinHandled) {
        joinHandled = true;
        clearTimeout(guard);
        earlySink = this.handleJoinFrame(ws, req, ip, isBinary ? '' : data.toString('utf8'));
        return;
      }
      if (!earlySink) return; // join 已失败（连接正在关闭）
      earlySink(data, isBinary);
    });
  }

  /** 解析并登记 join；返回早期帧接收函数（null = 已拒绝）。 */
  handleJoinFrame(ws, req, ip, raw) {
    // P1：锁定期内不做任何表扫描/解析——错码洪峰下锁定 IP 曾继续
    // 烧 O(全部子码) 扫描（CPU/堆 DoS）。直接 429。
    if (this.byIp.isLocked(ip)) {
      this.errorThenClose(ws, CLOSE.RATE_LIMITED, 'rate limited');
      return null;
    }
    const msg = parseJoinFirst(raw);
    if (!msg) {
      this.byIp.fail(ip); this.byKey.fail('join');
      this.errorThenClose(ws, CLOSE.BAD_MESSAGE, 'expected join');
      return null;
    }
    const sc = this.store.findSubCode(msg.subCode);
    if (!sc) { this.authFail(ws, ip, msg.subCode, CLOSE.BAD_CODE); return null; }
    if (sc.revoked) { this.errorThenClose(ws, CLOSE.SUBCODE_REVOKED, 'revoked'); return null; }
    if (sc.expiresAt && sc.expiresAt <= Date.now()) { this.errorThenClose(ws, CLOSE.SUBCODE_EXPIRED, 'expired'); return null; }
    const ch = this.store.getChannel(sc.channelId);
    if (!ch || !ch.control || ch.control.ws.readyState !== OPEN) {
      this.errorThenClose(ws, CLOSE.HOST_OFFLINE, 'host offline');
      return null;
    }
    if (ch.pipes.size + ch.pending.size >= this.maxPipesPerChannel) {
      this.errorThenClose(ws, CLOSE.BUSY, 'channel busy');
      return null;
    }
    sc.stats.joins += 1;
    const clientId = crypto.randomUUID();
    const pending = {
      id: clientId, ws, alive: true, subCodeId: sc.id,
      timer: setTimeout(() => {
        ch.pending.delete(clientId);
        this.errorThenClose(ws, CLOSE.PENDING_TIMEOUT, 'host did not dial pipe');
      }, this.joinPendingMs),
    };
    ch.pending.set(clientId, pending);
    // 预拼接缓冲：join 到管道对接之间客户端可能已发出首帧（如 relay 路径的
    // {type:'auth'}），不能丢——上限 64KB，超限视为滥用直接断开
    pending.early = [];
    pending.earlyBytes = 0;
    ws.on('pong', () => { pending.alive = true; });
    ws.on('close', () => {
      if (ch.pending.get(clientId) === pending) {
        clearTimeout(pending.timer);
        ch.pending.delete(clientId);
      }
    });
    try {
      ch.control.ws.send(JSON.stringify({ type: CTRL.CLIENT_OFFER, clientId }));
    } catch {
      clearTimeout(pending.timer);
      ch.pending.delete(clientId);
      this.errorThenClose(ws, CLOSE.HOST_OFFLINE, 'control gone');
      return null;
    }
    this.info(`client ${clientId.slice(0, 8)}… waiting on channel ${ch.id.slice(0, 8)}…`);
    // 早期帧接收器（splice 后停止接收）
    return (data, isBinary) => {
      if (ch.pending.get(clientId) !== pending) return;
      pending.earlyBytes += data.length;
      if (pending.earlyBytes > 64 * 1024) {
        clearTimeout(pending.timer);
        ch.pending.delete(clientId);
        try { ws.terminate(); } catch { /* gone */ }
        return;
      }
      pending.early.push([data, isBinary]);
    };
  }

  // ---------- /pipe ----------

  onPipe(ws, req) {
    const ip = this.clientIp(req);
    this.firstFrameGuard(ws, (raw) => {
      const msg = parseControlFirst(raw);
      if (!msg || msg.type !== CTRL.PIPE) {
        this.byIp.fail(ip); this.byKey.fail('pipe');
        return this.errorThenClose(ws, CLOSE.BAD_MESSAGE, 'expected pipe');
      }
      if (!this.verifyMaster(msg.masterCode)) {
        return this.authFail(ws, ip, sha256Hex(msg.masterCode), CLOSE.BAD_CODE);
      }
      const ch = this.store.getChannel(deriveChannelId(msg.masterCode));
      const pending = ch?.pending.get(msg.clientId);
      if (!ch || !pending) {
        return this.errorThenClose(ws, CLOSE.UNKNOWN_CLIENT, 'no such pending client');
      }
      clearTimeout(pending.timer);
      ch.pending.delete(msg.clientId);
      this.splice(ch, pending, ws);
    });
  }

  // ---------- 数据面：纯字节管道 ----------

  /**
   * 对接 pending 客户端与 host 管道。此后双向帧逐字节透传，仅做背压监控
   * 与字节计数；任一侧关闭/异常/超背压 → 管道整体终止（不波及其他连接）。
   */
  splice(ch, pending, hostWs) {
    const clientWs = pending.ws;
    const sc = ch.subcodes.get(pending.subCodeId) ?? null;
    /** 管道记录：持有两侧 socket 与 kill 闭包，sweep/吊销可从外部终止。 */
    const pipe = {
      ch, subCodeId: pending.subCodeId, clientWs, hostWs,
      clientAlive: true, hostAlive: true, closed: false, kill: null,
    };
    const kill = (why, hard = false, clientCode = 0) => {
      if (pipe.closed) return;
      pipe.closed = true;
      ch.pipes.delete(pipe);
      // 默认优雅 close（冲放在途帧后握手关闭）；背压/心跳丢失等异常路径用
      // terminate 立即切断
      const end = (s, code = 0) => {
        if (hard) { try { s.terminate(); } catch { /* gone */ } }
        else { try { s.close(code || 1000, why); } catch { try { s.terminate(); } catch { /* gone */ } } }
      };
      end(clientWs, clientCode);
      end(hostWs);
      this.info(`pipe closed (${why}) on ${ch.id.slice(0, 8)}… (${ch.pipes.size} active)`);
    };
    pipe.kill = kill;
    ch.pipes.add(pipe);
    ch.stats.pipesOpened += 1;
    this.bumpTotal(ch.id, 'pipes', 1);
    this.bumpTotal(ch.id, 'joins', 1);
    this.info(`pipe spliced on ${ch.id.slice(0, 8)}… (${ch.pipes.size} active)`);

    const fwd = (src, dst, counter) => {
      src.on('message', (data, isBinary) => {
        if (pipe.closed || dst.readyState !== OPEN) return;
        if (dst.bufferedAmount > this.backpressureBytes) {
          kill('backpressure', true); // 慢客户端保护（方案书 §3.4）
          return;
        }
        try {
          dst.send(data, { binary: isBinary });
          ch.stats[counter] += data.length;
          this.bumpTotal(ch.id, counter, data.length);
          if (sc) sc.stats.bytes += data.length;
        } catch {
          kill('send error', true);
        }
      });
    };
    fwd(clientWs, hostWs, 'bytesIn');
    fwd(hostWs, clientWs, 'bytesOut');

    // 对接完成：冲放在等待期缓存的客户端早期帧（auth 首帧等）
    if (pending.early && pending.early.length > 0 && hostWs.readyState === OPEN) {
      for (const [data, isBinary] of pending.early) {
        try {
          hostWs.send(data, { binary: isBinary });
          ch.stats.bytesIn += data.length;
        } catch {
          kill('flush error');
          break;
        }
      }
    }
    pending.early = [];

    clientWs.on('pong', () => { pipe.clientAlive = true; });
    hostWs.on('pong', () => { pipe.hostAlive = true; });
    clientWs.once('close', () => kill('client closed'));
    // 宿主侧关闭码翻译（2026-09-12 排障）：宿主以 4xxx 终局性关闭（限速/
    // 凭据拒绝）时，必须把「不可重试」语义透传给远端客户端——若一律按
    // close(1000) 正常关闭，客户端视作瞬时故障无限重连；一个拿着过期令牌
    // 的旧页面就能把宿主的共享中继鉴权窗口永久锁死，正确凭据也进不来。
    // 宿主码表（wsProtocol）→ 中继码表（protocol CLOSE）：
    //   4002 RATE_LIMITED → 4002（客户端致命：denied）
    //   4005 AUTH_DENIED  → 4001（客户端致命：denied，凭据错误）
    hostWs.once('close', (code) => kill('host closed', false, HOST_FATAL_TO_RELAY[code] || 0));
    clientWs.once('error', () => kill('client error'));
    hostWs.once('error', () => kill('host error'));
  }

  /** 收割通道：终止全部管道与挂起客户端（子码记录保留）。 */
  reapChannel(ch, why) {
    for (const pipe of [...ch.pipes]) pipe.kill(why);
    for (const pending of [...ch.pending.values()]) {
      clearTimeout(pending.timer);
      try { pending.ws.terminate(); } catch { /* gone */ }
    }
    ch.pending.clear();
    this.info(`channel ${ch.id.slice(0, 8)}… reaped (${why})`);
  }

  // ---------- 心跳与过期清扫 ----------

  sweep() {
    const now = Date.now();
    for (const ch of this.store.channels.values()) {
      // 计费生命周期：主码到期/吊销 → 通道自动停止（管道+挂起+控制全清）
      const me = ch.masterEntry;
      if (me && (me.revoked || (me.expiresAt && me.expiresAt <= now))) {
        this.killChannelsOfMaster(me, me.revoked ? 'master revoked' : 'plan expired');
        continue;
      }
      if (ch.control) {
        if (!ch.control.alive) {
          const ws = ch.control.ws;
          ch.control = null;
          try { ws.terminate(); } catch { /* gone */ }
          this.reapChannel(ch, 'control heartbeat lost');
        } else {
          ch.control.alive = false;
          try { ch.control.ws.ping(); } catch { /* gone */ }
        }
      }
      for (const pending of [...ch.pending.values()]) {
        if (!pending.alive) {
          clearTimeout(pending.timer);
          ch.pending.delete(pending.id);
          try { pending.ws.terminate(); } catch { /* gone */ }
        } else {
          pending.alive = false;
          try { pending.ws.ping(); } catch { /* gone */ }
        }
      }
      for (const pipe of [...ch.pipes]) {
        const sc = ch.subcodes.get(pipe.subCodeId);
        if (sc && (sc.revoked || (sc.expiresAt && sc.expiresAt <= now))) {
          pipe.kill(sc.revoked ? 'subcode revoked' : 'subcode expired');
          continue;
        }
        if (!pipe.clientAlive || !pipe.hostAlive) {
          pipe.kill('heartbeat lost', true);
          continue;
        }
        pipe.clientAlive = false;
        pipe.hostAlive = false;
        try { pipe.clientWs.ping(); } catch { /* gone */ }
        try { pipe.hostWs.ping(); } catch { /* gone */ }
      }
    }
  }

  // ---------- HTTP：静态 / 健康 / 子码管理 API ----------

  /** 进程级累计总账（管理页/计费底稿）：通道清理不清零。 */
  bumpTotal(channelId, field, n) {
    let t = this.totals.get(channelId);
    if (!t) {
      t = { bytesIn: 0, bytesOut: 0, pipes: 0, joins: 0, firstSeen: Date.now(), lastSeen: Date.now() };
      this.totals.set(channelId, t);
    }
    t[field] += n;
    t.lastSeen = Date.now();
  }

  /** 管理密码校验（scrypt$salt$hash，与登录同语义）。 */
  verifyAdminPassword(pw) {
    const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(this.adminHash ?? '');
    if (!m) return false;
    const want = Buffer.from(m[2], 'hex');
    const got = crypto.scryptSync(String(pw), Buffer.from(m[1], 'hex'), want.length);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  /** 管理会话：签发/校验（内存、TTL、容量上限）。 */
  issueAdminToken() {
    if (this.adminSessions.size > 64) {
      const now = Date.now();
      for (const [k, exp] of this.adminSessions) if (exp < now) this.adminSessions.delete(k);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.adminSessions.set(token, Date.now() + this.adminTokenTtlMs);
    return token;
  }

  adminOk(req) {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return false;
    const exp = this.adminSessions.get(m[1]);
    if (!exp || exp < Date.now()) { this.adminSessions.delete(m[1]); return false; }
    return true;
  }

  adminOverview() {
    const chans = [];
    for (const [id, ch] of this.store.channels) {
      const t = this.totals.get(id) ?? { bytesIn: 0, bytesOut: 0, pipes: 0, joins: 0, firstSeen: ch.createdAt ?? Date.now(), lastSeen: Date.now() };
      chans.push({
        id, online: !!ch.control && ch.control.ws.readyState === 1,
        pipes: ch.pipes.size,
        bytesIn: t.bytesIn, bytesOut: t.bytesOut, pipesOpened: t.pipes, joins: t.joins,
        firstSeen: t.firstSeen, lastSeen: t.lastSeen,
        subcodes: [...ch.subcodes.values()].map((sc) => ({
          id: sc.id, code: sc.code, label: sc.label, createdAt: sc.createdAt,
          expiresAt: sc.expiresAt, revoked: sc.revoked, stats: sc.stats,
        })),
      });
    }
    // 已被清理但总账仍有流量的通道也列出（计费视角不能丢账）
    for (const [id, t] of this.totals) {
      if (!this.store.channels.has(id)) {
        chans.push({
          id, online: false, pipes: 0,
          bytesIn: t.bytesIn, bytesOut: t.bytesOut, pipesOpened: t.pipes, joins: t.joins,
          firstSeen: t.firstSeen, lastSeen: t.lastSeen, subcodes: [],
        });
      }
    }
    let pipes = 0;
    for (const ch of this.store.channels.values()) pipes += ch.pipes.size;
    const now = Date.now();
    return {
      service: 'trelay', uptimeMs: Date.now() - this.startedAt, channels: chans, pipes,
      access: {
        publicUrl: this.publicUrl,
        caBound: !!this.publicCaPem,
        caFingerprint: this.publicCaPem ? caFingerprint(this.publicCaPem) : null,
      },
      maxPipes: this.maxPipesPerChannel * Math.max(1, this.store.channels.size),
      adminConfigured: !!this.adminHash,
      masters: this.masters.map((m) => ({
        id: m.hash.slice(0, 8), label: m.label, permanent: !!m.permanent,
        createdAt: m.createdAt, expiresAt: m.expiresAt, revoked: m.revoked,
        status: m.permanent ? 'permanent' : m.revoked ? 'revoked'
          : m.expiresAt && m.expiresAt <= now ? 'expired' : 'active',
        remainingMs: m.expiresAt ? Math.max(0, m.expiresAt - now) : null,
      })),
    };
  }

  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay.local');
    if (url.pathname === '/health') {
      // service 标记：web bundle 启动探测据此区分 relay 宿主与 RemoteServer
      // 宿主（后者 /health 返回纯文本 'ok'）——R-M3 双宿主同 bundle 的关键。
      return this.sendJson(res, 200, { ok: true, service: 'trelay', uptimeMs: Date.now() - this.startedAt, ...this.store.snapshot() });
    }
    if (url.pathname === '/admin' || url.pathname === '/static/admin.js') {
      if (!this.adminHash) return this.sendJson(res, 404, { error: 'admin not configured' });
      const isHtml = url.pathname === '/admin';
      res.writeHead(200, {
        'content-type': isHtml ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(isHtml ? ADMIN_PAGE_HTML : ADMIN_JS);
      return;
    }
    if (url.pathname.startsWith('/api/')) return this.handleApi(req, res, url);
    return this.serveStatic(url.pathname, res);
  }

  async handleApi(req, res, url) {
    const ip = this.clientIp(req);
    const authed = () => {
      const h = req.headers.authorization ?? '';
      const code = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!this.verifyMaster(code)) {
        // P1：管理页持有的是 admin 会话令牌（非主码）——对子码管理等
        // 管理 API 而言这是合法凭据，不得计入主码失败（否则 5 次/60s
        // 管理操作就把自己锁成 429）。仅当两者皆非时才记失败。
        if (!this.adminOk(req)) this.byIp.fail(ip);
        return null;
      }
      return deriveChannelId(code);
    };
    const send = (status, obj) => this.sendJson(res, status, obj);
    const p = url.pathname;

    // ---------- 管理页 API（页面本体由 handleHttp 直出） ----------
    if (p === '/api/admin/login' && req.method === 'POST') {
      if (this.byIp.isLocked(ip)) return send(429, { error: 'rate limited' });
      if (!this.adminHash) return send(404, { error: 'admin not configured' });
      const body = await readJson(req);
      if (!body || !this.verifyAdminPassword(String(body.password ?? ''))) {
        this.byIp.fail(ip);
        return send(401, { error: this.byIp.isLocked(ip) ? 'rate limited' : 'bad password' });
      }
      return send(200, { token: this.issueAdminToken(), expiresIn: this.adminTokenTtlMs });
    }
    if (p === '/api/admin/overview' && req.method === 'GET') {
      if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
      return send(200, this.adminOverview());
    }

    // ---------- 主码生命周期（手动签发/吊销/续期；到期 sweep 自停） ----------
    if (p === '/api/admin/masters' && req.method === 'GET') {
      if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
      const now = Date.now();
      return send(200, {
        masters: this.masters.map((m) => ({
          id: m.hash.slice(0, 8), label: m.label, permanent: !!m.permanent,
          createdAt: m.createdAt, expiresAt: m.expiresAt, revoked: m.revoked,
          status: m.permanent ? 'permanent'
            : m.revoked ? 'revoked'
            : m.expiresAt && m.expiresAt <= now ? 'expired'
            : 'active',
          remainingMs: m.expiresAt ? Math.max(0, m.expiresAt - now) : null,
        })),
      });
    }
    if (p === '/api/admin/masters' && req.method === 'POST') {
      if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') return send(400, { error: 'bad body' });
      const days = Number(body.days ?? 0);
      if (body.days != null && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
        return send(400, { error: 'days must be (0, 3650]（支持小数如 0.5=12h）' });
      }
      const code = newMasterCode();
      const entry = {
        hash: sha256Hex(code), label: String(body.label ?? '').slice(0, 64) || '(unnamed)',
        createdAt: Date.now(), expiresAt: days > 0 ? Date.now() + days * 86_400_000 : null,
        revoked: false,
      };
      this.masters.push(entry);
      this.persistMasters();
      this.info(`master issued (${entry.label}, ${days > 0 ? days + 'd' : 'permanent'}) id=${entry.hash.slice(0, 8)}`);
      // 明文仅此一次返回（与 CLI add-master 同语义）；已绑定对外地址则同时附混合口令
      const extra = {};
      if (this.publicUrl) {
        try {
          extra.token = encodeAccessToken({ url: this.publicUrl, master: code, caPem: this.publicCaPem, label: entry.label });
        } catch { /* 口令失败不阻断签发 */ }
      }
      return send(201, { code, id: entry.hash.slice(0, 8), label: entry.label, expiresAt: entry.expiresAt, ...extra });
    }
    {
      const mm = p.match(/^\/api\/admin\/masters\/([0-9a-f]{8})\/renew$/);
      if (mm && req.method === 'POST') {
        if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
        const body = await readJson(req);
        const days = Number(body?.days ?? 30);
        if (!Number.isFinite(days) || days <= 0 || days > 3650) return send(400, { error: 'bad days' });
        const m = this.masters.find((x) => x.hash.slice(0, 8) === mm[1]);
        if (!m) return send(404, { error: 'no such master' });
        if (m.permanent) return send(400, { error: 'permanent master needs no renewal' });
        m.revoked = false; // 续期即复活（吊销态一并解除）
        m.expiresAt = Math.max(Date.now(), m.expiresAt ?? 0) + days * 86_400_000;
        this.persistMasters();
        this.info(`master renewed +${days}d id=${m.hash.slice(0, 8)}`);
        return send(200, { ok: true, id: mm[1], expiresAt: m.expiresAt });
      }
      const md = p.match(/^\/api\/admin\/masters\/([0-9a-f]{8})$/);
      if (md && req.method === 'DELETE') {
        if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
        const m = this.masters.find((x) => x.hash.slice(0, 8) === md[1]);
        if (!m) return send(404, { error: 'no such master' });
        if (m.permanent) return send(400, { error: 'legacy/permanent master: edit relay-config.json' });
        m.revoked = true;
        this.persistMasters();
        this.killChannelsOfMaster(m, 'master revoked'); // 吊销立即生效
        this.info(`master revoked id=${md[1]}`);
        return send(200, { ok: true, id: md[1] });
      }
    }

    // ---------- 混合接入口令（tconf_v1：IP+主码+CA 一贴即配） ----------
    if (p === '/api/admin/access' && req.method === 'GET') {
      if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
      return send(200, {
        publicUrl: this.publicUrl,
        caBound: !!this.publicCaPem,
        caFingerprint: this.publicCaPem ? caFingerprint(this.publicCaPem) : null,
      });
    }
    if (p === '/api/admin/access' && req.method === 'PUT') {
      if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') return send(400, { error: 'bad body' });
      if (body.publicUrl !== undefined) {
        const u = String(body.publicUrl ?? '').trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\/.+/.test(u)) return send(400, { error: 'publicUrl must be http(s)://…' });
        this.publicUrl = u;
      }
      if (body.caPem !== undefined) {
        const pem = String(body.caPem ?? '').trim();
        if (pem && !pem.startsWith('-----BEGIN CERTIFICATE-----')) {
          return send(400, { error: 'caPem must be a PEM certificate' });
        }
        if (pem && !caFingerprint(pem)) return send(400, { error: 'caPem is not a valid X.509 certificate' });
        this.publicCaPem = pem;
      }
      this.persistAccess();
      this.info(`access config updated (url=${this.publicUrl || '-'} ca=${this.publicCaPem ? 'bound' : 'none'})`);
      return send(200, { publicUrl: this.publicUrl, caBound: !!this.publicCaPem, caFingerprint: this.publicCaPem ? caFingerprint(this.publicCaPem) : null });
    }
    if (p === '/api/admin/token' && req.method === 'POST') {
      if (!this.adminOk(req)) return send(401, { error: 'unauthorized' });
      const body = await readJson(req);
      const code = String(body?.code ?? '').trim();
      if (!code.startsWith('trelay_v1_')) return send(400, { error: 'code must be trelay_v1_…' });
      if (!this.publicUrl) return send(400, { error: 'publicUrl not bound — PUT /api/admin/access first（或 CLI bind-access）' });
      const entry = this.verifyMaster(code);
      if (!entry) return send(404, { error: 'unknown master code' });
      if (entry.revoked) return send(409, { error: 'master revoked' });
      // 明文主码仅在内存中短暂存在（拼口令即弃，不落盘不进日志）
      const token = encodeAccessToken({
        url: this.publicUrl, master: code, caPem: this.publicCaPem,
        label: String(body?.label ?? entry.label ?? '').slice(0, 64),
      });
      this.info(`access token issued for master id=${entry.hash.slice(0, 8)} (ca=${this.publicCaPem ? 'embedded' : 'none'})`);
      return send(200, { token, url: this.publicUrl, caFingerprint: this.publicCaPem ? caFingerprint(this.publicCaPem) : null });
    }

    if (p === '/api/channels/subcodes' && req.method === 'POST') {
      if (this.byIp.isLocked(ip)) return send(429, { error: 'rate limited' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') return send(400, { error: 'bad body' });
      // 主码 → 本通道；管理会话 → 显式 channelId（管理页代签）
      const channelId = authed() ?? (this.adminOk(req) && body.channelId ? body.channelId : null);
      if (!channelId) return send(401, { error: 'unauthorized' });
      const rec = this.store.issueSubCode(channelId, {
        ttlHours: body.ttlHours ?? this.subcodeTtlHours ?? 6,
        label: body.label,
      });
      this.info(`subcode ${rec.id} issued on ${channelId.slice(0, 8)}…`);
      return send(201, { subCode: rec.code, id: rec.id, label: rec.label, expiresAt: rec.expiresAt });
    }

    if (p === '/api/channels/subcodes' && req.method === 'GET') {
      const q = url.searchParams;
      const channelId = authed() ?? (this.adminOk(req) && q.get('channel') ? q.get('channel') : null);
      if (!channelId) return send(401, { error: 'unauthorized' });
      const ch = this.store.getChannel(channelId);
      const subcodes = ch
        ? [...ch.subcodes.values()].map((sc) => ({
            id: sc.id, code: sc.code, label: sc.label,
            createdAt: sc.createdAt, expiresAt: sc.expiresAt,
            revoked: sc.revoked, stats: sc.stats,
          }))
        : [];
      return send(200, { subcodes });
    }

    {
      const rm = p.match(/^\/api\/channels\/subcodes\/([^/]+)\/renew$/);
      if (rm && req.method === 'POST') {
        if (this.byIp.isLocked(ip)) return send(429, { error: 'rate limited' });
        const rec = this.store.findSubCodeById(rm[1]);
        if (!rec) return send(404, { error: 'no such subcode' });
        // 授权：管理会话；或属主主码（authed() 返回其通道 id）
        if (!this.adminOk(req) && authed() !== rec.channelId) return send(401, { error: 'unauthorized' });
        const body = await readJson(req);
        if (!body || typeof body !== 'object') return send(400, { error: 'bad body' });
        if (body.permanent !== true && body.days === undefined) return send(400, { error: 'days or permanent required' });
        const out = this.store.renewSubCode(rec.id, { days: body.days, permanent: body.permanent === true });
        if (!out) return send(409, { error: 'revoked subcode cannot renew' });
        this.info(`subcode ${rec.id} renewed (${body.permanent === true ? 'permanent' : '+' + body.days + 'd'})`);
        return send(200, { id: out.id, expiresAt: out.expiresAt });
      }
    }
    const m = p.match(/^\/api\/channels\/subcodes\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const q = url.searchParams;
      const channelId = authed() ?? (this.adminOk(req) && q.get('channel') ? q.get('channel') : null);
      if (!channelId) return send(401, { error: 'unauthorized' });
      if (q.get('purge') === '1') {
        // 删除（吊销后的清理）：记录从表中移除；若仍活跃先终止管道
        const ch0 = this.store.getChannel(channelId);
        const rec0 = ch0?.subcodes.get(m[1]);
        if (!rec0) return send(404, { error: 'no such subcode' });
        for (const pipe of [...(ch0?.pipes ?? [])]) {
          if (pipe.subCodeId === rec0.id) pipe.kill('subcode deleted');
        }
        const out = this.store.purgeSubCode(channelId, m[1]);
        if (!out) return send(404, { error: 'no such subcode' });
        this.info(`subcode ${rec0.id} purged`);
        return send(200, { ok: true, id: rec0.id, purged: true });
      }
      const rec = this.store.revokeSubCode(channelId, m[1]);
      if (!rec) return send(404, { error: 'no such subcode' });
      // 吊销立即生效：终止其名下活跃管道（TC-R3-07 语义）
      const ch = this.store.getChannel(channelId);
      for (const pipe of [...(ch?.pipes ?? [])]) {
        if (pipe.subCodeId === rec.id) pipe.kill('subcode revoked');
      }
      this.info(`subcode ${rec.id} revoked`);
      return send(200, { ok: true, id: rec.id });
    }

    return send(404, { error: 'not found' });
  }

  serveStatic(p, res) {
    const finish = (status, text, ct) => {
      res.writeHead(status, { 'content-type': ct ?? 'text/plain; charset=utf-8' });
      res.end(text);
    };
    if (!this.webRoot) return finish(404, 'not found');
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/static\//, '').replace(/^\//, '');
    const root = path.resolve(this.webRoot);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return finish(403, 'forbidden'); // 路径穿越守卫（TC-R1-10）
    }
    fs.readFile(abs, (err, data) => {
      if (err) return finish(404, 'not found');
      const ct = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  sendJson(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }
}

/** 读取（有上限的）JSON 请求体。 */
function readJson(req, maxBytes = 4096) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        return resolve(null);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
