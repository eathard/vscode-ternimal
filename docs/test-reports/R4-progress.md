# R-M4 阶段记录 — 加固与体系化（自动化全部收口）

- 日期：本轮实施（实施者：agent，待需求方复核）
- 对应判据：`docs/relay-verification-standard.md` §3.4
- 状态：**WBS-R4-A/B/C/D 全部完成（自动化子集全绿）；R-M4 验收门仅余人工项（真公网/抓包/20 会话全量压测）**

## WBS-R4-A 挑战应答（TC-R4-01 自动化子集 = E2E-12，全绿）

协议与实现：

- `wsProtocol`：`{auth-challenge, nonce}`（server→client）与 `{auth-response, mac}`
  （client→server）；明文 `{auth, token}` 在中继路径一律 AUTH_REQUIRED（类型保留
  仅为识别）；
- `AuthManager`：`issueRelayNonce()`（32B base64url、30s TTL、容量 256、超量驱逐）；
  `verifyRelayMac(nonce, mac)`——**校验即焚**（nonce 单次有效）、HMAC-SHA256 +
  `timingSafeEqual`、失败计数与 login()/relayAuth 同语义（第 5 次失败上锁）；
- `RemoteServer`：pendingAuth 连接注册即下发挑战（零 bootstrap 语义不变、5s 时限
  不变）；`auth-response` 为唯一放行消息；
- `WebSocketTransport`：中继模式 onopen 仅发 join；收到挑战经 **WebCrypto**
  `crypto.subtle` 计算 HMAC 回 MAC（浏览器/Node 同码）；非安全上下文（无
  crypto.subtle 的 http 公网）→ gate denied 并给出明确原因；
- 插件对称早期缓冲：host 的 auth-challenge 可能先于插件 relayWs 就绪到达 →
  localWs 侧同样增加 ≤64KB 早期缓冲（relay/插件两侧缓冲对称，顺序保持）。

E2E-12 断言：① 正确 MAC → auth-ok；② 两次连接 nonce 不同 + **旧 MAC 重放 →
4005**；③ 明文 auth → 4001（Token 不得明文过中继）。

配套更新：e2e `remoteClient` 助手改挑战应答（必须在返回前 await 挑战，否则调用
方 next() 抢走挑战消息导致应答永不发出）；smoke-e2e 两处原始客户端同样改造。

## WBS-R4-B E2E 加密协议位（TC-R4-02 自动化子集 = E2E-13，全绿）

- `src/shared/e2ee.ts`：`deriveSessionKey`（HKDF-SHA256(token, nonce,
  'ternimal-relay-e2e-v1') → AES-256-GCM 256bit）/ `sealFrame`（随机 96-bit
  IV + AEAD）/ `openFrame`（GCM 校验失败 → null）；纯 WebCrypto，浏览器与
  Node≥18 主进程同码；
- 协商：auth-response 附 `enc:1`（客户端能力宣告）→ host `relayE2EE` 开启
  时 auth-ok 附 `enc:1`，此后双向业务帧一律 `{type:'secure', iv, ct}` 信封；
  加密连接上明文业务帧 = BAD_MESSAGE(4004) 断链；控制面保持明文；
- 开关：`RemoteServer{relayE2EE}`，main 进程 env `TERNIMAL_RELAY_E2EE=1`
  开启，**默认关 → E2E-01~12 语义零变化**（全部保持绿）；
- 顺序保证：双方 per-connection Promise 发送链（seal 完成顺序 = 线路
  顺序）；加密连接错误帧同样 seal 且 **close 排在 seal 之后**（实测同步
  close 会抢在异步 seal 前把错误帧吞掉——E2E-13 发现）；Token 不出
  AuthManager（新增 `deriveRelaySessionKey(nonce)`）；
- E2E-13 断言：①挑战应答+enc 协商 auth-ok{enc:1}；②密文可解（tabs）；
  ③密文业务往返（list→tabs）；④IV 每帧不同；⑤**旁观者（=relay/插件视角）
  auth-ok 后线路全部 secure 信封**；⑥明文违例 4004；⑦密文篡改 GCM 拒收
  断链；⑧真实 transport 加密全流程（create/attach/input 回显）。

## WBS-R4-C 矩阵/容量/checklist（TC-R4-03/04/05 自动化子集 = verify-relay-matrix 6/6）

`scripts/verify-relay-matrix.mjs`（自包含、严格退出码；已并入 `verify:relay` 链与
`npm run verify` 伞），3 连跑稳定：

