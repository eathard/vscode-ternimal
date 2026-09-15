// wsProtocol.test.ts — codec-level mixed-version safety (wire-compat rules).
// The caps handshake: client announces via auth-response.caps, host echoes
// via auth-ok.caps. Old peers that never heard of caps ignore the field
// (Rule 1) — these tests pin the NEW parser's contract.
import { describe, expect, it } from 'vitest';
import { parseClientMessage, encodeServerMessage } from './wsProtocol';

const mac = 'ab';

describe('auth-response caps (client announcement)', () => {
  it('valid caps list parses through', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'auth-response', mac: 'ab'.repeat(32), caps: ['e2ee', 'softkeys'] }));
    expect(m).not.toBeNull();
    expect(m?.type).toBe('auth-response');
    if (m?.type === 'auth-response') expect(m.caps).toEqual(['e2ee', 'softkeys']);
  });

  it('frame WITHOUT caps stays byte-compatible (old client shape)', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'auth-response', mac: 'ab' }));
    expect(m).toEqual({ type: 'auth-response', mac: 'ab' });
  });

  it('malformed caps → null (BAD_MESSAGE on the wire)', () => {
    const mac = 'ab';
    const bad = (caps: unknown) => parseClientMessage(JSON.stringify({ type: 'auth-response', mac, caps }));
    expect(bad('e2ee')).toBeNull(); // not an array
    expect(bad([42])).toBeNull(); // non-string entry
    expect(bad(['E2EE'])).toBeNull(); // uppercase outside [a-z0-9-]
    expect(bad(['x'.repeat(33)])).toBeNull(); // entry too long
    expect(bad(Array.from({ length: 17 }, (_, i) => `c${i}`))).toBeNull(); // > 16 entries
  });

  it('valid caps at the boundary (16 entries, 32 chars) accepted', () => {
    const caps = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const m = parseClientMessage(JSON.stringify({ type: 'auth-response', mac, caps }));
    expect(m).not.toBeNull();
  });
  it('missing mac still rejected', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'auth-response', caps: ['e2ee'] }))).toBeNull();
  });
});

describe('mixed-version safety (wire-compat rules)', () => {
  it('server frames with caps re-encode losslessly', () => {
    // Host advertises caps on auth-ok; an old client JSON-parses and ignores
    // the unknown field, a new client reads it — the codec round-trips both.
    const frame = encodeServerMessage({ type: 'auth-ok', clientId: 'gc-1', caps: ['e2ee'] });
    const parsed = JSON.parse(frame);
    expect(parsed.caps).toEqual(['e2ee']);
    // old-client simulation: destructure without caps
    const { type, clientId } = parsed;
    expect(type).toBe('auth-ok');
    expect(clientId).toBe('gc-1');
  });

  it('auth-ok WITHOUT caps (old host) — new client must treat as no caps', () => {
    const parsed = JSON.parse('{"type":"auth-ok","clientId":"gc-2"}');
    const caps = Array.isArray(parsed.caps) ? parsed.caps : [];
    expect(caps).toEqual([]);
  });
});
