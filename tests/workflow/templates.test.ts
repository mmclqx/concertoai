/**
 * 工作流内置模板测试（v4.0 M2 T2.1）。
 */

import { describe, expect, it } from 'vitest';
import { parseWorkflowYaml, serializeWorkflowYaml } from '../../src/workflow/parser';
import {
  getWorkflowTemplate,
  WORKFLOW_TEMPLATE_NAMES,
  WORKFLOW_TEMPLATES,
} from '../../src/workflow/templates';

describe('内置模板（T2.1）', () => {
  it('4 个模板定义完整：name 合法 + 至少 1 个步骤 + 每步有 run', () => {
    expect([...WORKFLOW_TEMPLATE_NAMES].sort()).toEqual([
      'init-ts',
      'precommit',
      'release',
      'upgrade-deps',
    ]);
    for (const name of WORKFLOW_TEMPLATE_NAMES) {
      const wf = WORKFLOW_TEMPLATES[name];
      expect(wf?.name).toBe(name);
      expect(wf?.steps.length ?? 0).toBeGreaterThanOrEqual(1);
      for (const step of wf?.steps ?? []) {
        expect(step.run.length).toBeGreaterThan(0);
      }
    }
  });

  it('release 模板含审批节点（publish 前 require: approval）', () => {
    const release = getWorkflowTemplate('release');
    const publish = release?.steps.find((s) => s.name === 'publish');
    expect(publish?.require).toBe('approval');
    expect(publish?.files).toBeDefined();
  });

  it('getWorkflowTemplate 返回深拷贝（修改不污染注册表）', () => {
    const tpl = getWorkflowTemplate('precommit');
    tpl?.steps.push({ name: 'hack', run: 'echo hack' });
    expect(WORKFLOW_TEMPLATES.precommit?.steps).toHaveLength(3);
  });

  it('模板可序列化为 YAML 并解析回（init 生成链路）', () => {
    for (const name of WORKFLOW_TEMPLATE_NAMES) {
      const wf = getWorkflowTemplate(name);
      expect(wf).toBeDefined();
      const yaml = serializeWorkflowYaml(wf as NonNullable<typeof wf>);
      const parsed = parseWorkflowYaml(yaml);
      expect(parsed.name).toBe(name);
      expect(parsed.steps.length).toBe(wf?.steps.length);
    }
  });
});
