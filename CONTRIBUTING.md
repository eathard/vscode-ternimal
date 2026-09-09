# Contributing

Thanks for considering a contribution — and for reading this first.

## Setup

```bash
npm install --include=dev
npm run rebuild          # native modules against Electron
npm run dev              # build + launch
```

## The non-negotiable: run the verify matrix

Every suite prints `N/M passed` and exits non-zero on failure:

```bash
npm run verify              # unit + protocol + reconnect + soft-keys
node scripts/smoke-e2e.mjs  # real Electron + real bash + TLS roundtrip
npm run verify:browser      # real Chrome end-to-end (needs google-chrome)
```

Run all of it before sending anything that touches the **transport seam**
(`src/renderer/transport/`), the **SessionRegistry**, or the **remote
server**. Browser-level checks have caught real bugs that every lower
layer missed (asset 404 white screens, activation swallows, replay-injected
keystrokes) — they are not optional garnish.

## Architecture orientation

- `CLAUDE.md` — commands, architecture map, platform gotchas
- `docs/technical-design.md` — decisions and invariants (replay
  sanitization, transport connection-phase semantics, auth model)
- `docs/verification-standard.md` — what each suite covers

Two invariants that have bitten before: `ws` and `node-pty` stay webpack
externals; the web bundle's `publicPath` stays `/static/`.

## Commit style

Conventional-ish, imperative, one logical change per commit — see `git
log` for the house pattern (`feat:`, `fix:`, `revert:` …). Include what
was verified in the body when it is non-obvious.

## Adding strings / locales

User-facing strings live in `src/shared/i18n.ts` (zh + en). Add the key
to both dictionaries; embedders detect the locale once.
