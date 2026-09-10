# R-M3 阶段记录 — web 客户端中继模式（自动化子集全绿）

- 日期：本轮实施（实施者：agent，待需求方复核）
- 对应判据：`docs/relay-verification-standard.md` §3.3（TC-R3-01~07）
- 状态：**WBS-R3-A/B/C 全部实现；自动化子集（E2E-09/10/11）全绿；真浏览器/真公网用例待人工**

## 实现

| 工作包 | 内容 | 关键点 |
|--------|------|--------|
| WBS-R3-B | `WebSocketTransport` 增加中继模式（`opts.relay={subCode,token}`）：onopen 背靠背发送 join + auth 首帧，`auth-ok` 后冲放 outbox 并 re-attach | LAN 模式构造签名不变（零回归，reconnect 套件 8/8 佐证） |
| WBS-R3-C | 重连状态机：致命 close 码（4001/4002/4003/4004/4005）**停止重试**并进入 gate 终态；瞬断沿用 1s→30s 退避并重走 join+auth | `FATAL_CLOSE_CODES` 表；onclose 双形状归一（浏览器 CloseEvent vs ws 包回调参数） |
| WBS-R3-A | web bundle 双宿主启动：boot 探测 `/health`（relay 返回 JSON `service:'trelay'`，RemoteServer 返回纯文本）→ relay 模式走 gate：`#S=/#T=` 片段零配置（TC-R3-01）或子码+令牌手动卡片（TC-R3-02）；denied/revoked 回卡片显示原因（TC-R3-03 不白屏不挂起）；闪断显示顶部横幅不打断终端 | relay `/health` 增加 `service` 标记（附加字段，不破坏既有断言） |

## 自动化验证（verify-relay-e2e 新增，套件 11/11 × 3 连跑）

| 用例 | 覆盖 | 断言 |
|------|------|------|
| E2E-09 | TC-R3-01 子集 | 真实 transport（ws 包注入）join+auth 背靠背 → gate connecting→ready → listTabs/createTab/attach/input 回显 |
| E2E-10 | TC-R3-03 子集 | 坏子码 → 4001 → gate=denied，2.5s 内无重连（不锤 relay），绝不 ready |
| E2E-11 | TC-R3-05 子集 | relay 侧切断管道（子码仍有效）→ 1s 退避自动重连 → 重走 join+auth → re-attach replay **补齐断线期输出**（另一客户端在断线期驱动 PTY 产生 ring buffer 数据） |

## 本轮发现并修复的产品缺陷（R-M2 代码，先核实根因再改，未动已通过语义）

1. **relay /join 同段帧丢失**：firstFrameGuard 消费首帧后才挂早期帧监听——join 与 auth
   同一 TCP 段到达时第二帧 message 事件在监听挂载前发射而丢失。既有用例均带
   150ms sleep 掩盖了该路径。修复：重构为单一 message 监听器（首帧=join，
   其后全进早期缓冲）。
2. **插件侧早期帧竞态**：relay 收到 pipe 帧后立即冲放 join 期缓存首帧，而插件
   本机 TLS 握手可能未完成——消息到达时 splice 监听未挂 → 静默丢失 → host 侧
   auth timeout。修复：插件 dialPipe 即挂 relayWs 早期缓冲（≤64KB），splice 后
   按序冲放。

## 回归

`tsc --noEmit` 通过；全量构建通过；`verify-relay-e2e` **11/11**（3 连跑稳定）；
`verify-relay` 14/14；`npm run verify` 伞全绿（6/8/13/**18**/8 + softkeys，含
reconnect 8/8 —— LAN 模式 transport 零回归）；真浏览器 e2e **21/21**（LAN web
路径含 /health 探测不回归）；smoke-e2e **13 ALL PASS**（R2H 场景不受
relay/插件改动影响）。

## 待人工（R-M3 验收门剩余）

- TC-R3-01：真浏览器经 relay 静态托管页面 + 分享链接零配置直达（relay 需
  `--insecure`/静态目录指向 dist/web 启动）；
- TC-R3-02/03：手动输入兜底与错误提示的视觉确认；
- TC-R3-04：手机蜂窝网络真公网（须 relay 部署公网 + Caddy TLS）；
- TC-R3-06：本地窗口+中继客户端同时在线的标签同步（逻辑上经 E2E-11 的双客户端
  间接覆盖，仍需真机确认）；TC-R3-07：子码吊销后的浏览器端提示。
