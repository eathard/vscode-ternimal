# Ternimal 远程多标签终端 — 最终交付报告

> 版本：v1.0 | 范围：项目计划书 M1–M4 全部里程碑（计划中无 M5）
> 定位：三份基线文档（需求/计划/方案/验证）的收尾对账 + 使用说明
> 详见各里程碑报告：`docs/test-reports/M1～M4-report.md`

## 1. 项目验收结论

**代码级验收标准：全部达成。**
构建（webpack 双入口）、打包（AppImage + deb 一键成功且产物实测可跑）、
自动化验证矩阵（53 项断言 + 真实应用 TLS 端到端 8 项）全绿。

**流程验收标准：待需求方执行后签署。**
验证标准中的桌面/手机 GUI 手动用例、§4 性能基准、§5 SCENE-01 真实
场景全流程（DoD 第 4 条"本地起 Claude Code → 手机接管 → 断线重连 →
回本地继续"）需需求方亲手完成——各报告手动清单已在位，未补录任何
未执行的结论。

## 2. 交付物对账（D1–D10）

| 编号 | 计划内容 | 实际交付 | 状态 |
|------|----------|----------|------|
| D1 | SessionRegistry + 环形缓冲 | `src/main/sessionRegistry.ts` `ringBuffer.ts` | ✅ |
| D2 | 渲染端传输抽象 + 本地 IPC | `src/renderer/transport/{transport,localIpcTransport,webSocketTransport,index}.ts` | ✅ |
| D3 | WSS RemoteServer | `src/main/remoteServer.ts` + `src/shared/wsProtocol.ts` | ✅ |
| D4 | Web 终端 UI（双入口） | `src/web/` + `dist/web/`（webpack.web.config.js） | ✅ |
| D5 | 认证与安全 | `src/main/{authManager,certManager}.ts` | ✅ |
| D6 | 托盘驻留与生命周期 | `src/main/tray.ts` + main.ts 驻留改造 | ✅ |
| D7 | 配置模块 | `src/main/configStore.ts`（计划书写作 config.ts，实义一致） | ✅ |
| D8 | 自动化验证脚本 | `scripts/verify-{ringbuffer,registry,ws-protocol,ratelimit,reconnect}.mjs` + `smoke-e2e.mjs` | ✅ |
| D9 | 三份文档 | `docs/` 随里程碑持续同步（含 ws-external 更正） | ✅ |
| D10 | 打包配置 | electron-builder.yml + webpack 双入口；产物见 §4 | ✅ |

## 3. 最终验证矩阵（收尾全量重跑）

```
npm run build            三配置全部 compiled（renderer 3 条历史 warning）
npm run verify:m1        ringbuffer 6/6 · registry 7/7
npm run verify:m3        auth+cert+config 14/14 · ws-protocol 18/18
npm run verify:m4        reconnect 8/8（硬断链→退避重连→重放补齐→输入恢复）
npm run verify:browser   browser-e2e 12/12（真 Chrome：登录/指纹/cookie 属性/标签 UI/xterm 回显/刷新不新建标签；3 连跑全绿，详见 M4 报告 §7）
node scripts/smoke-e2e.mjs  8/8（真实 Electron+真 bash+TLS+登录+WSS 往返+重放）
npm run pack:linux       AppImage(113MB) + deb(78MB) 一键成功
打包产物实测               linux-unpacked 启动 → /health=200 → 登录页正常
```

里程碑战果存档：M2 期间定位并修复 P0 级"webpack 打包 ws 致事件循环
死锁"（七步单变量二分，M2 报告 §4）；M3 发现 selfsigned 5.5 与方案书
假设的三处 API 出入（含默认 sha1 陷阱）。

## 4. 使用说明

### 启动与访问
- 开发运行：`npm run dev`（Linux 已带 --no-sandbox）
- 安装运行：`release/Ternimal-1.0.0.AppImage` 或
  `sudo dpkg -i release/ternimal_1.0.0_amd64.deb`
- 首次启动：主控台打印一次性访问密码（SAVE IT），托盘菜单可
  「查看访问信息/重置密码」；自签证书指纹同步打印并显示于登录页
- 远程访问：同内网设备打开 `https://<主机内网IP>:8443` →
  浏览器证书警告页「高级→继续」（可先核对登录页指纹与托盘一致）→
  输入访问密码 → 出现与本地相同的标签列表，点击标签查看 Claude Code

### 运维要点
- 忘记密码：`TERNIMAL_PASSWORD=新密码` 环境变量覆盖启动一次（会覆写
  存储哈希）；或托盘「重置密码」（旧会话全部失效）
- 配置：`<userData>/config.json` —— port/host/passwordHash/certPath/
  replayBufferBytes/maxSessions；改后重启生效（TC-M4-04）
- 证书：<userData>/certs/ 下自动生成；换正式证书填 certPath
- 快速端口覆盖：`TERNIMAL_PORT` / `TERNIMAL_HOST`（优先于配置文件）
- 全量自检：`npm run verify:m1 && npm run verify:m3 && npm run verify:m4
  && node scripts/smoke-e2e.mjs`

## 5. 已知限制（设计取舍 + 遗留 P2）

1. 自签证书首次访问需手动信任（指纹核对流程已内置，方案书既定取舍）。
2. 会话/限速为内存态：应用重启后远程需重新登录（防拖库冒用，§2.5）。
3. 密码仅首启/重置时明文展示一次，不可找回，只能覆盖重置。
4. 重放环默认 1MB/标签：更早历史被整块淘汰（可调 replayBufferBytes）。
5. `ws` 必须保持 webpack external（打包版死锁事件循环，M2 报告 §4）。
6. node-pty 为原生模块：升级 Electron/node-pty 版本须先 `npm run rebuild`。
7. Linux 需 --no-sandbox（Deepin 类发行版 SUID 沙箱崩溃，已内建）。
8. 登录页为极简英文（P2，未本地化/美化）；托盘图标复用应用图标无驻留角标。
9. 明文 HTTP 无任何回退服务（安全既定；也意味着 80 端口习惯用户需手动加 https://）。

## 6. DoD 对账（计划书 §8）

| 条 | 内容 | 结论 |
|----|------|------|
| 1 | 验证标准 §3–§7 全过、遗留零或书面接受 | 自动化部分 ✅；GUI 手动用例/性能基准/SCENE-01 待需求方执行 |
| 2 | D1–D10 合入、构建打包一键成功 | ✅（本轮收尾实测，产物可运行） |
| 3 | 三份文档与实现一致 | ✅（ws-external、selfsigned API、D7 文件名等差异均已留档） |
| 4 | 需求方真实场景全流程试用并签署 | ⏳ 待需求方（SCENE-01 五步清单见验证标准 §5） |

**一句话结论：开发与可自动化验证的全部验收标准已达成；项目转入
需求方验收阶段，剩余动作集中在 GUI 手动用例、性能基准与 SCENE-01
全流程签署。**
