// authManager.test.ts — AuthManager unit semantics: scrypt verify, cookie
// issuance/attributes, session lifecycle (sliding TTL), per-IP rate limiter
// (5 failures/window → lock), token rotation invalidating sessions.
// (migrated from scripts/verify-ratelimit.mjs; real timers, short windows)
import { describe, expect, it } from 'vitest';
import { AuthManager, generateAccessToken } from './authManager';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RIGHT = 'right-token-32-chars-abcdefghij';
const sessionToken = (cookie: string | undefined) =>
  /ternimal_session=([0-9a-f]+)/.exec(cookie ?? '')![1];

describe('token primitives', () => {
  it('generateAccessToken: 32 URL-safe chars (192 bits), unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = generateAccessToken();
      expect(t.length).toBe(32);
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(t);
    }
    expect(seen.size).toBe(50);
  });
});

describe('login + cookie', () => {
  it('wrong token 401, near-miss rejected, right token 303 + hardened cookie', () => {
    const auth = new AuthManager({ accessToken: 's3cret-token-32-chars-aaaa' });
    const bad = auth.login('1.2.3.4', 'nope');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(401);
    expect(auth.login('1.2.3.4', 's3cret-token-32-chars-aaab').status).toBe(401);

    const good = auth.login('1.2.3.4', 's3cret-token-32-chars-aaaa');
    expect(good.status).toBe(303);
    expect(good.cookie).toBeTruthy();
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=']) {
      expect(good.cookie).toContain(attr);
    }
    expect(sessionToken(good.cookie).length).toBe(64);
  });

  it('verify path is safe: empty/malformed tokens never validate', () => {
    const auth = new AuthManager({ accessToken: 'x'.repeat(32) });
    expect(auth.login('9.9.9.9', '').status).toBe(401);
    expect(auth.login('9.9.9.9', 'undefined').status).toBe(401);
    expect(new AuthManager().getToken().length).toBe(32);
  });
});

describe('sessions', () => {
  it('tokenFromCookieHeader extracts ours from a multi-cookie header', () => {
    const auth = new AuthManager({ accessToken: 'x-token-x-token-x-token-x-token' });
    const r = auth.login('1.1.1.1', 'x-token-x-token-x-token-x-token');
    const token = sessionToken(r.cookie);
    expect(auth.tokenFromCookieHeader(`a=b; ternimal_session=${token}; c=d`)).toBe(token);
    expect(auth.tokenFromCookieHeader('other=value')).toBeUndefined();
    expect(auth.tokenFromCookieHeader(undefined)).toBeUndefined();
  });

  it('session lifecycle: unknown rejected, expiry enforced, sliding refresh works', async () => {
    const auth = new AuthManager({ accessToken: 'x-token-x-token-x-token-x-token', sessionTtlMs: 120 });
    const token = sessionToken(auth.login('2.2.2.2', 'x-token-x-token-x-token-x-token').cookie);

    expect(auth.isValidSession(token)).toBe(true);
    expect(auth.isValidSession('deadbeef'.repeat(8))).toBe(false);

    await sleep(60); // halfway; isValidSession refreshes lastSeen (sliding TTL)
    expect(auth.isValidSession(token)).toBe(true);

    await sleep(70); // 70 < 120 since the refresh at t=60 → alive
    expect(auth.isValidSession(token)).toBe(true);

    await sleep(130); // no intermediate access → expired
    expect(auth.isValidSession(token)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('5 failures lock for lockMs; correct token 429 while locked; unlock after', async () => {
    const auth = new AuthManager({ accessToken: RIGHT, windowMs: 10_000, lockMs: 80, maxFailures: 5 });
    for (let i = 1; i <= 5; i++) {
      const r = auth.login('3.3.3.3', 'wrong');
      expect([401, 429]).toContain(r.status);
    }
    expect(auth.isLocked('3.3.3.3')).toBe(true);

    const during = auth.login('3.3.3.3', RIGHT);
    expect(during.status).toBe(429);
    expect(during.retryAfterMs).toBeGreaterThan(0);

    await sleep(100); // lockMs=80
    expect(auth.isLocked('3.3.3.3')).toBe(false);
    expect(auth.login('3.3.3.3', RIGHT).status).toBe(303);
  });

  it('failures spread beyond windowMs never accumulate to a lock', async () => {
    const auth = new AuthManager({ accessToken: RIGHT, windowMs: 60, lockMs: 1000, maxFailures: 5 });
    for (let i = 0; i < 4; i++) {
      auth.login('4.4.4.4', 'wrong');
      await sleep(25); // window slides past before 5th failure
    }
    expect(auth.isLocked('4.4.4.4')).toBe(false);
    expect(auth.login('4.4.4.4', RIGHT).status).toBe(303);
  });

  it('successful login resets the failure window for that IP', () => {
    const auth = new AuthManager({ accessToken: RIGHT, windowMs: 10_000, lockMs: 1000, maxFailures: 3 });
    auth.login('5.5.5.5', 'wrong');
    auth.login('5.5.5.5', 'wrong');
    auth.login('5.5.5.5', RIGHT); // reset
    auth.login('5.5.5.5', 'wrong');
    auth.login('5.5.5.5', 'wrong');
    expect(auth.isLocked('5.5.5.5')).toBe(false);
  });

  it('rate limiting is per-IP', () => {
    const auth = new AuthManager({ accessToken: RIGHT, windowMs: 10_000, lockMs: 1000, maxFailures: 2 });
    auth.login('6.6.6.6', 'wrong');
    auth.login('6.6.6.6', 'wrong');
    expect(auth.isLocked('6.6.6.6')).toBe(true);
    expect(auth.isLocked('7.7.7.7')).toBe(false);
    expect(auth.login('7.7.7.7', RIGHT).status).toBe(303);
  });
});

describe('token rotation', () => {
  it('rotateToken: new token works, every old session dies (TC-M3-08 core)', () => {
    const auth = new AuthManager({ accessToken: 'old-token-32-chars-aaaaaaaaaa' });
    const token = sessionToken(auth.login('8.8.8.8', 'old-token-32-chars-aaaaaaaaaa').cookie);
    expect(auth.isValidSession(token)).toBe(true);

    const next = auth.rotateToken();
    expect(next.length).toBe(32);
    expect(next).not.toBe('old-token-32-chars-aaaaaaaaaa');
    expect(auth.isValidSession(token)).toBe(false);
    expect(auth.login('8.8.8.8', 'old-token-32-chars-aaaaaaaaaa').status).toBe(401);
    expect(auth.login('8.8.8.8', next).status).toBe(303);
  });
});
