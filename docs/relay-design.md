# Ternimal 中继服务器（Relay）— 技术方案书

> 版本：v0.2（讨论稿 · 开放问题已决议）
> 上游文档：`docs/technical-design.md`（主体技术方案）
> 配套文档：`docs/relay-plan.md`（行动计划书）、`docs/relay-verification-standard.md`（验收标准）
> 状态：四项关键决策（§0.2）与五项开放问题决议（§8）已拟定，待审查通过后进入 R-M1

## 0. 需求与决策记录

### 0.1 需求

1. 内网机器运行 Ternimal（PTY 宿主），中继服务器部署于公网 VPS；
2. 外网用户通过中继访问内网终端；
3. 内网侧软件中配置 **中继地址 + 访问授权码** 即可启用；
4. 中继授权码与 Ternimal Token 为**两套独立凭证**；
5. 中继功能以**插件**形态存在，关闭后自动卸载，保证内网零暴露、零驻留；
6. 浏览器端用户**粘贴一个 URL 即可远程**，不做任何手动配置。

### 0.2 关键决策（已确认）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 部署形态 | v1 单节点自用/内测，但**按未来公开服务的形状切接口**（见 §3.6） |
| D2 | 配置侧 | 仅内网主机侧配置；外网用浏览器访问（Electron 客户端走中继留作未来，协议已兼容） |
| D3 | 插件隔离 | Electron **utilityProcess 子进程**，kill 即净，OS 级卸载保证 |
| D4 | 授权码模型 | **主码（host 凭证）+ 可吊销子码（client 凭证）**；浏览器侧用分享链接零配置 |

## 1. 总体架构

### 1.1 拓扑

```
        公网 VPS                       内网主机                          外网客户端
┌────────────────────┐            ┌──────────────────────────┐      ┌──────────────┐
│  RelayServer       │   出站WSS   │  Ternimal 主进程          │      │   浏览器      │
│  (Node.js + ws)    │◄───────────┤   ├─ SessionRegistry     │      │  (web bundle)│
│                    │  ①控制通道   │   ├─ RemoteServer        │      └──────┬───────┘
│  控制面：register/  │            │   │   （绑 127.0.0.1）    │             │ WSS
│  join/offer/管理API │◄───────────┤   └─ PluginHost          │             │ ③join+子码
│  数据面：纯字节管道  │  ②每客户端  │      └─ RelayPlugin      │◄────────────┘
│  （不解析内层协议）  │   一条管道  │         (utilityProcess) │   分享链接直达
└────────────────────┘            └──────────────────────────┘
        │                                        ▲
        │  ④子码签发/吊销（管理API，主码鉴权）        │ loopback WSS + 证书指纹钉扎
        └────────────────────────────────────────┘
```

### 1.2 核心思想

- **哑管道**：relay 与插件只转发 WebSocket 帧，**不解析 `wsProtocol`**。会话逻辑完全
  复用现有 `RemoteServer` + `AuthManager` + ring buffer 重放 + 心跳 + 慢客户端策略。
  性能（每帧 O(1)、零 JSON 解析）与安全（relay 不可见会话语义）同源于此。
- **双轨鉴权**：授权码在 **relay** 校验（运输准入），Token 端到端在 **host** 校验
  （会话准入）。两套凭证、两个校验点、互不相识。
- **全出站**：内网机器启用中继后唯一网络行为是到 relay 的**出站** 443 连接，
  无任何监听端口暴露于内网。

## 2. 凭证与鉴权模型

### 2.1 三种凭证

| 凭证 | 谁签发 | 谁校验 | 生命周期 | 用途 |
|------|--------|--------|----------|------|
| **主码**（master code） | relay CLI 签发（§8-Q1；未来账户系统） | relay | 长期，可轮换 | host 登记通道 + 签发/吊销子码 |
| **子码**（sub-code） | host 应用经管理 API 生成 | relay | 短期（默认 6h，可配置；管理页可续期 +1天/+7天/转长期） | 客户端接入通道（join） |
| **Ternimal Token** | host 每次启动随机生成（现有 `AuthManager`） | host（端到端，穿管道） | 每次启动轮换 | 会话准入（现有语义不变） |

