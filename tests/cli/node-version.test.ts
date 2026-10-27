/**
 * Node 版本检查测试（v5.0 T1，来自 npx 实测发现）。
 *
 * 覆盖：
 * - 满足 / 不满足 engines 的判定（含边界 21.9.0 / 22.0.0）；
 * - 只在交互式终端提示（CI / 管道静默，G3 不添噪音）；
 * - 版本串畸形不崩（解析失败按 0 处理）；
 * - zh/en 双语占位符替换（{current} / {required} 不残留）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkNodeVersion,
  isNodeWarnSuppressed,
  MIN_NODE_MAJOR,
  SUPPRESS_NODE_WARN_ENV,
} from '../../src/cli/node-version';
import { setLocale } from '../../src/i18n';

beforeEach(() => {
  setLocale('zh');
});

afterEach(() => {
  setLocale('zh');
});

describe('checkNodeVersion：版本判定（v5.0 T1）', () => {
  it('满足要求（22.x / 23.x / 24.x）→ ok 且无警告', () => {
    for (const v of ['22.0.0', '22.20.1', '23.5.1', '24.1.0']) {
      const r = checkNodeVersion(v, { isTTY: true });
      expect(r.ok).toBe(true);
      expect(r.warning).toBe('');
    }
  });

  it('不满足要求（20.x / 21.x）→ 有中文警告且不阻断', () => {
    for (const v of ['20.20.2', '21.9.0']) {
      const r = checkNodeVersion(v, { isTTY: true });
      expect(r.ok).toBe(false);
      // 不阻断：函数只给提示，调用方照常执行（checkNodeVersion 不做 process.exit）
      expect(r.warning).toContain(v);
      expect(r.warning).toContain(`Node ${MIN_NODE_MAJOR}+`);
      expect(r.warning).toContain('⚠️');
    }
  });

  it('边界：21.99.99 不满足、22.0.0 满足（主版本比较而非字符串比较）', () => {
    expect(checkNodeVersion('21.99.99', { isTTY: true }).ok).toBe(false);
    expect(checkNodeVersion('22.0.0', { isTTY: true }).ok).toBe(true);
    // 字符串比较会误判 '9' > '22'，这里确认按数字比较
    expect(checkNodeVersion('9.11.2', { isTTY: true }).ok).toBe(false);
  });

  it('非交互式终端（CI / 管道 / 脚本）→ 静默不输出（G3 不添噪音）', () => {
    const r = checkNodeVersion('20.20.2', { isTTY: false });
    expect(r.ok).toBe(false);
    expect(r.warning).toBe('');
  });

  it('畸形版本串不崩（按 0 处理并提示）', () => {
    for (const v of ['', 'abc', 'v22', 'x.y.z']) {
      const r = checkNodeVersion(v, { isTTY: true });
      expect(Number.isNaN(r.major)).toBe(false);
      expect(r.ok).toBe(false);
    }
    // 'v22' 解析出 NaN → major 0；不抛异常即达标
    expect(() => checkNodeVersion('v22', { isTTY: true })).not.toThrow();
  });

  it('major 字段反映真实主版本', () => {
    expect(checkNodeVersion('22.20.1').major).toBe(22);
    expect(checkNodeVersion('20.20.2').major).toBe(20);
  });

  it('英文环境给出英文警告（G4 双语）', () => {
    setLocale('en');
    const r = checkNodeVersion('20.20.2', { isTTY: true });
    expect(r.warning).toContain('Current Node 20.20.2');
    expect(r.warning).toContain('requires');
  });

  it('占位符全部替换（无 {current} / {required} 残留）', () => {
    const zhWarn = checkNodeVersion('20.1.0', { isTTY: true }).warning;
    expect(zhWarn).not.toMatch(/\{[a-z]+\}/i);
    setLocale('en');
    const enWarn = checkNodeVersion('20.1.0', { isTTY: true }).warning;
    expect(enWarn).not.toMatch(/\{[a-z]+\}/i);
  });
});

describe('isNodeWarnSuppressed：用户显式静默（v5.0 T1 防噪音）', () => {
  it('CONCERTOAI_NO_NODE_WARN=1 / true → 静默', () => {
    expect(isNodeWarnSuppressed({ [SUPPRESS_NODE_WARN_ENV]: '1' })).toBe(true);
    expect(isNodeWarnSuppressed({ [SUPPRESS_NODE_WARN_ENV]: 'true' })).toBe(true);
  });

  it('未设置 / 其他值 → 不静默（默认提示）', () => {
    expect(isNodeWarnSuppressed({})).toBe(false);
    expect(isNodeWarnSuppressed({ [SUPPRESS_NODE_WARN_ENV]: '0' })).toBe(false);
    expect(isNodeWarnSuppressed({ [SUPPRESS_NODE_WARN_ENV]: 'yes' })).toBe(false);
  });

  it('suppressed=true 时不产生警告（即使版本过低）', () => {
    const r = checkNodeVersion('20.20.2', { isTTY: true, suppressed: true });
    expect(r.ok).toBe(false);
    expect(r.warning).toBe('');
  });
});