| 用例 | 覆盖 | 断言 |
|------|------|------|
| M-01 | TC-R4-03 relay 重启 | 同主码原端口复活 → 插件退避重注册；内存 store 清空 → 旧子码 4001 → gate denied 明确提示不重试；新子码重建 → replay 兜底重启前输出 |
| M-02 | TC-R4-03 断网 30s（缩尺 2s） | 断网期 PTY 输出进 ring buffer → 恢复后 attach replay 补齐 |
| M-03 | TC-R4-03 插件被杀 | SIGKILL → 新插件同主码接管 → transport 重连 → 新会话交互可用 |
| M-04 | TC-R4-04 背压 | 节流洪泛 32MB → relay 仅硬终止慢管道（以管道表为断言：1 保留/1 回收）；健康客户端交互不受影响 |
| M-05 | TC-R4-04 容量 | 3072×4KiB ≈12MiB 全链路 **17~31 MiB/s**（目标 3MiB/s 的 6~10 倍）+ relay 字节计数 ≥ 实收 |
| M-06 | TC-R4-04 并发 | 单通道第 5 管道 BUSY(4004) 拒收；4 并发管道（通道上限）承载 16 交互会话全通 |

**过程中发现并修复的真实缺陷**：transport `FATAL_CLOSE_CODES` 与 relay 实际
关闭码表错位——4003 实为 HOST_OFFLINE（瞬态）被误判致命（插件重启期客户端
永久放弃重连），4008/4009（过期/吊销）反而缺失。已按 `protocol.mjs CLOSE`
对齐：致命 = {4001 错码, 4002 限速, 4008 过期, 4009 吊销}；瞬态码
（4003/4004/4005/4010/4011）走退避重连。M-03（接管恢复）由 ✘ 转 ✔。

**记录的容量特性（非缺陷）**：512KiB 合成大帧 + 接收端 JSON 解析停顿在
relay 默认 1MB 背压阈值下仅 2 帧余量可触发管道保护；真实终端帧 KB 级不受
影响。已记录进 checklist §3.5，v1.1 提案：阈值可配置/升 4MB + token-bucket。

**TC-R4-05**：`docs/relay-public-checklist.md` 交付（部署/安全/容量/演进
埋点/运维五节，逐项 ✔/▲/○/☐ 标注；人工阻塞项集中 §6）。

## WBS-R4-D 伞并入（D-R12）

`npm run verify` = m1 + m3 + m4 + softkeys + **relay（14/14 + 12/12）**，本轮
全量跑通。

## 验收轮发现并修复：二进制帧翻转（真浏览器专属致命缺陷）

**现象**：真 Chrome 打开公网分享链接 → gate 卡「Connecting」→ 5s 断连循环；
所有 Node 客户端（e2e/matrix/探针）全绿。
**根因**：relay/插件转发 `ws.send(data, { isBinary })` —— ws 发送选项名是
`binary`，`isBinary` 被静默忽略；ws 8 中 TEXT 帧到达处理器时载荷已是
Buffer，Buffer 无选项 → 按二进制帧发送。Node 端 `toString()` 对 Buffer
照样工作 → 全部自动化测试被掩盖；浏览器收到 Blob →
`String(ev.data)`='[object Blob]' → JSON 解析静默失败 → 挑战应答永不发出。
**修复**：5 处转发改 `{ binary: isBinary }`（server.mjs ×2、relayPlugin ×3）；
真 Chrome 复现 → 修复后 348ms 挂载终端、键入抵达 PTY。
**新工具**：`scripts/public-browser-check.mjs`（真 Chrome/CDP 公网验收，含
--local 本机复现模式）；`scripts/relay-capture-check.mjs`（tcpdump 抓包断言：
Token 明文 0 次、业务明文 0 次、secure 信封可见 → TC-R4-01/02 收口）。

## 回归（R4 全部落地后全量）

`tsc --noEmit` 通过；`npm run build` 三包全过；矩阵 **6/6 × 3 连跑**；
`verify-relay-e2e` **13/13**；基础套件 m1/m3/m4/softkeys 全绿（6/8/13/18/8 +
softkeys，含 reconnect 8/8——致命码对齐后 LAN/中继零回归）；smoke-e2e
**13 ALL PASS**（真 Electron + 真 bash）；真浏览器 e2e **21/21**。
`npm run verify` 伞 = m1+m3+m4+softkeys+relay（14/14 + 13/13 + 6/6）。
TC-R4-04 全量（verify-tc-load.mjs）：tc lo=3MB/s × 10min × 20 会话 —— 16 交互
4128 次回显 + 3 中度 7.2MB 全程存活；重度洪泛管道被 relay 背压保护终止且
不扩散（隔离性在真实限速下成立）。binary 修复后复跑：matrix 6/6、e2e 13/13、relay 14/14、smoke 13、真浏览器
21/21、公网探针 ✓、公网真 Chrome ✓、抓包断言 ✓（终验收报告见
docs/test-reports/final-acceptance.md）。

## 待人工（R-M4 验收门剩余）

- TC-R4-01/02 的 relay `--insecure` 抓包肉眼复核；
- TC-R4-04 全量：20 会话 × 10min × tc 3MB/s；
- TC-R3-04 真公网端到端（依赖 VPS/Caddy 部署，见 checklist §6）；
- E2EE 开关：settings 面板已提供开关（`config.relay.e2ee`，热切换、仅新会话
  生效），env `TERNIMAL_RELAY_E2EE=1` 仍可强制（优先于面板）。
