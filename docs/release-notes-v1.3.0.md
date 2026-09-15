# Ternimal v1.3.0 — 线协议兼容契约 + 工程化加固

## 主题：混合版本是常态，线协议从此有契约

网页端比 App 活得久——手机上开着的会话页会在桌面端升级后继续存在。v1.3.0 把这一现实固化为**三条线协议规则**（`docs/wire-compatibility.md`）：

1. **可选字段安全**：收方必须忽略未知字段
2. **新帧类型必须协商**：未经 caps 握手声明的能力，双方都不得发送
3. **发布即变更**：任何影响线上行为的改动都按线协议变更对待；帧名永久

### caps 能力握手（本版核心机制）

- 主机端在 `auth-ok` 附带 `caps`（为空时整个字段省略——与旧版字节级一致，旧客户端零感知）
- 客户端以 `auth-response.caps` 应答（严格校验：≤16 项、`[a-z0-9-]{1,32}`、畸形即 `BAD_MESSAGE` 断连）
- 客户端 `supportsCap()`：caps 缺失 = 旧主机 = 功能自动关闭
- 混版本升级路径：1.3.0 主机 ↔ 1.2.x 客户端完全互通（旧端无 caps 字段，双方退回旧行为）

## 工程化

- **测试迁移 vitest**：纯逻辑套件与源码同置（`foo.test.ts`），72 个单测 8 文件 <1s；进程级/服务器级集成套件保留在 `scripts/verify-*.mjs`
- **oxlint** 接入（report-only 起步，`.oxlintrc.jsonc`）
- **Windows verify 链修复**：`pathToFileURL` 处理 `D:\` 盘符 URL、sleep 精度、POSIX 权限位断言平台门控——全链在 Windows 本机可跑
- 文档分册：`windows-packaging.md`（原生构建 + AV/EDR 行为红线）、`vps-ops.md`（部署/重启/配置所有权陷阱）、`wire-compatibility.md`
- 官网上线并关联：`vscode-ternimal.github.io`（README + About + package.json homepage）
- 打包防御：`dist/` 残留构建产物显式排除（v1.2.1 曾因 Windows 构建机残留膨胀至 438MB）

## 升级建议

- 所有用户可平滑升级；网页端无需任何操作
- 中继服务端与 1.3.0 客户端完全兼容，无需同步升级

## 安装包

| 平台 | 文件 | 校验 |
|---|---|---|
| Linux x64 (deb) | `ternimal_1.3.0_amd64.deb` | 见 Release 资产 |
| Linux x64 (AppImage) | `Ternimal-1.3.0.AppImage` | 见 Release 资产 |
| Windows x64 | `Ternimal Setup 1.3.0.exe` | 见 Release 资产 |
