# M4 生命周期与重连 — 里程碑测试报告

> 日期：本轮执行 | 执行人：实施者（AI agent）
> 依据：`docs/verification-standard.md` §3.4 | 计划书 WBS-M4-A～D
> **补遗**：收尾后新增真浏览器端到端验证（见 §7），修复 5 个仅浏览器
> 可见的缺陷后全绿（11/11 ×3 连跑）。

## 1. 结论

**M4 全部 4 项 WBS 完成；自动化验证全绿**（重连套件 8/8、全项目回归
52/52、真实应用 TLS 端到端 8/8）。桌面驻留/托盘/窗口重开保会话的 GUI
用例（TC-M4-01/02/03/07）待需求方在本机桌面执行；断线重连核心
（TC-M4-05/08）已由真传输类自动化覆盖。

## 2. 交付内容

| 任务 | 文件 | 状态 |
|------|------|------|
| WBS-M4-A 托盘 | `src/main/tray.ts`：图标（build/icon.png，缺图自动 1px 兜底）、菜单【显示窗口/复制访问地址/查看访问信息（地址+证书指纹）/重置密码（轮换→存哈希→灭全部会话→弹窗展示一次）/退出】；tooltip 常显访问地址 | ✅ |
| WBS-M4-B 驻留 | `main.ts`：`window-all-closed` 空操作（TC-M4-02）；退出收敛为幂等 `shutdown()`（killAll→dispose→server.stop→托盘销毁→quit，TC-M4-07）；托盘/菜单栏“显示窗口”重建或聚焦窗口 | ✅ |
| 窗口重开保会话 | 新 IPC `tabs:getReplay`（ipcChannels/ipcHandlers/preload 三件套）；`LocalIpcTransport.getReplay`；`TerminalApp.addTabFromInfo` 恢复滚动历史（fire-and-forget，不阻塞实时流）；`TerminalTab.write()` 公开 | ✅ |
| WBS-M4-C 配置接线 | `replayBufferBytes`→`SessionRegistry` 构造、`maxSessions`→RemoteServer（M3 已接）；ConfigStore 五字段全量生效 | ✅ |
| WBS-M4-D 重连打磨 | `WebSocketTransport` 同构化：可注入 ws 实现+Cookie 头（浏览器行为不变）、计时器去 window 化、location 守卫；新增 `scripts/verify-reconnect.mjs`（`npm run verify:m4`） | ✅ |

## 3. 自动化验证结果

```
$ npm run verify:m1        ringbuffer 6/6 · registry 7/7
$ npm run verify:m3        auth+cert+config 14/14 · ws-protocol 18/18
$ npm run verify:m4        reconnect 8/8
$ node scripts/smoke-e2e.mjs   （真实 Electron + 托盘启动 + 真 bash + TLS）
  PASS ×8：健康检查/未认证 401/登录发 cookie/已有标签可见（窗口会话恢复）
        /新建会话/WSS 往返/第二客户端重放/干净关闭

verify-reconnect.mjs 场景（TC-M4-05/08 核心，真传输类）：
  bootstrap tabs → attach → 实时数据 → 【网络式硬断链（RST，无关闭帧）】
  → 服务端输出继续累积 → 退避重连（1s 起）→ 自动重 attach
  → 重放补齐断线前后全部输出 → 实时流恢复 → 输入送达 → listTabs 应答
  → 会话零重复                                   —— 8/8 PASS
```

## 4. 与方案书的偏差

1. **重放通道走可选接口方法**（`transport.getReplay?`）而非独立 IPC 广播：
   本地窗口经 invoke 拉取；Web 端本就经 `attached.replay` 获得，无需实现。
   接口语义更收敛，行为与方案书 §2.7 一致。
2. **传输层新增测试注入缝**（`wsImpl`/`wsOptions` 构造参数）：浏览器路径
   零改动，node 测试可注入 `ws` 包 + Cookie 头。方案书 §2.4 补记。
3. 托盘“查看访问信息”以对话框呈现地址+指纹（方案书要求托盘可见指纹）。
4. 无头测试模式（`TERNIMAL_HEADLESS_TEST`）跳过托盘与窗口，防 CI 无显示
   环境误伤——生产路径不受影响。

## 5. 待需求方执行的手动用例

- [ ] TC-M4-01 托盘五菜单逐项可用（含复制地址、重置密码后旧会话失效）
- [ ] TC-M4-02 关窗 ≥10 分钟，远程持续操作 Claude Code，本地进程仍在
- [ ] TC-M4-03 托盘“显示窗口”，标签与历史输出恢复
- [ ] TC-M4-04 手改 config.json（端口/缓冲上限）重启生效
- [ ] TC-M4-05 手机断 Wi-Fi 30s 恢复，输出补齐
- [ ] TC-M4-06（可选）`tc netem delay 200ms loss 5%` 弱网 2 分钟
- [ ] TC-M4-07 托盘退出：PTY 全灭、进程退出、端口释放
- [ ] §4 性能基准与 §5 SCENE-01 全流程（项目级 DoD）

