// ConfigStore (M3 minimal slice of design §2.8; M4 extends with the full
// schema and settings UI). JSON file at <configDir>/config.json with
// atomic-ish write (tmp + rename), lazy defaults on first read.
import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  port: number;
  host: string;
  passwordHash: string;
  certPath: string; // '' = managed self-signed under certDir
  replayBufferBytes: number;
  maxSessions: number;
}

const DEFAULTS: AppConfig = {
  port: 8443,
  host: '0.0.0.0',
  passwordHash: '',
  certPath: '',
  replayBufferBytes: 1024 * 1024,
  maxSessions: 16,
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
      cfg = { ...DEFAULTS, ...raw };
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
