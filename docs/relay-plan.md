# Ternimal 中继服务器（Relay）— 行动计划书

> 版本：v1.0
> 上游文档：`docs/relay-design.md`（技术方案书 v0.2）
> 配套文档：`docs/relay-verification-standard.md`（验收标准）
> 用途：将技术方案书 §7 的 R-M1–R-M4 里程碑展开为可执行、可验收的行动计划。

## 1. 项目概述

### 1.1 目标

为 Ternimal 增加公网中继接入能力：内网主机通过插件（utilityProcess）出站
连接自建中继服务器，外网浏览器**粘贴分享链接即达终端**；中继授权码（主码/
子码）与 Ternimal Token 双轨独立；插件关闭即进程级卸载，内网零暴露、零驻留。

### 1.2 范围

**范围内**（对应技术方案书 §7 R-M1–R-M4）：

- `relay/` 独立中继服务：控制面/数据面、register/join/offer/pipe 协议、
  子码管理 API、主码签发 CLI、限速与配额计数、内存 ChannelStore
- Ternimal 侧 PluginHost + RelayPlugin（utilityProcess 隔离、loopback 管道、
  首帧 auth、证书 SAN 127.0.0.1）
- 设置面板（中继开关/地址/主码/双开切换）+ tray 分享链接与二维码
- web 客户端中继模式（`#S=`/`#T=` 片段零配置接入）
- 加固：挑战应答（Token 不明文过 relay）、E2E 加密协议位、重连/背压矩阵

**范围外**（明确不做，留二期）：多租户账户体系、Redis 多节点扩展、计费、
Electron 客户端走中继（协议已兼容，公开 beta 后）、每管道令牌桶限速
（v1.1 改进项，见技术方案书 §3.8）、WebRTC P2P 直连。

### 1.3 约束与前提

- 基线为 `relay-design.md` v0.2 全部决议（§0.2 四项决策 + §8 五项开放问题决议）
- `ws` 必须保持 webpack external（M2 既有教训，主进程死锁）；插件 bundle 同样处理
- 中继部署目标为 3MB/s 上行 VPS（容量模型见技术方案书 §3.8，余量 10 倍以上）
- 本地 Electron 与现有 LAN 远程体验**零回归**（回归基线 = 验证标准文档 §6）
- 无测试框架，沿用"自动化验证脚本 + 手动用例"组合（与主项目一致）

## 2. 交付物清单

| 编号 | 交付物 | 形态 | 所属里程碑 |
|------|--------|------|-----------|
| D-R1 | relay 服务核心（控制面/数据面/管道 splice/ChannelStore） | `relay/src/` 源码 | R-M1 |
| D-R2 | 主码签发 CLI（哈希落盘、明文仅显示一次） | `relay/cli.mjs` | R-M1 |
| D-R3 | 子码管理 API（签发/TTL/吊销/统计） | relay 源码 | R-M1 |
| D-R4 | relay 自动化验证脚本 | `scripts/verify-relay.mjs` | R-M1 |
| D-R5 | Caddy 部署示例（含 WS 透传与 trustedProxy 说明） | `relay/Caddyfile` + `relay/README.md` | R-M1 |
| D-R6 | PluginHost + RelayPlugin（utilityProcess） | `src/main/plugins/` + `dist/plugins/relayPlugin.js` | R-M2 |
| D-R7 | 现有模块扩展（首帧 auth / loopback / SAN 127.0.0.1） | `wsProtocol.ts`/`remoteServer.ts`/`authManager.ts`/`certManager.ts` | R-M2 |
| D-R8 | 设置面板（中继配置/双开切换/子码管理）+ tray 扩展 | renderer 源码 + `tray.ts` | R-M2 |
| D-R9 | 全链路冒烟脚本扩展 | `scripts/smoke-e2e.mjs` | R-M2 |
| D-R10 | web 客户端中继模式（片段读取/双首帧接入/重连适配） | `src/web/` 源码 | R-M3 |
| D-R11 | 挑战应答 + E2E 加密协议位 | shared/main/web 源码 | R-M4 |
| D-R12 | 验证脚本套件入 `npm run verify` 伞 | `package.json` | R-M4 |
| D-R13 | 文档（方案书 v0.2 已交付 + 本计划书 + 验收标准） | `docs/` | 滚动维护 |

## 3. 工作分解结构（WBS）

