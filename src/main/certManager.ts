// CertManager (M3, WBS-M3-A; technical design §2.9).
//
// Ensures a self-signed TLS certificate exists: load from a configured path,
// else generate (RSA-2048, 365d) with SANs covering localhost and every LAN
// IPv4 of the host, persisted under <certDir>. The SHA-256 fingerprint is
// surfaced on the login page so a remote user can eyeball-verify it against
// the value shown on the host (anti-MITM for self-signed deployments).
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as selfsigned from 'selfsigned';

export interface TlsMaterial {
  cert: string; // PEM
  key: string; // PEM
  /** Uppercase colon-hex SHA-256 of the DER cert — the human check value. */
  fingerprint: string;
  generated: boolean; // true if created during this call
}

const CERT_FILENAME = 'ternimal-cert.pem';
const KEY_FILENAME = 'ternimal-key.pem';

export async function ensureCertificate(certDir: string, certPathOverride?: string): Promise<TlsMaterial> {
  const dir = certPathOverride ? path.dirname(certPathOverride) : certDir;
  const certFile = certPathOverride
    ? certPathOverride
    : path.join(dir, CERT_FILENAME);
  const keyFile = certPathOverride
    ? certPathOverride.replace(/\.pem$/, '.key.pem')
    : path.join(dir, KEY_FILENAME);

  if (certPathOverride || (fs.existsSync(certFile) && fs.existsSync(keyFile))) {
    try {
      const cert = fs.readFileSync(certFile, 'utf8');
      const key = fs.readFileSync(keyFile, 'utf8');
      if (cert.includes('CERTIFICATE') && key.includes('PRIVATE KEY')) {
        return { cert, key, fingerprint: fingerprintPem(cert), generated: false };
      }
    } catch {
      // fall through to regeneration
    }
  }

  const generated = await generate();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certFile, generated.cert, { mode: 0o644 });
  fs.writeFileSync(keyFile, generated.key, { mode: 0o600 });
  return { ...generated, generated: true };
}

async function generate(): Promise<{ cert: string; key: string; fingerprint: string }> {
  // SubjectAltNameEntry: type 2 = DNS (value), 7 = IP (ip) per typings
  const altNames: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
  ];
  for (const ips of Object.values(os.networkInterfaces())) {
    for (const net of ips ?? []) {
      // IPv4 LAN addresses only — keeps SAN list short and useful
      if (net.family === 'IPv4' && !net.internal) {
        altNames.push({ type: 7, ip: net.address });
      }
    }
  }

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Ternimal' }],
    {
      keySize: 2048,
      algorithm: 'sha256', // default would be sha1 — set explicitly
      notAfterDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'subjectAltName',
          altNames,
        },
      ],
    }
  );
  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint: fingerprintPem(pems.cert),
  };
}

/** SHA-256 over the DER body of a PEM certificate, colon-hex formatted. */
export function fingerprintPem(certPem: string): string {
  const der = pemToDer(certPem);
  const hash = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return (hash.match(/.{2}/g) ?? []).join(':');
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}
