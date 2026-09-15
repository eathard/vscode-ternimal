// configStore.test.ts — remote config defaults, persistence round-trip,
// atomic write without tmp leftovers.
// (migrated from scripts/verify-ratelimit.mjs)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from './configStore';

describe('ConfigStore', () => {
  it('defaults when missing, round-trip persistence, atomic write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cfg-'));
    const store = new ConfigStore(dir);
    const cfg = store.load();
    expect(cfg.port).toBe(8443);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.maxSessions).toBe(16);

    store.save({ port: 9443, passwordHash: 'scrypt$aa$bb' });
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'config.json.tmp'))).toBe(false);

    const reloaded = new ConfigStore(dir).load();
    expect(reloaded.port).toBe(9443);
    expect(reloaded.passwordHash).toBe('scrypt$aa$bb');
  });
});
