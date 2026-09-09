# M1 会话中台 — 里程碑测试报告

> 日期：本轮执行 | 执行人：实施者（AI agent）
> 依据：`docs/verification-standard.md` §3.1 | 计划书 WBS-M1-A～E

## 1. 结论

**M1 自动化验收门（TC-M1-06）通过；手动用例待需求方在桌面环境执行。**
代码合入工作区，`npm run build` 全绿，`npm run verify:m1` 13/13 通过，
应用冒烟启动存活（--no-sandbox）。

## 2. 交付内容

| 任务 | 文件 | 状态 |
|------|------|------|
| WBS-M1-A 会话注册表 | `src/main/sessionRegistry.ts` | ✅ |
| WBS-M1-B 环形回放缓冲 | `src/main/ringBuffer.ts` | ✅ |
| WBS-M1-C IPC 扇出改造 | `src/main/ipcHandlers.ts` `src/main/main.ts` `src/main/preload.ts` `src/shared/ipcChannels.ts` | ✅ |
| WBS-M1-D 传输抽象层 | `src/renderer/transport/{transport,index,localIpcTransport}.ts`；`terminalApp/terminalTab/xtermWrapper/index` 解耦 `window.electronAPI` | ✅ |
| WBS-M1-E 标签恢复 | `terminalApp.init()` → `listTabs()`；`onTabsChange` → `reconcileTabs()` | ✅ |
| D8 验证脚本 | `scripts/verify-ringbuffer.mjs` `scripts/verify-registry.mjs` + `npm run verify:m1` | ✅ |

实现要点与方案书的偏差：

1. `PtyManager` 死代码 `checkTitle`（从未被定时调用）已移除，标题追踪由
   Registry 1s 轮询承担——即 TC-M1-05 对应的既有缺陷修复。
2. resize 采用"前沿立即 + 200ms 尾随去抖"（方案书 §2.2），比纯尾随去抖
   多保一次即时生效，拖拽体验更接近 VS Code。
3. `SessionRegistry` 以 `PtyHost` 结构化接口组合 `PtyManager`（惰性
   require），验证脚本注入假宿主即可在纯 node 下运行，不触
   Electron ABI 的 node-pty——与方案书 §2.2 一致。

## 3. 自动化验证结果（TC-M1-06）

```
$ npm run verify:m1
ringbuffer: 6/6 passed
  PASS  append + snapshot preserves chunk order
  PASS  evicts oldest chunks past the cap
  PASS  single oversized chunk keeps only itself
  PASS  clear resets state
  PASS  multi-byte UTF-8 counted by bytes not chars
  PASS  rejects non-positive cap
registry: 7/7 passed
  PASS  create returns server-generated SessionInfo and emits tabs (leading)
  PASS  write routes to pty; data event fires; replay buffer fills
  PASS  resize: leading edge immediate, trailing coalesced, clamped >= 1
  PASS  kill: exactly-once exit, list emptied, tabs broadcast
  PASS  natural exit: propagated with real exitCode
  PASS  title polling: process-name change → title event + info update
  PASS  replay buffer respects configured cap
```

构建与启动：

```
$ npm run build        → webpack compiled successfully
$ npx electron . --no-sandbox → 8s 冒烟存活，无未捕获异常（exit 124 = 超时器终止）
```

## 4. 环境问题与处置（记录备查）

| 问题 | 处置 |
|------|------|
| 宿主 shell `NODE_ENV=production` 导致 npm 省略 devDependencies（首次仅装 2 包） | `NODE_ENV=development npm install --include=dev` 重装（585 包） |
| `extract-zip` 在 Node 24 下对 Electron zip 静默截断（仅解出 1 文件即 exit 0） | python `zipfile` 手动解压 + 恢复权限 + 写 `path.txt`；zip 本体完整（74 成员，testzip 通过） |
| Deepin SUID 沙箱崩溃：bundle 内 `appendSwitch('no-sandbox')` 在本机晚于 Chromium 沙箱初始化，不生效 | `package.json` 的 `dev`/`start` 脚本追加 CLI `--no-sandbox`（与 CLAUDE.md 记载的 afterPack 打包方案同思路；flag 在非 Linux 平台为无害空操作） |

## 5. 待需求方执行的手动用例

以下需真实桌面交互，请在方便时执行并回填结果（验证标准 §3.1 / §6）：

- [ ] TC-M1-01 三标签并发 htop/vim/claude 无串扰
- [ ] TC-M1-02 Ctrl+W 仅关活动标签
- [ ] TC-M1-03 应用重启后空列表正常新建初始标签
- [ ] TC-M1-04 `echo $TERM` = xterm-256color
- [ ] TC-M1-05 claude 标签标题随进程名更新
- [ ] §6 本地回归清单 9 项（快捷键/搜索/主题/WebGL/右键/resize/中文/vim/退出）

执行方式：`npm run dev`（已含 --no-sandbox）。

## 6. 缺陷清单

无 P0/P1。P2 一项：`dist/verify` 为验证脚本的编译产物目录，已随
`.gitignore` 的 dist 规则忽略（确认：仓库 .gitignore 含 dist）。
