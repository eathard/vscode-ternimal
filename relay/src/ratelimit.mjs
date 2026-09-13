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
    this.maxKeys = opts.maxKeys ?? 10_000; // 记录数上限（防内存 DoS）
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
      // P1：插入前顺手驱逐过期记录——伪造 XFF/海量错子码曾可无限增殖
      // recs 造成内存 DoS（配合锁定早退后 CPU 也不再被烧）。
      if (this.recs.size >= this.maxKeys) this.evictExpired(now);
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

  /** 驱逐「窗口与锁均已过期」的记录；满了仍超限则按最旧窗口淘汰。 */
  evictExpired(now = Date.now()) {
    for (const [k, rec] of this.recs) {
      const dead = now - rec.windowStart >= this.windowMs && rec.lockedUntil <= now;
      if (dead) this.recs.delete(k);
    }
    while (this.recs.size >= this.maxKeys) {
      let oldestKey = null, oldest = Infinity;
      for (const [k, rec] of this.recs) {
        if (rec.windowStart < oldest) { oldest = rec.windowStart; oldestKey = k; }
      }
      if (oldestKey === null) break;
      this.recs.delete(oldestKey);
    }
  }
}
