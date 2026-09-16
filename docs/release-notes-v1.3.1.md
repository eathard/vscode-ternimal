# Ternimal v1.3.1 — 单实例双缺陷修复

> 本版仅发布 Linux 双件（deb / AppImage）；Windows 版维持 1.3.0，下个功能版一并追平。

## 修复：双击图标没反应（托盘驻留 + 第二实例副作用）

**现场**（v1.3.0 实机 journal，2026-09-16）：应用关窗驻留托盘后再双击桌面图标，无任何窗口出现；同时后台日志出现端口抢占与中继插件重启循环。

**根因一：第二实例「假退出」** — 拿不到单实例锁时只调用 `app.quit()`，但它是异步排队：`ready` 仍会触发，整机带着副作用完整开机一遍——回退自动端口再起一个 RemoteServer、以**同一主码**fork 中继插件并陷入 `plugin exited (0)` 重启循环，与真实例发生短暂注册争抢。用户视角是「点了没反应」加中继噪音。

**根因二：托盘驻留时无法唤回窗口** — `second-instance` 只 focus 已存在的窗口；窗口关闭驻留后 `mainWindow=null`，点图标什么都不发生。

**修复**（`src/main/main.ts`）：

1. 锁失败 → `app.quit()` 后紧跟 `process.exit(0)` 硬停——此刻尚无任何资源启动，无需善后
2. `second-instance` → 调用幂等的 `createWindow()`：窗口已销毁则重建、存活则 show+focus，`restore()` 覆盖最小化场景

**验证**：dev 构建双开实测——第二实例仅输出一行退出日志，零 RemoteServer/relay 副作用；verify-multi-instance 5/5；tsc + vitest 72/72。

## 安装包与校验和（仅 Linux）

| 平台 | 文件 | 大小 | MD5 |
|---|---|---|---|
| Linux x64 (deb) | `ternimal_1.3.1_amd64.deb` | 75.0 MB | 见下方 |
| Linux x64 (AppImage) | `Ternimal-1.3.1.AppImage` | 108.8 MB | 见下方 |

## 升级建议

- 遇到过「点图标没反应」的 Linux 用户请升级；无此症状可不急
- Windows 用户无需动作（1.3.0 不受使用层面影响，仅二次启动的日志噪音）

**完整变更**：[v1.3.0...v1.3.1](https://github.com/eathard/vscode-ternimal/compare/v1.3.0...v1.3.1)
