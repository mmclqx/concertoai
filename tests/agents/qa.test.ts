/**
 * QA Agent 测试（v3.0 M3 / T3.4）。
 *
 * 覆盖验收标准：
 * - 执行 npm run verify → 输出结构化测试报告（passed / testFiles / testCases / failedItems[]）；
 * - 失败项含失败文件/用例/错误信息；
 * - 测试失败时，失败详情格式化为 feedback 消息传回 Coder（formatFeedbackIssues）；
 * - 超时保护（默认 5min，超时视为失败且 passed=false）。
 */
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// node:child_process 为 ESM 内置模块命名空间，不可直接 spyOn（Cannot redefine property: spawn）。
// 模块级 mock：保留真实实现，仅将 spawn 替换为 vi.fn()（v3.1.1 Windows 回归测试用）。
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

import {
  buildQaSummary,
  ChildProcessQaRunner,
  DEFAULT_VERIFY_TIMEOUT_MS,
  formatFeedbackIssues,
  parseVerifyOutput,
  QaAgent,
  type QaReport,
  type QaRunner,
  type QaRunResult,
} from '../../src/agents';
import type { AgentContext } from '../../src/orchestrator';
import {
  VITEST_FAIL_POSIX,
  VITEST_FAIL_PREFIX_WIN,
  VITEST_FAIL_WIN,
  VITEST_PASS_WIN,
} from '../fixtures/platform-samples';

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造一个最小 AgentContext。 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-1',
    taskId: 'task-qa',
    parentTaskId: 'task-0',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** Fake QaRunner（返回预设输出）。 */
class FakeRunner implements QaRunner {
  result: QaRunResult;

  constructor(result: Partial<QaRunResult> = {}) {
    this.result = {
      ok: true,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...result,
    };
  }

  async run(): Promise<QaRunResult> {
    return this.result;
  }
}

/** 模拟 vitest 全绿输出。 */
const PASS_OUTPUT = [
  ' RUN  v4.1.10 F:/developer/2026/concertoai',
  '',
  ' Test Files  51 passed (51)',
  '      Tests  577 passed (577)',
  '   Duration 3.62s',
].join('\n');

/** 模拟 vitest 失败输出（含失败文件/用例/错误）。 */
const FAIL_OUTPUT = [
  ' RUN  v4.1.10',
  '',
  ' ❯ tests/foo.test.ts (3 tests | 1 failed) 123ms',
  '   ✓ 正常用例 1',
  '   ✗ 失败用例',
  '     AssertionError: expected 1 to be 2',
  '     ❯ tests/foo.test.ts:10:5',
  ' ❯ tests/bar.spec.ts (1 test | 1 failed) 5ms',
  '   × 另一个失败',
  '     Error: boom',
  '',
  ' Test Files  1 failed (51)',
  '      Tests  2 failed (577)',
].join('\n');

// ── parseVerifyOutput：结构化报告解析 ─────────────────────────

describe('parseVerifyOutput（结构化测试报告解析）', () => {
  it('全绿输出 → passed=true，含 testFiles/testCases 计数', () => {
    const report = parseVerifyOutput(PASS_OUTPUT, '', 1000);
    expect(report.passed).toBe(true);
    expect(report.testFiles).toBe(51);
    expect(report.testCases).toBe(577);
    expect(report.failedItems).toEqual([]);
    expect(report.timedOut).toBe(false);
    expect(report.durationMs).toBe(1000);
  });

  it('失败输出 → passed=false，failedItems 含文件/用例/错误', () => {
    const report = parseVerifyOutput(FAIL_OUTPUT, '', 2000);
    expect(report.passed).toBe(false);
    expect(report.testFiles).toBe(51);
    expect(report.testCases).toBe(577);
    expect(report.failedItems).toHaveLength(2);
    expect(report.failedItems[0]?.file).toBe('tests/foo.test.ts');
    expect(report.failedItems[0]?.testName).toBe('失败用例');
    expect(report.failedItems[0]?.error).toContain('AssertionError');
    expect(report.failedItems[1]?.file).toBe('tests/bar.spec.ts');
    expect(report.failedItems[1]?.testName).toBe('另一个失败');
    expect(report.failedItems[1]?.error).toContain('Error: boom');
  });

  it('stderr 合并解析（错误可能输出到 stderr）', () => {
    const report = parseVerifyOutput('', FAIL_OUTPUT, 3000);
    expect(report.passed).toBe(false);
    expect(report.failedItems).toHaveLength(2);
  });

  it('无输出 → passed=false，计数为 0', () => {
    const report = parseVerifyOutput('', '', 0);
    expect(report.passed).toBe(false);
    expect(report.testFiles).toBe(0);
    expect(report.testCases).toBe(0);
    expect(report.failedItems).toEqual([]);
  });
});

