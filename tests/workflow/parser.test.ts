/**
 * 工作流 YAML 解析/序列化/校验/依赖推断测试（v4.0 M2 T2.2/T2.4/T2.5）。
 */

import { describe, expect, it } from 'vitest';

import {
  inferDependencies,
  parseWorkflowYaml,
  serializeWorkflowYaml,
} from '../../src/workflow/parser';
import type { Workflow, WorkflowStep } from '../../src/workflow/types';

describe('parseWorkflowYaml（T2.2 解析 + zod 校验）', () => {
  it('解析完整 YAML（name/description/steps + depends/files/retry/require）', () => {
    const yaml = [
      'name: release',
      'description: 发布流程',
      'steps:',
      '  - name: lint',
      '    run: npm run lint',
      '  - name: test',
      '    run: npm run test -- --silent',
      '    depends:',
      '      - lint',
      '    retry: 1',
      '    require: approval',
      '    files:',
      '      - CHANGELOG.md',
    ].join('\n');
    const wf = parseWorkflowYaml(yaml);
    expect(wf.name).toBe('release');
    expect(wf.description).toBe('发布流程');
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[1]?.depends).toEqual(['lint']);
    expect(wf.steps[1]?.retry).toBe(1);
    expect(wf.steps[1]?.require).toBe('approval');
    expect(wf.steps[1]?.files).toEqual(['CHANGELOG.md']);
  });

  it('剥离行尾注释（含引号内 # 保护）', () => {
    const yaml = [
      'name: demo # 行尾注释',
      'steps:',
      '  - name: a',
      '    run: echo "a#b" # 引号内 # 保留',
    ].join('\n');
    const wf = parseWorkflowYaml(yaml);
    expect(wf.name).toBe('demo');
    expect(wf.steps[0]?.run).toBe('echo "a#b"');
  });

  it('未知顶层键 → 抛错', () => {
    expect(() =>
      parseWorkflowYaml('name: x\nfoo: bar\nsteps:\n  - name: a\n    run: echo a'),
    ).toThrow('未知顶层键');
  });

  it('缺失 steps → 抛错', () => {
    expect(() => parseWorkflowYaml('name: x')).toThrow('缺少 steps');
  });

  it('steps 列表缩进不一致 → 抛错（含行号）', () => {
    const yaml = 'name: x\nsteps:\n  - name: a\n    run: echo a\n - name: b\n    run: echo b';
    expect(() => parseWorkflowYaml(yaml)).toThrow('缩进');
  });

  it('空 YAML / 仅注释 → 抛错', () => {
    expect(() => parseWorkflowYaml('')).toThrow('为空');
    expect(() => parseWorkflowYaml('# 注释')).toThrow('为空');
  });

  it('工作流名校验：非法字符拒绝', () => {
    expect(() =>
      parseWorkflowYaml('name: "bad name"\nsteps:\n  - name: a\n    run: echo a'),
    ).toThrow('工作流名');
  });
});

describe('serializeWorkflowYaml（T2.5 export）', () => {
  it('roundtrip：parse(serialize(wf)) 与原工作流等价', () => {
    const wf: Workflow = {
      name: 'release',
      description: '发布流程',
      steps: [
        { name: 'lint', run: 'npm run lint' },
        {
          name: 'publish',
          run: 'npm publish',
          depends: ['lint'],
          require: 'approval',
          files: ['package.json'],
          retry: 2,
        },
      ],
    };
    const yaml = serializeWorkflowYaml(wf);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed).toEqual(wf);
  });

  it('retry: 0 保留输出（export/import 后语义不变，v4.1 发布前修复）', () => {
    const wf: Workflow = {
      name: 'no-retry',
      steps: [{ name: 'lint', run: 'npm run lint', retry: 0 }],
    };
    const yaml = serializeWorkflowYaml(wf);
    expect(yaml).toContain('    retry: 0');
    const round = parseWorkflowYaml(yaml);
    expect(round.steps[0]?.retry).toBe(0);
  });

  it('含特殊字符值自动加引号（冒号/空格/井号）', () => {
    const yaml = serializeWorkflowYaml({
      name: 'demo',
      steps: [{ name: 'x', run: 'echo "a: b" # c' }],
    });
    expect(yaml).toContain('run: "echo \\"a: b\\" # c"');
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.steps[0]?.run).toBe('echo "a: b" # c');
  });
});

