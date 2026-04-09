# Ternimal

<p align="center">
  <b>Standalone Terminal Emulator built with xterm.js + node-pty</b><br>
  <b>基于 VS Code 终端架构提取的独立终端模拟器</b>
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#chinese">中文</a>
</p>

---

<a name="english"></a>
## English

### Overview
Ternimal is a standalone terminal emulator application built on modern web technologies. It extracts the terminal architecture patterns from Visual Studio Code's official codebase, providing a high-performance, feature-rich terminal experience as an independent desktop application.

### Architecture
This project replicates VS Code's terminal architecture with three core components:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Frontend** | xterm.js | Terminal rendering with WebGL acceleration |
| **Backend** | node-pty | Pseudoterminal process management |
| **Bridge** | Electron IPC | Bidirectional data flow between UI and shell |

### Key Features

**Multi-Tab Support**
- New tab: `Ctrl+Shift+T`
- Close tab: `Ctrl+W`
- Switch tabs: `Ctrl+Tab` / `Ctrl+Shift+Tab`

**Advanced Rendering**
- WebGL renderer with automatic DOM fallback
- Unicode 11 support
- 256-color and truecolor support

**User Experience**
- Dark/Light theme toggle: `Ctrl+Shift+L`
- In-terminal search: `Ctrl+Shift+F`
- Right-click copy/paste
- Auto-resize on window change
- Scrollback buffer (5000 lines)

**Cross-Platform**
- Windows: PowerShell/CMD with ConPTY support
- macOS/Linux: Default shell with POSIX PTY

### Installation

```bash
# Clone the repository
git clone https://github.com/eathard/vscode-ternimal.git
cd vscode-ternimal

# Install dependencies
npm install

# Build and run
npm run dev

# Or build for production
npm run build
npm run pack        # Windows installer
```

### VS Code Patterns Extracted

This project incorporates proven patterns from VS Code's terminal implementation:

1. **Bidirectional Data Flow** (`terminalTab.ts:54-64`)
   - xterm → PTY: User input forwarding
   - PTY → xterm: Shell output rendering

2. **WebGL Renderer with Fallback** (`xtermWrapper.ts:106-117`)
   - Attempts WebGL for GPU acceleration
   - Graceful fallback to DOM renderer on failure
   - Context loss handling

3. **PTY Resize Guards** (`ptyManager.ts:70-72`)
   - Prevents zero/negative dimension errors
   - Pattern from `terminalProcess.ts:532-568`

4. **Windows Process Timeout** (`ptyManager.ts:78-95`)
   - Handles Windows ConPTY hang on kill
   - 5-second timeout with force kill

### Project Structure

```
src/
├── main/              # Electron main process
│   ├── main.ts        # Application entry
│   ├── ptyManager.ts  # PTY lifecycle management
│   └── ipcHandlers.ts # IPC channel handlers
├── renderer/          # Electron renderer process
│   ├── terminalApp.ts # Tab management
│   ├── terminalTab.ts # Single terminal instance
│   ├── xtermWrapper.ts # xterm.js integration
│   ├── tabBar.ts      # Tab UI component
│   ├── searchBar.ts   # Search UI component
│   └── themeManager.ts # Theme switching
└── shared/            # Shared constants
    ├── ipcChannels.ts # IPC protocol definitions
    └── themes/        # Color themes (VS Code Dark/Light)
```

---

<a name="chinese"></a>
## 中文

### 项目概述
Ternimal 是一个基于现代 Web 技术构建的独立终端模拟器应用程序。它从 Visual Studio Code 的官方代码库中提取终端架构模式，以独立的桌面应用程序形式提供高性能、功能丰富的终端体验。

### 架构设计
本项目复刻了 VS Code 的终端架构，包含三个核心组件：

| 组件 | 技术 | 用途 |
|------|------|------|
| **前端** | xterm.js | 终端渲染，支持 WebGL 加速 |
| **后端** | node-pty | 伪终端进程管理 |
| **桥接** | Electron IPC | UI 与 Shell 之间的双向数据流 |

### 主要功能

**多标签支持**
- 新建标签：`Ctrl+Shift+T`
- 关闭标签：`Ctrl+W`
- 切换标签：`Ctrl+Tab` / `Ctrl+Shift+Tab`

**高级渲染**
- WebGL 渲染器，自动降级到 DOM
- Unicode 11 支持
- 256色和真彩色支持

**用户体验**
- 暗黑/明亮主题切换：`Ctrl+Shift+L`
- 终端内搜索：`Ctrl+Shift+F`
- 右键复制/粘贴
- 窗口变化自动调整大小
- 回滚缓冲区（5000行）

**跨平台**
- Windows：PowerShell/CMD，支持 ConPTY
- macOS/Linux：默认 Shell，使用 POSIX PTY

### 安装方法

```bash
# 克隆仓库
git clone https://github.com/eathard/vscode-ternimal.git
cd vscode-ternimal

# 安装依赖
npm install

# 构建并运行
npm run dev

# 或构建生产版本
npm run build
npm run pack        # Windows 安装包
```

### 提取的 VS Code 模式

本项目整合了 VS Code 终端实现中的成熟模式：

1. **双向数据流** (`terminalTab.ts:54-64`)
   - xterm → PTY：转发用户输入
   - PTY → xterm：渲染 Shell 输出

2. **WebGL 渲染器与降级** (`xtermWrapper.ts:106-117`)
   - 尝试 WebGL 进行 GPU 加速
   - 失败时优雅降级到 DOM 渲染器
   - 上下文丢失处理

3. **PTY 尺寸保护** (`ptyManager.ts:70-72`)
   - 防止零/负尺寸错误
   - 模式源自 `terminalProcess.ts:532-568`

4. **Windows 进程超时** (`ptyManager.ts:78-95`)
   - 处理 Windows ConPTY 关闭时的挂起
   - 5秒超时后强制终止

### 项目结构

```
src/
├── main/              # Electron 主进程
│   ├── main.ts        # 应用入口
│   ├── ptyManager.ts  # PTY 生命周期管理
│   └── ipcHandlers.ts # IPC 通道处理器
├── renderer/          # Electron 渲染进程
│   ├── terminalApp.ts # 标签页管理
│   ├── terminalTab.ts # 单个终端实例
│   ├── xtermWrapper.ts # xterm.js 集成
│   ├── tabBar.ts      # 标签页 UI 组件
│   ├── searchBar.ts   # 搜索 UI 组件
│   └── themeManager.ts # 主题切换
└── shared/            # 共享常量
    ├── ipcChannels.ts # IPC 协议定义
    └── themes/        # 配色主题（VS Code 暗黑/明亮）
```

---

## License / 许可证

MIT License

## Acknowledgments / 致谢

This project is inspired by and extracts patterns from the [Visual Studio Code](https://github.com/microsoft/vscode) terminal implementation.

本项目灵感来源于并从 [Visual Studio Code](https://github.com/microsoft/vscode) 终端实现中提取模式。
