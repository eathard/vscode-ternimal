// keychain.ts — 多电脑书签的凭据钥匙串（v1.3.2）。
//
// 问题：中继链接 #S=<子码>&T=<令牌> 打开后 T 被立即抹除（P0：令牌不驻留
// 地址栏/历史），书签因此丢失后缀、无法免扫码回访；而一台手机常需连接
// 多台电脑——单条全局凭据会互相覆盖。
//
// 设计：子码是主机标识（非机密——没有 T 通不过挑战应答），令牌才是活凭据。
//   · URL 改写保留 #S=（地址栏/书签可携带主机标识）
//   · auth-ok 后 T 按子码存入 localStorage 钥匙串：{ [sub]: { token, exp } }
//   · 书签 #S=<sub> 打开 → 钥匙串命中 → 免扫码直连
//   · 滑动 TTL（默认 30 天，每次成功连接续期）；逐条「忘记」+ 过期清扫
//
// 安全权衡（有意识的放宽）：T 从 sessionStorage（本标签页）移到 localStorage
// （落盘、跨会话）。缓解：TTL 有限、逐条可吊销（忘记）、服务端子码本身
// 可吊销（既有能力）、T 永不进 URL/书签/历史。隐私模式下 localStorage
// 不可用 → 全部操作静默降级为现状行为。

/** 可注入的存储面（浏览器=window.localStorage；测试=Map 桩）。 */
export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'ternimal.keychain.v1';

export const KEYCHAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

interface KeychainEntry {
  token: string;
  /** 存储时间（ms since epoch）；exp = savedAt + TTL，每次命中滑动续期。 */
  savedAt: number;
}

interface KeychainShape {
  entries: Record<string, KeychainEntry>;
}

export class Keychain {
  private readonly storage: KVStorage | null;

  constructor(storage?: KVStorage | null, private readonly ttlMs: number = KEYCHAIN_TTL_MS) {
    // 隐私模式等场景 localStorage 访问即抛 → 持久化降级关闭
    this.storage = storage !== undefined ? storage : safeLocalStorage();
  }

  /** auth-ok 后调用：记录/续期一台主机的令牌。静默失败（存储满/不可用）。 */
  remember(subCode: string, token: string, now: number = Date.now()): void {
    if (!this.storage || !subCode || !token) return;
    const data = this.load();
    data.entries[subCode] = { token, savedAt: now };
    this.save(data);
  }

  /** 书签回访：按子码取未过期令牌。命中即滑动续期。 */
  lookup(subCode: string, now: number = Date.now()): string | null {
    if (!this.storage || !subCode) return null;
    const data = this.load();
    const entry = data.entries[subCode];
    if (!entry) return null;
    if (now - entry.savedAt > this.ttlMs) {
      delete data.entries[subCode];
      this.save(data);
      return null;
    }
    entry.savedAt = now; // 滑动续期
    this.save(data);
    return entry.token;
  }

  /** 忘记一台主机（「忘记此设备」按钮）。 */
  forget(subCode: string): void {
    if (!this.storage) return;
    const data = this.load();
    delete data.entries[subCode];
    this.save(data);
  }

  /** 管理卡：列出已存主机（子码 + 剩余天数），已过期条目顺手清扫。 */
  list(now: number = Date.now()): Array<{ subCode: string; token: string; daysLeft: number }> {
    if (!this.storage) return [];
    const data = this.load();
    const out: Array<{ subCode: string; token: string; daysLeft: number }> = [];
    let dirty = false;
    for (const [sub, entry] of Object.entries(data.entries)) {
      const age = now - entry.savedAt;
      if (age > this.ttlMs) {
        delete data.entries[sub];
        dirty = true;
        continue;
      }
      out.push({ subCode: sub, token: entry.token, daysLeft: Math.ceil((this.ttlMs - age) / 86400000) });
    }
    if (dirty) this.save(data);
    return out.sort((a, b) => a.subCode.localeCompare(b.subCode));
  }

  private load(): KeychainShape {
    if (!this.storage) return { entries: {} };
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return { entries: {} };
      const parsed = JSON.parse(raw) as KeychainShape;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
        return { entries: {} };
      }
      return parsed;
    } catch {
      return { entries: {} }; // 损坏 → 当空处理
    }
  }

  private save(data: KeychainShape): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* 配额满/隐私模式：静默放弃（现状行为不受影响） */
    }
  }
}

function safeLocalStorage(): KVStorage | null {
  try {
    // 触碰即抛（Safari 隐私模式等）→ null
    const ls = globalThis.localStorage;
    if (!ls) return null;
    ls.getItem(STORAGE_KEY);
    return ls as KVStorage;
  } catch {
    return null;
  }
}