describe('inferDependencies（T2.4 依赖推断）', () => {
  const steps = (overrides: Array<Partial<WorkflowStep> & { name: string; run: string }>) =>
    overrides as WorkflowStep[];

  it('test 依赖 build、publish 依赖 build（目标步骤存在时推断）', () => {
    const result = inferDependencies(
      steps([
        { name: 'build', run: 'npm run build' },
        { name: 'test', run: 'npm run test' },
        { name: 'publish', run: 'npm publish' },
      ]),
    );
    expect(result).toContainEqual({ from: 'test', to: 'build', reason: expect.any(String) });
    expect(result).toContainEqual({ from: 'publish', to: 'build', reason: expect.any(String) });
  });

  it('已显式声明依赖 → 不重复推断', () => {
    const result = inferDependencies(
      steps([
        { name: 'build', run: 'npm run build' },
        { name: 'test', run: 'npm run test', depends: ['build'] },
      ]),
    );
    expect(result).not.toContainEqual(expect.objectContaining({ from: 'test', to: 'build' }));
  });

  it('目标步骤不存在 → 不推断（build 步骤缺失时 test 无依赖可加）', () => {
    const result = inferDependencies(steps([{ name: 'test', run: 'npm run test' }]));
    expect(result).toEqual([]);
  });

  it('typecheck 依赖 lint（lint 与 typecheck 一起做，先 lint 后 typecheck）', () => {
    const result = inferDependencies(
      steps([
        { name: 'lint', run: 'npm run lint' },
        { name: 'typecheck', run: 'npm run typecheck' },
      ]),
    );
    expect(result).toContainEqual({ from: 'typecheck', to: 'lint', reason: expect.any(String) });
    // 不产生反向边（lint 不依赖 typecheck——避免 lint 被排到 typecheck 之后）
    expect(result).not.toContainEqual(expect.objectContaining({ from: 'lint', to: 'typecheck' }));
  });

  it('typecheck 无 lint 时回落到 typecheck 依赖 build', () => {
    const result = inferDependencies(
      steps([
        { name: 'build', run: 'npm run build' },
        { name: 'typecheck', run: 'npm run typecheck' },
      ]),
    );
    expect(result).toContainEqual({ from: 'typecheck', to: 'build', reason: expect.any(String) });
  });

  it('每个步骤只匹配最高优先级规则（publish 不额外推 lint）', () => {
    const result = inferDependencies(
      steps([
        { name: 'build', run: 'npm run build' },
        { name: 'publish', run: 'npm run publish' },
      ]),
    );
    expect(result).toEqual([expect.objectContaining({ from: 'publish', to: 'build' })]);
  });

  // v4.1 P0-1：循环依赖——推断边若与已声明边成环则跳过
  it('不推断会成环的依赖（release 模板：build 依赖 test，不推 test 依赖 build）', () => {
    const result = inferDependencies(
      steps([
        { name: 'lint', run: 'npm run lint' },
        { name: 'test', run: 'npm run test -- --silent', depends: ['lint', 'build'] },
        { name: 'build', run: 'npm run build', depends: ['test', 'lint'] },
        { name: 'changelog', run: 'node scripts/update-changelog.mjs', depends: ['build'] },
        { name: 'publish', run: 'npm publish', depends: ['changelog', 'build'] },
      ]),
    );
    // 关键：不产生 test→build（会与 build→test 成环）
    expect(result).not.toContainEqual(expect.objectContaining({ from: 'test', to: 'build' }));
    // 也不产生 build→test（已声明跳过）
    expect(result).not.toContainEqual(expect.objectContaining({ from: 'build', to: 'test' }));
    // publish 依赖 build 已声明 → 不重复推；changelog 无匹配规则
    // 全量断言：无任何推断边（全部已声明/成环被跳过）
    expect(result).toEqual([]);
  });

  it('间接成环也跳过（a 依赖 b，b 依赖 c，不推 c 依赖 a）', () => {
    const result = inferDependencies(
      steps([
        { name: 'a', run: 'npm run build', depends: ['b'] },
        { name: 'b', run: 'npm run test', depends: ['c'] },
        { name: 'c', run: 'npm run typecheck' },
      ]),
    );
    // a 的 run 匹配 build→lint 规则（目标 lint 不存在）；c 的 run 匹配 typecheck→lint（lint 不存在）
    // 但 c 若推 typecheck 依赖 build（build 存在且 = a）→ 会成环（c→a→b→c），应跳过
    expect(result).not.toContainEqual(expect.objectContaining({ from: 'c', to: 'a' }));
  });
});
