# Ternimal v1.3.0 — 线协议兼容契约 + 工程化加固

## 核心特性：caps 能力握手

**为什么**：网页端比 App 活得久——手机上开着的会话页会在桌面端升级后继续存在，混合客户端/主机版本是常态而非异常。v1.3.0 把这一现实固化为线协议契约（`docs/wire-compatibility.md`），从此新功能的上线不再需要"所有端一起升级"。

**三条线协议规则**

1. **可选字段安全** — 收方必须忽略未知字段
2. **新帧类型必须协商** — 未经 caps 握手声明的能力，双方都不得发送
3. **发布即变更** — 任何影响线上行为的改动都按线协议变更对待；帧名永久

**握手机制**（扩展现有 `enc:1` 模式，零破坏）

| 方向 | 帧 | 行为 |
|---|---|---|
| 主机 → 客户端 | `auth-ok.caps` | 通告能力；**为空时整个字段省略**——与旧版字节级一致，旧客户端零感知 |
| 客户端 → 主机 | `auth-response.caps` | 应答能力；严格校验：≤16 项、`[a-z0-9-]{1,32}`、畸形帧即 `BAD_MESSAGE` 断连 |

客户端侧 `supportsCap()`：caps 缺失 = 旧主机 = 功能自动关闭。**1.3.0 ↔ 1.2.x 完全互通**（旧端无 caps 字段，双方退回旧行为），中继服务端无需同步升级。

## 工程化

- **测试迁移 vitest** — 纯逻辑套件与源码同置（`foo.test.ts`），**72 个单测 / 8 文件 <1s**；进程级/服务器级集成套件保留在 `scripts/verify-*.mjs`（分层：纯逻辑进单测，跨进程进脚本）
- **oxlint 接入**（report-only 起步，`.oxlintrc.jsonc`）— 为后续 lint 门禁铺路
- **Windows verify 链修复** — `pathToFileURL` 处理 `D:\` 盘符 URL（裸盘符路径会被解析为 URL scheme）、`sleep(1)` Windows 定时器钳制 ≈15.6ms、POSIX 权限位断言平台门控——全链现在 Windows 本机可跑
- **M-05 吞吐护栏** — verify 伞曾因机器资源挤占无限死等；现为 120s 硬顶 + 诊断输出（裸机实测 17.5 MiB/s，阈值 3 MiB/s）

## 文档与基础设施

- 平台参考分册：`windows-packaging.md`（原生构建 + AV/EDR 行为红线）、`vps-ops.md`（部署/重启/配置所有权陷阱）、`wire-compatibility.md`（线协议变更流程）
- **官网上线**：[vscode-ternimal.github.io](https://vscode-ternimal.github.io)（README + 仓库 About + `package.json` homepage 三处关联）
- 打包防御：`dist/` 残留构建产物显式排除（v1.2.1 曾因 Windows 构建机残留膨胀至 438MB，现结构性免疫）
- 截图更新：`same-session` / `web-mobile` 高清化

## 质量门禁（发版时全绿）

vitest 72/72 · registry 8/8 · ws-protocol 18/18 · reconnect 8/8 · relay 14/14 · relay-e2e 13/13 · relay-matrix 6/6 · relay-admin 11/11 · relay-takeover 5/5 · relay-token 6/6

## 安装包与校验和

| 平台 | 文件 | 大小 | MD5 |
|---|---|---|---|
| Linux x64 (deb) | `ternimal_1.3.0_amd64.deb` | 75.0 MB | `a865a054209a3a5bb761840bbe25ab1d` |
| Linux x64 (AppImage) | `Ternimal-1.3.0.AppImage` | 108.8 MB | `d58fde1e1b73e69d0ce51a67a6cdb6d0` |
| Windows x64 | `Ternimal Setup 1.3.0.exe` | 83.1 MB | `846337f6a9bf4936f73ecc96e6811c61` |

## 升级建议

- 所有用户可平滑升级；网页端无需任何操作
- 1.3.0 主机与 1.2.x 客户端混布完全兼容（caps 自动降级）

**完整变更**：[v1.2.1...v1.3.0](https://github.com/eathard/vscode-ternimal/compare/v1.2.1...v1.3.0)
