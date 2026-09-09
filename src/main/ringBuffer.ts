// Ring-shaped replay buffer for PTY output (technical design §2.1).
//
// PTY onData delivers whole JS strings; chunks are enqueued as-is so a
// snapshot never splits a UTF-16 surrogate pair. Known limitation (accepted
// in requirements §7-5): the snapshot start may land mid ANSI escape
// sequence; xterm.js tolerates truncated sequences.

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB

export class RingBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    if (maxBytes <= 0) throw new Error('RingBuffer maxBytes must be > 0');
    this.maxBytes = maxBytes;
  }

  /** Append one output chunk, evicting oldest chunks past the cap. */
  append(chunk: string): void {
    const size = Buffer.byteLength(chunk, 'utf8');
    // Defensive: a single chunk larger than the whole buffer keeps only
    // itself (most recent output wins).
    if (size >= this.maxBytes) {
      this.chunks = [chunk];
      this.bytes = size;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks[0], 'utf8');
      this.chunks.shift();
    }
  }

  /** Full buffered output for replay-on-attach. */
  snapshot(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  get byteLength(): number {
    return this.bytes;
  }
}
