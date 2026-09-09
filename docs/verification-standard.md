# Ternimal 远程多标签终端 — 验证标准文档

> 版本：v1.0
> 上游文档：`docs/remote-terminal-requirements.md`（需求规格）、
> `docs/technical-design.md`（技术方案书）
> 用途：里程碑验收门（对应计划书 §4）与项目最终验收的统一判据。
> 结论只有三种：**通过 / 不通过 / 不适用（需注明理由）**，不允许"基本通过"。

## 1. 验证策略总览

| 层 | 手段 | 覆盖 |
|----|------|------|
| 单元/模块 | 自动化验证脚本 `scripts/verify-*.mjs`（Node 直跑，无框架依赖） | RingBuffer、SessionRegistry、限速器、配置模块 |
| 协议联调 | 自动化 WS 客户端脚本（`ws` 库扮演远程客户端） | WS 协议全消息、认证握手、重连重放 |
| 端到端 | 手动测试用例（本表 §3–§5，含真实 Claude Code 会话） | 交互体验、移动端、生命周期 |
| 回归 | 本地 Electron 全功能清单（§6） | 每里程碑必跑 |
| 稳定性 | soak 测试（§7） | M4 验收前执行一次 |

验证环境基线：

- 宿主机：Deepin 桌面 Linux，Node 与依赖按仓库 README/CLAUDE.md 就绪
  （`npm install` + 如动过原生模块则 `npm run rebuild`）
- 远程端 A：同局域网另一台 PC 的 Chrome/Firefox 最新版
- 远程端 B：同局域网手机浏览器（Android Chrome 与 iOS Safari 至少其一，
  两者的证书信任流程差异需各验一次）
- 网络模拟：`tc qdisc` 或断开 Wi-Fi 5s/30s 模拟弱网（可选 masque 无关，
  用系统自带手段即可）

执行纪律：每个用例记录执行日期、执行人、结果、证据（截图/日志摘录/
脚本输出），汇总入 `docs/test-reports/` 目录。

## 2. 自动化验证脚本（交付物 D8）

