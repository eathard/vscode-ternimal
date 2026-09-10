// ConfigStore (M3 minimal slice of design §2.8; M4 extends with the full
// schema and settings UI). JSON file at <configDir>/config.json with
// atomic-ish write (tmp + rename), lazy defaults on first read.
import * as fs from 'fs';
import * as path from 'path';

export interface RelayConfig {
  /** 自签 relay 根证书 PEM 路径（如 Caddy internal CA）；主/子进程 TLS 信任用 */
  caPath: string;
  enabled: boolean;
  /** Relay base URL, e.g. https://relay.example.com (Caddy 前置) */
  url: string;
  /**
   * R-M4-B：中继路径端到端加密（AES-256-GCM，HKDF(token, nonce)）。
   * 默认关；开启后对请求加密的中继连接生效，relay/插件只见密文。
   */
  e2ee: boolean;
  /** 主码（trelay_v1_…）— 仅在插件子进程与管理 API 调用中使用 */
  masterCode: string;
  /** 退出时清除主码（偏执模式，方案书 §4.1） */
  clearMasterCodeOnExit: boolean;
  /**
   * LAN 直连与中继双开（方案书 §8-Q3）：中继启用时默认收窄 loopback，
   * true = 保持 0.0.0.0 监听（设置面板显式切换并提示暴露面变化）。
   */
  lanDirect: boolean;
}

export interface AppConfig {
  port: number;
  host: string;
  passwordHash: string;
  certPath: string; // '' = managed self-signed under certDir
  replayBufferBytes: number;
  maxSessions: number;
  relay: RelayConfig;
}

const DEFAULTS: AppConfig = {
  port: 8443,
  host: '0.0.0.0',
  passwordHash: '',
  certPath: '',
  replayBufferBytes: 1024 * 1024,
  maxSessions: 16,
  relay: { enabled: false, url: '', masterCode: '', clearMasterCodeOnExit: false, lanDirect: false, e2ee: false, caPath: '' },
};

export class ConfigStore {
  readonly file: string;
  private cache: AppConfig | null = null;

  constructor(configDir: string) {
    this.file = path.join(configDir, 'config.json');
  }

  load(): AppConfig {
    if (this.cache) return this.cache;
    let cfg: AppConfig;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      cfg = { ...DEFAULTS, ...raw, relay: { ...DEFAULTS.relay, ...(raw.relay ?? {}) } };
    } catch {
      cfg = { ...DEFAULTS };
    }
    this.cache = cfg;
    return cfg;
  }

  save(patch: Partial<AppConfig>): AppConfig {
    const current = this.load();
    const next = { ...current, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = next;
    return next;
  }
}
