/**
 * /workflow 斜杠命令测试（v4.0 M2 T2.6）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseWorkflowCommand, runWorkflowSlash } from '../../src/cli/slash/workflow';
import { saveWorkflow } from '../../src/cli/workflow';
import type { CommandRunner } from '../../src/workflow/executor';
import type { Workflow } from '../../src/workflow/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-slash-workflow-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function okRunner(executed: string[]): CommandRunner {
  return async (cmd) => {
    executed.push(cmd);
    return { ok: true, stdout: '', stderr: '' };
  };
}

describe('parseWorkflowCommand', () => {
  it('/workflow 与 /workflow list → list', () => {
    expect(parseWorkflowCommand('/workflow')).toEqual({ type: 'list' });
    expect(parseWorkflowCommand('/workflow list')).toEqual({ type: 'list' });
  });

  it('/workflow run <name> → run', () => {
    expect(parseWorkflowCommand('/workflow run release')).toEqual({ type: 'run', name: 'release' });
  });

  it('/workflow init [template] / export / import', () => {
    expect(parseWorkflowCommand('/workflow init release')).toEqual({
      type: 'init',
      template: 'release',
    });
    expect(parseWorkflowCommand('/workflow init')).toEqual({ type: 'init', template: undefined });
    expect(parseWorkflowCommand('/workflow export release')).toEqual({
      type: 'export',
      name: 'release',
    });
    expect(parseWorkflowCommand('/workflow import ./wf.yml')).toEqual({
      type: 'import',
      file: './wf.yml',
    });
  });

  it('非 /workflow → null；非法子命令 → unknown', () => {
    expect(parseWorkflowCommand('hello')).toBeNull();
    expect(parseWorkflowCommand('/workflow foo')).toMatchObject({ type: 'unknown' });
  });
});

describe('runWorkflowSlash', () => {
  it('list：无工作流 → 提示安装', async () => {
    const { message } = await runWorkflowSlash({ type: 'list' }, { cwd: tmp });
    expect(message.content).toContain('暂无已安装工作流');
  });

  it('init release → 生成文件并提示', async () => {
    const { message } = await runWorkflowSlash({ type: 'init', template: 'release' }, { cwd: tmp });
    expect(message.content).toContain('release');
    expect(path.join(tmp, '.concertoai', 'workflows', 'release.yml')).toBeDefined();
    // 文件真实存在
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(tmp, '.concertoai', 'workflows', 'release.yml'))).toBe(true);
  });

  it('run：成功执行工作流（fake runner + 进度推送）', async () => {
    const wf: Workflow = {
      name: 'demo',
      steps: [
        { name: 'a', run: 'a' },
        { name: 'b', run: 'b', depends: ['a'] },
      ],
    };
    saveWorkflow(tmp, wf);
    const executed: string[] = [];
    const progress: string[] = [];
    const { message } = await runWorkflowSlash(
      { type: 'run', name: 'demo' },
      {
        cwd: tmp,
        runCommand: okRunner(executed),
        onProgress: (p) => {
          if (p.stepName !== '') {
            progress.push(p.stepName);
          }
        },
      },
    );
    expect(executed).toEqual(['a', 'b']);
    expect(progress).toContain('a');
    expect(progress).toContain('b');
    expect(message.content).toContain('执行成功');
  });

  it('run：工作流不存在 → 提示', async () => {
    const { message } = await runWorkflowSlash({ type: 'run', name: 'missing' }, { cwd: tmp });
    expect(message.content).toContain('工作流不存在');
  });
});
