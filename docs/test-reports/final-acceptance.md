# 项目终验收报告（R-M1~R-M4）

- 日期：验收轮（实施者：agent；依据 `docs/relay-verification-standard.md` §3.1~§3.4）
- 结论：**通过（自动化可测范围 100% 覆盖、全绿）；仅余三项人工/环境项**（见 §5）

## 1. 验收证据矩阵

| 里程碑 | 判据 | 证据 | 结果 |
|--------|------|------|------|
| R-M1 §3.1 | relay 独立可用 | verify-relay **14/14**（含 TLS/限速/子码 TTL/背压/心跳/清理 8 场景） | ✔ |
| R-M2 §3.2 | 插件宿主/接入/隔离 | smoke-e2e **13 ALL PASS**（真 Electron+真 bash）；矩阵 M-03 接管；矩阵/探针插件无孤儿（forkPlugin connected-guard） | ✔ |
| R-M3 §3.3 | web 客户端中继模式 | 真浏览器 e2e **21/21**（LAN）；**真 Chrome 公网验收**（public-browser-check：零配置链接 → 终端 348ms~1845ms 挂载 → 键入抵达 PTY）；gate 卡片兜底在诊断中实证渲染 | ✔（04 手机蜂窝人工确认见 §5） |
| R-M4 §3.4 | 加固体系化 | 详见下行 | ✔ |

### R-M4 分项（验收门 TC-R4-01~06）

| 用例 | 自动化证据 | 结果 |
|------|-----------|------|
| TC-R4-01 挑战应答 | E2E-12（nonce 单次/每连接不同/重放 4005/明文 4001）+ **抓包断言**（relay-capture-check：Token 明文 0 次） | ✔ |
| TC-R4-02 E2E 加密 | E2E-13（13/13）+ **抓包断言**（业务明文 0 次、secure 密文信封可见） | ✔ |
| TC-R4-03 重连矩阵 | verify-relay-matrix **6/6**（M-01/02/03：relay 重启/断网/插件被杀） | ✔ |
| TC-R4-04 容量 | M-04/05/06：背压隔离、全链路 17~31MiB/s、4 管道×16 会话（20 会话×10min×tc 全量人工） | ✔（全量人工项见 §5） |
| TC-R4-05 公开 checklist | `docs/relay-public-checklist.md` + **公网部署已落地**（146.56.214.137，Caddy→relay systemd，探针+真 Chrome 双验证） | ✔ |
| TC-R4-06 伞 | `npm run verify` 退出码 0（含 relay 14/14 + e2e 13/13 + matrix 6/6） | ✔ |

## 2. 验收过程发现并修复的真实缺陷

1. **二进制帧翻转（致命，浏览器专属）**：relay/插件转发用 `ws.send(data, { isBinary })`
   ——ws 的发送选项名是 **`binary`**，`isBinary` 被静默忽略；ws 8 的 TEXT 帧到达
   处理器时载荷已是 Buffer，Buffer+无选项 → 自动按 **二进制帧** 发送。Node 客户端
   `toString()` 一律可用故全部自动化测试绿灯；**真浏览器收到 Blob** →
   `String(ev.data)` = `"[object Blob]"` → JSON 解析静默失败 → 挑战应答永不发出
   → 5s 认证超时 → 断连循环。修复：5 处转发改 `{ binary: isBinary }`
   （relay/src/server.mjs ×2、relayPlugin.mjs ×3）。真 Chrome 复现 → 修复 →
   348ms 挂载终端。教训已记入 relay-design（真实浏览器验收不可替代）。
2. **transport 致命关闭码表错位**（本轮早前）：4003 瞬态误判致命/4008/4009 缺失 → 已对齐。
3. **诊断期间发现残留 headless Chrome 抢占调试端口**导致跨 run 串台 → 验收脚本
   改为每 run 独立调试端口（工具性问题，记录备查）。

## 3. 公网部署验收（TC-R3-04 核心）

- 形态：Ubuntu 24.04 VPS + Caddy(443, tls internal, default_sni) → relay systemd
  （127.0.0.1:8080，webRoot=dist/web）；
- 探针（public-relay-probe）：插件 wss 注册 ✔、子码签发 191~308ms ✔、
  挑战应答+E2EE 公网协商 41~45ms ✔、密文回显 41~61ms ✔；
- **真 Chrome（public-browser-check）**：零配置链接 → E2EE → 终端挂载 →
  键入抵达 PTY ✔；
- 真 Electron 应用注册（utilityProcess 插件，env 直连）✔。
- 主码（两枚均有效）：`<凭据已脱敏——见服务器 relay-config.json 与运营记录>`

## 4. 最终回归（验收轮全量）

`tsc --noEmit` ✓；build 三包 ✓；伞全绿（6/8/13/18/8 + softkeys + relay 14/14 +
e2e 13/13 + matrix 6/6）；smoke **13**；真浏览器 LAN e2e **21/21**；
公网探针 ✓；公网真 Chrome ✓；抓包断言 ✓（全部在 binary 修复后复跑）。

## 5. 未尽事项（人工/环境，非代码）

1. ~~TC-R3-04 最后一环~~ **✔ 已确认**：手机真机打开分享链接直达终端（需求方
   原话「手机端可以访问」；证书警告选「继续访问」）。
2. ~~TC-R4-04 全量~~ **✔ 已通过**：`scripts/verify-tc-load.mjs` —— tc lo=3MB/s
   × 10 分钟 × 20 会话（16 交互 4128 次回显 + 3 中度 7.2MB 全存活；重度管道
   背压终止不扩散）。
3. 生产收口：域名 + Let's Encrypt（消除内部 CA 的浏览器提示与 NODE_EXTRA_CA_CERTS）；
   ufw 仅放行 22/80/443。
4. （v1.1 backlog，方案书已列）per-pipe token-bucket、背压阈值可配置。
