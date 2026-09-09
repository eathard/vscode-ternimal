# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ternimal is a standalone Electron terminal emulator built with xterm.js (renderer) and node-pty (main process), replicating VS Code's terminal architecture. No framework — plain TypeScript with hand-rolled DOM UI.

## Commands

```bash
npm run dev          # Build (webpack) and launch Electron — primary dev loop
npm run build        # Build main + renderer + web bundles
npm run build:main   # Build main process only
npm run build:renderer # Build renderer process only
npm run rebuild      # electron-rebuild — REQUIRED after installing/upgrading Electron or node-pty (native module)
npm run pack         # Build + electron-builder for Windows and Linux
npm run pack:linux   # Build + Linux packages (AppImage + deb)
npm run verify:m1|m3|m4|browser   # Milestone verification suites (exit 0/1)
node scripts/smoke-e2e.mjs        # Real Electron + real bash + TLS e2e
```

No linter. Verification is script-based (`N/M passed`, exit code 0/1) — see
`docs/verification-standard.md`. Run the full matrix when touching the
transport seam, registry, or remote server.

## Architecture

Two Electron processes bridged by a preload script:

```
renderer (xterm.js)                  main (node-pty)
  terminalApp.ts    ── spawn/write/resize/kill ──►  ipcHandlers.ts ──► ptyManager.ts
  terminalTab.ts    ◄── pty:onData/onExit/onTitle ── (broadcast to window)
```

On top of that, a remote layer serves the SAME sessions to browsers
(LAN/VPN, self-signed TLS): `SessionRegistry` (main, EventEmitter, single
source of truth) feeds both the local IPC path and `remoteServer.ts`
(HTTPS + password login + WSS `/ws`; JSON protocol in
`src/shared/wsProtocol.ts`). Renderer clients talk through the
`TerminalTransport` seam (`src/renderer/transport/`):
`LocalIpcTransport` for the Electron window, `WebSocketTransport` for the
web bundle (`src/web/`, built by `webpack.web.config.js`). Sessions survive
client disconnects — ring-buffer replay on attach. Supporting modules:
`authManager.ts` (scrypt + rate limit), `certManager.ts` (self-signed with
LAN-IP SAN), `configStore.ts` (atomic JSON config), `tray.ts`.

### Data flow (core concept)

- **Input**: `xterm.onData` → `window.electronAPI.ptyWrite(id, data)` (src/renderer/terminalTab.ts:54) → `ptyManager.write`
- **Output**: `pty.onData` → `PtyManager` emits `'data'` → `ipcHandlers.ts` broadcasts to the window → every `TerminalTab` filters by `payload.id === id` and writes to its xterm instance
- PTY instances are keyed by tab ID (`tab-{timestamp}-{counter}`); all PTY events are broadcast and filtered client-side by ID

### Key files

- `src/shared/ipcChannels.ts` — the IPC contract: channel names (`IPC.*`) and payload types. Changing/adding channels requires updating: this file, `src/main/ipcHandlers.ts`, `src/main/preload.ts`, and the `window.electronAPI` declaration in `src/renderer/terminalTab.ts`
- `src/main/ptyManager.ts` — PTY lifecycle (`spawn`/`write`/`resize`/`kill`/`killAll`); an EventEmitter between the PTY layer and IPC
- `src/renderer/terminalApp.ts` — tab orchestration and global keyboard shortcuts (Ctrl+Shift+T new tab, Ctrl+W close, Ctrl+Tab cycle, Ctrl+Shift+F search, Ctrl+Shift+L theme toggle)
- `src/renderer/xtermWrapper.ts` — xterm.js setup: Fit/Search/WebGL/Unicode11 addons, resize handling, right-click copy/paste

### Patterns worth preserving (from VS Code)

- **WebGL with static fallback flag** (`xtermWrapper.ts`): a static `webglFailed` — once WebGL fails, all subsequently created terminals skip it (DOM renderer)
- **Resize guards** (`ptyManager.ts:71`): dimensions clamped with `Math.max(cols, 1)` to avoid zero/negative PTY sizes
- **Windows ConPTY kill timeout** (`ptyManager.ts:78-95`): 5s force-kill fallback because ConPTY can hang

## Build & Platform Gotchas

- `node-pty` is a **native module**, excluded from the webpack bundle (`externals` in webpack.main.config.js). After changing Electron or node-pty versions, run `npm run rebuild` or the app will crash on startup
- Webpack outputs: `dist/main/` (main.js + preload.js) and `dist/renderer/` (renderer.js + index.html). `package.json` `main` points to `dist/main/main.js`
- **Linux requires `--no-sandbox`**: `src/main/main.ts` appends it at runtime for Linux (Deepin SUID sandbox crashes). `build/afterPack.js` additionally rewrites the packaged Linux binary as a bash wrapper that removes `chrome-sandbox` and auto-retries on exit codes 133/134 (Chromium startup crashes)
- Packaging config lives in `electron-builder.yml` (not in package.json); output goes to `release/`
- `vscode-src/` is a placeholder for reference material and is excluded from builds and packaging
- **`ws` must stay a webpack external** (`webpack.main.config.js`): bundling it deadlocks the main event loop after the first outbound broadcast (documented in `docs/test-reports/` M2 §4). Same for `node-pty`
- Web bundle is served by the app itself under `/static/` — `webpack.web.config.js` sets `output.publicPath: '/static/'`; relative asset URLs 404 in real browsers
