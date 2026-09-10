// relay/src/ratelimit.mjs — 控制面失败限速（register/join/管理 API 共用）。
//
// 语义对齐主项目 AuthManager（docs/verification-standard.md 的既有先例）：
// 每 key 在 windowMs 内失败达 maxFailures 次 → 锁定 lockMs；成功不计失败、
// 不清零计数（窗口滑动按窗口起点重置）。窗口/锁时长可注入，验证脚本以
// 毫秒级参数跑完整语义。

export class RateLimiter {
  /**
   * @param {{windowMs?: number, lockMs?: number, maxFailures?: number}} [opts]
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.lockMs = opts.lockMs ?? 60_000;
    this.maxFailures = opts.maxFailures ?? 5;
    /** @type {Map<string, {failures: number, windowStart: number, lockedUntil: number}>} */
    this.recs = new Map();
  }

  /** 是否处于锁定期（锁定时直接拒绝，不消耗计数）。 @param {string} key */
  isLocked(key) {
    const rec = this.recs.get(key);
    return !!rec && rec.lockedUntil > Date.now();
  }

  /** 剩余锁定毫秒数（未锁定为 0）。 @param {string} key */
  lockedRemainingMs(key) {
    const rec = this.recs.get(key);
    return rec ? Math.max(0, rec.lockedUntil - Date.now()) : 0;
  }

  /**
   * 记录一次失败；达到阈值则上锁并返回 true（本次已触发锁定）。
   * @param {string} key
   */
  fail(key) {
    const now = Date.now();
    let rec = this.recs.get(key);
    if (!rec || now - rec.windowStart >= this.windowMs) {
      rec = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.recs.set(key, rec);
    }
    rec.failures += 1;
    if (rec.failures >= this.maxFailures) {
      rec.lockedUntil = now + this.lockMs;
      rec.failures = 0;
      rec.windowStart = now;
      return true;
    }
    return false;
  }
}