码格式：`trelay_v1_<base64url(24B)>`（带版本前缀，为未来账户体系预留可解析的
租户段演进空间）。

存储与比对（§8-Q1）：relay 配置中**只存主码 SHA-256 哈希**——24 字节高熵
随机数无需加盐（GitHub/Stripe 等存 API key 哈希的同款惯例），比对一律
`crypto.timingSafeEqual`（常数时间，防时序侧信道）；CLI 签发时明文仅显示
一次，离屏即不可再取。

### 2.2 分享链接 UX（浏览器零配置的来源）

host 侧配置一次 `中继地址 + 主码` 后，设置面板/tray 提供「生成分享链接」：

```
https://relay.example.com/#S=<子码>&T=<启动Token>
```

- 片段（`#` 后）不会出现在服务器日志，页面 JS 读取后经 WS 首帧发送；
- 与现有 LAN URL `https://host:port/#T=<token>` 哲学一致，tray 二维码复用同一
  展示面（中继启用时切换为分享链接）；
- 链接即凭证束：子码（短期/可吊销）+ Token（每次启动轮换）双重时效；
  给朋友的链接过期自动失效，换码/重启均不惊动 host 配置。

### 2.3 v2 升级路径（架构不变，仅协议首帧演进）

- **挑战应答**：host 经管道发 nonce，客户端回 `HMAC-SHA256(token, nonce)`
  （R-M4-A 已实现，E2E-12 全绿；nonce 单次有效/每连接不同/重放拒）
- **E2E 加密（R-M4-B 已实现，E2E-13 全绿）**：会话密钥
  `HKDF-SHA256(ikm=token, salt=nonce, info='ternimal-relay-e2e-v1')` →
  AES-256-GCM；协商 = auth-response 附 `enc:1`（能力宣告），host 决定启用则
  auth-ok 附 `enc:1`，此后双向业务帧封装 `{type:'secure', iv, ct}`（AEAD，
  IV 每帧随机 96-bit）；控制面（challenge/response/auth-ok）保持明文。
  开关：RemoteServer `relayE2EE`（env `TERNIMAL_RELAY_E2EE=1`，默认关 →
  行为与 R-M4-A 完全一致，零回归）。实现要点：双方 per-connection
  Promise 发送链保证 seal 完成顺序 = 线路顺序；加密连接上错误帧同样 seal
  且 close 排在 seal 之后（同步 close 会吞掉错误帧）；Token 不出
  AuthManager（`deriveRelaySessionKey(nonce)`）。
  （浏览器 WebCrypto）。Token 从此永不明文经过 relay。
- **端到端加密**：`AES-GCM`，密钥 `HKDF(token, nonce)` 派生，relay 对会话内容
  彻底盲。公开服务上线前**必做**（信任模型从"自建 VPS"变为"第三方运维"）。

## 3. 中继服务器设计（`relay/`，独立部署）

### 3.1 进程模型：控制面与数据面分离

同一 Node 进程内两个逻辑面（未来可拆分部署，扩展点见 §3.6）：

- **控制面**（HTTPS + WSS `/control`）：register / offer / 子码管理 API。
  有状态、需鉴权、可限流。
- **数据面**（WSS `/join`、`/pipe`）：管道 splice，无业务语义、高吞吐。

### 3.2 线上协议

```
host → relay  WSS /control:
  → {v:1, type:'register', masterCode}
  ← {type:'registered', channelId}           或 {type:'error', code:'BAD_CODE'|'CHANNEL_TAKEN'}

client → relay  WSS /join:
  → {v:1, type:'join', subCode}              ← 验证子码→归属通道→挂起等待(10s超时)
  （一旦对接成功，后续所有帧【原样透传】给 host 的管道，relay 不再解析）

relay → host  （控制通道）:
  ← {type:'client-offer', clientId}

host → relay  WSS /pipe（每客户端一条新连接，全出站）:
  → {type:'pipe', masterCode, clientId}      ← relay 将 client ws ↔ pipe ws splice
```

### 3.3 子码管理 API（HTTPS，主码鉴权）

