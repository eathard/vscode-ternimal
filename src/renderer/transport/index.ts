// Transport singleton: the Electron entry sets LocalIpcTransport before the
// app boots; the M2 web entry sets WebSocketTransport instead.
import type { TerminalTransport } from './transport';

let instance: TerminalTransport | null = null;

export function setTransport(t: TerminalTransport): void {
  instance = t;
}

export function getTransport(): TerminalTransport {
  if (!instance) {
    throw new Error('[Ternimal] Transport not initialized — call setTransport() at entry point');
  }
  return instance;
}

export type { TerminalTransport, CreateTabOptions, AttachedPayload } from './transport';
