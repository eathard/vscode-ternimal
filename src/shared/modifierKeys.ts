// modifierKeys (web soft-keyboard, design frozen with user).
//
// Pure byte-level mapping for the Ctrl/Alt/Shift soft-keyboard: mobile
// browsers cannot produce modified keystrokes, so the web client keeps a
// pending modifier state and translates the NEXT single-character input
// into the corresponding VT/xterm escape sequence before it enters the
// transport pipeline. No event synthesis, fully deterministic/testable.
//
// Semantics (frozen with the user):
// - one-shot: any single-char keystroke while modifiers are pending both
//   maps (or passes through plain when unmapped) and CONSUMES the state
// - multi-char input (paste / IME commit) passes through untouched and
//   does NOT consume — pasting is not a keystroke
// - Ctrl+a..z → \x01..\x1a; Ctrl+[ \ ] ^ _ space/?/@ specials
// - Alt+key → ESC-prefixed (readline meta), applied after ctrl/shift
// - Shift+Tab → \x1b[Z (backtab); Ctrl+Shift+x ≡ Ctrl+x (xterm default)
export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false, shift: false };

export function hasModifiers(mods: ModifierState | null | undefined): boolean {
  return !!mods && !!(mods.ctrl || mods.alt || mods.shift);
}

export interface ModifierResult {
  /** Bytes to send instead of the raw input. */
  data: string;
  /** True when the pending modifier state should be reset (one-shot). */
  consumed: boolean;
}

/** Ctrl-special table (VT conventions; ? → DEL, space/@ → NUL). */
const CTRL_SPECIALS: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  '?': '\x7f',
};

/**
 * Translate one keystroke under the pending modifiers.
 * See module comment for the frozen semantics.
 */
export function applyModifiers(
  data: string,
  mods: ModifierState | null | undefined
): ModifierResult {
  if (!hasModifiers(mods)) return { data, consumed: false };
  if (data.length !== 1) return { data, consumed: false };

  let out: string | null = null;
  const ch = data;

  if (ch === '\t') {
    // Tab family: only Shift+Tab has a distinct sequence (backtab); all
    // other Tab combinations pass through plain.
    out = mods!.shift ? '\x1b[Z' : '\t';
  } else {
    let base: string | null = null;
    if (mods!.ctrl) {
      const lower = ch.toLowerCase();
      if (lower >= 'a' && lower <= 'z') {
        base = String.fromCharCode(lower.charCodeAt(0) - 96);
      } else if (CTRL_SPECIALS[ch] !== undefined) {
        base = CTRL_SPECIALS[ch];
      }
    }
    if (base === null && mods!.shift) {
      // Shift on an as-yet-unmapped char: uppercase letters (IME usually
      // already sends the right case — harmless), other chars unchanged.
      base = ch.toLowerCase() !== ch.toUpperCase() && ch === ch.toLowerCase() ? ch.toUpperCase() : ch;
    }
    out = base ?? ch;
  }

  // Alt prefixes whatever we produced (readline meta binding).
  if (mods!.alt && out !== null) out = '\x1b' + out;

  return { data: out ?? data, consumed: true };
}
