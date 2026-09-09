// verify-softkeys.mjs — unit checks for the modifier mapping table
// (src/shared/modifierKeys.ts). Frozen semantics:
//   one-shot consumption, Ctrl/Alt/Shift arbitrary combos, unmapped keys
//   pass through plain, multi-char input never consumes.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  'npx tsc src/shared/modifierKeys.ts --outDir dist/verify --rootDir src ' +
    '--module commonjs --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node',
  { cwd: root, stdio: 'inherit' }
);
const { applyModifiers, hasModifiers, NO_MODIFIERS, arrowSequence } = await import(
  pathToFileURL(path.join(root, 'dist/verify/shared/modifierKeys.js')).href
);

let failed = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

const M = (ctrl, alt, shift) => ({ ctrl, alt, shift });

// Ctrl family
check('Ctrl+c → \\x03', applyModifiers('c', M(true, false, false)).data === '\x03');
check('Ctrl+C (uppercase) → \\x03', applyModifiers('C', M(true, false, false)).data === '\x03');
check('Ctrl+d → \\x04', applyModifiers('d', M(true, false, false)).data === '\x04');
check('Ctrl+[ → ESC', applyModifiers('[', M(true, false, false)).data === '\x1b');
check('Ctrl+space → NUL', applyModifiers(' ', M(true, false, false)).data === '\x00');
check('Ctrl+? → DEL', applyModifiers('?', M(true, false, false)).data === '\x7f');
check('Ctrl+Shift+x ≡ Ctrl+x', applyModifiers('x', M(true, false, true)).data === '\x18');

// Alt family (readline meta = ESC prefix)
check('Alt+f → \\x1bf', applyModifiers('f', M(false, true, false)).data === '\x1bf');
check('Alt+b → \\x1bb', applyModifiers('b', M(false, true, false)).data === '\x1bb');
check('Ctrl+Alt+c → \\x1b\\x03', applyModifiers('c', M(true, true, false)).data === '\x1b\x03');

// Shift family
check('Shift+Tab → backtab \\x1b[Z', applyModifiers('\t', M(false, false, true)).data === '\x1b[Z');
check('Tab alone with mods absent → untouched', applyModifiers('\t', NO_MODIFIERS).data === '\t');
check('Ctrl+Tab passes plain \\t', applyModifiers('\t', M(true, false, false)).data === '\t');

// Unmapped → plain passthrough (still consumed)
const unmapped = applyModifiers('5', M(true, false, false));
check('Ctrl+5 unmapped → plain "5", consumed', unmapped.data === '5' && unmapped.consumed === true);

// One-shot consumption
check('consumed=true on any single char with mods', applyModifiers('c', M(false, true, false)).consumed === true);
check('consumed=false without mods', applyModifiers('c', NO_MODIFIERS).consumed === false);
check('consumed=false with empty mods object', applyModifiers('c', M(false, false, false)).consumed === false);

// Multi-char (paste / IME commit) → untouched, NOT consumed
const paste = applyModifiers('hello world', M(true, false, false));
check('paste passes through, does not consume', paste.data === 'hello world' && paste.consumed === false);
check('empty string passes through', applyModifiers('', M(true, false, false)).data === '');

// hasModifiers helper
check('hasModifiers detects combos', hasModifiers(M(true, false, true)) === true && hasModifiers(NO_MODIFIERS) === false && hasModifiers(null) === false);

// Arrow sequences (direct taps honor modifiers + DECCKM)
check('arrow up plain → CSI \\e[A', arrowSequence('up', NO_MODIFIERS) === '\x1b[A');
check('arrow up in application mode → SS3 \\eOA', arrowSequence('up', NO_MODIFIERS, true) === '\x1bOA');
check('arrow left plain → \\e[D', arrowSequence('left', NO_MODIFIERS) === '\x1b[D');
check('Ctrl+up → \\e[1;5A', arrowSequence('up', M(true, false, false)) === '\x1b[1;5A');
check('Alt+right → \\e[1;3C', arrowSequence('right', M(false, true, false)) === '\x1b[1;3C');
check('Shift+down → \\e[1;2B', arrowSequence('down', M(false, false, true)) === '\x1b[1;2B');
check('Ctrl+Shift+left → \\e[1;6D', arrowSequence('left', M(true, false, true)) === '\x1b[1;6D');
check('Ctrl+Alt+Shift+up → \\e[1;8A', arrowSequence('up', M(true, true, true)) === '\x1b[1;8A');
check('modified arrow ignores application mode (CSI form)', arrowSequence('up', M(true, false, false), true) === '\x1b[1;5A');

// Direct-key path (Esc/Tab buttons go through the same table)
check('Esc direct with no mods → \\x1b', applyModifiers('\x1b', NO_MODIFIERS).data === '\x1b');
check('Esc with Ctrl pending → plain \\x1b (consumed)', applyModifiers('\x1b', M(true, false, false)).data === '\x1b');

console.log(`softkeys: ${failed ? 'FAILED' : 'ALL PASS'} (${failed ? 'not-all' : 'all'} checks, ${failed} failed)`);
process.exit(failed ? 1 : 0);