> 默认 TTL = `limits.subcodeTtlHours`（6 小时）。管理页可为任一子码续期：
> `POST /api/channels/subcodes/:id/renew`（管理会话或属主主码），`{days:N}` 自当前
> 到期顺延（已过期则从当下复活）或 `{permanent:true}` 转长期（`expiresAt=null`，
> join/pump 校验对 null 放行）。吊销为终态，不可续期。

```
POST   /api/channels/subcodes      {ttlHours?, label?}   → {subCode, id, expiresAt}
GET    /api/channels/subcodes                             → 列表（含调用/流量统计）
DELETE /api/channels/subcodes/:id                        → 吊销
```

管理 UI 位于 **host 应用的设置面板**（不另做 relay dashboard；公开服务阶段再在
同一 API 上加 Web 控制台）。

### 3.4 性能设计

终端流量特征：小帧、低吞吐、延迟敏感（击键回显），偶发突发（1MB replay、cat 大文件）。

- 转发路径 **零 JSON 解析、零字符串转换**（Buffer 直通），每帧 O(1)；
  Node 单进程数千对管道无压力，v1 目标规模（个人/小团队）绰绰有余；
- **背压**：监控 `ws.bufferedAmount`，超 1MB 终止该管道（客户端可重连，
  ring buffer 重放兜底）——与现有 `SLOW_CLIENT_BYTES` 杀慢客户端哲学一致；
- 帧上限 1MB，与 `WS.MAX_MESSAGE_BYTES` 对齐；心跳 30s ping/pong（复用现有间隔）；
- **重连**：控制通道断开后指数退避 + 抖动（1s→30s 封顶）重注册；同主码重复
  register 视为接管（旧管道全部收割）；
- 新增延迟 = relay 一跳 RTT（同国 VPS 约 10–40ms），终端场景完全可用。

### 3.5 滥用防护（day-one）

- 控制面限速：register/join/管理API 按 IP + 按码双重限流；
- 每通道并发管道上限（默认 4）、每码连接/重连频率上限；
- 全程字节计数（背压本来就要数），落配额计数器（未来计费钩子的数据源）。

默认参数（§8-Q2 决议，均可经 relay 配置覆盖）：

| 参数 | 默认值 | 可调范围 / 说明 |
|------|--------|-----------------|
| 子码 TTL | 24h | 签发时 1h–7d |
| 每通道并发管道 | 4 | 1–16 |
| join 挂起等待 | 10s | 固定（host 拨管道的窗口期） |
| 单 IP register/join 失败限速 | 5 次/分 → 锁 1 分钟 | 对齐 `AuthManager` 现有语义 |
| 单管道背压上限 | 1MB（bufferedAmount） | 对齐 `WS.MAX_MESSAGE_BYTES` |

### 3.6 公开服务演进路径（v1 埋点，不推倒重来）

| 维度 | v1 | 未来 | v1 埋点 |
|------|----|------|---------|
| 租户 | 单租户，配置文件管主码 | 账户注册、每户多主机 | 码格式带版本前缀；register/join 角色分离（账户体系只换查表逻辑，协议不改） |
| 状态 | 进程内存 | 多节点水平扩展 | 状态收进 **`ChannelStore` 接口**（内存实现 → Redis 实现）；通道粘滞：channelId→节点 路由表 |
| 部署 | 单进程 | 控制面/数据面分别伸缩 | 两面从第一天就按独立模块切 |
| 配额 | 连接数上限 | 带宽/时长/计费 | 字节计数器 + 限额检查点 |
| 信任 | 自建 VPS 可信 | relay 为第三方，必须盲 | §2.3 E2E 协议位预留 |

### 3.7 生产部署与 TLS（§8-Q4 决议）

- **生产**：**Caddy 反向代理前置**（自动 Let's Encrypt 签发与续期，WebSocket
  原生透传，长连接无默认超时坑），relay 自身只监听 `127.0.0.1:<port>` 明文
  ——TLS 边界即攻击面边界，Node 进程不碰证书与私钥；
- **限流取真实 IP**：relay 需显式配置 `trustedProxy` 后才采信
  `X-Forwarded-For`（仅信任来自 `127.0.0.1` 的代理头，防伪造绕过限速）；
