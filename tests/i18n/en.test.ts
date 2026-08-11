import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';

/** 递归提取字典的键路径集合（叶节点）。maxDepth 防止未来嵌套过深导致栈溢出（v3.4 T1.1 S-C1）。 */
function collectKeys(obj: Record<string, unknown>, prefix = '', depth = 0, maxDepth = 5): string[] {
  if (depth >= maxDepth) {
    throw new Error(
      `i18n 字典嵌套超过 maxDepth=${maxDepth}（路径: ${prefix}），请检查 en.test.ts collectKeys`,
    );
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      keys.push(path);
    } else if (typeof value === 'object' && value !== null) {
      keys.push(...collectKeys(value as Record<string, unknown>, path, depth + 1, maxDepth));
    }
  }
  return keys.sort();
}

/** 递归提取字典全部叶节点值（任意深度，非空英文断言用）。 */
function collectLeafValues(obj: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') {
      values.push(value);
    } else if (typeof value === 'object' && value !== null) {
      values.push(...collectLeafValues(value as Record<string, unknown>));
    }
  }
  return values;
}

/** 非空英文断言（v3.4 T1.3 I3：en 字典误抄中文会红——含 CJK 字符校验）。 */
function assertEnglishLeaf(value: string): void {
  expect(value.length).toBeGreaterThan(0);
  expect(value).not.toMatch(/[\u4e00-\u9fff]/);
}

describe('en 字典', () => {
  it('与 zh 字典键结构完全一致（叶节点一一对应）', () => {
    expect(collectKeys(en)).toEqual(collectKeys(zh));
  });

  it('所有文案均为非空英文', () => {
    for (const value of collectLeafValues(en as unknown as Record<string, unknown>)) {
      assertEnglishLeaf(value);
    }
  });

  it('collectKeys maxDepth 超限抛清晰错误（T1.1 S-C1 正向）', () => {
    // 2 层正常
    expect(collectKeys({ a: { b: 'x' } })).toEqual(['a.b']);
    // 6 层嵌套（depth=6 超过 maxDepth=5）报错，错误含 maxDepth 值与路径
    const deep = { a: { b: { c: { d: { e: { f: 'x' } } } } } };
    expect(() => collectKeys(deep)).toThrowError(/maxDepth=5/);
    expect(() => collectKeys(deep)).toThrowError(/a\.b\.c\.d\.e/);
  });

  it('含中文的 mock 字典会使非空英文断言失败（T1.3 I3 负面测试）', () => {
    const mock = { a: { b: '中文文案' } } as unknown as Record<string, unknown>;
    expect(() => {
      for (const value of collectLeafValues(mock)) {
        assertEnglishLeaf(value);
      }
    }).toThrowError(/[\u4e00-\u9fff]/);
  });
});