### R-M1 relay 服务核心（预计 3–4 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-R1-A | 服务骨架：控制面/数据面模块切分、配置加载、`ChannelStore` 接口 + 内存实现 | 源码 |
| WBS-R1-B | 主码签发 CLI：`relay --add-master`，SHA-256 落盘、明文仅显示一次、`timingSafeEqual` 比对 | D-R2 + TC-R1-01 |
| WBS-R1-C | 控制通道：register/offer、同主码重复注册接管（旧管道收割）、心跳（30s ping/两周期无 pong 收割） | 源码 |
| WBS-R1-D | 数据面：join（子码验证 + 10s 挂起等待）、pipe（splice 零解析双向转发） | 源码 |
| WBS-R1-E | 子码管理 API：签发（TTL 默认 24h，1h–7d）/列表（含流量统计）/吊销 | D-R3 + TC-R1-09 |
| WBS-R1-F | 滥用防护：IP+码双重限速（5 次/分→锁 1 分）、每通道并发管道上限 4、单管道背压 1MB 终止、全程字节计数 | 源码 |
| WBS-R1-G | 静态托管 web bundle、`--insecure` 开发模式、`trustedProxy`/X-Forwarded-For 采信 | D-R5 |
| WBS-R1-H | `verify-relay.mjs`：假 host + 假 client 管道贯通；错码/超时/接管/背压/并发上限矩阵 | D-R4 + R-M1 验收门 |

### R-M2 Ternimal 插件宿主与接入（预计 4–5 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-R2-A | PluginHost：utilityProcess fork/kill、MessageChannelMain IPC、deactivate 超时强杀、will-quit 兜底、崩溃自动重启 | 源码 + TC-R2-04/07 |
| WBS-R2-B | RelayPlugin 子进程：控制通道维持、client-offer→出站拨 pipe、loopback WSS 拨号（证书指纹钉扎）、双向 splice | D-R6 |
| WBS-R2-C | `wsProtocol` 首帧 auth 三消息 + `AuthManager` per-connection 校验与每连接失败限速 | D-R7 + TC-R2-09 |
| WBS-R2-D | `RemoteServer` loopback 模式（无 cookie + 首帧 auth 仅限 loopback 来源）+ `certManager` SAN 127.0.0.1 | D-R7 + TC-R2-05/06 |
| WBS-R2-E | `configStore` relay 配置段；设置面板：开关/地址/主码/显式双开切换（提示暴露面变化）| D-R8 + TC-R2-01/05 |
| WBS-R2-F | 子码管理面板 + 分享链接组装（`#S=`/`#T=` 片段）+ tray 状态与二维码切换 | D-R8 + TC-R2-02 |
| WBS-R2-G | webpack 插件 target（node target，`ws` external），产物 `dist/plugins/relayPlugin.js` | 构建通过 |
| WBS-R2-H | `smoke-e2e.mjs` 扩展：真实 relay + 真实 Electron + 真实 bash 全链路 | D-R9 + TC-R2-10（✔ 已完成：SCENE-R2H-01~04，验收文档 §3.2.1） |

### R-M3 web 客户端中继模式（预计 2 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-R3-B | `WebSocketTransport` 中继接入：join 首帧→管道建立等待→auth 首帧 | 源码（✔ E2E-09/10/11 自动化子集） |
| WBS-R3-C | 中继断线重连状态机（join 重试、管道重建后 attach+replay 衔接） | TC-R3-05（✔ E2E-11 子集；致命码不重试 ✔ E2E-10） |
| WBS-R3-A | 登录页中继模式：`#S=`/`#T=` 片段自动填充，手动输入兜底 | D-R10 + TC-R3-01/02（✔ gate UI + /health 探测双宿主；浏览器实测待人工） |

### R-M4 加固与体系化（预计 2–3 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-R4-A | 挑战应答：host 发 nonce、客户端回 `HMAC-SHA256(token, nonce)`（WebCrypto），Token 不再明文过 relay | D-R11 + TC-R4-01（✔ E2E-12 自动化子集：nonce 单次/每连接不同/重放拒/明文拒） |
| WBS-R4-B | E2E 加密协议位：AES-GCM + `HKDF(token, nonce)`，默认关闭可启用 | TC-R4-02（✔ E2E-13 自动化子集：auth-ok 后线路全密文/密文往返/IV 每帧不同/明文违例 4004/篡改断链/真实 transport 全流程；开关 `TERNIMAL_RELAY_E2EE=1`，默认关零回归） |
| WBS-R4-C | 重连/背压/接管矩阵压测 + 3MB/s 容量实测（对齐技术方案书 §3.8 模型）+ 公开服务前 checklist | TC-R4-03/04/05（✔ 自动化子集 verify-relay-matrix 6/6：M-01~03 重连三场景、M-04 背压隔离、M-05 容量 17~31MiB/s+字节计数、M-06 4 管道×16 会话；✔ checklist 文档 docs/relay-public-checklist.md；20 会话×10min×tc 为人工项；并修复 transport 致命码表与 relay 实际码表错位缺陷） |
| WBS-R4-D | relay 套件并入 `npm run verify` 伞 | D-R12（✔ verify = m1+m3+m4+softkeys+relay） |

