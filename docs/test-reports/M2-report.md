# M2 远程数据通路 — 里程碑测试报告

> 日期：本轮执行 | 执行人：实施者（AI agent）
> 依据：`docs/verification-standard.md` §3.2 | 计划书 WBS-M2-A～F

## 1. 结论

**M2 全部 6 项 WBS 完成；自动化验证全绿**（协议套件 13/13、M1 回归 13/13、
真实应用端到端 6/6）。浏览器手动用例（TC-M2-01～05）待需求方在内网环境
执行。期间发现并修复一个 P0 级构建缺陷（webpack 打包 ws 导致事件循环
死锁，详见 §4）。

## 2. 交付内容

| 任务 | 文件 | 状态 |
|------|------|------|
| WBS-M2-A WS 协议 | `src/shared/wsProtocol.ts`（消息信封 + 严格解析 + 错误码 4001–4004） | ✅ |
| WBS-M2-B RemoteServer | `src/main/remoteServer.ts`（HTTP 静态 + /ws + 心跳 + 慢客户端切断 + 路径穿越防护）；`main.ts` 接线（`TERNIMAL_PORT/HOST` 环境覆盖） | ✅ |
| WBS-M2-C WebSocketTransport | `src/renderer/transport/webSocketTransport.ts`（指数退避重连 1s→30s、重连自动重 attach、认证错误跳登录页） | ✅ |
| WBS-M2-D Web 入口 | `src/web/index.ts` + `index.html`（CSP 含 `connect-src ws: wss:`、移动端 viewport） | ✅ |
| WBS-M2-E 双入口构建 | `webpack.web.config.js` → `dist/web/{index.html,web.js,style.css,xterm.css}` | ✅ |
| WBS-M2-F attach 重放 | 假宿主套件 + 真实 e2e 双重验证（第二客户端 attach 拿到历史输出） | ✅ |
| D8 脚本 | `scripts/verify-ws-protocol.mjs`（含 RFC6455 裸帧客户端、掩码帧构造）+ `npm run verify:m2`；`scripts/smoke-e2e.mjs` 真实链路冒烟；`scripts/lib/fake-pty-host.mjs` 共享库 | ✅ |

## 3. 自动化验证结果

```
$ npm run verify:m2
ws-protocol: 13/13 passed
  （bootstrap/create+attach+replay/input 门禁/resize 钳制/NO_SESSION/
    畸形帧断链/超大帧/exit+tabs/心跳终止/停滞客户端切断/静态服务+穿越防护）
  SKIPPED(M3)×2：未认证拒握手、登录限速 —— M3 落地后补齐（滚动交付）

$ npm run verify:m1   （回归）
ringbuffer: 6/6 passed   registry: 7/7 passed

$ node scripts/smoke-e2e.mjs   （真实 Electron + 真 bash + 真 WS）
  PASS  real app launched, /health=200
  PASS  ws connect; 1 existing tab（本地窗口的会话可见 = 共享标签模型生效）
  PASS  created real session (pid 真实)
  PASS  input→PTY→bash→output roundtrip over WS
  PASS  second client got ring-buffer replay (M2-F)
  PASS  session closed cleanly
```

## 4. P0 缺陷记录：webpack 打包 ws 致事件循环死锁

**症状**：应用（及隔离复现）在 WS 客户端 create 会话后立即整体冻结——
健康检查超时、后续入站消息永不处理；主线程 0% CPU、内核态阻塞在
`poll(pipe)`；SIGTERM 无效（需 SIGKILL）。

**排查路径**（全程可复现、逐步二分）：

1. 纯 node + 真 node-pty + tsc 产物 registry → 正常（排除 node-pty/注册表）
2. `--disable-gpu` → 仍冻结（排除 WebGL）
3. 无渲染进程（`TERNIMAL_HEADLESS_TEST`）→ 仍冻结（排除渲染端/IPC）
4. 关标题轮询 → 仍冻结（排除 pty.process getter）
5. 纯 node + 真 RemoteServer + tsc 产物 → 正常（排除业务逻辑）
6. 纯 node + **webpack 产物** → **冻结复现**（Electron 完全出局）
7. 同一 bundle 仅把 `ws` 改 external → **恢复正常**

**结论**：`ws` 被打进 bundle 后，首次出站广播（tabs）即触发其内部状态
机死锁。**修复：`webpack.main.config.js` 将 `ws` 与 `node-pty` 同列为
external**。技术方案书 §4 已同步更正。

**经验教训**（写入排查工具箱）：
- 排除法每步必须单变量，且**每次实验前彻底清杀旧进程**（冻结的
  Chromium 进程会无视 SIGTERM 赖着端口，本轮两次被陈旧进程误导）
- `pkill -f` 模式会自匹配执行中的 shell 命令行，用 `[x]` 括号技巧或
  脚本文件规避
- node 输出到管道/文件是块缓冲，诊断输出务必走 stderr 或落盘

## 5. 与方案书的偏差

1. `ws` 由"随 bundle 打入"改为 **external**（§4 已更正，见上）。
2. RemoteServer 在客户端连接时主动推送初始 tabs 快照（零延迟引导），
   `list` 请求仍受支持——协议的超集，向后兼容。
3. 慢客户端切断在心跳扫描中兜底执行（不只依赖发送前检查），测试
   注入 2KB 阈值验证。
4. 调试钩子以环境变量保留：`TERNIMAL_DEBUG`（协议/出生日志）、
   `TERNIMAL_HEADLESS_TEST`（无窗口起服务）、`scripts/grab-stack.mjs`
   （inspector 取栈工具）。

## 6. 待需求方执行的手动用例

- [ ] TC-M2-01 浏览器中途接入，重放 Claude Code 历史 TUI 输出
- [ ] TC-M2-02 远程输入、本地同步可见（共享标签）
- [ ] TC-M2-03 远程新建/关闭标签，本地标签栏实时同步
- [ ] TC-M2-04 双端 resize（最后操作者生效）
- [ ] TC-M2-05 远程附着中本地关标签
- [ ] 手机浏览器（同 Wi-Fi）打开 `http://<主机IP>:8443` 冒烟

执行方式：`npm run dev` 启动（日志打印服务地址），同一内网设备访问。

## 7. 缺陷清单

无未修复 P0/P1。P2 一项：`dist/web` 尚无登录页/样式微调（M3 交付内容）。
