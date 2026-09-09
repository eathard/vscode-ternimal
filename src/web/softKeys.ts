// SoftKeys (web-only): draggable floating bar with Ctrl/Alt/Shift toggles
// plus direct Esc/Tab keys. One-shot semantics live in TerminalApp +
// modifierKeys.ts; this module is pure UI:
//   - pointerdown on buttons NEVER steals focus from xterm's textarea
//   - drag via the handle (or bar background) with pointer capture;
//     position clamped to the viewport and persisted in localStorage
//   - collapses to a small round handle when the collapse toggle is tapped
//   - clears pending combos on tab visibility loss / window blur
import './softkeys.css';
import type { TerminalApp } from '../renderer/terminalApp';
import { t, detectLocale } from '../shared/i18n';

const POS_KEY = 'ternimal-softkeys-pos';

interface SavedPos {
  x: number;
  y: number;
}

export function mountSoftKeys(app: TerminalApp): HTMLElement {
  const locale = detectLocale(navigator.language);
  const bar = document.createElement('div');
  bar.id = 'softkeys';
  bar.innerHTML = `
    <button class="sk-handle" title="${t(locale, 'sk.drag')}" aria-label="${t(locale, 'sk.drag')}">⠿</button>
    <button class="sk-mod" data-mod="ctrl">Ctrl</button>
    <button class="sk-mod" data-mod="alt">Alt</button>
    <button class="sk-mod" data-mod="shift">Shift</button>
    <span class="sk-sep"></span>
    <button class="sk-direct" data-key="\x1b">Esc</button>
    <button class="sk-direct" data-key="\t">Tab</button>
    <span class="sk-sep"></span>
    <button class="sk-arrow" data-dir="left" title="←">←</button>
    <button class="sk-arrow" data-dir="down" title="↓">↓</button>
    <button class="sk-arrow" data-dir="up" title="↑">↑</button>
    <button class="sk-arrow" data-dir="right" title="→">→</button>
  `;
  document.body.appendChild(bar);

  const modButtons: Record<string, HTMLButtonElement> = {};
  bar.querySelectorAll<HTMLButtonElement>('.sk-mod').forEach((b) => {
    modButtons[b.dataset.mod!] = b;
  });

  const refresh = () => {
    const mods = app.getPendingMods();
    (Object.keys(modButtons) as Array<keyof typeof mods>).forEach((k) => {
      modButtons[k].classList.toggle('sk-active', !!(mods as any)[k]);
    });
  };
  app.onPendingModsChange = refresh;

  // Buttons: act on pointerdown (instant on touch, immune to the click
  // suppression that pointerdown-preventDefault causes under CDP-driven
  // synthetic mice); preventDefault keeps xterm focused.
  bar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (b.classList.contains('sk-mod')) {
        const mods = app.getPendingMods();
        const key = b.dataset.mod as 'ctrl' | 'alt' | 'shift';
        mods[key] = !mods[key];
        app.setPendingMods(mods);
        vibrate();
      } else if (b.classList.contains('sk-direct')) {
        app.sendDirect(b.dataset.key!);
        vibrate();
      } else if (b.classList.contains('sk-arrow')) {
        app.sendArrow(b.dataset.dir as 'up' | 'down' | 'left' | 'right');
        vibrate();
      }
      // handle button: drag only, no action
    });
  });

  // ---- drag (handle or any non-button area) ----
  let dragging = false;
  let offX = 0;
  let offY = 0;
  const startDrag = (e: PointerEvent) => {
    dragging = true;
    const rect = bar.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic/testing pointers may not be capturable — drag still
      // works via bubbling listeners on the bar.
    }
    e.preventDefault();
  };
  (bar.querySelector('.sk-handle') as HTMLButtonElement).addEventListener(
    'pointerdown',
    startDrag
  );
  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button.sk-mod, button.sk-direct, button.sk-arrow')) return;
    startDrag(e);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    positionBar(e.clientX - offX, e.clientY - offY);
  });
  bar.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    savePos();
  });
  bar.addEventListener('pointercancel', () => {
    dragging = false;
  });

  // ---- positioning ----
  function clamp(x: number, y: number): SavedPos {
    const w = bar.offsetWidth || 300;
    const h = bar.offsetHeight || 44;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)),
    };
  }
  function positionBar(x: number, y: number): void {
    const p = clamp(x, y);
    bar.style.left = `${p.x}px`;
    bar.style.top = `${p.y}px`;
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
  }
  function savePos(): void {
    try {
      localStorage.setItem(
        POS_KEY,
        JSON.stringify({ x: bar.offsetLeft, y: bar.offsetTop })
      );
    } catch {
      /* storage unavailable — position just won't persist */
    }
  }
  function restorePos(): void {
    let pos: SavedPos | null = null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) pos = JSON.parse(raw);
    } catch {
      /* ignore corrupt entries */
    }
    if (pos) {
      positionBar(pos.x, pos.y);
    } else {
      // default: bottom-center
      bar.style.left = '50%';
      bar.style.top = 'auto';
      bar.style.right = 'auto';
      bar.style.bottom = '18px';
      bar.style.transform = 'translateX(-50%)';
    }
  }
  restorePos();
  // Dropping the centering transform must first convert the VISUAL
  // position (rect includes the translateX) into layout coords —
  // otherwise the bar jumps right by half its width.
  const dropTransform = (): void => {
    if (bar.style.transform === 'none') return;
    const r = bar.getBoundingClientRect();
    bar.style.transform = 'none';
    positionBar(r.left, r.top);
  };
  bar.addEventListener('pointerdown', dropTransform, { once: true });
  window.addEventListener('resize', () => {
    const r = bar.getBoundingClientRect();
    bar.style.transform = 'none';
    positionBar(r.left, r.top); // re-clamp into viewport
  });

  // ---- safety: never leak a pending combo across focus/visibility loss ----
  const clear = () => app.clearPendingMods();
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clear();
  });

  return bar;
}

function vibrate(): void {
  if (navigator.vibrate) navigator.vibrate(12);
}