### 依赖关系与关键路径

```
R-M1 ──► R-M2 ──► R-M3 ──► R-M4
 │         │
 │         └─ WBS-R2-C/D 可与 R-M2-A/B 并行（不同文件域）
 └─ WBS-R1-A/B 可先行（协议冻结前独立）

关键路径：WBS-R1-C/D → R2-B → R2-H → R3-B/C → R4-A
```

## 4. 进度计划

单人全职估算，总计 **11–14 个工作日**：

| 里程碑 | 工期 | 累计 | 验收门 |
|--------|------|------|--------|
| R-M1 | D1–D4 | D4 | 验收标准 §3.1 全通过（relay 独立可用） |
| R-M2 | D5–D9 | D9 | 验收标准 §3.2 全通过 + 本地零回归 |
| R-M3 | D10–D11 | D11 | 验收标准 §3.3 全通过 |
| R-M4 | D12–D14 | D14 | 验收标准 §3.4 全通过 → 项目验收 |

每个里程碑结束为评审节点：对照验收标准逐项执行并记录结果，未通过项进入
缺陷清单，修复复验后方可进入下一里程碑。

## 5. 风险登记表

| 编号 | 风险 | 概率 | 影响 | 缓解措施 | 应急预案 |
|------|------|------|------|----------|----------|
| RR1 | utilityProcess 中运行 ws 客户端的兼容性问题 | 中 | 高 | R-M2 第一个任务即做最小 spike（拨 relay 收发帧） | 降级 `child_process.fork`（隔离语义不变） |
| RR2 | 公网 relay 被扫描/滥用 | 中 | 中 | 控制面限速 + 主码哈希 + 并发上限（day-one）；Caddy 仅暴露 443 | fail2ban 接入；临时关闭 register |
| RR3 | 链路拥塞时背压杀管道误伤正常客户端 | 中 | 低 | 容量模型已证目标场景余量 10 倍；验收含 3MB/s 实测 | v1.1 提前：每管道令牌桶限速 |
| RR4 | 主码/子码泄露 | 低 | 高 | 子码短 TTL + 可吊销；主码轮换即全断（旧管道收割） | 文档化应急流程（轮换步骤） |
| RR5 | 插件 bundle 误打包 `ws` 致死锁（M2 既有教训） | 中 | 高 | webpack external 沿用主进程配置；构建产物检查 | 运行时启动自检（首帧超时即报错） |
| RR6 | iOS Safari 长连接后台冻结/重连限制 | 中 | 低 | R-M3-C 重连状态机覆盖前台恢复场景 | 已知限制记录（移动端保持前台使用） |
| RR7 | Caddy WS 透传/头转发配置错误 | 低 | 中 | D-R5 交付 Caddyfile 示例；TC-R4 覆盖代理路径 | 临时 `--insecure` + 防火墙白名单 |
| RR8 | 自签证书 SAN 变更影响现有 LAN 流程 | 低 | 中 | SAN 追加（非替换），现有指纹流程回归 | 手动指定证书路径（现有能力） |

## 6. 变更管理

- 需求基线：`relay-design.md` v0.2。里程碑评审后进入冻结，变更需评估对
  方案书 + 本计划 + 验收标准三份文档的影响并升版本号。
- 范围外功能请求（多租户、计费、Electron 客户端等）一律进入二期清单。

## 7. 角色

| 角色 | 职责 |
|------|------|
| 实施者 | 编码、自测、验证脚本、relay 部署、文档维护 |
| 需求方（用户） | 里程碑评审、真实外网场景试用（SCENE-R-01）、验收签署 |

## 8. 完成定义（DoD）

1. `relay-verification-standard.md` §3–§7 全部用例通过，遗留问题为零或经
   需求方书面接受；
2. 本地 Electron 与 LAN 远程零回归（主项目验证标准 §6 清单复跑通过）；
3. SCENE-R-01 真实场景由需求方亲自执行并签署；
4. `npm run verify` 伞含 relay 套件且全绿；
5. 三份 relay 文档（方案/计划/验收）与实现一致，部署文档（relay/README）
   可让需求方独立完成 VPS 部署。
