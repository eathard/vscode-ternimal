# Ternimal 远程多标签终端 — 技术方案书

> 版本：v1.0
> 上游文档：`docs/remote-terminal-requirements.md`（需求规格 v1.0）
> 配套文档：`docs/project-plan.md`（计划书）、`docs/verification-standard.md`（验证标准）

## 1. 总体架构

### 1.1 进程/模块视图

```
┌────────────────────────────── 宿主机：Electron 应用 ──────────────────────────────┐
│                                                                                   │
│  本地窗口 renderer                     main 进程                                   │
│  ┌──────────────────────┐             ┌────────────────────────────────────────┐ │
│  │ TerminalApp/UI 组件   │             │ main.ts                                │ │
│  │  ├ TerminalTab        │  IPC(现有)  │  ├ TrayController（M4）                │ │
│  │  ├ TabBar/SearchBar   │◄──────────► │  ├ ConfigStore（M4）                   │ │
│  │  └ XtermWrapper       │             │  ├ registerIpcHandlers（改造）          │ │
│  │       │               │             │  │    └► SessionRegistry ◄──────┐      │ │
│  │  LocalIpcTransport ───┼────────────►│  │       ├ PtyManager（复用）  │      │ │
│  └──────────────────────┘             │  │       └ RingBuffer × N       │      │ │
│                                       │  │                               │      │ │
│  远程浏览器                            │  └──────────┬───────────────────┘      │ │
│  ┌──────────────────────┐             │             │ 事件扇出                  │ │
│  │ Web UI（同一套组件）   │             │  ┌──────────▼───────────────────┐      │ │
│  │  WebSocketTransport ─┼──HTTPS/WSS──►│  │ RemoteServer                 │      │ │
│  └──────────────────────┘             │  │  ├ 静态资源 dist/web          │      │ │
│                                       │  │  ├ /auth 令牌认证（M3，/login  │      │ │
│                                       │  │  │   为 GET 别名）+ 二维码扫码     │      │ │
│                                       │  │  └ /ws 会话流 + 心跳 + 限速   │      │ │
│                                       │  └──────────────────────────────┘      │ │
│                                       └────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心设计原则

1. **会话状态上移**：标签/会话从 renderer 私有状态变为 main 进程
   `SessionRegistry` 的服务端状态；本地窗口与远程浏览器均为其客户端。
2. **传输层抽象**：UI 组件只依赖 `TerminalTransport` 接口，本地走 IPC、
   远程走 WSS，双入口共享同一套 UI 代码。
3. **单写多读扇出**：PTY 事件（data/exit/title）由 Registry 统一扇出到
   本地 IPC 通道与所有已 attach 的 WS 客户端；输入从任一客户端汇入同一
   PTY。
4. **最小侵入**：`PtyManager` 保持原样（仅事件转发方式调整），
   VS Code 传承的守护逻辑（resize 钳制、ConPTY kill 超时）原封不动。

## 2. 模块详细设计

### 2.1 环形回放缓冲（`src/main/ringBuffer.ts`，M1）

```ts
export class RingBuffer {
  constructor(maxBytes: number);          // 默认 1MB，来自配置
  append(chunk: string): void;            // PTY 输出分片追加，超限丢弃最老分片
  snapshot(): string;                     // 当前缓冲全量拼接（attach 重放用）
  clear(): void;
  get byteLength(): number;               // Buffer.byteLength 统计
}
```

设计要点：

- PTY `onData` 给出的是 UTF-16 JS string，分片按"整段 string"入队，
  天然不产生 UTF-8 字节截断问题。
- 追加时若单分片自身超上限，仅保留该分片（防御异常大块输出）。
- 已知限制（需求规格 §7-5）：快照起点可能落在 ANSI 转义序列中间，首屏
  可能有少量花屏，xterm.js 对残缺序列有容错，接受此瑕疵。

### 2.2 会话注册表（`src/main/sessionRegistry.ts`，M1）

```ts
export interface SessionInfo {
  id: string;            // 格式沿用 tab-{timestamp}-{counter}
  title: string;         // 初始 'Terminal'，随 PTY 标题更新
  pid: number;
  cols: number;          // 当前 PTY 尺寸（最后操作者生效）
  rows: number;
  shell?: string;
  cwd?: string;
  createdAt: number;
}

