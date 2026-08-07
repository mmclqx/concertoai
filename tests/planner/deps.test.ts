/**
 * 计划依赖检测单元测试。
 *
 * 覆盖：步骤提取、显式依赖、文件依赖、隐式读写依赖、
 * 拓扑排序、循环检测、并行组计算。
 */

import { describe, expect, it } from 'vitest';

import { analyzeDeps } from '../../src/planner/deps';

describe('步骤提取', () => {
  it('编号列表被解析为步骤', () => {
    const plan = [
      '1. 读取 src/index.ts',
      '2. 编辑 src/index.ts 添加导出',
      '3. 运行 npm test',
    ].join('\n');

    const result = analyzeDeps(plan);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]?.title).toBe('读取 src/index.ts');
    expect(result.steps[1]?.title).toBe('编辑 src/index.ts 添加导出');
    expect(result.steps[2]?.title).toBe('运行 npm test');
  });

  it('空计划返回空步骤', () => {
    const result = analyzeDeps('');
    expect(result.steps).toHaveLength(0);
  });

  it('识别写操作标记', () => {
    const plan = '1. 创建 src/new.ts\n2. 查看 src/new.ts';
    const result = analyzeDeps(plan);
    expect(result.steps[0]?.isWrite).toBe(true);
    expect(result.steps[1]?.isWrite).toBe(false);
  });

  it('提取文件路径引用', () => {
    const plan = '1. 读取 `src/index.ts` 和 `package.json`';
    const result = analyzeDeps(plan);
    const refs = result.steps[0]?.fileRefs ?? [];
    expect(refs).toContain('src/index.ts');
    expect(refs).toContain('package.json');
  });
});

describe('显式依赖', () => {
  it('depends on: 格式被解析', () => {
    const plan = [
      '1. 初始化项目',
      '2. 编写代码 depends on: 1',
      '3. 运行测试',
    ].join('\n');

    const result = analyzeDeps(plan);
    const deps = result.dependencies.filter((d) => d.from === 2 && d.to === 1);
    expect(deps.length).toBeGreaterThanOrEqual(1);
  });

  it('多依赖用逗号分隔', () => {
    const plan = [
      '1. 步骤一',
      '2. 步骤二',
      '3. 步骤三 depends on: 1, 2',
    ].join('\n');

    const result = analyzeDeps(plan);
    expect(result.dependencies.some((d) => d.from === 3 && d.to === 1)).toBe(true);
    expect(result.dependencies.some((d) => d.from === 3 && d.to === 2)).toBe(true);
  });
});

describe('文件依赖检测', () => {
  it('后续步骤引用前序步骤写入的文件 → 自动建立依赖', () => {
    const plan = [
      '1. 创建 `src/config.ts`',
      '2. 编辑 `src/config.ts` 添加新字段',
    ].join('\n');

    const result = analyzeDeps(plan);
    const fileDep = result.dependencies.find(
      (d) => d.from === 2 && d.to === 1 && d.reason.includes('config.ts'),
    );
    expect(fileDep).toBeDefined();
  });
});

describe('拓扑排序', () => {
  it('链式依赖按顺序排列', () => {
    const plan = [
      '1. 第一步',
      '2. 第二步 depends on: 1',
      '3. 第三步 depends on: 2',
    ].join('\n');

    const result = analyzeDeps(plan);
    expect(result.ordered).toEqual([1, 2, 3]);
    expect(result.cycles).toHaveLength(0);
  });

  it('无依赖步骤自然顺序', () => {
    const plan = ['1. A', '2. B', '3. C'].join('\n');
    const result = analyzeDeps(plan);
    expect(result.ordered).toEqual([1, 2, 3]);
  });
});

describe('循环检测', () => {
  it('循环依赖被检出', () => {
    const plan = [
      '1. A depends on: 2',
      '2. B depends on: 1',
    ].join('\n');

    const result = analyzeDeps(plan);
    expect(result.cycles.length).toBeGreaterThan(0);
  });
});

describe('并行组', () => {
  it('无依赖步骤归入同一并行组', () => {
    const plan = ['1. A', '2. B', '3. C'].join('\n');
    const result = analyzeDeps(plan);
    // 三个独立步骤应在同一组
    expect(result.parallelGroups.some((g) => g.includes(1) && g.includes(2) && g.includes(3))).toBe(
      true,
    );
  });

  it('有依赖时分组正确', () => {
    const plan = [
      '1. 第一步',
      '2. 第二步 depends on: 1',
      '3. 第三步',
    ].join('\n');

    const result = analyzeDeps(plan);
    // 步骤 1 和 3 可并行，步骤 2 依赖 1
    const firstGroup = result.parallelGroups[0];
    expect(firstGroup).toBeDefined();
    if (firstGroup !== undefined) {
      expect(firstGroup).toContain(1);
      expect(firstGroup).toContain(3);
    }
  });
});