## 6. 缺陷清单

无未修复 P0/P1。P2：托盘图标为应用图标复用（未做“驻留态”角标）；
重置密码弹窗为系统原生样式。

## 8. 补遗：鉴权改为动态令牌 + 扫码（用户需求迭代）

密码输入改为**动态访问令牌**（每次启动随机 192bit，`TERNIMAL_TOKEN` 可
覆盖；`timingSafeEqual` 比对；限速/锁定/cookie 机制不变）。托盘「查看
访问信息」弹**二维码**窗口（qrcode 依赖，URL/令牌/证书指纹同屏），
手机扫码 → `https://ip:port/#T=<token>` → 页面 JS 自动换取会话 cookie
并抹除片段（**片段不进服务器日志**）。「重置访问令牌」即时轮换并弹新
二维码。`/login` 保留为 GET 别名。测试全部随迁：verify:m3 31 项、
smoke、browser-e2e（新增"QR 式片段 URL 自动登录"用例，13/13 ×N）。

## 7. 补遗：真浏览器端到端验证（Chrome + puppeteer-core/CDP）

自动化到浏览器层（此前 WS/HTTP 客户端测不到：资源加载、表单 UX、
xterm 渲染、浏览器 cookie 行为）。`scripts/verify-browser-e2e.mjs`
（`npm run verify:browser`）：无头 Chrome 打真 HTTPS 服务全流程——

```
PASS ×11：未认证跳登录 / 登录表单 / 登录页指纹=服务端证书指纹 /
  错密码拒绝+错误提示 / 对密码落位 / 标签栏+初始标签渲染 /
  web.js+style.css 正常加载（非白屏）/ cookie HttpOnly+Secure+SameSite=Strict
  （浏览器视角实测）/ UI 按钮新建标签 / 浏览器键盘→PTY→bash→xterm 渲染回显
截图：docs/test-reports/screenshots/{login,terminal}.png
稳定性：修复后 3 连跑全绿
```

### 过程中发现并修复的缺陷（全部有回归覆盖）

| # | 缺陷 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | **Web 资源相对路径 404**：index.html 引用 `web.js`/`style.css` → 请求 `/web.js` 不在 `/static/*` 路由 → 真浏览器白屏 | **P0** | webpack `output.publicPath='/static/'` |
| 2 | **激活意图被去重吞噬**：广播先于 createTab 响应到达时，reconcile 以未激活收养会话，`addTabFromInfo(activate:true)` 被 has() 早退 → 标签永久隐藏 | P0 | 去重分支补 `if (opts.activate) switchTab(id)` |
| 3 | **Web 端从未 attach**：switchTab 不发 attach → 服务端拒绝输入（4003）→ 打字无效 | P0 | switchTab 调 `transport.attach(id)`（本地 IPC 为空操作）+ onAttached 重放填充无输出标签 |
| 4 | 未激活标签容器默认可见（堆叠遮挡点击） | P1 | addTabFromInfo 未激活即 `tab.hide()` |
| 5 | WS 未 open 时 create 消息静默丢弃 + createTab 新鲜度基线被自身更新污染 + favicon 404/CSP 噪音 | P1 | outbox 缓冲冲刷 / 基线快照 / 内联 icon |
| 6 | **每次刷新新建标签**（用户实测报告）：`listTabs()` 在 socket 未 OPEN 时直接返回空缓存 → `init()` 误判"服务端无会话"而建新标签 | P1 | listTabs 改为有界等待连接建立后再询问服务端（超时/主动关闭才回退缓存）；e2e 用例"刷新后恢复且不新建"，12/12 ×3 连跑 |
| 7 | **刷新向终端注入 `1;2c` 垃圾**（用户实测报告）：重放缓冲里的陈旧终端能力查询（DA/DSR/DECRQM/OSC 颜色查询；Claude Code 启动即发）被新 xterm 自动应答，应答被当作键盘输入写进 PTY | P1 | `SessionRegistry.getReplay()` 统一净化（单一出口，覆盖 WS attach 与本地 TABS_GET_REPLAY 两条路）；registry 单测（查询剥除/数据保留/OSC 非查询保留）+ e2e 差分用例"刷新零新增注入"，13/13 ×2 |

排查侧记：曾疑似"第三次 spawn 死锁"，最终判定为**系统高负载下 fork()
偶发慢启动（>10s）+ 测试轮询窗口过短**造成的假象——放宽到 30s 并修正
poll 条件表达式后稳定。裸 WS 压测（连开 5 会话）6/6 正常佐证。
