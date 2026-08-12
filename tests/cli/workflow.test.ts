/**
 * workflow CLI 文件操作测试（v4.0 M2 T2.5）。
 *
 * 覆盖：save/load/list roundtrip + export 内容可解析（T2.5 验收）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  confirmInferredDependencies,
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
} from '../../src/cli/workflow';
import { parseWorkflowYaml, serializeWorkflowYaml } from '../../src/workflow/parser';
import type { Workflow } from '../../src/workflow/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-cli-workflow-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('workflow 文件存储（T2.5）', () => {
  it('saveWorkflow → loadWorkflow roundtrip 一致', () => {
    const wf: Workflow = {
      name: 'release',
      description: '发布',
      steps: [
        { name: 'lint', run: 'npm run lint' },
        { name: 'publish', run: 'npm publish', depends: ['lint'], require: 'approval' },
      ],
    };
    const file = saveWorkflow(tmp, wf);
    expect(file).toBe(path.join(tmp, '.concertoai', 'workflows', 'release.yml'));
    const loaded = loadWorkflow(tmp, 'release');
    expect(loaded).toEqual(wf);
  });

  it('listWorkflows 返回已安装工作流名（排序）', () => {
    saveWorkflow(tmp, { name: 'b', steps: [{ name: 'x', run: 'echo x' }] });
    saveWorkflow(tmp, { name: 'a', steps: [{ name: 'y', run: 'echo y' }] });
    expect(listWorkflows(tmp)).toEqual(['a', 'b']);
  });

  it('导出内容可直接被 parseWorkflowYaml 解析（export → import 链路）', () => {
    const wf: Workflow = {
      name: 'precommit',
      steps: [{ name: 'lint', run: 'npm run lint' }],
    };
    saveWorkflow(tmp, wf);
    const loaded = loadWorkflow(tmp, 'precommit');
    const exported = serializeWorkflowYaml(loaded as Workflow);
    const reimported = parseWorkflowYaml(exported);
    expect(reimported).toEqual(wf);
  });

  it('loadWorkflow：文件不存在 / 非法 YAML → undefined（不抛错）', () => {
    expect(loadWorkflow(tmp, 'missing')).toBeUndefined();
    mkdirSync(path.join(tmp, '.concertoai', 'workflows'), { recursive: true });
    writeFileSync(path.join(tmp, '.concertoai', 'workflows', 'bad.yml'), 'not: [valid', 'utf8');
    expect(loadWorkflow(tmp, 'bad')).toBeUndefined();
  });

  it('已保存文件为合法 YAML（readFileSync 内容可解析）', () => {
    saveWorkflow(tmp, { name: 'demo', steps: [{ name: 'a', run: 'echo hi' }] });
    const raw = readFileSync(path.join(tmp, '.concertoai', 'workflows', 'demo.yml'), 'utf8');
    expect(parseWorkflowYaml(raw).steps[0]?.run).toBe('echo hi');
  });
});

describe('confirmInferredDependencies（T2.4 提示确认）', () => {
  it('无推断边 → 原样返回（不改配置）', async () => {
    const wf: Workflow = {
      name: 'demo',
      steps: [{ name: 'a', run: 'echo hi' }],
    };
    expect(await confirmInferredDependencies(wf)).toEqual(wf);
  });

  it('非 TTY（无输入）→ 不静默写入（保持原配置）', async () => {
    const wf: Workflow = {
      name: 'demo',
      steps: [
        { name: 'build', run: 'npm run build' },
        { name: 'test', run: 'npm run test' },
      ],
    };
    // 测试环境 stdin 非 TTY → promptLine 返回 undefined → 拒绝分支
    const result = await confirmInferredDependencies(wf);
    expect(result.steps[1]?.depends).toBeUndefined();
    expect(result).toEqual(wf);
  });
});
