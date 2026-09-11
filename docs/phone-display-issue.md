# 手机端显示问题：反馈描述与解决方案

> 状态：问题一已修复（b91b3ff）；问题二已实施并三轮验收通过（见文末）
> 来源：产品所有者实测反馈（2026-09-11）

## 一、用户反馈的问题

> 「现在手机上的格式显示经常错乱」「之前局域网版本根本没有这样的问题，
> 这是核心啊」「手机端旋转为什么会影响到终端内的显示」

拆解为两个独立问题：

### 问题 1：手机端终端内容错乱/花屏（真缺陷，已修复）

- **现象**：手机浏览器打开局域网分享页，终端文字错乱、花屏、闪烁；
- **复现条件**：手机（触屏/移动 UA）+ WebGL 可用的浏览器；键盘弹出、
  旋转、高频重绘内容（spinner/进度条）下加剧；
- **影响面**：所有手机 Web 观看端——商用场景的核心路径；
- **为何之前没暴露**：自动化套件的运行环境 WebGL 初始化失败，静默走了
  DOM 渲染器回退，恰好绕开了故障路径；桌面端 Electron 的 WebGL 稳定，
  也不受影响。

**根因**：`@xterm/addon-webgl` 的画布渲染在移动端天然脆弱——键盘弹出
引发 resize 重排竞态（字撕裂/错位）、移动 GPU 频繁回收 WebGL 上下文
（闪烁）、高分屏 devicePixelRatio 缩放残影。

**修复**（b91b3ff，已发布本机+Windows 包）：`xtermWrapper.enableWebgl()`
检测 `pointer: coarse` 或移动 UA 即整会话强制 DOM 渲染器；桌面维持
WebGL。验证：390px 手机仿真 + 5 轮键盘开合风暴中输出内容完整、零乱码、
零转义泄漏；全套件绿。

### 问题 2：手机旋转改变会话几何（设计特性，待改造）

- **现象**：旋转手机，终端会话本身被重排；若桌面与手机同挂一个会话，
  桌面显示也跟着变；
- **机制**：旋转 → fit 重算列数 → resize 消息 → **共享 PTY 真被 resize**
  （实测 stty 80→98 列）→ 程序收 SIGWINCH 重绘。这是初版设计：
  last-writer-wins + 200ms 服务端去抖（technical-design.md 风险 R4）；
- **为何之前无感**：之前手机通常是唯一观看端，旋转=自然重排；现在双端
  同挂测试暴露了互抢几何。

## 二、解决方案（问题 2）

**核心原则：会话几何归「创建者」，观看者不抢。**

| 端 | 行为 |
|---|---|
| 桌面窗口 | 不变：拖拽即 resize（创建者权利，拖动跟手 UX 保留） |
| 手机观看**他人创建的会话** | **跟随模式**（默认）：按会话自身列宽渲染 + 缩放适配屏宽；旋转/键盘弹出=纯显示层变化，PTY 零影响 |
| 手机自己点 + 创建的会话 | 自动拥有者：fit + resize（现行为，延续直觉） |
| 观看端需要几何 | 每标签「适配本机宽度」开关，一键接管，关即还 |

**实现要点**（纯客户端，零协议变更）：

1. `SessionInfo` 增加 `cols/rows`（registry 内部已知，透出即可）；
2. web 客户端跟随模式：xterm 按会话 cols/rows 初始化，容器 CSS 缩放适配；
3. 自建标签（本端点 +）自动进入拥有者模式；开关存 localStorage；
4. 服务端 last-writer-wins 原样保留（开关打开即 last-writer，语义自洽）。

**明确不做**：tmux 式最小客户端优先（会把桌面大窗锁成 44 列，更糟）；
服务端强占用/租约（复杂度无收益）；每客户端虚拟几何（需服务端终端
模拟，摧毁零知识简洁性）。

**验收标准**：

- [ ] 手机观看桌面会话，旋转 5 次会话 stty 尺寸不变、内容零损伤；
- [ ] 键盘开合风暴中跟随模式渲染稳定；
- [ ] 手机自建会话旋转仍正常自适应（拥有者行为不回退）；
- [ ] 「适配本机宽度」开关双向生效，重启浏览器记忆；
- [ ] M4/browser 套件 + smoke-e2e + 手机仿真探针全绿；桌面拖拽跟手无回退。

**工作量**：约 0.5~0.8 天（含验证）。

## 三、实施记录（问题二）