- **开发/验证**：`--insecure` 明文直连模式（`verify-relay.mjs` 使用），代码
  路径与生产一致，仅跳过 TLS 层。

选型依据：TLS 生命周期免运维是公网服务的长期成本大头，Caddy 将其归零；
Nginx 需手写 WS upgrade 头且默认 60s `proxy_read_timeout` 是长连接常见坑；
Node 内嵌 ACME（greenlock 等）则把证书逻辑引入应用进程，得不偿失。

### 3.8 容量评估（以 3MB/s 上行中继为例）

关键区分：**在线 ≠ 活跃**。空闲会话仅 30s 一次心跳（<0.1 B/s），在线数受
内存/CPU 限制（Node 单进程万级 WS 无压力），**同时活跃数才受带宽约束**。
中继为哑管道，转发的是已封装 WS 帧，JSON 转义（`\x1b`→`\u001b` 等）使终端
输出典型膨胀 ~1.5 倍，需计入：

| 活跃档 | 场景 | 线上速率（含开销） | 3MB/s 可支持 |
|--------|------|--------------------|--------------|
| 日常交互 | 敲命令、回显 | ~1.5 KB/s | ~2000 |
| 中度 | `tail -f`、htop | ~10–15 KB/s | ~200–300 |
| 重度 | 构建日志狂滚 | ~100–150 KB/s | ~20–30 |
| 病态 | `cat` 大文件、`yes` | MB/s 级 | 1–3 即占满 |

混合负载（80% 交互 + 15% 中度 + 5% 重度）≈ 9 KB/s/会话 → **~330 个同时
活跃会话**；对个人/小团队目标场景余量 10 倍以上。

边界因素：

- **attach 重放突发**：每客户端接入最多 1MB 快照，30 人同时接入 = 占满
  链路 ~10s，属可接受瞬时突发；
- **web bundle 冷加载** ~0.5–1MB/次，≈ 3–6 次/秒新页面加载；
- **Node 非瓶颈**：哑管道 3MB/s 远低于单核 ws 转发能力（10–50MB/s 量级）；
- **实际并发 = min(relay 上行, host 上行, 客户端下行)**——家庭宽带 host
  上行（1–5MB/s）常为真实短板；
- **公平性改进项（v1.1）**：链路整体拥塞时 1MB bufferedAmount 杀管道会误杀
  受害者，建议 §3.5 参数表增加每管道令牌桶限速（默认 ~256 KB/s），
  封顶单会话病态流量。

## 4. Ternimal 侧插件设计

### 4.1 PluginHost 与生命周期

```ts
// src/main/plugins/pluginHost.ts（新增）
export interface TernimalPlugin {
  id: string;
  activate(ctx: PluginContext): Promise<void>;   // spawn 子进程、接 IPC
  deactivate(): Promise<void>;                   // kill 子进程（超时强杀）
}
```

- **隔离**：插件逻辑全部运行于 Electron `utilityProcess` 子进程
  （`fork(dist/plugins/relayPlugin.js)` + `MessageChannelMain` IPC）；
  主进程只收发消息，永不加载插件代码。
- **卸载语义三层**：socket 清理 + 代码卸载由 **kill 进程**一次达成（OS 保证，
  定时器/回调/引用随地址空间消失）；可选「退出时清除主码」覆盖凭据层；
  主进程退出时 utilityProcess 自动跟随死亡（另挂 will-quit 兜底）。
- **崩溃/断线**：子进程 exit / 控制通道断开 → 上报主进程 → tray 状态置灰 →
  指数退避自动重启重连。

### 4.2 RelayPlugin（子进程内）：纯管道

职责仅三件事，无任何业务逻辑：

1. **控制通道**：拨 relay、register、接收 client-offer；
2. **管道对接**：收到 offer → 出站拨 relay `/pipe` + 同时拨本机
   `wss://127.0.0.1:<port>`（**证书指纹钉扎**；自签证书 SAN 已内置
   `127.0.0.1`/`::1`，M3 实现即含，无需改动）→ 双向 splice；