// ── 跨平台样本库回归（v3.2 M1 / T1.5）─────────────────────────

describe('parseVerifyOutput 跨平台样本（v3.2 M1 / T1.5）', () => {
  it('Windows 盘符 vitest 失败输出 → 解析失败文件/用例（反斜杠路径）', () => {
    const report = parseVerifyOutput(VITEST_FAIL_WIN, '', 1000);
    expect(report.passed).toBe(false);
    expect(report.testFiles).toBe(51);
    expect(report.failedItems).toHaveLength(1);
    expect(report.failedItems[0]?.file).toBe('C:\\work\\demo\\tests\\foo.test.ts');
    expect(report.failedItems[0]?.testName).toBe('失败用例');
    expect(report.failedItems[0]?.error).toContain('AssertionError');
  });

  it('POSIX vitest 失败输出 → 解析失败文件/用例（正斜杠路径）', () => {
    const report = parseVerifyOutput(VITEST_FAIL_POSIX, '', 1000);
    expect(report.passed).toBe(false);
    expect(report.failedItems).toHaveLength(1);
    expect(report.failedItems[0]?.file).toBe('/home/user/work/demo/tests/foo.test.ts');
    expect(report.failedItems[0]?.error).toContain('AssertionError');
  });

  it('Windows 盘符 vitest 全绿输出 → passed=true 计数正确', () => {
    const report = parseVerifyOutput(VITEST_PASS_WIN, '', 1000);
    expect(report.passed).toBe(true);
    expect(report.testFiles).toBe(51);
    expect(report.testCases).toBe(577);
  });

  it('Windows FAIL 前缀形态（FAIL C:...）→ 失败文件解析', () => {
    const report = parseVerifyOutput(VITEST_FAIL_PREFIX_WIN, '', 1000);
    expect(report.passed).toBe(false);
    expect(report.failedItems).toHaveLength(1);
    expect(report.failedItems[0]?.file).toBe('C:\\work\\demo\\tests\\bar.spec.ts');
    expect(report.failedItems[0]?.testName).toBe('另一个失败');
    expect(report.failedItems[0]?.error).toContain('Error: boom');
  });
});

// ── buildQaSummary / formatFeedbackIssues ─────────────────────

describe('buildQaSummary / formatFeedbackIssues', () => {
  it('通过摘要：包含通过计数', () => {
    expect(buildQaSummary(true, 51, 577, 0)).toContain('通过');
    expect(buildQaSummary(true, 51, 577, 0)).toContain('51');
    expect(buildQaSummary(true, 51, 577, 0)).toContain('577');
  });

  it('失败摘要：包含失败计数', () => {
    expect(buildQaSummary(false, 51, 577, 2)).toContain('失败');
    expect(buildQaSummary(false, 51, 577, 2)).toContain('2 项失败');
  });

  it('formatFeedbackIssues：失败详情格式化为 feedback 消息（含文件/用例/错误）', () => {
    const report = parseVerifyOutput(FAIL_OUTPUT, '', 1000);
    const issues = formatFeedbackIssues(report);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('tests/foo.test.ts');
    expect(issues[0]).toContain('失败用例');
    expect(issues[0]).toContain('AssertionError');
  });

  it('formatFeedbackIssues：无失败项时返回空数组', () => {
    const report: QaReport = parseVerifyOutput(PASS_OUTPUT, '', 1000);
    expect(formatFeedbackIssues(report)).toEqual([]);
  });
});

// ── QaAgent ───────────────────────────────────────────────────

