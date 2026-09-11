# Windows 兼容性评估报告（2026-09-11）

> 环境限制：本机无 Windows 实机；评估 = 代码级审计 + Linux 交叉构建 win-x64 产物 + 产物内部核验。

## 结论：代码层面兼容良好，产物完整；建议实机冒烟后发布

## 一、平台分支审计（全部正确）

| 位置 | Windows 行为 | 评价 |
|------|-------------|------|
| ptyManager.ts:16/76/104 | ConPTY（`windows-pty` 终端名 + 5s 强杀兜底） | ✓ VS Code 同款模式 |
| ipcHandlers.ts:70 | 默认 shell = `powershell.exe` | ✓ |
| main.ts:16 | `--no-sandbox` 仅 Linux 追加 | ✓ Windows 不受影响 |
| afterPack.js | bash 包装器仅 Linux（Windows 直跑 exe） | ✓（无 133/134 自动重试，Windows 上不需要） |
| src/ 全量 | 无硬编码 Unix 路径（path.join 贯通） | ✓ |

## 二、关键子系统

- **证书**：`selfsigned` 纯 JS 生成（无 openssl CLI 依赖）✓
- **托盘**：nativeImage BGRA 染色跨平台；图标多候选路径 + 1px 兜底不阻塞启动 ✓
- **中继**：`relay.caPath` 单一路径 env（Windows 反斜杠路径可用）；插件 utilityProcess 路径 path.join ✓
- **node-pty**：产物含 win32-x64/arm64 prebuilds（conpty*.node）✓

## 三、交叉构建验证（Linux → win-x64）

- `electron-builder --win zip` **成功**：`release/Ternimal-1.1.0-win.zip`（121 MB）
- asar 内核齐备：dist/main、renderer、plugins/relayPlugin.mjs、web ✓
- NSIS 安装器需 wine（Linux）；本次补齐 `build/icon.ico`（256/48/32/16）后 NSIS 可在 wine/Windows CI 出包

## 四、遗留风险（实机才能确认）

1. **未签名 exe**：SmartScreen 会弹「未知发布者」警告；杀软可能误报（Electron 常见）——正式发布需代码签名证书
2. ConPTY 实际行为（Win10 1809+/Win11 均内置 ConPTY ✓，理论无碍）
3. 托盘在 Windows 的图标尺寸/行为差异
4. Windows 路径带空格/中文用户名下的 userData（Electron 处理，理论安全）

## 五、发布建议

1. 在 Windows 实机（或 GitHub Actions windows-latest）跑冒烟：启动 → 开标签（PowerShell） → 设置面板 → 中继连接
2. 出包走 `npm run pack`（NSIS）于 Windows CI；临时分发用 zip 即可
3. 若长期维护 Windows，建议加 `verify:win-smoke` 脚本于 CI