3. **管理 API 代理**：为主进程的「生成分享链接」按钮调 relay 子码 API。

每远端客户端 = 一条独立端到端管道（client→relay→plugin→local Server 四段 ws
一一对应），**任何一层都不需要多路复用协议**。

### 4.3 现有代码的最小改动清单（R-M2 已实现状态回写）

| 位置 | 改动 |
|------|------|
| `wsProtocol.ts` | ✔ ~~首帧 `{type:'auth', token}`~~（R-M4-A 起中继路径升级为**挑战应答**：`auth-challenge`/`auth-response`，Token 明文不再过中继；明文 auth 被拒 AUTH_REQUIRED）/ `auth-ok`、错误码 `AUTH_DENIED=4005`、时限 `RELAY_AUTH_TIMEOUT_MS=5s`（LAN cookie 流程不变）。nonce 单次有效 30s TTL、每连接不同，AuthManager 以 HMAC-SHA256+timingSafeEqual 校验，锁定语义与 login() 一致 |
| `AuthManager` | ✔ `relayAuth()`：独立失败键（`__relay__`），语义与 HTTP `login()` 完全一致——第 5 次失败即上锁并 429，锁定期间 loopback upgrade 直接 401 |
| `RemoteServer` | ✔ loopback 无 cookie 路径由 `allowRelayFirstFrameAuth` **显式门控（默认关）**：未启用中继时 M3 语义零回归（TC-M3-04）；认证前零业务流量、无 bootstrap 推送 |
| `certManager` | 无需改动——SAN 已内置 `127.0.0.1`/`::1`（M3 实现即含，调研确认） |
| `configStore` | ✔ `relay: {enabled, url, masterCode, clearMasterCodeOnExit, lanDirect}`（lanDirect = §8-Q3 双开显式开关） |
| relay 侧补充 | 实现期新增：join→splice 间隙的客户端**早期帧缓冲**（≤64KB，auth 首帧不丢）——R-M3 实测发现 join+auth **同一 TCP 段**到达时第二帧会在监听挂载前丢失，/join 已重构为单一 message 监听器；**插件侧同样需要早期帧缓冲**（relay 冲放的首帧可能先于本机 TLS 握手完成），两侧均已实现；管道 teardown 优雅 close（仅背压/心跳丢失硬 terminate，防截断在途错误帧） |
| IPC/设置 UI | 中继设置面板（地址/主码/开关/分享链接生成）+ tray 状态与二维码切换（R-M2 E/F，进行中） |
| 构建 | ✔ CopyPlugin 原样拷贝 `dist/plugins/relayPlugin.mjs`（ws 为运行时 external，无需打包；避免 M2 死锁教训复发） |

### 4.4 启用中继时的网络暴露面

- `RemoteServer` 中继启用时**默认收窄到 `127.0.0.1`**；如需 LAN 直连与中继
  同时可用（§8-Q3 决议：允许双开），设置面板提供显式开关切回 `0.0.0.0`，
  切换时 UI 明确提示内网暴露面变化（fail-secure：默认最小暴露，扩面须显式）；
- 内网机器唯一对外行为：到 relay 的出站 443；
- 插件关闭 = kill 子进程 → **无监听、无连接、无驻留代码**。

## 5. 浏览器端（web bundle 小改）

- relay 直接托管同一份 `dist/web` 静态资源（客户端对任意 relay 通用）；
- 登录页新增中继模式：读取 `#S=<子码>&T=<token>` 片段 → WS 连 relay `/join`
  → 首帧 `{join, subCode}`（运输准入）→ 管道建立后 host 下发 `{auth-challenge,
  nonce}` → 客户端回 `{auth-response, mac=HMAC-SHA256(token, nonce)}`（R-M4-A，
  WebCrypto；Token 明文不再经过中继）→ 之后即现有 `wsProtocol` 全流程；
- 手动模式兜底：两个输入框（子码 + Token），供片段被剥掉的场景。

## 6. 安全分析

