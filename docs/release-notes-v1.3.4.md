# Ternimal v1.3.4 — 修复中继「重连风暴」：回放截断到单帧预算

## 问题（2026-10-02 线上事故）

中继链接打开后终端永远空白，浏览器顶部横幅无限循环
`Relay connection lost — reconnecting…`（实测单页 44+ 次重连）。

**根因**：长跑输出型会话（如挂了一整天的 `ping`）把回放环形缓冲填到近 1MB
（上限）；attach 时 RemoteServer 把整个回放**密封成单帧**发出，base64+GCM
膨胀后线上尺寸 ≈1.4MB，**超过 relay `/pipe` 的 maxPayload 硬限（1MB）**——
超限帧直接断管（`host error`），close 1000 属非致命码，客户端重连 → 认证
成功（退避归零）→ 再 attach → 再断 → 死循环。回放 >~770KB 的会话经中继
一律连不上；本地 LAN 路径不受影响。

## 修复

**attach 回放按线上预算截断（保最新），单帧永不超限。**

- `WS.MAX_SECURE_FRAME_BYTES = 900KB`：relay 1MB maxPayload 之下的安全预算
- `fitReplayToBudget()`：从头部裁剪、优先对齐行首（终端首行不残缺）、
  任意输入长度收敛（含 ≤3 字符极短输入的收敛保证）
- `estimateSealedWireBytes()`：密封信封线上尺寸的保守上界
  （UTF-8 字节 + GCM tag + base64 ×4/3）
- 本地 IPC / 窗口重开路径不截断（无帧上限）；行为收缩已按
  wire-compatibility 规则 3 记录豁免

## 验证

- 回归用例 **M-07**（verify-relay-matrix）：真 relay（1MB maxPayload）+
  1.1MB 回放 → attach 存活、实时数据到达、零重连；**撤销修复即红**
  （完整复现线上重连风暴），修复后绿
- 顺手修复 `fitReplayToBudget` 初版在极短回放+极小预算下的死循环
  （单测抓出：worker 131% CPU 空转）

## 质量门禁

vitest 80/80 · relay-matrix 7/7 · `npm run verify` 全矩阵 ✓ · tsc strict ✓ ·
smoke-e2e ALL PASS（真 Electron + 真 bash + TLS + 中继隧道）

## 安装包与校验和（仅 Linux）

| 平台 | 文件 | 大小 | MD5 |
|---|---|---|---|
| Linux x64 (deb) | `ternimal_1.3.4_amd64.deb` | 75.1 MB | `7d31d78242397063f673dca9784e9998` |
| Linux x64 (AppImage) | `Ternimal-1.3.4.AppImage` | 108.8 MB | `741243732be8cbcd867815513381eaaf` |

**完整变更**：[v1.3.3...v1.3.4](https://github.com/eathard/vscode-ternimal/compare/v1.3.3...v1.3.4)

> 升级提示：分享令牌随宿主进程启动轮换——升级后请从 ⚙ 面板重新生成
> 分享链接；浏览器首次访问仍需点过 Caddy 自签证书警告（设计内行为）。
