# Ternimal 远程多标签终端 — 项目计划书

> 版本：v1.0
> 上游文档：`docs/remote-terminal-requirements.md`（需求规格 v1.0）
> 配套文档：`docs/technical-design.md`（技术方案书）、`docs/verification-standard.md`（验证标准）

## 1. 项目概述

### 1.1 目标

将 Ternimal（Electron + xterm.js + node-pty 单机终端）改造为支持 HTTPS
外部接入的多标签终端：本地与远程浏览器**共享同一组标签会话**，核心场景为
远程操控正在本地运行的 Claude Code 长任务。

### 1.2 范围

**范围内**（核心版，对应需求规格 §6 M1–M4）：

- 会话状态上移至 main 进程（SessionRegistry + 环形回放缓冲）
- 内嵌 HTTPS/WSS 服务与 Web 版终端 UI（复用现有 renderer 组件）
- 单密码认证、登录限速、自签名证书自动生成
- 关窗驻留系统托盘、PTY 会话保活、断线重连

**范围外**（明确不做，留二期）：只读模式、手机虚拟按键条、REST API、
无头服务器模式、审计日志、多用户、Let's Encrypt 自动签发。

### 1.3 约束与前提

- 宿主机为桌面 Linux（Deepin），Electron 34 + node-pty 1.1，原生模块
  改版后需 `npm run rebuild`（现有约束，见 CLAUDE.md）
- 仅内网/VPN 暴露，不直接上公网
- 本地 Electron 使用体验不允许回归（回归清单见验证标准 §6）
- 无测试框架的现状下，验证以"自动化验证脚本 + 手动测试用例"组合完成
  （见验证标准 §2），不引入大型测试框架

## 2. 交付物清单

| 编号 | 交付物 | 形态 | 所属里程碑 |
|------|--------|------|-----------|
| D1 | SessionRegistry 及环形缓冲模块 | `src/main/sessionRegistry.ts` 等源码 | M1 |
| D2 | 渲染端传输抽象层 + 本地 IPC 实现 | `src/renderer/transport/` | M1 |
| D3 | WSS RemoteServer（含 WS 协议实现） | `src/main/remoteServer.ts` 等 | M2 |
| D4 | Web 终端 UI（双入口构建产物） | `src/web/` + `dist/web/` | M2 |
| D5 | 认证与安全模块（登录/限速/证书） | main 进程源码 | M3 |
| D6 | 托盘驻留与生命周期管理 | `src/main/tray.ts` 等 | M4 |
| D7 | 配置文件读写模块 | `src/main/config.ts` | M4 |
| D8 | 自动化验证脚本套件 | `scripts/verify-*.mjs` | M1–M4 滚动交付 |
| D9 | 三份文档（需求/方案/验证） | `docs/` | 已交付，随变更维护 |
| D10 | 打包配置更新 | webpack 双入口 + electron-builder | M2 |

## 3. 工作分解结构（WBS）

### M1 会话中台（预计 2–3 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-M1-A | 设计并实现 `SessionRegistry`：会话表、create/kill/write/resize/list、事件（data/exit/title/tabsChanged） | 源码 + 单元验证脚本通过 |
| WBS-M1-B | 环形回放缓冲（字节上限可配、追加/快照接口） | 源码 + 缓冲边界验证脚本 |
| WBS-M1-C | `ipcHandlers.ts` 改造：PTY 事件经 Registry 统一分发；spawn 由 Registry 代理，ID 服务端生成 | 源码 |
| WBS-M1-D | 渲染端 `Transport` 接口抽象 + `LocalIpcTransport`；`terminalApp/terminalTab/xtermWrapper` 剥离 `window.electronAPI` 直接依赖（含右键剪贴板） | 源码，本地全功能回归通过 |
| WBS-M1-E | 本地窗口启动时从 Registry 恢复标签列表（关窗重开标签不丢的自然收益验证点） | 源码 + 手动用例 TC-M1-03 |

### M2 远程数据通路（预计 3–4 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-M2-A | WS 协议实现（消息信封、类型定义共享于 `src/shared/`） | 源码 + 协议联调脚本 |
| WBS-M2-B | `RemoteServer`：HTTP 静态服务 + WS upgrade（先明文 HTTP 裸跑，M3 再上 TLS） | 源码 |
| WBS-M2-C | `WebSocketTransport`（含心跳、指数退避重连） | 源码 |
| WBS-M2-D | Web UI 入口：`src/web/index.html` + bootstrap，复用 renderer 组件 | 源码 |
| WBS-M2-E | webpack 双入口构建 + dist/web 产物 + CSP 调整（connect-src wss:） | 构建通过 + 浏览器可用 |
| WBS-M2-F | attach 重放流程（缓冲快照 → 实时流无缝衔接） | 联调通过 TC-M2-01/02 |

### M3 安全（预计 2 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-M3-A | 自签证书生成（`selfsigned` 纯 JS 依赖，首启生成、指纹展示） | 源码 + TC-M3-01 |
| WBS-M3-B | 鉴权页 + 令牌校验（迭代后：动态令牌 + `#T=` 片段自动登录 + 二维码）+ httpOnly cookie 会话 | 源码 + TC-M3-02/03 |
| WBS-M3-C | WS 握手认证校验、未认证连接拒绝 | TC-M3-04 |
| WBS-M3-D | 登录限速（5 次/分钟/IP，锁 1 分钟） | TC-M3-05 |
| WBS-M3-E | RemoteServer 切换 HTTPS（证书装配、HTTP→HTTPS 重定向或拒绝） | TC-M3-06 |

