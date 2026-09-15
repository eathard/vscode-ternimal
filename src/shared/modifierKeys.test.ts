// modifierKeys.test.ts — modifier mapping table. Frozen semantics:
// one-shot consumption, Ctrl/Alt/Shift arbitrary combos, unmapped keys pass
// through plain, multi-char input never consumes.
// (migrated from scripts/verify-softkeys.mjs)
import { describe, expect, it } from 'vitest';
import { applyModifiers, hasModifiers, NO_MODIFIERS, arrowSequence } from './modifierKeys';

const M = (ctrl: boolean, alt: boolean, shift: boolean) => ({ ctrl, alt, shift });

describe('applyModifiers: Ctrl family', () => {
  it('Ctrl+c → \\x03', () => expect(applyModifiers('c', M(true, false, false)).data).toBe('\x03'));
  it('Ctrl+C (uppercase) → \\x03', () => expect(applyModifiers('C', M(true, false, false)).data).toBe('\x03'));
  it('Ctrl+d → \\x04', () => expect(applyModifiers('d', M(true, false, false)).data).toBe('\x04'));
  it('Ctrl+[ → ESC', () => expect(applyModifiers('[', M(true, false, false)).data).toBe('\x1b'));
  it('Ctrl+space → NUL', () => expect(applyModifiers(' ', M(true, false, false)).data).toBe('\x00'));
  it('Ctrl+? → DEL', () => expect(applyModifiers('?', M(true, false, false)).data).toBe('\x7f'));
  it('Ctrl+Shift+x ≡ Ctrl+x', () => expect(applyModifiers('x', M(true, false, true)).data).toBe('\x18'));
});

describe('applyModifiers: Alt family (readline meta = ESC prefix)', () => {
  it('Alt+f → \\x1bf', () => expect(applyModifiers('f', M(false, true, false)).data).toBe('\x1bf'));
  it('Alt+b → \\x1bb', () => expect(applyModifiers('b', M(false, true, false)).data).toBe('\x1bb'));
  it('Ctrl+Alt+c → \\x1b\\x03', () => expect(applyModifiers('c', M(true, true, false)).data).toBe('\x1b\x03'));
});

describe('applyModifiers: Shift family', () => {
  it('Shift+Tab → backtab \\x1b[Z', () => expect(applyModifiers('\t', M(false, false, true)).data).toBe('\x1b[Z'));
  it('Tab alone with mods absent → untouched', () => expect(applyModifiers('\t', NO_MODIFIERS).data).toBe('\t'));
  it('Ctrl+Tab passes plain \\t', () => expect(applyModifiers('\t', M(true, false, false)).data).toBe('\t'));
});

describe('applyModifiers: consumption semantics', () => {
  it('unmapped → plain passthrough (still consumed)', () => {
    const unmapped = applyModifiers('5', M(true, false, false));
    expect(unmapped.data).toBe('5');
    expect(unmapped.consumed).toBe(true);
  });
  it('consumed=true on any single char with mods', () =>
    expect(applyModifiers('c', M(false, true, false)).consumed).toBe(true));
  it('consumed=false without mods', () =>
    expect(applyModifiers('c', NO_MODIFIERS).consumed).toBe(false));
  it('consumed=false with empty mods object', () =>
    expect(applyModifiers('c', M(false, false, false)).consumed).toBe(false));
  it('paste passes through, does not consume', () => {
    const paste = applyModifiers('hello world', M(true, false, false));
    expect(paste.data).toBe('hello world');
    expect(paste.consumed).toBe(false);
  });
  it('empty string passes through', () => expect(applyModifiers('', M(true, false, false)).data).toBe(''));
});

describe('applyModifiers: direct-key path (Esc/Tab buttons share the table)', () => {
  it('Esc direct with no mods → \\x1b', () => expect(applyModifiers('\x1b', NO_MODIFIERS).data).toBe('\x1b'));
  it('Esc with Ctrl pending → plain \\x1b (consumed)', () =>
    expect(applyModifiers('\x1b', M(true, false, false)).data).toBe('\x1b'));
});

describe('hasModifiers', () => {
  it('detects combos', () => expect(hasModifiers(M(true, false, true))).toBe(true));
  it('false for NO_MODIFIERS', () => expect(hasModifiers(NO_MODIFIERS)).toBe(false));
  it('false for null', () => expect(hasModifiers(null)).toBe(false));
});

describe('arrowSequence (direct taps honor modifiers + DECCKM)', () => {
  it('arrow up plain → CSI \\e[A', () => expect(arrowSequence('up', NO_MODIFIERS)).toBe('\x1b[A'));
  it('arrow up in application mode → SS3 \\eOA', () => expect(arrowSequence('up', NO_MODIFIERS, true)).toBe('\x1bOA'));
  it('arrow left plain → \\e[D', () => expect(arrowSequence('left', NO_MODIFIERS)).toBe('\x1b[D'));
  it('Ctrl+up → \\e[1;5A', () => expect(arrowSequence('up', M(true, false, false))).toBe('\x1b[1;5A'));
  it('Alt+right → \\e[1;3C', () => expect(arrowSequence('right', M(false, true, false))).toBe('\x1b[1;3C'));
  it('Shift+down → \\e[1;2B', () => expect(arrowSequence('down', M(false, false, true))).toBe('\x1b[1;2B'));
  it('Ctrl+Shift+left → \\e[1;6D', () => expect(arrowSequence('left', M(true, false, true))).toBe('\x1b[1;6D'));
  it('Ctrl+Alt+Shift+up → \\e[1;8A', () => expect(arrowSequence('up', M(true, true, true))).toBe('\x1b[1;8A'));
  it('modified arrow ignores application mode (CSI form)', () =>
    expect(arrowSequence('up', M(true, false, false), true)).toBe('\x1b[1;5A'));
});
