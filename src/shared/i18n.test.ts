// i18n.test.ts — zh/en dictionaries with en fallback (OSS readiness).
// (migrated from scripts/verify-softkeys.mjs)
import { describe, expect, it } from 'vitest';
import { t, detectLocale } from './i18n';

describe('detectLocale', () => {
  it('zh variants → zh', () => {
    expect(detectLocale('zh-CN')).toBe('zh');
    expect(detectLocale('zh_TW')).toBe('zh');
  });
  it('en/undefined/null → en', () => {
    expect(detectLocale('en-US')).toBe('en');
    expect(detectLocale(undefined)).toBe('en');
    expect(detectLocale(null)).toBe('en');
  });
});

describe('t()', () => {
  it('resolves zh and en for the same key', () => {
    expect(t('zh', 'auth.submit')).not.toBe(t('en', 'auth.submit'));
    expect(t('en', 'auth.submit')).toBe('Sign in');
  });
  it('falls back to the key itself on unknown key', () => {
    expect(t('zh', 'nonexistent.key')).toBe('nonexistent.key');
  });
});
