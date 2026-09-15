// certManager.test.ts — self-signed certificate generation: X.509 shape
// (CN/SAN), SHA-256 fingerprint format, on-disk reuse with stable
// fingerprint, private-key permissions (POSIX only — Windows chmod is a no-op).
// (migrated from scripts/verify-ratelimit.mjs)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureCertificate, fingerprintPem } from './certManager';

describe('ensureCertificate', () => {
  it('generates valid X.509 with SANs; key mode 0600', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cert-unit-'));
    const tls = await ensureCertificate(dir);
    expect(tls.generated).toBe(true);
    expect(tls.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const cert = new crypto.X509Certificate(tls.cert);
    expect(cert.subject.split('\n').some((l) => l.includes('CN=Ternimal'))).toBe(true);
    const san = cert.subjectAltName ?? '';
    expect(san).toContain('localhost');
    expect(san).toContain('127.0.0.1');

    const keyFile = path.join(dir, 'ternimal-key.pem');
    if (process.platform !== 'win32') {
      // Windows has no POSIX permission bits: the read-only attribute maps
      // to 0o666 regardless of the write mode.
      const mode = fs.statSync(keyFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('second call reuses disk material with identical fingerprint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ternimal-cert-unit-'));
    const first = await ensureCertificate(dir);
    const second = await ensureCertificate(dir);
    expect(second.generated).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(fingerprintPem(first.cert)).toBe(first.fingerprint);
  });
});
