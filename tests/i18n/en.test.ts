import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';

/** 递归提取字典的键路径集合（叶节点）。 */
function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      keys.push(path);
    } else if (typeof value === 'object' && value !== null) {
      keys.push(...collectKeys(value as Record<string, unknown>, path));
    }
  }
  return keys.sort();
}

describe('en 字典', () => {
  it('与 zh 字典键结构完全一致（叶节点一一对应）', () => {
    expect(collectKeys(en)).toEqual(collectKeys(zh));
  });

  it('所有文案均为非空英文', () => {
    for (const value of Object.values(en).flatMap((v) =>
      typeof v === 'object' && v !== null
        ? Object.values(v as Record<string, unknown>).flatMap((vv) =>
            typeof vv === 'object' && vv !== null
              ? Object.values(vv as Record<string, unknown>)
              : [vv],
          )
        : [v],
    )) {
      expect(typeof value).toBe('string');
      expect(String(value).length).toBeGreaterThan(0);
    }
  });
});
