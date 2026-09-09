// grab-stack.mjs — attach to the Electron main inspector, pause, print stacks
import WebSocket from 'ws';

const target = process.argv[2] || 'ws://127.0.0.1:9229/node';
const ws = new WebSocket(target);

ws.on('open', () => {
  send('Debugger.enable', {});
  setTimeout(() => send('Debugger.pause', {}), 200);
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method === 'Debugger.paused') {
    console.error('=== PAUSED — main thread stack ===');
    for (const frame of msg.params.callFrames) {
      const fn = frame.functionName || '(anonymous)';
      const loc = frame.location;
      console.error(`  ${fn} @ script:${loc?.scriptId}:${loc?.lineNumber}:${loc?.columnNumber}`);
      const scopes = frame.scopeChain?.map((s) => s.type).join(',');
      if (scopes) console.error(`      scopes: ${scopes}`);
    }
    console.error('=== reason:', msg.params.reason, '===');
    process.exit(0);
  }
});
ws.on('error', (e) => {
  console.error('inspector error:', e.message);
  process.exit(1);
});

function send(method, params) {
  ws.send(JSON.stringify({ id: Math.random(), method, params }));
}
setTimeout(() => {
  console.error('no pause within 8s');
  process.exit(2);
}, 8000);