| 威胁 | 对策 |
|------|------|
| 内网机器被扫描 | 全出站设计：无监听端口；loopback 绑定 + 指纹钉扎 |
| 插件关闭后残留 | 进程级隔离，kill 即净；主进程退出自动跟随 |
| 主码泄露 | 攻击者最多接管通道/签发子码 → 立刻轮换主码（旧管道全断，子码全失效） |
| 子码/分享链接泄露 | 双重时效：子码 TTL + Token 每次启动轮换；逐个吊销 |
| 撞库/爆破 | relay 控制面 IP+码双重限速；host 侧每连接 auth 失败限速（复用锁语义） |
| relay 被攻陷 | v1 信任模型：TLS 到两端但 relay 运维者理论可见流量（自建 VPS 前提）；公开服务前 E2E 必做（§2.3），届时 relay 只见密文与随机数 |
| DoS | 接受（配额 + 连接上限缓解）；管道断开自动重连 + replay 兜底 |

## 7. 里程碑（沿用仓库 M 编号，接续现有 M1–M4）

> 本章为概览；任务分解见 `relay-plan.md` §3（WBS-R*-*），逐项验收判据见
> `relay-verification-standard.md` §3（TC-R*-**）。

- **R-M1** `relay/` 服务核心：控制/数据面、register/join/offer/pipe、子码 API、
  内存 ChannelStore、限速与配额计数、主码签发 CLI（`relay --add-master`，
  哈希落盘、明文仅显示一次，见 §8-Q1）。验证：`scripts/verify-relay.mjs`
  （假 host + 假 client 走通管道；错码/错 token/背压/超时矩阵）。
- **R-M2** Ternimal 插件宿主 + RelayPlugin（utilityProcess、loopback 管道、
  首帧 auth、loopback 证书 SAN）+ 设置面板 + tray 分享链接/二维码。
  验证：扩展 `scripts/smoke-e2e.mjs`（真实 relay + 真实 Electron 全链路）。
- **R-M3** web 客户端中继模式（`#S=`/`#T=` 片段、双首帧接入）。
- **R-M4** 加固：挑战应答、E2E 加密协议位、重连/背压矩阵、公开服务前 checklist。
  全部纳入 `npm run verify` 伞。
- **未来（公开 beta 后，§8-Q5 决议）**：Electron 客户端走中继——
  `WebSocketTransport` 指向 relay `/join` 并复用 R-M3 的双首帧接入
  （协议零改动，仅新增连接配置入口）。

## 8. 开放问题决议（v0.2 按最佳实践拟定，待审查）

| # | 问题 | 决议 | 依据 |
|---|------|------|------|
| Q1 | 主码签发方式 | relay CLI：`relay --add-master` 生成 `trelay_v1_...`；配置文件**只存 SHA-256 哈希**，明文仅签发时显示一次；比对用 `timingSafeEqual` | 24 字节高熵随机数无需加盐（GitHub/Stripe 存 API key 哈希的同款惯例）；CLI 是 v1 最小可行签发面，账户系统上线后平替为签发 API，线上协议不动 |
| Q2 | 子码 TTL / 通道并发上限 | 子码默认 **24h**（签发时 1h–7d 可调）；每通道并发管道默认 **4**（可配 1–16） | 24h 覆盖"当天分享给自己/同事"主场景，又不至于长期暴露凭据；4 = 本机 + 手机 + 一位访客 + 余量，终端会话极少超过；均入 §3.5 默认参数表 |
| Q3 | LAN 与中继是否双开 | **允许**；中继启用时默认收窄 loopback，双开需在设置面板显式切回 `0.0.0.0` 并提示暴露面变化 | fail-secure：默认最小暴露；便利性一步可达，但绝不悄悄扩面 |
| Q4 | relay 生产 TLS | **Caddy 前置**（自动 Let's Encrypt + WS 原生透传），relay 只听 `127.0.0.1` 明文；`trustedProxy` 显式配置后方采信 `X-Forwarded-For` 限流；`--insecure` 仅供开发验证 | TLS 免运维是公网服务长期成本大头；Nginx 60s read timeout 为长连接常见坑；证书不进 Node 进程缩小攻击面（详见 §3.7） |
| Q5 | Electron 客户端走中继优先级 | **延后至公开 beta 后**；协议已兼容（双首帧接入），仅差连接配置入口 | 浏览器已覆盖外网主场景；避免 R-M1–M4 关键路径发散，R-M3 的 web 端双首帧改动未来天然复用 |

