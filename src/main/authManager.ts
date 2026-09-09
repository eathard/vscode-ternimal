// AuthManager (M3, WBS-M3-B/C/D; technical design §2.5).
//
// Single-password authentication with scrypt-at-rest storage, in-memory
// bearer sessions (httpOnly Secure SameSite=Strict cookies), sliding 7-day
// expiry, and a per-IP failed-login rate limiter (5 failures/minute → 1 min
// lockout). Restart invalidates all sessions by design (documented limit).
//
// Testability: window/lock/TTL are injectable so verify-ratelimit.mjs can
// run the semantics in milliseconds instead of minutes.
import * as crypto from 'crypto';

export const SESSION_COOKIE = 'ternimal_session';
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days, sliding
const DEFAULT_WINDOW_MS = 60_000; // failure window
const DEFAULT_LOCK_MS = 60_000; // lockout duration
const DEFAULT_MAX_FAILURES = 5;
const PASSWORD_LEN = 12;

export interface AuthManagerOptions {
  /** Pre-hashed password ("scrypt$salt$hash") — normally from ConfigStore. */
  passwordHash?: string;
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
  private passwordHash: string;
  private readonly ttlMs: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly maxFailures: number;
  private sessions: Map<string, SessionRecord> = new Map();
  private ips: Map<string, IpRecord> = new Map();

  constructor(opts: AuthManagerOptions = {}) {
    this.passwordHash = opts.passwordHash ?? hashPassword(generatePassword());
    this.ttlMs = opts.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  }

  /** Attempt login for an IP; rate-limits before even checking the password. */
  login(ip: string, password: string): LoginResult {
    const now = Date.now();
    const rec = this.ips.get(ip);
    if (rec && rec.lockedUntil > now) {
      return { ok: false, status: 429, retryAfterMs: rec.lockedUntil - now };
    }

    if (this.verifyPassword(password)) {
      this.ips.delete(ip); // success resets the failure window
      const token = crypto.randomBytes(32).toString('hex');
      this.sessions.set(token, { createdAt: now, lastSeen: now });
      return {
        ok: true,
        status: 303,
        cookie: `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}`,
      };
    }

    this.recordFailure(ip, now);
    const updated = this.ips.get(ip)!;
    return updated.lockedUntil > now
      ? { ok: false, status: 429, retryAfterMs: updated.lockedUntil - now }
      : { ok: false, status: 401 };
  }

  /** Validate a session token; sliding expiry refreshes lastSeen. */
  isValidSession(token: string | undefined | null): boolean {
    if (!token) return false;
    const now = Date.now();
    const rec = this.sessions.get(token);
    if (!rec) return false;
    if (now - rec.lastSeen > this.ttlMs) {
      this.sessions.delete(token);
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

  /** Rotate the password and invalidate every existing session. */
  resetPassword(): string {
    const password = generatePassword();
    this.passwordHash = hashPassword(password);
    this.sessions.clear();
    this.ips.clear();
    return password;
  }

  /** Only compares hash format equality — used by config migration checks. */
  currentHash(): string {
    return this.passwordHash;
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

  private verifyPassword(password: string): boolean {
    try {
      const [scheme, saltHex, hashHex] = this.passwordHash.split('$');
      if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
        N: 16384,
      });
      return crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}

/** scrypt$<salt hex>$<hash hex> — N=16384 per design §2.8. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** URL-safe random password, 12 chars (design §2.8 first-boot default). */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(PASSWORD_LEN);
  let out = '';
  for (let i = 0; i < PASSWORD_LEN; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
