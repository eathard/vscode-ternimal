// Shared fake PtyHost for verification scripts (D8). Implements the
// structural PtyHost contract from sessionRegistry.ts so suites run under
// plain node without the Electron-ABI node-pty module.
import { EventEmitter } from 'node:events';

export class FakePty {
  constructor(host, id, request) {
    this.host = host;
    this.id = id;
    this.pid = 4200 + host.seq++;
    this.process = 'bash';
    this.resizeCalls = [];
    this.writeCalls = [];
    this.killed = false;
    this.cols = request.cols;
    this.rows = request.rows;
  }
  write(data) {
    this.writeCalls.push(data);
    // echo semantics make the registry data path observable
    this.host.emit('data', { id: this.id, data: `<${data}>` });
  }
  emitOutput(data) {
    // test helper: simulate spontaneous PTY output (e.g. long-running task)
    this.host.emit('data', { id: this.id, data });
  }
  resize(cols, rows) {
    this.resizeCalls.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }
  kill() {
    this.killed = true;
    this.host.ptys.delete(this.id);
    this.host.emit('exit', { id: this.id, exitCode: 0 });
  }
}

export class FakePtyHost extends EventEmitter {
  constructor() {
    super();
    this.ptys = new Map();
    this.seq = 0;
  }
  spawn(request) {
    const pty = new FakePty(this, request.id, request);
    this.ptys.set(request.id, pty);
    return pty;
  }
  write(id, data) {
    this.ptys.get(id)?.write(data);
  }
  resize(id, cols, rows) {
    this.ptys.get(id)?.resize(cols, rows);
  }
  kill(id) {
    this.ptys.get(id)?.kill();
  }
  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}
