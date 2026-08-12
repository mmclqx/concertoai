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

  it('每个步骤只匹配最高优先级规则（publish 不额外推 lint）', () => {
    const result = inferDependencies(
      steps([
        { name: 'build', run: 'npm run build' },
        { name: 'publish', run: 'npm run publish' },
      ]),
    );
    expect(result).toEqual([expect.objectContaining({ from: 'publish', to: 'build' })]);
  });
});