describe('QaAgent（标准 Agent 契约）', () => {
  it('def 契约：name=qa，权限 = run_command（白名单 npm run verify）', () => {
    const agent = new QaAgent({ runner: new FakeRunner({ ok: true }) });
    expect(agent.def.name).toBe('qa');
    expect(agent.def.version).toBe('1.0.0');
    const perms = agent.def.permissions;
    expect(perms).toHaveLength(1);
    expect(perms[0]?.tool).toBe('run_command');
    expect((perms[0]?.args as { command: string } | undefined)?.command).toBe('npm run verify');
  });

  it('默认超时 = 5min', () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('execute：verify 通过 → 报告 passed=true', async () => {
    const agent = new QaAgent({
      runner: new FakeRunner({ ok: true, stdout: PASS_OUTPUT }),
    });
    const report = await agent.execute({ description: '运行测试' }, makeContext());
    expect(report.passed).toBe(true);
    expect(report.testFiles).toBe(51);
    expect(report.testCases).toBe(577);
    expect(report.summary).toContain('通过');
  });

  it('execute：verify 失败 → 报告 passed=false，含失败详情（供 feedback）', async () => {
    const agent = new QaAgent({
      runner: new FakeRunner({ ok: false, stdout: FAIL_OUTPUT }),
    });
    const report = await agent.execute({ description: '运行测试' }, makeContext());
    expect(report.passed).toBe(false);
    expect(report.failedItems).toHaveLength(2);
    expect(report.summary).toContain('失败');
    // 失败详情可格式化为 feedback 传回 Coder
    const issues = formatFeedbackIssues(report);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('execute：超时 → passed=false 且 timedOut=true，含超时失败项', async () => {
    const agent = new QaAgent({
      runner: new FakeRunner({ ok: false, stdout: '', stderr: '', timedOut: true }),
      timeoutMs: 100,
    });
    const report = await agent.execute({ description: '运行测试' }, makeContext());
    expect(report.passed).toBe(false);
    expect(report.timedOut).toBe(true);
    expect(report.failedItems).toHaveLength(1);
    expect(report.failedItems[0]?.error).toContain('超时');
    expect(report.summary).toContain('超时');
  });

  it('execute：exit code 非 0 但输出无 FAIL 段 → passed=false（退出码兜底）', async () => {
    const agent = new QaAgent({
      runner: new FakeRunner({ ok: false, stdout: PASS_OUTPUT }),
    });
    const report = await agent.execute({ description: '运行测试' }, makeContext());
    // 输出看似通过但退出码非 0 → runner.ok 兜底强制 passed=false，防解析漏判
    expect(report.passed).toBe(false);
    expect(report.failedItems).toHaveLength(1);
    expect(report.failedItems[0]?.error).toContain('退出码非 0');
  });
});

// ── ChildProcessQaRunner（v3.1.1 Windows 回归）────────────────

/** 假 ChildProcess：真实 ChildProcess 基础上附加 triggerClose 测试钩子。 */
type MockChild = childProcess.ChildProcess & { triggerClose(code: number): void };

/** 构造可触发 close 的假 ChildProcess（spawn mock 用）。 */
function createMockChild(): MockChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let closeHandler: ((code: number) => void) | undefined;
  const self = {
    pid: 4242,
    stdout,
    stderr,
    kill: () => true,
    triggerClose: (code: number) => closeHandler?.(code),
    on: (event: string, cb: (code: number) => void) => {
      if (event === 'close') closeHandler = cb;
      return self;
    },
  };
  return self as unknown as MockChild;
}

describe('ChildProcessQaRunner（v3.1.1 Windows 回归）', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('run() 直接使用构造器解析后的命令，不追加 .cmd 后缀（防 npm.cmd.cmd → ENOENT）', async () => {
    const mockChild = createMockChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(mockChild as childProcess.ChildProcess);

    const runner = new ChildProcessQaRunner({ cwd: process.cwd() });
    const runPromise = runner.run(1000);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const cmd = spawnMock.mock.calls[0]?.[0] ?? '';
    // 不允许双重 .cmd 后缀（旧代码：win32 → npm.cmd.cmd）
    expect(cmd.endsWith('.cmd.cmd')).toBe(false);
    // 平台默认：win32 → npm.cmd；其他 → npm
    const expected = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    expect(cmd).toBe(expected);

    // 触发 close(0) 让 promise 正常 resolve（不挂起）
    mockChild.triggerClose(0);
    const result = await runPromise;
    expect(result.ok).toBe(true);
  });
});
