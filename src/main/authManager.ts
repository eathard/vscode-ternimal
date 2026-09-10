// AuthManager (M3, WBS-M3-B/C/D; design §2.5; token model per user request).
//
// Dynamic-access-token authentication: a URL-safe random token generated
// per app launch (env TERNIMAL_TOKEN overrides for tests/recovery), shown
// as a QR code in the tray "查看访问信息" window. Browsers open
// https://host:port/#T=<token> — the fragment never reaches the server;
// the login page exchanges it via POST /auth for an in-memory session
// cookie (HttpOnly/Secure/SameSite=Strict, sliding 7-day expiry).
// Per-IP failed-attempt rate limiter (5/min → 1 min lockout). Restart
// rotates the token and invalidates all sessions by design.
//
// Testability: window/lock/TTL are injectable so verify-ratelimit.mjs can
// run the semantics in milliseconds instead of minutes.
import * as crypto from 'crypto';
import { deriveSessionKey } from '../shared/e2ee';

export const SESSION_COOKIE = 'ternimal_session';
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days, sliding
const DEFAULT_WINDOW_MS = 60_000; // failure window
const DEFAULT_LOCK_MS = 60_000; // lockout duration
const DEFAULT_MAX_FAILURES = 5;
const TOKEN_BYTES = 24; // 192-bit, base64url → 32 chars

export interface AuthManagerOptions {
  /** Explicit access token (env override for tests/recovery); generated if absent. */
  accessToken?: string;
  sessionTtlMs?: number;
  windowMs?: number;
  lockMs?: number;
  maxFailures?: number;
}

interface SessionRecord {
  createdAt: number;
  lastSeen: number;
}

interface IpRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export interface LoginResult {
  ok: boolean;
  status: number; // HTTP status for the response
  cookie?: string; // full Set-Cookie header value on success
  retryAfterMs?: number; // when locked out
}

export class AuthManager {
  private accessToken: string;
  private readonly ttlMs: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly maxFailures: number;
  private sessions: Map<string, SessionRecord> = new Map();
  private ips: Map<string, IpRecord> = new Map();

  constructor(opts: AuthManagerOptions = {}) {
    this.accessToken = opts.accessToken ?? generateAccessToken();
    this.ttlMs = opts.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  }

  /** Current access token — for the tray QR/URL display surface. */
  getToken(): string {
    return this.accessToken;
  }

  /** Attempt auth for an IP; rate-limits before even checking the token. */
  login(ip: string, token: string): LoginResult {
    const now = Date.now();
    const rec = this.ips.get(ip);
    if (rec && rec.lockedUntil > now) {
      return { ok: false, status: 429, retryAfterMs: rec.lockedUntil - now };
    }

    if (this.verifyToken(token)) {
      this.ips.delete(ip); // success resets the failure window
      const session = crypto.randomBytes(32).toString('hex');
      this.sessions.set(session, { createdAt: now, lastSeen: now });
      return {
        ok: true,
        status: 303,
        cookie: `${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}`,
      };
    }

    this.recordFailure(ip, now);
    const updated = this.ips.get(ip)!;
    return updated.lockedUntil > now
      ? { ok: false, status: 429, retryAfterMs: updated.lockedUntil - now }
      : { ok: false, status: 401 };
  }

  /** Validate a session token; sliding expiry refreshes lastSeen. */
  isValidSession(session: string | undefined | null): boolean {
    if (!session) return false;
    const now = Date.now();
    const rec = this.sessions.get(session);
    if (!rec) return false;
    if (now - rec.lastSeen > this.ttlMs) {
      this.sessions.delete(session);
      return false;
    }
    rec.lastSeen = now;
    return true;
  }

