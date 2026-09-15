# Windows 打包 SOP（实机）

> 活文档：每次实机打包/排障后把新坑记进来。兼容性审计快照（2026-09-11）见
> `windows-compatibility.md`——那是评估记录，本文是操作规范。

## 1. 原生构建流程（已验证端到端）

```bash
npm ci --ignore-scripts --registry=https://registry.npmmirror.com
npm run build
npx electron-builder --win nsis --x64 -c.npmRebuild=false
```

- `--ignore-scripts` + `-c.npmRebuild=false`：node-pty 自带 win32-x64 N-API
  prebuilds，Electron 直接加载；跳过 rebuild 免装 VS Build Tools（已验证
  ConPTY 在出货 exe 内工作）。
- 打包配置在 `electron-builder.yml`，产物输出 `release/`。

## 2. 杀软 / EDR 行为规避（posture）

**已知问题**：Huorong/联想等第三方杀软会在 npm ci 途中吃掉 node_modules
文件（随机缺 package.json / electron install.js），表现为 `\\?\...` ENOENT。
先把项目目录 + electron 缓存加入杀软信任区，再 npm ci。

**行为规则**——下列模式不要出现在发行物、安装期脚本、支持工具里。行为型
杀软/EDR 按 ATT&CK 技术形状评分，无法区分善意意图（Orca 的复盘：Defender
8 天对纯正常功能开出 6 起事故，无一命中签名）：

| 禁用模式 | 为何像攻击 | 替代做法 |
|---|---|---|
| `-ExecutionPolicy Bypass` | 现实攻击标配 | 正常签名/策略内运行；确需绕过则改为引导用户手动执行 |
| `-EncodedCommand`（base64 PowerShell） | 无文件攻击标配 | 落 `.ps1` 文件再执行 |
| `cmd.exe /c` 拼自由文本 | 命令注入形状；且 MSYS 会吞 `/c` | argv 数组传递；`.cmd` shim 先解析到真实目标再直启 |
| 运行时 `Add-Type` 编译 | 恶意载荷释放形状 | 预编译进产物 |
| 自拷贝签名镜像换名运行 | 白化攻击形状 | 原地升级/标准卸装器 |
| 定时批量 `OpenProcess` + 读他进程内存 | 进程注入侦察形状 | 用系统 API（如 NtQuerySystemInformation 表）或既定工具 |

需要 PowerShell 时：ship `.ps1` 文件、参数走 argv/环境变量而非字符串拼接、
避免每操作一个解释器进程的爆发式短命进程。

## 3. ssh 远程测试限制

- ssh 拉起的 GUI 进程落在隐藏会话（无桌面/托盘）——可见窗口测试用
  `schtasks /IT`（InteractiveToken）或让用户自己双击；sshd 会话关闭时
  会杀整个进程树。
- ssh 上的 PowerShell：嵌套 `powershell -Command` 会吃掉 `$vars`（双重
  插值）——ship `.ps1` 文件代替；`ErrorActionPreference=Stop` 会把原生
  stderr（npm warning 之类）变成终止性错误。

## 4. 相关平台坑（详见 CLAUDE.md「Build & Platform Gotchas」）

- `sleep(1)` 在 Windows 钳制到 ~15.6ms；`fs.statSync().mode` 的 POSIX 位
  无意义（恒 0o666）；动态 `import()` 必须 `pathToFileURL(...).href`。
