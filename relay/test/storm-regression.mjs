// 新增回归：宿主终局性关闭码必须透传（风暴修复验证）
// 场景：宿主以 4005/4002 关闭管道 → 中继必须以 4001/4002 关闭客户端
// （客户端 FATAL_CLOSE_CODES 命中 → 停止重连），而非 1000。
import { RelayServer } from '../src/server.mjs';
import { sha256Hex } from '../src/protocol.mjs';
import WebSocket from 'ws';

const PORT = 18901;
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };

const server = new RelayServer({ port: PORT, host: '127.0.0.1', log: false, config: { masterHashes: [sha256Hex('trelay_v1_testhost')], limits: {} } });
await server.start();

// 宿主控制连接注册
const ctrl = new WebSocket(`ws://127.0.0.1:${PORT}/control`);
await new Promise(r => ctrl.on('open', r));
ctrl.send(JSON.stringify({ v: 1, proto: 2, type: 'register', masterCode: 'trelay_v1_testhost' }));
const chId = await new Promise(r => ctrl.once('message', d => r(JSON.parse(d).channelId)));

// 发一个子码（管理路径太重——直接用 store）
const sc = server.store.issueSubCode(chId, { ttlHours: 1, label: 't' });

async function attempt(hostCloseCode) {
  return new Promise((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${PORT}/join`);
    // 宿主：等控制连接上的 client-offer → 拨 /pipe
    const onOffer = (d) => {
      const { clientId } = JSON.parse(d);
      if (clientId === undefined) return;
      const host = new WebSocket(`ws://127.0.0.1:${PORT}/pipe`);
      host.on('open', () => host.send(JSON.stringify({ type: 'pipe', masterCode: 'trelay_v1_testhost', clientId })));
      // 拼接成功的标志：收到客户端任意帧（客户端会发 auth 首帧吗？不会——
      // 直接触发：splice 后中继冲放 early；无 early 时用 open 定时器兜底）
      host.on('message', () => { try { host.close(hostCloseCode, 'host says no'); } catch {} });
      setTimeout(() => { try { host.close(hostCloseCode, 'host says no'); } catch {} }, 800);
    };
    ctrl.once('message', onOffer);
    client.on('open', () => client.send(JSON.stringify({ type: 'join', subCode: sc.code })));
    // 客户端发一帧（成为 early 缓冲，拼接后冲给宿主——同时保证管道有流量路径）
    setTimeout(() => { try { client.send('x'); } catch {} }, 150);
    client.on('close', (code, reason) => {
      console.log('  [dbg] client close code=', code, 'reason=', String(reason));
      resolve(code);
    });
    setTimeout(() => resolve(-1), 5000);
  });
}

const code = await attempt(4005);
t('host 4005 AUTH_DENIED → client 4001 (fatal passthrough)', code === 4001);

const code2 = await attempt(4002);
t('host 4002 RATE_LIMITED → client 4002 (fatal passthrough)', code2 === 4002);

// P1 决策表补全回归：
const code4001 = await attempt(4001);
t('host 4001 AUTH_REQUIRED → client 4001 (fatal: client defect, no retry)', code4001 === 4001);
const code4003 = await attempt(4003);
t('host 4003 NO_SESSION → client 1000 (transient by design: reconnect heals)', code4003 === 1000);
const code4004 = await attempt(4004);
t('host 4004 BAD_MESSAGE → client 1000 (transient by design: self-limiting)', code4004 === 1000);

await server.stop();
console.log(`storm-regression: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