  /** Extract our session token from a Cookie header value. */
  tokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === SESSION_COOKIE) return rest.join('=');
    }
    return undefined;
  }

  /** Is this IP currently locked out? (WS handshakes may also consult it.) */
  isLocked(ip: string): boolean {
    const rec = this.ips.get(ip);
    return !!rec && rec.lockedUntil > Date.now();
  }

  // ---------- WBS-R2-C: relay/loopback first-frame auth ----------
  // 中继管道经本机插件以无 cookie 的 WS 连入 RemoteServer；token 由远端
  // 客户端端到端出示（授权码与 Token 双轨独立，relay-design §2）。
  // 失败计数独立于 HTTP 登录（key 恒为 '__relay__'）：同一窗口内 5 次失败
  // → 锁定 1 分钟，语义与 login() 一致且共用可注入的窗口/锁参数。

  private static readonly RELAY_KEY = '__relay__';

  /** Is the relay first-frame path currently locked out? */
  isRelayLocked(): boolean {
    return this.isLocked(AuthManager.RELAY_KEY);
  }

  /**
   * Verify a first-frame token on the relay path.
   * @returns ok = token valid; locked = currently rate-limited (implies !ok).
   */
  relayAuth(token: string): { ok: boolean; locked: boolean } {
    const now = Date.now();
    const rec = this.ips.get(AuthManager.RELAY_KEY);
    if (rec && rec.lockedUntil > now) {
      return { ok: false, locked: true };
    }
    if (this.verifyToken(token)) {
      this.ips.delete(AuthManager.RELAY_KEY);
      return { ok: true, locked: false };
    }
    this.recordFailure(AuthManager.RELAY_KEY, now);
    const updated = this.ips.get(AuthManager.RELAY_KEY);
    return { ok: false, locked: !!updated && updated.lockedUntil > now };
  }

  // ---------- R-M4-A: 挑战应答（Token 不再明文过 relay） ----------

  private static readonly NONCE_TTL_MS = 30_000;
  private static readonly NONCE_CAP = 256;
  private relayNonces = new Map<string, number>(); // nonce → expiresAt

  /** 签发单次有效 nonce（base64url 32B）。超量驱逐最旧。 */
  issueRelayNonce(): string {
    const now = Date.now();
    // 顺手清扫过期项（顺带控容）
    if (this.relayNonces.size > 0) {
      for (const [n, exp] of this.relayNonces) {
        if (exp <= now) this.relayNonces.delete(n);
      }
    }
    while (this.relayNonces.size >= AuthManager.NONCE_CAP) {
      const oldest = this.relayNonces.keys().next().value as string;
      this.relayNonces.delete(oldest);
    }
    const nonce = crypto.randomBytes(32).toString('base64url');
    this.relayNonces.set(nonce, now + AuthManager.NONCE_TTL_MS);
    return nonce;
  }

  /**
   * 校验挑战应答：mac == HMAC-SHA256(token, nonce)（hex，常数时间比较）。
   * nonce 一次性（校验即焚，无论成败）→ 捕获重放无效；锁定语义与
   * relayAuth/login() 一致（第 5 次失败即上锁）。
   */
  verifyRelayMac(nonce: string, mac: string): { ok: boolean; locked: boolean } {
    const now = Date.now();
    const rec = this.ips.get(AuthManager.RELAY_KEY);
    if (rec && rec.lockedUntil > now) {
      return { ok: false, locked: true };
    }
    const expiresAt = this.relayNonces.get(nonce);
    this.relayNonces.delete(nonce); // 单次有效
    const expected = expiresAt && expiresAt > now
      ? crypto.createHmac('sha256', this.accessToken).update(nonce).digest('hex')
      : '';
    if (expected && /^[0-9a-f]{64}$/.test(mac) && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'))) {
      this.ips.delete(AuthManager.RELAY_KEY);
      return { ok: true, locked: false };
    }
    this.recordFailure(AuthManager.RELAY_KEY, now);
    const updated = this.ips.get(AuthManager.RELAY_KEY);
    return { ok: false, locked: !!updated && updated.lockedUntil > now };
  }

  /** Rotate the access token and invalidate every existing session. */
  rotateToken(): string {
    this.accessToken = generateAccessToken();
    this.sessions.clear();
    this.ips.clear();
    this.relayNonces.clear();
    return this.accessToken;
  }

  /** R-M4-B: 从内部 token 派生中继 E2E 会话密钥（token 不出 AuthManager）。 */
  deriveRelaySessionKey(nonce: string): Promise<CryptoKey> {
    return deriveSessionKey(this.accessToken, nonce);
  }

  private recordFailure(ip: string, now: number): void {
    let rec = this.ips.get(ip);
    if (!rec || now - rec.windowStart > this.windowMs) {
      rec = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.ips.set(ip, rec);
    }
    rec.failures++;
    if (rec.failures >= this.maxFailures) {
      rec.lockedUntil = now + this.lockMs;
    }
  }

  private verifyToken(token: string): boolean {
    const expected = Buffer.from(this.accessToken, 'utf8');
    const actual = Buffer.from(token ?? '', 'utf8');
    if (expected.length !== actual.length || expected.length === 0) return false;
    return crypto.timingSafeEqual(expected, actual);
  }
}

/** URL-safe random access token, 32 chars (192 bits of entropy). */
export function generateAccessToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}