> 五项决议均已回写正文：Q1→§2.1「存储与比对」/ §7-R-M1，Q2→§3.5 默认参数表，
> Q3→§4.4，Q4→§3.7，Q5→§7「未来」。

## 附录：转发帧类型陷阱（验收轮实证）

`ws` 的发送选项名是 **`binary`**（布尔），不是消息事件里的 `isBinary`；
`ws.send(data, { isBinary })` 会被静默忽略。ws 8 中 TEXT 帧到达 message
处理器时载荷已是 Buffer——Buffer 载荷 + 无 binary 选项 → 自动按**二进制帧**
发送。Node 客户端 `toString()` 对 Buffer 照常工作（全部自动化测试被掩盖），
**真浏览器**收到 Blob → JSON 解析静默失败。纯字节管道的任何一跳转发都必须
`dst.send(data, { binary: isBinary })`（server.mjs / relayPlugin.mjs 共 5 处）。
教训：浏览器可达路径必须有真浏览器验收（public-browser-check）。

## 管理页（/admin，计费运维底座）

- **鉴权独立于主码**：管理密码（`cli.mjs set-admin` → scrypt$salt$hash 落盘）→
  内存会话令牌（32B 随机、12h TTL、容量 64）；登录走 byIp 限速（5 次锁 60s）。
  页面/JS 仅在配置 adminHash 后暴露（未配置 → 404）。
- **路由**：`/admin` + `/static/admin.js` 由 handleHttp 直出（no-store）；
  `/api/admin/login`、`/api/admin/overview` 在 API 层；子码三端点
  （GET/POST/DELETE）在主码之外也接受管理会话（GET/DELETE 需 `?channel=`，
  POST 需 body.channelId——管理侧代签/吊销，通道主权仍在主码持有人+管理员二元）。
- **计费底稿**：进程级总账 `totals`（channelId → bytesIn/bytesOut/pipes/joins/
  firstSeen/lastSeen），通道被清理不清零（不丢账）；relay 重启归零——持久化
  CDR/对接计费系统为 v1.1。页面提供通道/子码两级用量、吊销、签发、CSV 导出。
- **攻击面声明**：新增面 = 两个静态资源 + 三个 JSON 端点，全部密码/令牌门禁；
  页面 CSP（self）、无第三方依赖、单文件内联。

## 主码生命周期（收费时效，需求方定义的真实场景）

- **模型**：付费客户 = 一枚带有效期的主码（手动签发/手动吊销/到期自动停止）。
  收款线下完成，运营者在管理页或 CLI 签发；无自助支付面。
- **数据**：`relay-config.json` 的 `masters[]`：
  `{ hash, label, createdAt, expiresAt|null, revoked }`（缺省 expiresAt=null=永久，
  旧 masterHashes 字符串加载时视为永久——存量部署零迁移）。管理 API 变更经
  `persistMasters()` 原子写盘（cli serve 传 configFile）。
- **强制点**：① `verifyMaster` 命中即校验吊销/过期（注册与 API 共用）；
  ② `sweep`（每心跳周期）检查 `ch.masterEntry` → 过期/吊销即
  `killChannelsOfMaster`（管道+挂起+控制全清）——「到期自动停止」的执行器；
  ③ 吊销 API 同步调用同一执行器（立即生效）。
- **恢复语义**：续期（renew）同时解除吊销态；客户侧插件退避重连无需干预，
  续期后自动恢复注册（B-04）。到期/吊销期间客户端见 HOST_OFFLINE 语义退避，
  不误报致命。
- **管理面**：`/admin` 主码区块（状态/到期/剩余/+7/+30 续期/吊销/签发明文仅
  一次）；CLI `add-master --days --label / list-masters / renew-master /
  revoke-master`。明文永不落盘（仅签发响应一次性返回）。
- **验证**：verify-relay-admin B-01~05（签发注册/到期自停不殃及/吊销即停/
  续期恢复/legacy 兼容）。