| 脚本 | 验证对象 | 判定 |
|------|----------|------|
| `scripts/verify-ringbuffer.mjs` | 追加/超限丢弃/快照一致性/清空 | 断言全过，退出码 0 |
| `scripts/verify-registry.mjs` | create/kill/list/write/resize 钳制/事件次序/tabs 广播 | 同上 |
| `scripts/verify-ratelimit.mjs` | 5 次/分阈值触发与 1 分钟解锁 | 同上 |
| `scripts/verify-ws-protocol.mjs` | 未认证拒握手、list/attach/input/resize、畸形消息断链、心跳超时 | 同上 |
| `scripts/verify-reconnect.mjs` | 模拟断链→重连→attach→replay 与断链前输出衔接 | 同上 |
|  `scripts/verify-browser-e2e.mjs` | **真浏览器全流程**（`npm run verify:browser`）：未认证重定向、鉴权页与指纹核对、错令牌/**二维码式 `#T=` 片段 URL 自动登录**、标签栏与 UI 按钮、cookie 三属性、xterm 键入→PTY→bash→渲染回显、**刷新后恢复且不新建标签、刷新零陈旧查询注入（无 `1;2c` 垃圾）**、软键盘真实 Ctrl+C 中断 sleep + 一次性复位、悬浮条位置稳定/拖动持久化/重载恢复、切标签清组合键；产截图 `docs/test-reports/screenshots/` | 同上 |

脚本运行前置：`verify-ringbuffer/registry/ratelimit/ws-protocol/reconnect`
仅依赖 `node`（≥18）与仓库 `node_modules`，自起最小 Registry/Server 实例；
`verify-browser-e2e` 额外需要系统 Chrome（puppeteer-core 驱动 CDP，
`/usr/bin/google-chrome`）并自起真实 Electron 应用。

## 3. 里程碑验收门

### 3.1 M1 — 会话中台（本地零回归前提下的内部重构）

| 用例 | 前置 | 步骤 | 预期 |
|------|------|------|------|
| TC-M1-01 | `npm run dev` 启动 | Ctrl+Shift+T 连开 3 个标签，各跑 `htop`/`vim`/`claude` | 各标签独立交互，输出无串扰 |
| TC-M1-02 | M1 完成 | 关闭活动标签（Ctrl+W） | 仅该标签 PTY 退出，其余不受影响；列表只剩 2 |
| TC-M1-03 | 应用运行中开过标签 | 关闭整个应用窗口→重新 `npm run dev` | 标签列表恢复（listTabs 生效，PTY 已随退出销毁属预期，验证点是列表恢复不报错、空列表正常新建初始标签） |
| TC-M1-04 | 两个标签 | 在标签 1 跑 `echo $TERM` | 输出 `xterm-256color`（spawn 环境变量不回归） |
| TC-M1-05 | 跑 `claude` 的标签 | 观察 ≥5s | 标签标题随 Claude Code 进程名更新（修复既有 checkTitle 未定时调用缺陷） |
| TC-M1-06 | — | `node scripts/verify-ringbuffer.mjs && node scripts/verify-registry.mjs` | 退出码 0 |
| TC-M1-07 | — | §6 本地回归清单全跑 | 全部通过 |

**M1 验收门：TC-M1-01～07 全通过。**

### 3.2 M2 — 远程数据通路（HTTP 裸跑阶段）

| 用例 | 前置 | 步骤 | 预期 |
|------|------|------|------|
| TC-M2-01 | 宿主机标签 1 正在跑 `claude`（已有大量输出）；远程端 A 打开 `http://<host>:<port>` | 点击标签 1 | 附件即重放历史输出（含 Claude Code 当前 TUI 状态），随后实时更新 |
| TC-M2-02 | TC-M2-01 基础上 | 远程端键盘输入 "status" 并回车 | Claude Code 响应该输入；本地窗口同步看到相同输出 |
| TC-M2-03 | 本地 + 远程各开一标签 | 远程端新建标签、关闭另一标签 | 本地标签栏实时同步增删（onTabsChange 生效） |
| TC-M2-04 | 远程端 A 附着中 | 宿主机本地窗口 resize（拖大窗口） | PTY 尺寸随本地（最后操作者）；远程端 xterm 出现滚动条或 reflow，不崩溃 |
| TC-M2-05 | 远程端 A 附着标签 1 | 本地关闭标签 1 | 远程端收到 exit 提示；标签从两端列表消失 |
| TC-M2-06 | — | `node scripts/verify-ws-protocol.mjs` | 退出码 0 |
| TC-M2-07 | — | `npm run build` 后确认 `dist/web/` 产物完整（index.html/web.js/css） | 文件齐全且浏览器加载无 404 |

**M2 验收门：TC-M2-01～07 全通过。**

### 3.3 M3 — 安全

| 用例 | 前置 | 步骤 | 预期 |
|------|------|------|------|
| TC-M3-01 | 首次启动 | 查看托盘/日志中的证书指纹；远程端访问 `https://<host>:8443` | 证书告警页指纹与展示一致；手动信任后可访问（Android/iOS 各验一次） |
| TC-M3-02 | 打开鉴权页 | 输入错误令牌 | 拒绝并提示；扫托盘二维码（`#T=` 片段 URL）自动登录跳转终端页 |
| TC-M3-03 | 登录成功后 | 检查 cookie | `ternimal_session` 存在且属性为 HttpOnly/Secure/SameSite=Strict |
| TC-M3-04 | 未登录状态 | 直接发起 WS `/ws` 握手（可用脚本） | 握手被拒（401），收不到任何会话数据；浏览器端被导回登录页 |
| TC-M3-05 | 鉴权页 | 同一 IP 连续输错 5 次令牌 | 第 6 次起返回限速提示；1 分钟后可再试 |
| TC-M3-06 | 服务运行中 | `curl http://<host>:8443/`（明文） | 明文数据面不可用（拒绝或重定向至 https，不返回页面内容） |
| TC-M3-07 | — | `curl -I https://<host>:8443/static/../package.json` 类路径穿越尝试 | 403/404，读不到 webRoot 外文件 |
| TC-M3-08 | 登录成功 | 托盘"重置访问令牌"→ 旧浏览器刷新 | 旧 cookie 失效，需重新扫码/用新令牌登录 |

**M3 验收门：TC-M3-01～08 全通过。**

### 3.4 M4 — 生命周期与重连

| 用例 | 前置 | 步骤 | 预期 |
|------|------|------|------|
| TC-M4-01 | 应用运行 | 查看托盘 | 菜单含：显示窗口/复制访问地址/查看访问信息（二维码）/重置访问令牌/退出，功能逐项可用 |
| TC-M4-02 | 标签 1 跑 `claude`，远程端已附着 | 关闭本地窗口，等待 ≥10 分钟，远程端继续操作 | 会话存活，远程交互不中断；本地进程未退出（托盘在） |
| TC-M4-03 | TC-M4-02 之后 | 托盘"显示窗口" | 窗口重建，标签恢复，历史输出仍在 |
| TC-M4-04 | 手改 `config.json` 端口/缓冲上限后重启 | 验证生效（netstat 端口、重放大小变化） | 配置项全部生效 |
| TC-M4-05 | 远程端 B（手机）附着跑 Claude Code 的标签 | 断开手机 Wi-Fi 30s 再恢复 | 自动重连→重放补齐断线期间输出；Claude Code 会话未死 |
| TC-M4-06 | 弱网（可选） | `tc netem delay 200ms loss 5%` 下持续操作 2 分钟 | 可用性不崩；心跳不误杀（30s×2 阈值下） |
| TC-M4-07 | — | 托盘"退出" | 全部 PTY 终止、进程退出、端口释放 |
| TC-M4-08 | — | `node scripts/verify-reconnect.mjs` | 退出码 0 |

**M4 验收门：TC-M4-01～08 全通过。**

## 4. 性能基准（M2、M4 各测一轮）

| 指标 | 测量方法 | 判定线 |
|------|----------|--------|
| 按键回显延迟（远程） | 远程端跑 `time read -n1` 类回显程序，肉眼/录屏对比本地；或脚本测 WS input→data RTT 分位数 | P50 < 50ms，P99 < 150ms（内网） |
| 输出吞吐 | 标签内 `yes | pv > /dev/null` 持续 30s，远程端附着 | 客户端不断链（bufferedAmount 保护不触发），UI 无冻结 |
| 大量输出下的 attach | 先 `cat` 一个 50MB 文本产生输出，再远程 attach | 重放在 2s 内完成，内存无持续增长 |
| 会话内存 | 16 标签各跑 10 分钟 htop，记录主进程 RSS | 稳定值 < 600MB，无单调增长趋势 |
| 启动时间 | `npm run dev` 到可交互 | 与基线（改造前）差 < 500ms |

## 5. 真实场景验收（项目级，DoD 第 4 条）

SCENE-01 全流程（必须由需求方亲自执行）：

1. 本地开 3 个标签，其一运行真实 Claude Code 执行一个 ≥10 分钟任务；
2. 手机（内网/VPN）HTTPS 登录，接管该标签：查看进度、发送追加指令、
   用 Esc 中断一次操作；
3. 途中断网 30 秒再恢复，验证重连与输出补齐；
4. 回到本地电脑，重开窗口继续操作同一 Claude Code 会话；
5. 全程本地与远程标签列表一致，无崩溃、无会话丢失。

判定：5 步全部顺畅完成，Claude Code 会话状态始终正确。

## 6. 本地回归清单（每里程碑必跑）

| # | 项 | 判定 |
|---|----|------|
| 1 | Ctrl+Shift+T 新标签 / Ctrl+W 关 / Ctrl+Tab 轮换 / Ctrl+Shift+2/3 方向切换语义不变 | 行为与改造前一致 |
| 2 | Ctrl+Shift+F 搜索可找可跳 | 正常 |
| 3 | Ctrl+Shift+L 主题切换，新旧标签均生效 | 正常 |
| 4 | WebGL 渲染正常（about:gpu 或肉眼平滑度；失败时 DOM 回退） | 正常 |
| 5 | 右键复制/粘贴（本地窗口内） | 正常 |
| 6 | 窗口拖拽 resize → PTY 尺寸跟随、内容 reflow | 正常 |
| 7 | 中文/emoji 输入显示（Unicode11） | 正常 |
| 8 | vim/htop 全屏 TUI 无渲染异常 | 正常 |
| 9 | 应用正常退出无残留进程/僵尸 PTY | 正常 |

## 7. 稳定性（soak）测试

- 条件：8 小时，8 个标签（含 1 个 Claude Code 会话、2 个 htop、5 个
  闲置 shell），远程客户端每 30 分钟随机断连重连一次。
- 判定：主进程 RSS 无单调增长（每 2 小时采样）；无未捕获异常退出；
  全部标签会话存活；验证脚本日志无错误。
- 时机：M4 验收门通过后、最终验收前执行一次。

## 8. 缺陷与验收管理

- 缺陷分级：**P0**（阻断核心场景/安全破口/数据丢失）→ 当前里程碑门禁
  关闭，立即修复；**P1**（功能不可用但有绕行）→ 里程碑内修复或需求方
  书面接受带病通过；**P2**（体验瑕疵）→ 记录进二期清单。
- 里程碑验收记录模板：用例编号 / 结果 / 证据 / 执行人 / 日期，存
  `docs/test-reports/M{n}-report.md`。
- 最终验收 = 计划书 §8 DoD 四条全部满足 + 本文档 §3–§7 全绿 +
  SCENE-01 由需求方签署。

## 9. 变更记录

| 版本 | 日期 | 摘要 |
|------|------|------|
| v1.0 | 本次 | 初版，用例编号与计划书/技术方案书引用一致 |