export class SessionRegistry extends EventEmitter {
  create(opts: { shell?: string; cwd?: string; cols: number; rows: number }): SessionInfo;
  kill(id: string): void;                    // 同步删除 + pty.kill（复用现有守护）
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number, byClient?: ClientRef): void;
  list(): SessionInfo[];
  // 事件：
  //   'data'  (DataPayload)    —— 同时写对应会话的 RingBuffer
  //   'exit'  (ExitPayload)
  //   'title' (TitlePayload)
  //   'tabs'  (SessionInfo[])  —— 列表变更（create/kill）时发出
}
```

职责与边界：

- **拥有 PTY 生命周期**：内部实例化一个 `PtyManager`（或直接持有个体
  PTY），spawn 参数拼装沿用 `ptyManager.spawn` 现有逻辑（TERM、COLORTERM、
  cwd 回退、尺寸钳制）。
- **ID 由服务端生成**：现在 `terminalApp.ts:8` 的客户端 `generateId()`
  废弃，`create()` 返回带服务端 ID 的 `SessionInfo`。
- **resize 去抖**：last-writer-wins 基础上加 200ms 服务端去抖，缓解双端
  交替抢尺寸的抖动（风险 R4）；`byClient` 记录尺寸当前归属，仅用于诊断
  日志，不做强占用。
- **title 追踪**：沿用 `ptyManager.ts:46-55` 的轮询 `pty.process` 方案，
  移交 Registry 统一做（现有 `checkTitle` 实际未被定时调用，属既有缺陷，
  本次以 1s 间隔定时器修复并纳入验证用例 TC-M1-05）。

### 2.3 IPC 契约变更（`src/shared/ipcChannels.ts`，M1）

现有 7 个通道全部保留、语义不变；新增 3 个：

```ts
IPC.TABS_LIST  = 'tabs:list'    // invoke → SessionInfo[]（窗口启动恢复、刷新）
IPC.TABS_ON_CHANGE = 'tabs:onChange'  // main→renderer 广播 SessionInfo[]
// PTY_ON_DATA/EXIT/TITLE 语义不变，但 payload id 即 SessionInfo.id
```

`spawn` 请求体（`SpawnRequest.id`）改为由 Registry 忽略并重生成
（兼容期保留字段），响应增加完整 `SessionInfo`。

扇出改造（`ipcHandlers.ts`）：

```ts
// 现状：ptyManager.on('data', p => sendToRenderer(IPC.PTY_ON_DATA, p))
// 改为：
registry.on('data',  (p) => { sendToRenderer(IPC.PTY_ON_DATA, p);
                              remoteServer.broadcastData(p); });   // M2 起
registry.on('tabs',  (tabs) => sendToRenderer(IPC.TABS_ON_CHANGE, tabs));
```

`window-all-closed` 后 `mainWindow` 为 null，`sendToRenderer` 已有
`isDestroyed()` 守卫（`ipcHandlers.ts:13`），扇出天然降级为仅 WS 端。

### 2.4 渲染端传输抽象（`src/renderer/transport/`，M1–M2）

```ts
export interface TerminalTransport {
  listTabs(): Promise<SessionInfo[]>;
  createTab(opts: { shell?: string; cwd?: string }): Promise<SessionInfo>;
  closeTab(id: string): void;
  attach(id: string): void;          // 声明关注（本地=隐式，远程=显式消息）
  detach(id: string): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  getDefaultShell(): Promise<string>;
  clipboardWrite(text: string): void;
  clipboardRead(): Promise<string>;