### M4 生命周期（预计 1–2 个工作日）

| 任务 | 内容 | 验收物 |
|------|------|--------|
| WBS-M4-A | 托盘模块：图标、菜单（显示窗口/退出/复制访问地址/查看访问信息二维码/重置访问令牌） | 源码 + TC-M4-01 |
| WBS-M4-B | `window-all-closed` 改为驻留；退出路径 killAll 语义收敛 | TC-M4-02/03 |
| WBS-M4-C | 配置文件模块（端口/绑定地址/密码哈希/证书路径/缓冲上限） | 源码 + TC-M4-04 |
| WBS-M4-D | 断线重连端到端打磨（弱网模拟下缓冲补齐） | TC-M4-05 |

### 依赖关系与关键路径

```
M1 ──► M2 ──► M3 ──► M4
       │            │
       └─ M2-F 依赖 M1-B（缓冲）
                     └─ M4-D 依赖 M3（重连需先过认证）
```

关键路径：WBS-M1-A/B → M2-A/B/F → M3-B/C → M4-D。
M2-E（构建）与 M2-C（传输）可并行；M3-A 与 M3-B 可并行。

## 4. 进度计划

单人全职估算，总计 **8–11 个工作日**：

| 里程碑 | 工期 | 累计 | 验收门 |
|--------|------|------|--------|
| M1 | D1–D3 | D3 | 验证标准 §3.1 全部通过（本地零回归） |
| M2 | D4–D7 | D7 | 验证标准 §3.2 全部通过 |
| M3 | D8–D9 | D9 | 验证标准 §3.3 全部通过 |
| M4 | D10–D11 | D11 | 验证标准 §3.4 全部通过 → 项目验收 |

每个里程碑结束为评审节点：对照验证标准逐项执行并记录结果，未通过项进入
缺陷清单，修复后复验方可进入下一里程碑。

## 5. 风险登记表

| 编号 | 风险 | 概率 | 影响 | 缓解措施 | 应急预案 |
|------|------|------|------|----------|----------|
| R1 | renderer 组件隐藏的 electronAPI 耦合（已发现右键剪贴板）导致 Web 端运行时报错 | 高 | 中 | M1-D 全量排查 `window.electronAPI` 引用，传输层接口一次覆盖 | 运行时特性探测降级（无剪贴板则禁用右键菜单） |
| R2 | Claude Code 大量输出时 WS 背压/慢客户端拖垮输出循环 | 中 | 高 | 监控 `bufferedAmount`，超阈值（8MB）断开慢客户端；PTY 读取不受阻 | 降低缓冲上限；分帧压缩（二期） |
| R3 | 自签证书生成失败（环境异常） | 低 | 中 | 采用纯 JS `selfsigned` 包，不依赖系统 openssl | 支持配置文件手动指定证书路径 |
| R4 | 多端 resize 抖动（两端交替抢尺寸） | 中 | 低 | last-writer-wins + 服务端 200ms 去抖 | 已定为已知限制，文档明示 |
| R5 | 重放缓冲从转义序列中间截断导致首屏渲染异常 | 中 | 低 | xterm.js 对残缺序列有容错；首屏少量花屏可接受 | 记录起始点对齐优化（二期） |
| R6 | 长时间运行内存增长（断开客户端未清理、缓冲无界） | 低 | 高 | 客户端关闭即从 Registry 注销；缓冲硬上限 | 验证标准含 8 小时 soak 测试门 |
| R7 | Claude Code 版本升级改变 TUI 交互行为 | 中 | 低 | 验收用例使用真实 Claude Code 会话 | 回归验证标准 §5 用例重跑 |
| R8 | node-pty 与 Electron 重编译问题（升级触发） | 低 | 高 | 不升级 Electron/node-pty 版本；如需升级先跑 `npm run rebuild` | 锁定版本 |
| R9 | Linux 打包（afterPack 改写）与新静态资源路径冲突 | 低 | 中 | dist/web 随 asar 打包，`__dirname` 相对定位 | extraResources 方案备选 |

## 6. 变更管理

- 需求基线：`remote-terminal-requirements.md` v1.0。里程碑评审后进入
  需求冻结，变更需评估对三份文档 + WBS + 工期的影响并更新版本号。
- 文档版本规则：重大变更升主版本，澄清性修改升次版本，变更记录写入
  各文档末尾附表。
- 范围外功能请求一律进入二期清单，不在本期消化。

## 7. 角色

| 角色 | 职责 |
|------|------|
| 实施者 | 编码、自测、验证脚本编写、文档维护 |
| 需求方（用户） | 里程碑评审、验收签署、真实场景（Claude Code）试用反馈 |

## 8. 完成定义（DoD）

1. 验证标准文档 §3–§7 全部用例通过，遗留问题清单为零或经需求方书面接受；
2. 全部交付物（D1–D10）合入仓库主干，构建与打包命令可一键成功；
3. 三份文档与最终实现一致（无"文档说有、代码没有"项）；
4. 需求方在真实内网环境完成一次完整的"本地起 Claude Code → 手机接管
   → 断线重连 → 回本地继续"全流程试用并签署验收。
