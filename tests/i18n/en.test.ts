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

/**
 * 递归提取「键路径 → 模板原文」映射（只收叶节点字符串）。
 *
 * 与 `collectKeys` 同一 maxDepth 口径：嵌套继续加深时抛清楚错误，而不是静默漏掉深层键
 * （漏键 = 少比一组占位符 = 假绿）。
 */
function collectLeafMap(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
  depth = 0,
  maxDepth = 5,
): Record<string, string> {
  if (depth >= maxDepth) {
    throw new Error(
      `i18n 字典嵌套超过 maxDepth=${maxDepth}（路径: ${prefix}），请检查 en.test.ts collectLeafMap`,
    );
  }
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      out[path] = value;
    } else if (typeof value === 'object' && value !== null) {
      collectLeafMap(value as Record<string, unknown>, path, out, depth + 1, maxDepth);
    }
  }
  return out;
}

/** 提取模板里的占位符名集合（`{path}` → `path`）；排序使比对与书写顺序无关。 */
function collectPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

/**
 * 找出 zh/en 占位符集合不一致的键（空数组 = 全部一致）。
 *
 * 只比**同一个键**的两侧占位符；键本身缺失由 `collectKeys` 用例负责，
 * 这里跳过以免同一个问题报两遍。
 */
function findPlaceholderMismatches(
  zhMap: Record<string, string>,
  enMap: Record<string, string>,
): string[] {
  const mismatches: string[] = [];
  for (const [key, zhTemplate] of Object.entries(zhMap)) {
    const enTemplate = enMap[key];
    if (enTemplate === undefined) {
      continue;
    }
    const zhPlaceholders = collectPlaceholders(zhTemplate);
    const enPlaceholders = collectPlaceholders(enTemplate);
    if (zhPlaceholders.join(',') !== enPlaceholders.join(',')) {
      mismatches.push(`${key}: zh=[${zhPlaceholders.join(',')}] en=[${enPlaceholders.join(',')}]`);
    }
  }
  return mismatches.sort();
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

/**
 * 占位符一致性护栏。
 *
 * ## 抓什么
 * 同一个键在 zh / en 两侧的**占位符集合必须相同**：一侧写了 `{path}` 另一侧漏掉 →
 * 英文用户看到字面 `{path}`（`fmt()` 缺参数时保留原样，见 `src/i18n/zh.ts` 的 `fmt`），
 * 或者一侧多写 `{count}` 导致参数被静默忽略、关键数字丢失。两个方向的偏斜都算 bug。
 *
 * ## 不抓什么（**故意不抓，别误以为这里能兜住**）
 * - **两侧一致地漏**：`metricsCmd.statusOff` 曾 zh/en 都缺 `{path}`，本护栏**判为一致、不会红**
 *   ——那是「设计契约缺失」（该显示文件路径却没显示），不是翻译偏斜。挡它的是**用法级用例**：
 *   `tests/cli/slash-metrics.test.ts` 的「status 按当前开关给不同回执，且都带真实文件路径」。
 * - **调用方传了模板不消费的键**：`fmt()` 对多余参数静默忽略，不做校验；同上靠用法级断言。
 * - **键结构缺失**：由上面的 `collectKeys` 用例负责，这里跳过以免重复报错。
 */
describe('占位符一致性（zh ↔ en）', () => {
  it('同一键在 zh / en 两侧的占位符集合必须一致', () => {
    const zhMap = collectLeafMap(zh as unknown as Record<string, unknown>);
    const enMap = collectLeafMap(en as unknown as Record<string, unknown>);
    // 自证：真的扫到了足够多的键，否则下面的 of [] 会变成空循环假绿
    expect(Object.keys(zhMap).length).toBeGreaterThan(500);
    expect(Object.keys(enMap).length).toBe(Object.keys(zhMap).length);
    expect(findPlaceholderMismatches(zhMap, enMap)).toEqual([]);
  });

  it('护栏自证：真偏斜会被抓（一侧多 / 一侧少 / 名字不同 / 两侧都漏判为一致）', () => {
    // 一侧少：英文漏了 {path} —— 正是本护栏要挡的翻译偏斜
    expect(findPlaceholderMismatches({ a: '文件 {path}' }, { a: 'file' })).toEqual([
      'a: zh=[path] en=[]',
    ]);
    // 一侧多：英文多了 {count}，中文模板会静默丢掉这个参数
    expect(findPlaceholderMismatches({ a: '文件' }, { a: 'file {count}' })).toEqual([
      'a: zh=[] en=[count]',
    ]);
    // 名字不同：{path} ↔ {file}，两侧都填不上对方的坑
    expect(findPlaceholderMismatches({ a: '{path}' }, { a: '{file}' })).toEqual([
      'a: zh=[path] en=[file]',
    ]);
    // 书写顺序不同但集合相同 → 不算不一致（避免为了顺序改文案）
    expect(findPlaceholderMismatches({ a: '{a} {b}' }, { a: '{b} {a}' })).toEqual([]);
    // 边界诚实标注：两侧一致地漏 → 判为一致（这类靠用法级用例挡，见上方说明）
    expect(findPlaceholderMismatches({ a: '已关闭' }, { a: 'disabled' })).toEqual([]);
  });

  it('collectLeafMap maxDepth 超限抛清晰错误（与 collectKeys 同口径）', () => {
    const deep = { a: { b: { c: { d: { e: { f: '{x}' } } } } } };
    expect(() => collectLeafMap(deep)).toThrowError(/maxDepth=5/);
    expect(() => collectLeafMap(deep)).toThrowError(/a\.b\.c\.d\.e/);
  });
});
