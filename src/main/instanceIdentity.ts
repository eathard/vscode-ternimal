// instanceIdentity.ts — 多实例身份（方案 B）。
//
// 启动参数 `--ternimal-instance=<id>`（或 env TERNIMAL_INSTANCE）选择实例；
// 缺省 id='default' 沿用原 userData（存量用户零迁移）。非默认实例：
//   userData → <base>/instances/<id>（配置/证书/会话完全独立）
//   实例色 = 调色板[hash(id)]（同 id 跨重启稳定）→ 顶栏背景 + 托盘图标同色
//   窗口标题 / 托盘提示带实例标签
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface InstanceIdentity {
  id: string;
  isDefault: boolean;
  /** 实例主色 #rrggbb（顶栏背景基调、托盘染色、强调线） */
  color: string;
  /** 顶栏背景（实例色向暗混合，保证前景可读） */
  barBg: string;
  /** 强调色（边线/高亮，= color 提亮） */
  accent: string;
}

/** 8 色调色板（暗底可读、两两可区分） */
const PALETTE = [
  '#c43e4f', // 红
  '#c97a2b', // 橙
  '#7e9c3a', // 绿
  '#2f8f8f', // 青
  '#4a7fd6', // 蓝
  '#8a63c9', // 紫
  '#b85c8f', // 玫红
  '#8d8d8d', // 灰
];

const DEFAULT_BAR_BG = '#181818';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** 按比例混合两色（t=0 → a, t=1 → b） */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

export function resolveInstanceId(argv: string[], env: NodeJS.ProcessEnv): string {
  const fromArg = argv.find((a) => a.startsWith('--ternimal-instance='));
  if (fromArg) {
    const id = fromArg.split('=')[1]?.trim() ?? '';
    // 实例 id 进文件路径：仅允许字母数字-_（防路径注入）
    if (/^[A-Za-z0-9_-]{1,32}$/.test(id)) return id;
  }
  const fromEnv = (env.TERNIMAL_INSTANCE ?? '').trim();
  if (/^[A-Za-z0-9_-]{1,32}$/.test(fromEnv)) return fromEnv;
  return 'default';
}

export function instanceIdentity(id: string, colorOverride?: string): InstanceIdentity {
  if (id === 'default') {
    return { id, isDefault: true, color: '#4a7fd6', barBg: DEFAULT_BAR_BG, accent: '#4a7fd6' };
  }
  const h = crypto.createHash('sha256').update(id, 'utf8').digest();
  const color = colorOverride ?? PALETTE[h[0] % PALETTE.length];
  return {
    id,
    isDefault: false,
    color,
    barBg: mix(color, '#101010', 0.68), // 实例色打底、压暗保可读
    accent: mix(color, '#ffffff', 0.25),
  };
}

/**
 * 非默认实例的 userData 隔离 + 首次种子配置。
 * 必须在 app ready 之前调用（setPath 约束）。
 * 种子策略：克隆默认 config.json，但【关闭中继】——同主码双开会在 relay 侧
 * 打接管大战，双实例必须各自填独立主码后再启用（防呆）。
 */
export function isolateUserData(
  app: { getPath: (n: 'userData') => string; setPath: (n: 'userData', v: string) => void },
  id: string
): string | undefined {
  if (id === 'default') return undefined;
  const base = app.getPath('userData');
  const instDir = path.join(base, 'instances', id);
  const cfgDir = path.join(instDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  // ---- 选色占位（避让同机兄弟实例，杜绝撞色；.color 长期持久） ----
  let color: string | undefined;
  const colorFile = path.join(instDir, '.color');
  try {
    if (fs.existsSync(colorFile)) {
      const c = fs.readFileSync(colorFile, 'utf8').trim();
      if (/^#[0-9a-f]{6}$/i.test(c)) color = c.toLowerCase();
    }
    if (!color) {
      const used = new Set<string>();
      const siblingsRoot = path.join(base, 'instances');
      for (const sib of fs.readdirSync(siblingsRoot)) {
        if (sib === id) continue;
        try {
          const c = fs.readFileSync(path.join(siblingsRoot, sib, '.color'), 'utf8').trim();
          if (/^#[0-9a-f]{6}$/i.test(c)) used.add(c.toLowerCase());
        } catch { /* 无占位 → 未用 */ }
      }
      const h = crypto.createHash('sha256').update(id, 'utf8').digest();
      const start = h[0] % PALETTE.length;
      for (let i = 0; i < PALETTE.length && !color; i++) {
        const cand = PALETTE[(start + i) % PALETTE.length];
        if (!used.has(cand)) color = cand;
      }
      color ??= PALETTE[start]; // 超过 8 个实例：回退哈希位（允许复用）
      fs.writeFileSync(colorFile, color + '\n', { mode: 0o600 });
    }
  } catch { /* 选色失败不阻断：走哈希默认 */ }
  const src = path.join(base, 'config', 'config.json');
  const dst = path.join(cfgDir, 'config.json');
  if (!fs.existsSync(dst) && fs.existsSync(src)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (cfg && typeof cfg === 'object' && cfg.relay && typeof cfg.relay === 'object') {
        cfg.relay.enabled = false; // 防同主码接管大战：双开后在各自设置里启用
      }
      fs.writeFileSync(dst, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    } catch {
      /* 种子失败不阻断启动：走默认配置 */
    }
  }
  app.setPath('userData', instDir);
  return color;
}
