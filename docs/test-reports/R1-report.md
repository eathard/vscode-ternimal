# R-M1 验收记录 — relay 服务核心

- 日期：本轮实施（实施者：agent，待需求方复核）
- 对应判据：`docs/relay-verification-standard.md` §3.1
- 套件：`npm run verify:relay`（`scripts/verify-relay.mjs`）

## 结果汇总

**14/14 通过**（TC-R1-01～12 全绿，另含 2 个附带语义用例）。

| 用例 | 结果 | 证据摘要 |
|------|------|----------|
| TC-R1-01 主码签发 CLI | ✔ | 配置仅存 SHA-256 哈希、明文不落盘、二次签发不同码 |
| TC-R1-02 管道贯通 | ✔ | 4KB 随机二进制 ×2 方向 + JSON 文本帧逐字节一致；字节计数累加 |
| TC-R1-03 错主码限速 | ✔ | 前 5 次 close 4001，第 6 次 4002（锁定） |
| TC-R1-04 过期/吊销子码 | ✔ | 4008 / 4009；控制通道不受影响 |
| TC-R1-05 挂起超时 | ✔ | 200ms 注入 → 4005 + pending 表清理 |
| TC-R1-06 接管收割 | ✔ | 旧控制连接 4010；旧管道全断；新通道存活；子码保留 |
| TC-R1-07 并发上限 | ✔ | 4 管道满载后第 5 个 join → 4004 |
| TC-R1-08 背压终止 | ✔ | 32KB 阈值 + 4MB 突发 → 仅该管道终止，对照管道/控制通道存活 |
| TC-R1-09 子码 API | ✔ | 签发 201/列表/吊销 200/404/错主码 401 |
| TC-R1-10 静态+穿越守卫 | ✔ | 裸 TCP 原样路径（fetch 会规范化，故不用 fetch）→ 403/404 无泄露 |
| TC-R1-11 心跳收割 | ✔ | 120ms 心跳 ×2 周期无 pong（裸 TCP 客户端）→ 收割且 pending 归零 |
| 附带：首帧守卫 | ✔ | 150ms 超时 → 400x 断链 |
| 附带：控制通道后续消息 | ✔ | register 后再发消息 → 4006 BAD_MESSAGE |
| 附带：未知路径 upgrade | ✔ | socket 拒绝 |

## 交付物对照（relay-plan.md §2）

D-R1 `relay/src/server.mjs`+`store.mjs` · D-R2 `relay/cli.mjs` · D-R3 管理 API（server.mjs 内）·
D-R4 `scripts/verify-relay.mjs`（`npm run verify:relay`）· D-R5 `relay/Caddyfile`+`relay/README.md`+`relay/package.json`

## 回归

- `npm run verify`（主项目伞）全绿，零回归。
- CLI 实跑冒烟：`add-master` → `serve` → `GET /health` → 优雅退出，正常。

## 遗留

- 无 P0/P1。TC-R1-10 首版用例自身有缺陷（fetch 规范化路径 + secret 放置在 webRoot 内），已修正为裸 TCP 原样路径后通过——服务端守卫逻辑无需改动。
- TC-R1-11 的裸客户端 join 帧为脚本手工织帧（掩码文本帧），实现仅测试侧，无生产影响。
