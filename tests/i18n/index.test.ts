import { describe, expect, it } from 'vitest';

import { DICTS, fmt, resolveLocale, setLocale, t } from '../../src/i18n';

describe('resolveLocale', () => {
  it('识别 zh / en，未知值回退 zh', () => {
    expect(resolveLocale('zh')).toBe('zh');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('EN')).toBe('en');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale('fr')).toBe('zh');
    expect(resolveLocale(undefined)).toBe('zh');
  });
});

describe('setLocale / t', () => {
  it('默认中文，切换 en 后生效', () => {
    setLocale('zh');
    expect(t().errors.noApiKey).toBe('未找到 DEEPSEEK_API_KEY 环境变量，请先设置后再启动。');
    setLocale('en');
    expect(t().errors.noApiKey).toContain('DEEPSEEK_API_KEY');
    expect(t().status.model).toBe('Model');
    setLocale('zh');
  });

  it('DICTS 包含两种语言且为同构字典', () => {
    expect(Object.keys(DICTS).sort()).toEqual(['en', 'zh']);
    expect(DICTS.zh.prompt.placeholder).toContain('Enter');
    expect(DICTS.en.prompt.placeholder).toContain('Enter');
  });

  it('fmt 占位符替换与语言无关', () => {
    setLocale('en');
    expect(fmt(t().errors.modelCallFailed, { message: 'x' })).toBe('Model call failed: x');
    setLocale('zh');
  });
});
