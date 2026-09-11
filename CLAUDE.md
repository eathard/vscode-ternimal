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
npm run verify                # umbrella: m1+m3+m4+softkeys (exit 0/1)
npm run verify:m1|m3|m4|browser|softkeys  # individual suites
node scripts/smoke-e2e.mjs        # Real Electron + real bash + TLS e2e
```

No linter — the quality gates are `tsc --noEmit` (strict + noUnusedLocals/
noUnusedParameters/noImplicitOverride/noFallthroughCasesInSwitch) and the
script suites (`N/M passed`, exit code 0/1) — see
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
(HTTPS + dynamic access-token auth + WSS `/ws`; JSON protocol in
`src/shared/wsProtocol.ts`). Renderer clients talk through the
`TerminalTransport` seam (`src/renderer/transport/`):
`LocalIpcTransport` for the Electron window, `WebSocketTransport` for the
web bundle (`src/web/`, built by `webpack.web.config.js`). Sessions survive
client disconnects — ring-buffer replay on attach. Supporting modules:
`authManager.ts` (per-launch token + rate limit; tray shows QR), `certManager.ts` (self-signed with
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

## Relay & Multi-instance

- `relay/` is a standalone zero-knowledge relay server (Node, no build step; `relay/cli.mjs serve`). Its verification suites: `npm run verify:relay` (+ `verify:instances` for multi-instance). Runtime `relay/relay-config.json` is gitignored (contains credential hashes).
- Multi-instance: `--ternimal-instance=<id>` (or `TERNIMAL_INSTANCE`) gives each instance its own userData under `instances/<id>/` (config seeded from default with relay DISABLED — same master code in two instances causes a takeover war), a claimed color (top bar + tray icon + window title), and automatic port fallback on EADDRINUSE. Default launch is untouched.

## Access Token (tconf_v1) — one-paste setup

- `relay/src/token.mjs` = shared codec (zlib raw + base64url + 8-hex checksum, prefix `tconf_v1_`), imported BOTH by relay (CLI/admin API) and the app main process (webpack inlines it; only node:zlib/crypto deps). Never duplicate the codec.
- Admin binds `publicUrl` + `publicCaPem` once (PUT /api/admin/access, or `cli.mjs bind-access --url … --ca-file root.crt`; persisted in relay-config.json). Issuing a master then embeds a token in the response; `POST /api/admin/token {code}` mints one for an existing master (server stores hashes only — the plaintext code must be supplied by the operator).
- App: ⚙ panel top card — paste → RELAY_PREVIEW_TOKEN (masked summary) → RELAY_APPLY_TOKEN (writes CA to userData/certs/relay-ca.pem, fills url/master/caPath, connects). Manual fields remain for domain+public-CA users.
- QR intentionally dropped: the token is consumed by the desktop app (paste), phones can't use it.

## Same-Master Conflict: Intent Preemption (方案一)

- One master code = one live device. New plugin (proto:2) registering against a LIVE holder gets `occupied` (UI shows 在别处使用中 + 强制接管); the holder stays untouched. A 30s silent probe auto-takes-over once the holder dies (machine migration = zero clicks).
- `force: true` (only from a human clicking the panel button) kicks the holder: it receives `taken-over` and parks (已被接管, NO auto-reconnect, 夺回 button). War is structurally impossible: kicking requires a click, the kicked side stops retrying.
- Legacy clients (no proto field) keep last-wins for rolling upgrades. Zombie holders are detected by a 2.5s ping-probe on register.
- Verify: `npm run verify:relay-takeover` (B-08). NOTE: dist/plugins/relayPlugin.mjs is a minified transform of the source — grep for identifiers there will false-negative.

## Windows Packaging (on a real Windows box)

- Build natively on Windows when possible: `npm ci --ignore-scripts --registry=https://registry.npmmirror.com` then `npm run build` then `npx electron-builder --win nsis --x64 -c.npmRebuild=false`
  - `--ignore-scripts` + `-c.npmRebuild=false`: node-pty ships win32-x64 prebuilds (N-API) that Electron loads as-is; skipping rebuild avoids needing VS Build Tools (verified end-to-end: ConPTY works in the shipped exe)
- **3rd-party AV (Huorong/Lenovo) eats node_modules files mid-install** (random missing package.json / electron install.js). Add the project dir + electron cache to the AV trust zone before npm ci, or builds flake with `\\?\...` ENOENT errors
- ssh-spawned GUI processes land in a hidden session (no desktop/tray) — use schtasks InteractiveToken or the user's own double-click for visible-window testing; sshd also kills the process tree when the session closes
- PowerShell over ssh: nested `powershell -Command` eats `$vars` (double interpolation) — ship `.ps1` files instead; native stderr (npm warnings) becomes terminating errors with ErrorActionPreference=Stop

## VPS relay ops gotchas (systemd unit `ternimal-relay`, User=ubuntu)

- **NEVER run `sudo node cli.mjs bind-access/add-master/…` against the live config**: saveConfig rewrites `relay-config.json` as `root:root 0600`, then the `ubuntu` service user silently loads NOTHING (loadConfig swallows EACCES → defaults: admin "not configured", masters gone, access unbound — relay keeps serving). Fix if hit: `sudo chown ubuntu:ubuntu relay-config.json && sudo systemctl restart ternimal-relay`. Run CLI ops as the service user (or chown afterwards).
- Relay restarts clear subcodes/channels (memory-only): clients auto re-register, but users must regenerate tray share links.
- Admin page ops (PUT access / mint token) are the SAFE path vs CLI on a root-owned config — they write via the running process, keeping ownership intact.

## Build & Platform Gotchas

- `node-pty` is a **native module**, excluded from the webpack bundle (`externals` in webpack.main.config.js). After changing Electron or node-pty versions, run `npm run rebuild` or the app will crash on startup
- Webpack outputs: `dist/main/` (main.js + preload.js) and `dist/renderer/` (renderer.js + index.html). `package.json` `main` points to `dist/main/main.js`
- **Linux requires `--no-sandbox`**: `src/main/main.ts` appends it at runtime for Linux (Deepin SUID sandbox crashes). `build/afterPack.js` additionally rewrites the packaged Linux binary as a bash wrapper that removes `chrome-sandbox` and auto-retries on exit codes 133/134 (Chromium startup crashes)
- Packaging config lives in `electron-builder.yml` (not in package.json); output goes to `release/`
- **Packaged Linux binary is a bash wrapper** (`/usr/bin/ternimal` → spawns `/opt/Ternimal/ternimal.real`): killing the wrapper does NOT kill the app. Cleanup patterns must match `ternimal.real` (or the Electron binary path), or orphaned instances keep running — and two instances sharing one master code produce a relay takeover-reconnect war
- `vscode-src/` is a placeholder for reference material and is excluded from builds and packaging
- **`ws` must stay a webpack external** (`webpack.main.config.js`): bundling it deadlocks the main event loop after the first outbound broadcast (documented in `docs/test-reports/` M2 §4). Same for `node-pty`
- Web bundle is served by the app itself under `/static/` — `webpack.web.config.js` sets `output.publicPath: '/static/'`; relative asset URLs 404 in real browsers
- User-facing strings live in `src/shared/i18n.ts` (zh/en, `t(locale, key)` with en fallback). Locale = `TERNIMAL_LOCALE` env override, else system (`app.getLocale()` main / `navigator.language` web); tests set `TERNIMAL_LOCALE=en` for deterministic English assertions
