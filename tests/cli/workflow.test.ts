/**
 * workflow CLI 文件操作测试（v4.0 M2 T2.5）。
 *
 * 覆盖：save/load/list roundtrip + export 内容可解析（T2.5 验收）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock 共享 promptLine：使 promptRecovery 的输入可控（默认返回 undefined = 无输入，与原非 TTY 行为一致）
vi.mock('../../src/cli/prompt', () => ({
  promptLine: vi.fn(),
}));

import { promptLine } from '../../src/cli/prompt';
import {
  confirmInferredDependencies,
  defaultRunCommand,
  listWorkflows,
  loadWorkflow,
  loadWorkflowResult,
  promptRecovery,
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

  it('loadWorkflowResult：文件不存在 → not-found（区别于解析失败，v4.1 发布前修复）', () => {
    const r = loadWorkflowResult(tmp, 'missing');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not-found');
      expect(r.message).toBeUndefined();
    }
  });

  it('loadWorkflowResult：非法 YAML → parse-error + 真实错误信息（不再误导为「不存在」）', () => {
    mkdirSync(path.join(tmp, '.concertoai', 'workflows'), { recursive: true });
    // 内联列表 `depends: [lint]`（用户自然写法）→ parser 只支持块状列表 → 解析失败
    writeFileSync(
      path.join(tmp, '.concertoai', 'workflows', 'bad.yml'),
      'name: bad\nsteps:\n  - name: lint\n    run: npm run lint\n  - name: typecheck\n    run: npm run typecheck\n    depends: [lint]\n',
      'utf8',
    );
    const r = loadWorkflowResult(tmp, 'bad');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('parse-error');
      // 真实错误信息应含「必须是列表」类提示（不再显示「工作流不存在」）
      expect(r.message).toBeTruthy();
    }
  });

  it('loadWorkflowResult：合法 YAML → ok + workflow', () => {
    saveWorkflow(tmp, {
      name: 'okwf',
      description: 'd',
      steps: [{ name: 'lint', run: 'npm run lint' }],
    });
    const r = loadWorkflowResult(tmp, 'okwf');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workflow.name).toBe('okwf');
      expect(r.workflow.steps).toHaveLength(1);
    }
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

describe('promptRecovery（v4.1 F 等待态 + 智能摘要）', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  it('失败信息先显示智能摘要（tsc 行）再显示步骤（不淹没提示）', async () => {
    vi.mocked(promptLine).mockResolvedValueOnce('r');
    const error = [
      'src/a.ts(10,5): error TS2322: Type "x" is not assignable.',
      'npm error code ELIFECYCLE',
    ].join('\n');
    const choice = await promptRecovery('typecheck', error);
    expect(choice).toBe('retry');
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('💡 摘要：src/a.ts(10,5): error TS2322');
    expect(out).toContain('❌ 步骤 typecheck 失败');
  });

  it('选 F → 进入等待态 → Enter（空输入）→ fix-and-retry', async () => {
    vi.mocked(promptLine).mockResolvedValueOnce('f').mockResolvedValueOnce('');
    const choice = await promptRecovery('lint', 'err');
    expect(choice).toBe('fix-and-retry');
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('需手动修复');
  });

  it('选 F → 等待态输入 a → abort（整体回滚）', async () => {
    vi.mocked(promptLine).mockResolvedValueOnce('f').mockResolvedValueOnce('a');
    const choice = await promptRecovery('lint', 'err');
    expect(choice).toBe('abort');
  });

  it('选 F → 等待态超时（undefined）→ abort（防挂起）', async () => {
    vi.mocked(promptLine).mockResolvedValueOnce('f').mockResolvedValueOnce(undefined);
    const choice = await promptRecovery('lint', 'err');
    expect(choice).toBe('abort');
  });

  it('选 F → 等待态非法输入 → 重新提示后 Enter 重试', async () => {
    vi.mocked(promptLine)
      .mockResolvedValueOnce('f')
      .mockResolvedValueOnce('zz')
      .mockResolvedValueOnce('');
    const choice = await promptRecovery('lint', 'err');
    expect(choice).toBe('fix-and-retry');
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('无效输入');
  });

  it('非法输入 → abort（fail-closed，安全兜底）', async () => {
    vi.mocked(promptLine).mockResolvedValueOnce('zz');
    const choice = await promptRecovery('lint', 'err');
    expect(choice).toBe('abort');
  });

  it('无输入（Ctrl+C → undefined）→ abort（fail-closed）', async () => {
    vi.mocked(promptLine).mockResolvedValueOnce(undefined);
    const choice = await promptRecovery('lint', 'err');
    expect(choice).toBe('abort');
  });
});

describe('defaultRunCommand（v4.1 P0-2 Windows stderr 丢失修复）', () => {
  // Windows 下 `npm run <script>` 失败时，子命令真实错误常进 stdout（npm 透传），stderr 为空。
  // 用 node -e 模拟「失败但错误进 stdout」的子进程，验证 defaultRunCommand 合并 stdout。
  it('失败时 stdout 含错误、stderr 为空 → stderr 合并 stdout（真实错误不丢失）', async () => {
    // 命令：打印错误到 stdout 后 exit(1)（模拟 tsc 错误进 stdout 的 npm 场景）
    const cmd =
      process.execPath +
      ' -e "console.log(\'error TS1287: top-level export in CJS\'); process.exit(1)"';
    const out = await defaultRunCommand(cmd, tmp);
    expect(out.ok).toBe(false);
    // 关键断言：stderr 合并了 stdout 的错误行（此前只取 err.message「Command failed」）
    expect(out.stderr).toContain('error TS1287');
  });

  it('失败时 stdout 为空、stderr 有错误 → stderr 保留（不回归）', async () => {
    const cmd = `${process.execPath} -e "console.error('npm error code ELIFECYCLE'); process.exit(1)"`;
    const out = await defaultRunCommand(cmd, tmp);
    expect(out.ok).toBe(false);
    expect(out.stderr).toContain('npm error code ELIFECYCLE');
  });

  it('成功时 stdout/stderr 分离（不合并，回归）', async () => {
    const cmd = `${process.execPath} -e "console.log('out-line'); console.error('err-line')"`;
    const out = await defaultRunCommand(cmd, tmp);
    expect(out.ok).toBe(true);
    expect(out.stdout).toContain('out-line');
    expect(out.stderr).toContain('err-line');
  });

  it('失败且 stdout/stderr 皆空 → 退回命令错误信息（不丢错误）', async () => {
    // 命令本身不存在 → exec 报 ENOENT，stdout/stderr 空 → 退回 err.message
    const out = await defaultRunCommand('definitely-not-a-real-cmd-xyz', tmp);
    expect(out.ok).toBe(false);
    expect(out.stderr.length).toBeGreaterThan(0);
  });
});

describe('preflightAndInit（v4.1 P1-4 不可修复项拒绝反馈）', () => {
  it('不可修复项存在 + 用户拒绝继续（n）→ 打印「已停止执行」并返回 false', async () => {
    // 构造一个只缺 test/build（均可自动修复项之外的）的项目：lint/typecheck 可自动，
    // 但 test/build 不可自动 → 需全部不可自动才走 preflightContinue 分支。
    // 用仅含 test 的工作流（autoInitForScript('test') = undefined，全部不可自动）。
    writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'p', version: '1.0.0', scripts: {} }),
      'utf8',
    );
    const wf: Workflow = {
      name: 'release',
      steps: [
        { name: 'test', run: 'npm run test' },
        { name: 'build', run: 'npm run build', depends: ['test'] },
      ],
    };
    // 模拟用户输入 n（拒绝继续）
    vi.mocked(promptLine).mockResolvedValueOnce('n');
    const { preflightAndInit } = await import('../../src/cli/workflow');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ready = await preflightAndInit(wf, tmp);
      expect(ready).toBe(false);
      const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // P1-4：明确停止文案（不再静默退出）
      expect(out).toContain('已停止执行');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('不可修复项存在 + 用户选择继续（y）→ 返回 true（继续执行）', async () => {
    writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'p2', version: '1.0.0', scripts: {} }),
      'utf8',
    );
    const wf: Workflow = {
      name: 'release',
      steps: [
        { name: 'test', run: 'npm run test' },
        { name: 'build', run: 'npm run build', depends: ['test'] },
      ],
    };
    vi.mocked(promptLine).mockResolvedValueOnce('y');
    const { preflightAndInit } = await import('../../src/cli/workflow');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ready = await preflightAndInit(wf, tmp);
      expect(ready).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