- `terminalTab`：`geometryOwner` 守卫——跟随者本地 fit 但不发送 resize；
  接管时立即以当前尺寸同步（`setGeometryOwner(true)`）。
- `terminalApp`：`createdHere` 集合 + `setFollowMode` + 每标签 localStorage
  覆盖（`ternimal.adapt.<id>` = '1'/'0'）+ `toggleAdapt`/`isGeometryOwner`。
  关键坑：reconcile 先于 createTab 到达时去重路径会吞掉 createdHere
  标记——去重分支需补记（否则自建会话被误判为跟随者）。
- web 入口：默认开启跟随模式 + 「适配本机宽度」chip（i18n 中英）。
- 服务端零改动（registry 本就随 resize 更新 SessionInfo 并广播）。
- 验收（scripts/verify-web-follow.mjs，手机仿真，3 轮全过）：
  - [x] 自建会话旋转改变 stty（32 111 → 18 98）
  - [x] 跟随会话旋转×5 stty 不变
  - [x] chip 接管后旋转变；还回后旋转不变
  - [x] verify 伞 + smoke-e2e 全绿；桌面（Electron）路径零改动

### 修正记录：跟随渲染从「本机折行」改为「固定会话几何+整体缩放」

首版跟随模式让观看端按自己窄屏折行渲染——对纯流式内容（echo/编译日志）
没问题，但 TUI（claude/vim/htop）按 PTY 列宽做**绝对光标定位**，44 列视
图渲染 111 列流时光标序列落错位置 = 花屏。修正：

- `xtermWrapper.setFixedGeometry(cols, rows)`：跟随端 xterm 固定使用会话
  自身几何渲染（`Terminal.resize` 到 SessionInfo 的 cols/rows），永不折行；
- `applyFollowScale()`：量 `.xterm-screen` 自然宽，根元素显式设宽后整体
  `transform: scale(k)` 适配容器（k=min(宽比, 高比)，下限 0.15）；旋转/
  键盘弹出只重算 k；
- `reconcileTabs` 对跟随标签同步会话几何（宿主 resize 后观看端跟随更新）；
- `TerminalTab` 构造参数 `follower`——在 attachToDom 的首次 fit 之前就位，
  杜绝跟随端 attach 瞬间向 PTY 发一次 resize 的「闪踢」。

复验：B3 断言「100 连 X 只占 1 视觉行」（xterm 几何=会话几何的数学证明）
+ transform=scale(0.418)=390/933（111 列）恰为理论值；A/B/C/D 四段 3 轮
稳定；verify 伞 11 套件 + smoke-e2e 全绿。

## 四、复盘：WebGL 移动端禁令是误伤（已撤销）

用户报告 v1.2 中 claude 图标（✳）从黄色变灰白。双版本并行实测定位：

- claude 输出流**零颜色码**——黄色来自 U+2733 的**彩色 emoji 字形呈现**；
- WebGL 渲染器经 2D 画布 fillText 光栅化，能保留彩色 emoji（黄 ✳）；
- DOM 渲染器是文本 span，手机字体栈把 U+2733 解析为单色字形 → 灰白；
- 而乱码真凶是共享会话几何（问题二已修）——WebGL 禁令属误伤。

处置：撤销 b91b3ff 的移动端强制 DOM（恢复 v1.1 行为：全端优先 WebGL，
初始化失败仍走 webglFailed 静态降级）。复验：v1.2@手机UA 与 v1.1 渲染
**逐像素一致**（yellow:121/gray:1583 完全相同）；verify 伞 11 套件绿；
跟随模式/适配 chip 不受影响。

## 五、附记：「claude 图标黑白」排查全记录（非 Ternimal 回归）

现象：系统终端里 claude 橘黄 logo，Ternimal 里黑白。逐层排除：渲染器
（五路径像素级一致）→ 终端能力查询（DA1/DA2/OSC10/11 全部正常响应）→
**真凶：启动 App 的环境带 `NO_COLOR=1`**（调试 shell 泄漏），claude 遵循
no-color.org 规范整体褪色；而用户从桌面图标启动的 App/系统终端无此变量。

修复（本仓库）：`ptyManager` spawn 时剔除 NO_COLOR/CLICOLOR/FORCE_COLOR/
CLICOLOR_FORCE——终端标签是全新交互 TTY，GUI 继承链上的颜色偏好属意外
泄漏。验证：NO_COLOR=1 污染启动下 claude 仍全彩（彩色像素 6219）。

教训：跨终端对比 CLI 行为时，先 diff 两边的 `env`；像素取证前先确认
进程环境一致。
