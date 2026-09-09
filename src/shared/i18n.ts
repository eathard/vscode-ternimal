// i18n (open-source readiness): flat-string dictionaries for the small,
// fixed UI surface (tray menu, QR info window, auth page, soft-keyboard).
// No framework — a lookup with English fallback. Locale is detected once
// by the embedder: main process from app.getLocale(), web from
// navigator.language (both fall back to 'en' for anything non-Chinese).
export type Locale = 'zh' | 'en';

export function detectLocale(tag: string | undefined | null): Locale {
  return !!tag && tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const STRINGS: Record<Locale, Record<string, string>> = {
  zh: {
    'tray.show': '显示窗口',
    'tray.copyUrl': '复制访问地址',
    'tray.viewAccess': '查看访问信息（二维码）',
    'tray.rotateToken': '重置访问令牌',
    'tray.quit': '退出',
    'tray.tooltip': 'Ternimal',
    'info.title': 'Ternimal 访问信息',
    'info.heading': '手机扫码访问 Ternimal',
    'info.tip': '扫码后浏览器将自动完成鉴权（首次需信任自签名证书）。\n令牌随链接以 URL 片段携带，不会出现在服务器日志中。',
    'info.url': '访问链接（含令牌，可直接复制给内网设备）',
    'info.token': '访问令牌（手动输入用，重置后立即失效）',
    'info.fp': '证书 SHA-256 指纹（应与登录页显示一致）',
    'info.qrFailed': '（二维码生成失败 — 请使用下方链接/令牌）',
    'auth.title': 'Ternimal — 登录',
    'auth.heading': 'Ternimal 远程终端',
    'auth.placeholder': '访问令牌（或扫二维码）',
    'auth.submit': '登录',
    'auth.locked': '已锁定 — 请一分钟后重试',
    'auth.wrongToken': '令牌错误',
    'auth.tooMany': '尝试次数过多',
    'auth.hint': '扫码或粘贴带令牌的访问链接时无需手动输入。',
    'auth.fpLabel': '证书 SHA-256 指纹（请在主机上核对）：',
    'sk.drag': '拖动',
  },
  en: {
    'tray.show': 'Show window',
    'tray.copyUrl': 'Copy access URL',
    'tray.viewAccess': 'Access info (QR code)',
    'tray.rotateToken': 'Rotate access token',
    'tray.quit': 'Quit',
    'tray.tooltip': 'Ternimal',
    'info.title': 'Ternimal access info',
    'info.heading': 'Scan to open Ternimal on your phone',
    'info.tip': 'Scanning signs you in automatically (trust the self-signed certificate on first visit).\nThe token rides in the URL fragment and never reaches server logs.',
    'info.url': 'Access link (token included — safe to hand to LAN devices)',
    'info.token': 'Access token (manual entry; invalidated on rotate)',
    'info.fp': 'Certificate SHA-256 fingerprint (must match the sign-in page)',
    'info.qrFailed': '(QR generation failed — use the link/token below)',
    'auth.title': 'Ternimal — Sign in',
    'auth.heading': 'Ternimal Remote',
    'auth.placeholder': 'Access token (or scan the QR code)',
    'auth.submit': 'Sign in',
    'auth.locked': 'Locked — retry in a minute',
    'auth.wrongToken': 'Wrong token',
    'auth.tooMany': 'Too many attempts',
    'auth.hint': 'No typing needed when scanning the QR code or opening a tokenized link.',
    'auth.fpLabel': 'Certificate SHA-256 fingerprint (verify on the host):',
    'sk.drag': 'Drag',
  },
};

export function t(locale: Locale, key: string): string {
  return STRINGS[locale][key] ?? STRINGS.en[key] ?? key;
}
