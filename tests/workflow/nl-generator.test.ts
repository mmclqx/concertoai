/**
 * 自然语言生成工作流测试（v4.0 M2 T2.2）。
 */

import { describe, expect, it } from 'vitest';

import type { ModelClient } from '../../src/model/client';
import { generateWorkflowFromNl } from '../../src/workflow/nl-generator';

/** 构造按序输出给定文本的 mock 模型客户端。 */
function mockClient(text: string): ModelClient {
  return {
    async *streamChat() {
      yield { choices: [{ delta: { content: text } }] } as never;
    },
  } as ModelClient;
}

describe('generateWorkflowFromNl（T2.2 自然语言生成）', () => {
  it('模型输出合法 YAML → 返回 workflow', async () => {
    const yaml = [
      'name: release',
      'description: 发布',
      'steps:',
      '  - name: lint',
      '    run: npm run lint',
      '  - name: publish',
      '    run: npm publish',
      '    depends:',
      '      - lint',
      '    require: approval',
    ].join('\n');
    const result = await generateWorkflowFromNl('每次发版先 lint 再发布，发布要审批', {
      client: mockClient(yaml),
      model: 'test-model',
    });
    expect(result.error).toBeUndefined();
    expect(result.workflow?.name).toBe('release');
    expect(result.workflow?.steps).toHaveLength(2);
    expect(result.workflow?.steps[1]?.require).toBe('approval');
  });

  it('容忍 ```yaml 围栏（模型常加围栏）', async () => {
    const yaml = '```yaml\nname: demo\nsteps:\n  - name: a\n    run: echo a\n```';
    const result = await generateWorkflowFromNl('跑一个 echo', {
      client: mockClient(yaml),
      model: 'test-model',
    });
    expect(result.workflow?.name).toBe('demo');
  });

  it('非法 YAML → 返回 error（降级人工编辑提示）', async () => {
    const result = await generateWorkflowFromNl('随便', {
      client: mockClient('name: x\nunknown_key: 1'),
      model: 'test-model',
    });
    expect(result.workflow).toBeUndefined();
    expect(result.error).toContain('AI 生成失败');
  });

  it('模型输出空 → 返回 error（降级）', async () => {
    const result = await generateWorkflowFromNl('随便', {
      client: mockClient(''),
      model: 'test-model',
    });
    expect(result.workflow).toBeUndefined();
    expect(result.error).toContain('AI 生成失败');
  });

  it('未配置模型 → 直接返回 error（不调用模型）', async () => {
    const result = await generateWorkflowFromNl('随便', {});
    expect(result.workflow).toBeUndefined();
    expect(result.error).toContain('未配置模型');
  });
});