  onTabsChange(cb: (tabs: SessionInfo[]) => void): Unsubscribe;
  onData(cb: (p: DataPayload) => void): Unsubscribe;
  onExit(cb: (p: ExitPayload) => void): Unsubscribe;
  onTitle(cb: (p: TitlePayload) => void): Unsubscribe;
  onAttached(cb: (p: { id: string; replay: string }) => void): Unsubscribe; // 远程重放
}
```

`WebSocketTransport` 的连接期语义（浏览器 e2e 阶段固化，防"刷新即新建"）：

- **发送侧 outbox**：socket 非 OPEN 时控制消息（create/list/attach…）入队，
  onopen 时按序冲刷，不静默丢弃；
- **listTabs 有界等连接**：连接未建立时不读空缓存，而是 50ms 轮询直到
  OPEN 再发 `list`（总超时同 REQUEST_TIMEOUT_MS，超时或主动 dispose 才
  回退缓存）——否则 `TerminalApp.init()` 会把空缓存误判为"服务端无会话"
  而在每次刷新时新建标签；
- **激活去重不忘激活**：`addTabFromInfo` 对已存在会话早退去重时，若本次
  携带 activate 意图仍需 `switchTab`（广播可能先于 createTab 响应以
  "未激活"身份收养该会话）。

**Web 软键盘（`src/web/softKeys.ts`，仅 web 束挂载）**：可拖动悬浮条
（Ctrl/Alt/Shift 粘滞开关 + Esc/Tab/↑↓←→ 直发键；方向键按活动标签的
DECCKM 状态选 CSI `\x1b[A` 或 SS3 `\x1bOA`，修饰时恒为 `\x1b[1;<mod>` 形式，mod=1+shift+2·alt+4·ctrl），位置钳制于视口并存
localStorage。组合翻译用**字节级映射**（`src/shared/modifierKeys.ts`
纯函数，Ctrl+a..z→\x01..\x1a、Alt→ESC 前缀、Shift+Tab→\x1b[Z、
Ctrl+Shift≡Ctrl、未映射原样透传），经 `setInputTransform` 缝注入
TerminalTab 的 onData 管道——不伪造键盘事件，本地端恒等。一次性语义：
下一个单字符击键消耗组合并复位；粘贴/IME 多字符不消耗；切标签/失焦
清零。按钮动作挂 pointerdown（触摸即时且防 CDP 合成 click 被吞），
preventDefault 保证 xterm 焦点不丢。

`getReplay()` 是重放的唯一出口（WS `attached` 与本地 `TABS_GET_REPLAY`
共用），内建**陈旧查询净化**：剥除 DA1/DA2/XTVERSION/DSR/DECRQM/OSC
颜色查询等终端能力询问，普通输出与 OSC 设置原样保留——否则新 xterm 会
自动应答重放里的陈旧查询，把应答（如 `ESC[?1;2c`）当键盘输入注入正在
运行的程序（bash 回显为 `1;2c` 垃圾；Claude Code 启动即发此类查询，
故网页每次刷新必现）。已知固有限制（P2 后续）：查询为**活输出**时，
所有当时在线的已连接客户端（本地窗口+网页）会各自应答一次——多读端
架构固有，彻底方案是把查询应答上移到服务端（tmux 式），暂未实施。

- `LocalIpcTransport`：包装现有 `window.electronAPI`（preload 不动）；
  `attach/detach` 为空实现（本地窗口始终全量接收广播，行为与现状一致）；
  剪贴板直通 Electron clipboard。
- `WebSocketTransport`：实现 §3 协议；`attach` 发送显式消息并等待
  `attached`（携带重放）；含心跳（30s ping/pong）与指数退避重连
  （1s/2s/4s/…上限 30s），重连成功后自动重新 attach 全部已知标签。
  M4 同构化：构造参数可注入 ws 实现/Cookie 头（`verify-reconnect.mjs`
  在 node 里驱动真传输类），浏览器路径零改动；计时器用环境全局而非
  `window.*`。
- 重放恢复（M4）：`TerminalTransport.getReplay?` 可选方法——本地窗口
  经 IPC `tabs:getReplay` 拉取环形缓冲快照（TC-M4-03 重开窗口恢复
  历史）；Web 端重放已由 `attached` 携带，无需实现。
- UI 组件改造点：
  - `terminalTab.ts`：构造函数改为"先拿 `SessionInfo` 再建 xterm"的异步
    初始化（`TerminalApp.newTab` 改 async）；spawn 不再由 tab 自己发起。
  - `terminalApp.ts`：启动时 `listTabs()` 恢复已有会话（无则新建初始
    标签）；`onTabsChange` 驱动标签栏（远程关标签，本地同步消失）。
  - `xtermWrapper.ts:80-92`：右键剪贴板改走 transport 注入的
    clipboard 接口（当前直接引用 `window.electronAPI`，是 Web 端复用的
    硬耦合，风险 R1 的已知实例）。

### 2.5 远程服务（`src/main/remoteServer.ts`，M2–M3）

```ts
export class RemoteServer {
  constructor(opts: {
    registry: SessionRegistry;
    config: ConfigStore;          // 端口/绑定地址/证书/缓冲上限
    webRoot: string;              // dist/web 静态目录
  });
  start(): Promise<{ port: number; certFingerprint: string }>;
  stop(): void;
  broadcastData(p: DataPayload): void;      // Registry 扇出调用
}
```

内部组成：

- **HTTP 层**（Node `https.createServer`，M2 阶段暂 `http.createServer`）：
  - `GET /` → `index.html`（Web 终端页面）
  - `GET /static/*` → dist/web 静态文件（Content-Type 白名单 + 路径穿越
    防护：resolve 后必须仍在 webRoot 内）
  - `GET /auth`（`/login` 为别名）→ 鉴权页；`POST /auth` → 令牌校验。
    页面 JS 自动读取 URL 片段 `#T=<token>` 换取会话 cookie 并抹除片段
    （托盘二维码/复制的链接即此形态；片段不进服务器日志）。
  - `GET /health` → 200（无敏感信息，供内网探活）
- **WS 层**（`ws` 库，挂 `/ws` 路径）：
  - upgrade 前校验会话 cookie，未认证直接拒绝握手（返回 401）
  - 每连接维护 `attachedIds: Set<string>`；心跳 30s，超时 2 倍间隔判死
  - 慢客户端保护：`bufferedAmount > 8MB` 强制断开（风险 R2）
- **限速器**：内存 Map<ip, {count, windowStart}>，5 次/分钟，超出锁 1 分钟
  （仅作用于 `/login` 失败尝试）。

会话 cookie：

- 登录成功签发 `ternimal_session=<32B 随机 hex>`，属性
  `HttpOnly; Secure; SameSite=Strict; Path=/`
- 服务端内存 Map 保存 token→{createdAt, lastSeen}；有效期 7 天滑动；
  重启即全部失效（一期接受，文档明示）

### 2.6 WS 协议规范（`src/shared/wsProtocol.ts`，M2）

JSON 文本帧，统一信封 `{ "type": "...", ... }`。字段与 IPC payload
（`ipcChannels.ts`）对齐：

**客户端 → 服务端**

| type | 载荷 | 说明 |
|------|------|------|
| `list` | — | 请求标签列表，服务端回 `tabs` |
| `create` | `{shell?, cwd?}` | 新建标签（尺寸以首个 attach 客户端 fit 为准，服务端先按 80×24 建档） |
| `close` | `{id}` | 关闭标签 |
| `attach` | `{id}` | 附着会话；触发 `attached` + 重放 |
| `detach` | `{id}` | 取消附着（切后台省流可选） |
| `input` | `{id, data}` | 写入 PTY（UTF-8 文本） |
| `resize` | `{id, cols, rows}` | 服务端钳制 `max(1)` 后生效（last-writer-wins + 200ms 去抖） |
| `ping` | — | 应用层心跳（与 ws 协议层 ping 二选一，实现取 ws 协议层） |

**服务端 → 客户端**

| type | 载荷 | 说明 |
|------|------|------|
| `tabs` | `{tabs: SessionInfo[]}` | 列表快照/变更广播（create/kill/尺寸标题变化节流 500ms） |
| `attached` | `{id, replay, cols, rows, title}` | attach 确认 + 环形缓冲重放 |
| `data` | `{id, data}` | 实时输出（仅发给 attached 客户端） |
| `exit` | `{id, exitCode}` | 会话退出 |
| `title` | `{id, title}` | 标题变更 |
| `error` | `{code, message}` | 协议级错误（如 attach 不存在的 id） |

错误码：`AUTH_REQUIRED`(4001)、`RATE_LIMITED`(4002)、`NO_SESSION`(4003)、
`BAD_MESSAGE`(4004)。客户端收到 `AUTH_REQUIRED` 应跳转登录页。

### 2.7 托盘与生命周期（`src/main/tray.ts`，M4）

- `main.ts`：`window-all-closed` 改为不退出（仅置空 mainWindow）；
  新增托盘图标 + 菜单：
  - `显示窗口` → 无则 `createWindow()`（启动时 `listTabs` 恢复标签）
  - `复制访问地址` → `https://<LAN-IP>:<port>` 写入剪贴板
  - `查看访问信息（二维码）` → QR 窗口（URL/令牌/证书指纹）；
    `重置访问令牌` → 重置后立即失效全部会话 cookie 并弹出新二维码
  - `退出` → `registry.killAll()` + `app.quit()`（唯一正常退出路径）
- `before-quit` 保留 `killAll()`；托盘退出走同一函数，语义收敛。
- 图标复用现有打包图标资源（项目已含 png-to-ico 流程）。

### 2.8 配置模块（`src/main/config.ts`，M4）

`userData/config.json`，首启生成默认值：

```jsonc
{
  "port": 8443,
  "bind": "0.0.0.0",            // 可改 127.0.0.1 或内网具体 IP
  "accessToken": 不落盘，           // 每次启动随机生成（192bit），托盘展示/轮换
  "certPath": "",                // 空 = userData/certs/ 自签
  "replayBufferBytes": 1048576,  // 每会话环形缓冲上限
  "maxSessions": 16
}
```

访问令牌：`crypto.randomBytes(24).toString('base64url')`（192bit，每次启动
轮换；`TERNIMAL_TOKEN` 环境变量可覆盖，用于测试/恢复）。比对用
`timingSafeEqual`（长度不等直接拒绝）。会话 cookie 机制不变。
改配置需重启应用生效（一期不做热加载）。

### 2.9 证书方案（M3）

- 新增依赖 `selfsigned`（纯 JS，规避对系统 openssl 的依赖，风险 R3）。
- 首启生成 RSA-2048 自签证书：CN=`Ternimal`，SAN 含本机全部内网 IP 与
  `localhost`，有效期 365 天，存 `userData/certs/`。
- 指纹（SHA-256）在托盘菜单与登录页展示，供远程端核对防中间人。
- `certPath` 非空时优先加载用户证书（为二期接反代/Let's Encrypt 留口）。

## 3. 关键时序

### 3.1 远程接入 + 重放（核心链路）

```
浏览器                    RemoteServer              SessionRegistry        PTY
  │ GET / (TLS+cookie)        │                          │                 │
  │──────────────────────────►│ 静态页面                  │                 │
  │ WS /ws (cookie 校验通过)   │                          │                 │
  │──────────────────────────►│                          │                 │
  │ -- list -->               │                          │                 │
  │──────────────────────────►│------ list() ------------►│                 │
  │ <-- tabs [...]            │                          │                 │
  │◄──────────────────────────│◄-------------------------│                 │
  │ -- attach {id} -->        │                          │                 │
  │──────────────────────────►│--- attach(id, client) ---►│                 │
  │ <-- attached {replay}     │◄-- buffer.snapshot() ----│                 │
  │◄──────────────────────────│                          │                 │
  │                           │◄=========== data ========================│
  │ <-- data (实时流)          │<------ 'data' 事件 ------│                 │
  │◄──────────────────────────│                          │                 │
  │ -- input / resize -->     │--- write()/resize() ----►│──► stdin ──────►│
```

### 3.2 断线重连

```
客户端掉线 ──► WS close
              ├─ Registry: 该 client 从 attached 集合移除；PTY 与缓冲不动
              └─ 客户端: 指数退避重连 → 重认证 → 对已知标签逐个 attach
                         → attached.replay 全量补齐（一期不做差量）
```

### 3.3 关窗驻留（M4）

```
用户点 X ──► window-all-closed ──► 不 quit，mainWindow=null
             ├─ Registry/PTY/RemoteServer 全部不动，远程继续用
             └─ 托盘"显示窗口" ──► createWindow() ──► listTabs() 恢复标签
```

## 4. 构建与打包改造

| 项 | 变更 |
|----|------|
| `webpack.renderer.config.js` | 改多入口：`electron`（现有，target electron-renderer）与 `web`（target web，产物 `dist/web/`：index.html + web.js + css） |
| `src/web/index.html` | 复制自 renderer 版，CSP 增加 `connect-src 'self' wss:`；无 preload 依赖 |
| `webpack.main.config.js` | entry 不变；**`ws` 必须设为 external**（打包版死锁事件循环，见 §4 与 M2 报告）；`selfsigned` 可随 bundle 打入 |
| `package.json` | dependencies 增 `ws`、`selfsigned`；scripts 不变 |
| `webpack.main.config.js` | **`ws` 必须与 node-pty 同为 external**——打包版 ws 会在首次出站广播后死锁事件循环（pipe-poll 挂起，纯 node 可复现，M2 实测修复，详见 test-reports/M2-report.md §4） |
| `electron-builder.yml` | 无需 extraResources（dist/web 随 asar，Electron fs 可读 asar 内文件）；若 afterPack 与资源定位冲突，备选 extraResources（风险 R9） |
| 原生模块 | node-pty 版本不动，理论上无需 `rebuild`；升级 Electron 才需要 |

## 5. 安全设计汇总

| 层面 | 措施 |
|------|------|
| 传输 | 全站 TLS（自签），无明文 HTTP 数据面；`/health` 亦走 TLS |
| 认证 | 动态访问令牌（每启动轮换 192bit；扫码/链接免输入）；httpOnly+Secure+SameSite=Strict cookie；WS upgrade 复验 |
| 暴露面 | 默认内网/VPN；`bind` 可收紧到具体接口；令牌轮换即吊销全部会话 |
| 防爆破 | 5 次/分/IP 失败锁定 1 分钟 |
| Web 安全 | 静态服务路径穿越防护；CSP 限制 connect-src；无内嵌第三方资源 |
| 审计 | 一期仅进程日志（登录成功/失败、客户端连接/断开、标签创建/关闭）；结构化审计二期 |

**明示的剩余风险**（与需求规格 §7 一致）：远程控制终端本质等于远程
代码执行，安全边界 = 令牌 + 网络边界（内网/VPN），不得直接暴露公网。

## 6. 边界与错误处理

| 场景 | 行为 |
|------|------|
| attach 不存在的 id | 回 `error {NO_SESSION}`，客户端刷新 tabs |
| 会话退出时仍有 attached 客户端 | 广播 `exit`；缓冲再保留 60s 供迟到者读取后销毁 |
| 两个客户端同时 attach 同一标签 | 均收实时流；input 混流（已知限制）；resize last-writer-wins |
| WS 消息畸形/超长（>1MB 文本帧） | 回 `BAD_MESSAGE` 并断开连接 |
| 登录后应用重启 | cookie 全失效，远程端跳登录页重认证，会话数据不丢 |
| PtyManager kill（ConPTY 挂起） | 沿用 5s 强杀守护；killAll 逐个串行，退出最坏 5s×N |
| 端口占用 | 启动失败弹窗 + 日志，提示改配置端口 |

## 7. 性能设计

- **延迟**：数据面为 PTY→Registry→WS 直转，无落盘；内网 RTT 主导，
  目标按键回显增量 <50ms。
- **吞吐**：`ws` 以 binary/text 帧直写；慢客户端 `bufferedAmount` 8MB
  断链保护，保证 PTY 读取循环永不阻塞。
- **内存**：每会话 = PTY 缓冲（node-pty 内部）+ 环形缓冲（默认 1MB）+
  客户端 xterm scrollback（5000 行，客户端自担）；`maxSessions=16` 上限。
- **广播节流**：`tabs` 广播 500ms 合并；`data` 不节流（保交互实时性）。

## 8. 变更记录

| 版本 | 日期 | 摘要 |
|------|------|------|
| v1.0 | 本次 | 初版，对应需求规格 v1.0 全部 FR 与已确认决策 |
