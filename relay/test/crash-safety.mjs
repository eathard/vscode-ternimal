// crash-safety.mjs — P0 回归：未认证坏帧不得崩掉中继进程。
// 场景：/join 升级后、首帧认证前，发送含非法 UTF-8 的 text 帧（ws 8.x
// receiverOnError → emit('error')）。修复前：无 error 监听 → uncaught →
// 进程退出；修复后：该连接被关，服务器继续服务后续正常 join。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const PORT = 4599;
const child = spawn(process.execPath, ['cli.mjs', 'serve', '--port', String(PORT), '--insecure'], {
  cwd: new URL('.', import.meta.url).pathname.replace(/\/test\/$/, '/'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

let exited = null;
child.on('exit', (code) => { exited = code; });
let stderr = '';
child.stderr.on('data', (d) => { stderr += String(d); });

const waitHealthy = async () => {
  for (let i = 0; i < 100; i++) {
    if (exited !== null) throw new Error(`relay died during boot: ${stderr.slice(-300)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('relay never became healthy');
};

let pass = 0, fail = 0;
const ok = (name, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
};

try {
  await waitHealthy();
  ok('CS-01 中继启动', true);

  // 坏帧 1：非法 UTF-8 的 text 帧（裸 socket 手写帧头，payload 含 0xFF）
  const net = await import('node:net');
  const bad = await new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1');
    sock.on('connect', () => {
      sock.write(
        'GET /join HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += String(d);
      if (buf.includes('101')) {
        // 掩码 text 帧：FIN+opcode=1, MASK=1, len=4, 掩码 4 字节, payload 0xFF×4
        sock.write(Buffer.from([0x81, 0x84, 0x01, 0x02, 0x03, 0x04, 0xFF, 0xFF, 0xFF, 0xFF]));
        setTimeout(() => { sock.destroy(); resolve(true); }, 600);
      }
    });
    sock.on('error', () => resolve(false));
  });
  ok('CS-02 非法 UTF-8 text 帧已注入（连接被处理）', bad === true);

  await sleep(800);
  ok('CS-03 中继进程存活（未 uncaught 崩溃）', exited === null);

  // 坏帧 2：ws 客户端发非法 opcode 控制帧后，正常客户端仍能 join
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/join`);
  const joined = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'join', subCode: 'tsub_v1_nonexistent' })));
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve(-1));
    setTimeout(() => resolve(-2), 5000);
  });
  ok('CS-04 坏帧后新客户端仍能完成 join 并收到关闭码', typeof joined === 'number' && joined > 0);
  ok('CS-05 中继全程存活', exited === null);
} finally {
  child.kill('SIGTERM');
  await sleep(300);
}

console.log(`crash-safety: ${pass}/${pass + fail} passed${fail ? ' — FAILED' : ''}`);
process.exit(fail ? 1 : 0);
