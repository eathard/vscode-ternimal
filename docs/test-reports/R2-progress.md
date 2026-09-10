# R-M2 阶段记录 — 插件宿主与接入（自动化子集全绿）

- 日期：本轮实施（实施者：agent，待需求方复核）
- 对应判据：`docs/relay-verification-standard.md` §3.2 + §3.2.1
- 状态：**WBS-R2 A–H 全部实现；自动化子集全绿；GUI 人工用例（TC-R2-01/02/03/05/06 视觉面）待需求方手工执行**

## R2-H smoke-e2e 扩展（本轮完成，验收标准见验收文档 §3.2.1）

| 场景 | 覆盖 | 结果 |
|------|------|------|
| SCENE-R2H-01 | RR1 spike（真 utilityProcess + ws + 指纹钉扎）/ TC-R2-06 自动化子集 | ✔ `relay: registered` 日志 + pid |
| SCENE-R2H-02 | TC-R2-10：假浏览器→relay→utilityProcess→loopback TLS→真 bash 三跳回显 | ✔ |
| SCENE-R2H-03 | TC-R2-07：`kill -9` 插件 → PluginHost 退避重启（pid 更换）→ 新隧道可用 | ✔ |
| SCENE-R2H-04 | TC-R2-04：应用退出后新旧 pid 均 ESRCH（零孤儿） | ✔ |

`node scripts/smoke-e2e.mjs` = **13 项 ALL PASS**（既有 M3 七项 + R2-H 六项）。

配套改动：状态事件贯通 pid（插件→PluginHost→主进程日志）；env 通道
`TERNIMAL_RELAY_URL/MASTER` 启用（不写用户配置）；smoke 的鉴权断言改为
双语义门（LAN 模式 401 / relay 模式首帧 AUTH_REQUIRED=4001——loopback 升级
免 cookie 是设计行为，业务帧在 auth 前一律拒绝）。

## 本轮（监督轮次 2 之前）完成

| 任务 | 状态 | 证据 |
|------|------|------|
| WBS-R2-E 设置面板 | ✔ RelayController + 6 IPC + preload + 齿轮 + 深色面板 | tsc + 构建 |
| WBS-R2-F tray/分享 | ✔ 状态项/复制分享链接/二维码切换 + 子码吊销 | 代码 + i18n |
| TC-R2-08（fork 子集） | ✔ E2E-08 断线重连 | verify-relay-e2e 8/8 |
| 产品缺陷 | relay `stop()` 未收割控制通道 → 显式 terminate | E2E-08 暴露 |

## 前轮完成（保留记录）

WBS-R2-A PluginHost（utilityProcess+崩溃退避重启+3s 强杀+请求面）；B 插件子进程
（控制重连/指纹钉扎/双向拼接/子码代理）；C 首帧 auth（auth-ok + 独立失败计数）；
D loopback 显式门控（`allowRelayFirstFrameAuth` 默认关）；G CopyPlugin 产物。
前轮修复：预拼接帧丢失（早期帧缓冲）、terminate 截断在途帧（优雅 close）、
reply id 覆盖；测试侧 3 起竞态/断言模型修正。

## 语义决议（已回写 relay-design.md §4.3）

- `allowRelayFirstFrameAuth` 显式门控：默认不开放 loopback 无 cookie 路径（TC-M3-04 不变）；
- AuthManager relayAuth 锁定语义与 HTTP login() 一致（第 5 次失败上锁并 429）；
- 运行时启用/绑定变更 → 保存即生效于下次启动（面板明示 restartRequired）；
- smoke 双语义门：鉴权拒绝的表现形态随模式（401 vs AUTH_REQUIRED），安全属性不变。

## 回归（R2-H 完成后全量）

`tsc --noEmit` 通过；`npm run build:main` 通过；smoke-e2e **13 项 ALL PASS**；
`npm run verify:relay` = 14/14 + 8/8；`npm run verify` 伞全绿
（6/8/13/18/8 + softkeys ALL PASS）；真浏览器 e2e（Chrome + 真实 Electron）
**21/21 ALL PASS**。

## R-M2 验收门状态

TC-R2-04/07/08/09/10/11：自动化通过（e2e + smoke + 伞）。
TC-R2-01/02/03/05/06：需真机 GUI 人工执行（面板交互/tray 视觉/ss 扫描/跨机探测），
自动化已覆盖其逻辑内核（注册日志/子码签发/进程退出/暴露面提示/loopback 绑定）。


