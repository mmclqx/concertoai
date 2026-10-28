/**
 * `concertoai commit` 测试（v5.0 T17）。
 *
 * ## 这个命令最危险的失败，不是「没提交成功」
 *
 * 是**越权**与**骗人**：
 * - 悄悄动了远程（push/pull/rebase）或绕过检查（--no-verify / --force）；
 * - 体检挂了却照样提交（`--yes` 被当成「连体检也不用」）；
 * - 用户说 n / 按 Ctrl+C / 非交互终端，却还是把提交落了；
 * - 暂存区是空的，却不打招呼 `git add -A` 把整个工作区卷进提交。
 *
 * 所以用例按四条线写：
 * 1. **安全边界（D3-B）**：真实调用逐个核对白名单 + 源码字面量护栏（无远程/无改写历史/无绕过开关）；
 * 2. **体检不可跳过**：`--yes` 只跳过 message 审批，check 失败一律不提交；
 * 3. **fail-closed**：审批 n / Ctrl+C / 非 TTY → 一条都没提交；
 * 4. **薄包装（G6）**：体检只走 `./check` 的 `runCheck`，本文件里没有第二套 verify 解析。
 *
 * git 与 check 全部注入假实现，测试**绝不真跑 git**（不污染真实仓库，也不依赖联网）。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import type { CheckResult, CheckStageResult, CheckStageStatus } from '../../src/cli/check';
import {
  ALLOWED_GIT_SUBCOMMANDS,
  type CommitCommandOptions,
  type GitOutcome,
  type GitRunner,
  MAX_FILES_SHOWN,
  runCommitCommand,
} from '../../src/cli/commit';
import { MAX_DIFF_CHARS } from '../../src/core/commit-message';
import { DICTS, fmt, setLocale } from '../../src/i18n';
import { zh } from '../../src/i18n/zh';
import type { VerifyStage } from '../../src/loop/self-heal';
import type { ModelClient } from '../../src/model/client';

// ── 假 git（记录每一次调用）──────────────────────────────────

/** 假 git 的可调状态（默认：干净的仓库 + 两个暂存文件）。 */
interface FakeGitState {
  /** 是不是 git 仓库。 */
  repo?: boolean;
  /** git 命令本身不存在（未安装 / 不在 PATH）。 */
  missing?: boolean;
  /** 当前分支；null = detached HEAD。 */
  branch?: string | null;
  /** 暂存文件名。 */
  staged?: string[];
  /** 未跟踪文件名。 */
  untracked?: string[];
  stat?: string;
  diff?: string;
  addOk?: boolean;
  /**
   * `git add -A` 执行成功，但暂存区仍然为空。
   *
   * 真实场景：工作区里的变化全被 `.gitignore` 忽略（或只动了空目录），
   * 「加了等于没加」——退出码 0 却什么也没暂存，此时绝不能拿空 message 去 commit。
   */
  addStagesNothing?: boolean;
  commitOk?: boolean;
  commitStderr?: string;
  commitStdout?: string;
}

/** 假 git 句柄：`calls` / `inputs` 供白名单与「message 走 stdin」断言。 */
interface FakeGit {
  run: GitRunner;
  calls: string[][];
  inputs: Array<string | undefined>;
}

/**
 * 构造假 git 执行器。
 *
 * 未知子命令一律返回失败（`ok: false`）：真实现里遇到白名单外的命令会静默执行，
 * 假实现选择「炸出来」，这样白名单回归能立刻被看见。
 */
function fakeGit(overrides: FakeGitState = {}): FakeGit {
  const state = {
    repo: true,
    missing: false,
    branch: 'main' as string | null,
    staged: ['src/cli/commit.ts', 'src/core/commit-message.ts'],
    untracked: [] as string[],
    stat: ' 2 files changed, 210 insertions(+)',
    diff: [
      'diff --git a/src/cli/commit.ts b/src/cli/commit.ts',
      '+++ b/src/cli/commit.ts',
      '+export async function runCommitCommand(): Promise<number> {}',
    ].join('\n'),
    addOk: true,
    addStagesNothing: false,
    commitOk: true,
    commitStderr: '',
    commitStdout: '[main 1a2b3c4] feat(cli): 新增 commit 命令\n 2 files changed, 210 insertions(+)',
    ...overrides,
  };
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  const ok = (stdout: string): GitOutcome => ({ ok: true, stdout, stderr: '' });
  const fail = (stderr: string): GitOutcome => ({ ok: false, stdout: '', stderr });

  const run: GitRunner = async (args, input) => {
    calls.push([...args]);
    inputs.push(input);
    switch (args[0]) {
      case 'rev-parse':
        if (args[1] === '--git-dir') {
          return ok('.git\n');
        }
        if (state.missing) {
          return fail('git: command not found');
        }
        return state.repo
          ? ok('true\n')
          : fail('fatal: not a git repository (or any of the parent directories): .git');
      case 'symbolic-ref':
        return state.branch === null ? fail('') : ok(`${state.branch}\n`);
      case 'diff':
        if (args.includes('--name-only')) {
          return ok(state.staged.map((file) => `${file}\n`).join(''));
        }
        if (args.includes('--stat')) {
          return ok(`${state.stat}\n`);
        }
        return ok(state.diff);
      case 'ls-files':
        return ok(state.untracked.map((file) => `${file}\n`).join(''));
      case 'add':
        if (!state.addOk) {
          return fail('error: unable to index file');
        }
        // 成功但仍空：退出码 0，暂存区一个文件都没多（`.gitignore` 吞掉全部改动的场景）
        if (!state.addStagesNothing) {
          state.staged = [...state.staged, ...state.untracked];
          state.untracked = [];
        }
        return ok('');
      case 'commit':
        return state.commitOk ? ok(state.commitStdout) : fail(state.commitStderr);
      default:
        return fail(`unexpected git subcommand: ${args.join(' ')}`);
    }
  };

  return { run, calls, inputs };
}

// ── 假体检（产物结构必须与 T15 一致）───────────────────────

/** 单段结果（只有失败段需要摘要与下一步命令）。 */
function stageResult(stage: VerifyStage, status: CheckStageStatus): CheckStageResult {
  const failed = status === 'fail';
  return {
    stage,
    script: stage === 'type' ? 'typecheck' : stage,
    status,
    errorCount: failed ? 1 : 0,
    summary: failed ? 'src/cli/commit.ts:1:5 × Unexpected any.' : '',
    nextCommand: failed ? 'concertoai fix' : null,
    outputLineCount: 2,
    outputTruncated: false,
    output: [],
  };
}

/** 构造 `CheckResult`（全绿 / lint 段失败两种，够覆盖分支）。 */
function checkResult(ok: boolean): CheckResult {
  const statuses: CheckStageStatus[] = ok
    ? ['pass', 'pass', 'pass', 'pass']
    : ['pass', 'fail', 'skipped', 'skipped'];
  const stages = (['build', 'lint', 'type', 'test'] as VerifyStage[]).map((stage, index) =>
    stageResult(stage, statuses[index] ?? 'pass'),
  );
  return {
    ok,
    mode: 'verify',
    stages,
    failedStages: ok ? [] : ['lint'],
    conclusion: ok ? '✅ 可以提交' : '❌ 1 项待修（lint）',
    conclusionHint: ok ? '' : '💡 先运行 `concertoai fix`',
    nextCommands: ok ? [] : ['concertoai fix'],
    code: ok ? 0 : 1,
    durationMs: 4200,
  };
}

// ── 测试脚手架 ────────────────────────────────────────────────

/**
 * 审批询问函数的**非空**签名。
 *
 * `CommitCommandOptions['ask']` 是可选属性，索引访问自带 `| undefined`；
 * 直接拿它当「函数类型」用（如 `answers()` 的返回值），会让 `a ?? b` 这种
 * 兜底表达式的结果依然「可能 undefined」。这里用 `NonNullable` 剥掉可选性，
 * 让类型从一开始就表达「这是一个一定能调用的函数」。
 */
type AskFn = NonNullable<CommitCommandOptions['ask']>;

/** 按顺序回答（最后一条会被复用，避免越界后回答 undefined）。 */
function answers(...values: Array<string | undefined>): AskFn {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return Promise.resolve(value);
  };
}

/** fake 模型（可记录 prompt，供截断断言）。 */
function fakeClient(texts: readonly string[], sink?: string[]): ModelClient {
  return {
    async *streamChat(params) {
      sink?.push(params.messages.map((message) => message.content).join('\n'));
      for (const text of texts) {
        yield {
          id: 'test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        } as never;
      }
    },
  };
}

/** 一次完整执行的上下文（git / check / ask / 输出全部可观测）。 */
function harness(
  options: {
    git?: FakeGitState;
    check?: CheckResult;
    isTTY?: boolean;
    ask?: AskFn;
    yes?: boolean;
    client?: ModelClient;
    lang?: string;
  } = {},
) {
  const fake = fakeGit(options.git);
  const lines: string[] = [];
  const errors: string[] = [];
  const checkCalls: string[] = [];
  const askCalls: string[] = [];
  const rawAsk = options.ask ?? answers('y');
  const run = (): Promise<number> =>
    runCommitCommand({
      cwd: process.cwd(),
      isTTY: options.isTTY ?? true,
      yes: options.yes === true,
      ask: (question) => {
        askCalls.push(question);
        return rawAsk(question);
      },
      runGit: fake.run,
      check: async (cwd) => {
        checkCalls.push(cwd);
        return options.check ?? checkResult(true);
      },
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.client !== undefined ? { model: 'deepseek-v4-flash' } : {}),
      ...(options.lang !== undefined ? { lang: options.lang } : {}),
      log: (line) => lines.push(line),
      logErr: (line) => errors.push(line),
    });
  return {
    run,
    fake,
    lines,
    errors,
    checkCalls,
    askCalls,
    text: () => lines.join('\n'),
    all: () => [...lines, ...errors].join('\n'),
  };
}

/** 提交调用（`['commit','-F','-']`）与它收到的 stdin。 */
function commitCall(fake: FakeGit): { args: string[]; input: string | undefined } | undefined {
  const index = fake.calls.findIndex((args) => args[0] === 'commit');
  if (index < 0) {
    return undefined;
  }
  return { args: fake.calls[index] ?? [], input: fake.inputs[index] };
}

/** 本地兜底 message 的正文（两文件样本），用于断言「提交的到底是什么」。 */
const LOCAL_TEXT = [
  fmt(zh.commit.localSubject, { count: 2 }),
  '',
  `- ${fmt(zh.commit.localBodyPoint, { file: 'src/cli/commit.ts' })}`,
  `- ${fmt(zh.commit.localBodyPoint, { file: 'src/core/commit-message.ts' })}`,
].join('\n');

/** 安全红线：任何一条出现在真实 git 调用或源码里都算越权（决策 D3-B）。 */
const FORBIDDEN = [
  'push',
  'pull',
  'rebase',
  'checkout',
  'merge',
  'reset',
  '--force',
  '--no-verify',
];

/** 去掉源码注释（JSDoc 里写着「**不**推送」，直接子串检查会把否认当罪证）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** 读 commit.ts 源码（去注释）。 */
async function commitSource(): Promise<string> {
  const url = new URL('../../src/cli/commit.ts', import.meta.url);
  return stripComments(await readFile(fileURLToPath(url), 'utf8'));
}

beforeEach(() => {
  setLocale('zh');
});

// ── 主路径 ────────────────────────────────────────────────────

describe('runCommitCommand 全流程（体检 → message → 审批 → 本地提交）', () => {
  it('体检通过 + 审批 y → message 走 stdin 提交，退出码 0', async () => {
    const ctx = harness();
    const code = await ctx.run();
    expect(code).toBe(0);
    const commit = commitCall(ctx.fake);
    expect(commit?.args).toEqual(['commit', '-F', '-']);
    // message 必须走 stdin（不拼命令行、不落临时文件）
    expect(commit?.input).toBe(LOCAL_TEXT);
    const text = ctx.text();
    expect(text).toContain(fmt(zh.commit.branch, { branch: 'main' }));
    expect(text).toContain(zh.commit.messageTitle);
    expect(text).toContain(fmt(zh.commit.filesTitle, { count: 2 }));
    expect(text).toContain('src/core/commit-message.ts');
    expect(text).toContain(zh.commit.commitOk);
    expect(text).toContain(zh.commit.localOnly);
    // 体检过程日志走 stderr（stdout 保持干净，便于脚本消费）
    expect(ctx.errors.join('\n')).toContain(zh.commit.checking);
    expect(text).toContain(fmt(zh.commit.checkPassed, { seconds: '4.2' }));
    expect(ctx.checkCalls).toHaveLength(1);
  });

  it('没有 API Key → 如实说「未调用模型」，message 用真实文件名兜底', async () => {
    const ctx = harness();
    await ctx.run();
    const text = ctx.text();
    expect(text).toContain(fmt(zh.commit.localNotice, { reason: zh.commit.localReasonNoClient }));
    expect(text).not.toContain(zh.commit.costNotice.split('{')[0] ?? '将调用模型');
  });

  it('注入模型 → 用模型写的 message 提交，并在调用前提示成本', async () => {
    const ctx = harness({
      client: fakeClient(['feat(cli): 新增 commit 命令', '\n- 新增 src/cli/commit.ts']),
    });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(commitCall(ctx.fake)?.input).toBe(
      'feat(cli): 新增 commit 命令\n\n- 新增 src/cli/commit.ts',
    );
    const text = ctx.text();
    expect(text).toContain('将调用模型生成 commit message');
    expect(text).toContain('新增 src/cli/commit.ts');
    expect(text).not.toContain(zh.commit.localReasonNoClient);
  });

  it('模型调用失败 → 如实告知原因，仍然可以提交（不卡死）', async () => {
    const ctx = harness({
      client: {
        // biome-ignore lint/correctness/useYield: 刻意在产出前抛错，模拟模型调用失败
        async *streamChat() {
          throw new Error('socket hang up');
        },
      },
    });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.text()).toContain(
      fmt(zh.commit.localNotice, { reason: zh.commit.localReasonModelFailed }),
    );
    expect(commitCall(ctx.fake)?.input).toBe(LOCAL_TEXT);
  });

  it('界面语言 en → 全英文输出（字典键无遗漏）', async () => {
    const ctx = harness({ lang: 'en' });
    await ctx.run();
    expect(ctx.text()).toContain(DICTS.en.commit.title);
    expect(ctx.text()).toContain(DICTS.en.commit.localOnly);
  });
});

// ── 体检不可跳过 ──────────────────────────────────────────────

describe('体检门（--yes 也绝不跳过）', () => {
  it('体检没过 → 打印失败报告 + 指向 `concertoai fix`，不提交', async () => {
    const ctx = harness({ check: checkResult(false) });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(commitCall(ctx.fake)).toBeUndefined();
    const text = ctx.text();
    expect(text).toContain(zh.commit.checkFailed);
    expect(text).toContain(zh.commit.checkFailedHint);
    // 失败摘要来自 formatCheckReport（复用 T15），不是自己拼的一行话
    expect(text).toContain('lint');
    expect(text).toContain('Unexpected any');
  });

  it('--yes 只跳过 message 审批，绝不跳过体检（CI 场景）', async () => {
    const ctx = harness({ yes: true, check: checkResult(false) });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.checkCalls).toHaveLength(1);
    expect(ctx.askCalls).toHaveLength(0);
    expect(commitCall(ctx.fake)).toBeUndefined();
  });

  it('--yes + 体检通过 → 不弹审批直接提交', async () => {
    const ctx = harness({ yes: true });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.askCalls).toHaveLength(0);
    expect(commitCall(ctx.fake)?.input).toBe(LOCAL_TEXT);
  });
});

// ── 审批门：默认 N，fail-closed ─────────────────────────────

describe('审批门（默认 N，非交互/中断一律不提交）', () => {
  it('回答 n → 已取消，一条都没提交（暂存区保持原样）', async () => {
    const ctx = harness({ ask: answers('n') });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.cancelled);
    expect(commitCall(ctx.fake)).toBeUndefined();
    // 只读了暂存区清单，没有 add / commit 的写操作
    expect(ctx.fake.calls.some((args) => args[0] === 'add')).toBe(false);
  });

  it('Ctrl+C（回答 undefined）→ 视为拒绝，不提交', async () => {
    const ctx = harness({ ask: answers(undefined) });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.cancelled);
    expect(commitCall(ctx.fake)).toBeUndefined();
  });

  it('非交互终端且没给 --yes → 说明需要交互式终端，不提交、不读答案', async () => {
    const ctx = harness({ isTTY: false });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.needsTty);
    expect(ctx.askCalls).toHaveLength(0);
    expect(commitCall(ctx.fake)).toBeUndefined();
  });
});

// ── 仓库状态门：无仓库 / 无 git / 冲突 / detached ───────────

describe('仓库状态守卫', () => {
  it('不是 git 仓库 → 提示 git init 后退出，且完全不起体检', async () => {
    const ctx = harness({ git: { repo: false } });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.notRepo);
    expect(ctx.text()).toContain(zh.commit.notRepoHint);
    expect(ctx.checkCalls).toHaveLength(0);
    expect(commitCall(ctx.fake)).toBeUndefined();
  });

  it('git 没装 → 说清「找不到 git」，不冒充「不是仓库」', async () => {
    const ctx = harness({ git: { missing: true } });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.gitMissing);
    expect(ctx.text()).not.toContain(zh.commit.notRepo);
    expect(commitCall(ctx.fake)).toBeUndefined();
  });

  it('合并冲突中（.git/MERGE_HEAD 存在）→ 拒绝提交并给解法', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'commit-conflict-'));
    try {
      await writeFile(path.join(cwd, 'MERGE_HEAD'), 'deadbeef\n', 'utf8');
      const fake = fakeGit();
      const lines: string[] = [];
      const code = await runCommitCommand({
        cwd,
        isTTY: true,
        ask: answers('y'),
        // rev-parse --git-dir 在假 git 里返回 '.git'，但真实仓库可能在别处；
        // 这里直接把 git-dir 指到临时目录本身，从而只验证 MERGE_HEAD 探测逻辑
        runGit: (args, input) =>
          args[0] === 'rev-parse' && args[1] === '--git-dir'
            ? Promise.resolve({ ok: true, stdout: '.\n', stderr: '' })
            : fake.run(args, input),
        check: async () => checkResult(true),
        log: (line) => lines.push(line),
        logErr: () => {},
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain(zh.commit.conflict);
      expect(lines.join('\n')).toContain(zh.commit.conflictHint);
      expect(commitCall(fake)).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('detached HEAD → 警告但允许提交（明确告知后果）', async () => {
    const ctx = harness({ git: { branch: null } });
    const code = await ctx.run();
    expect(code).toBe(0);
    const text = ctx.text();
    expect(text).toContain(zh.commit.detached);
    expect(text).toContain(zh.commit.detachedHint);
    expect(commitCall(ctx.fake)?.input).toBe(LOCAL_TEXT);
  });
});

// ── 暂存区为空：默认 N，绝不偷偷 add -A ─────────────────────

describe('暂存区守卫（默认 N，不禁自 add -A）', () => {
  it('暂存区空 + 非交互终端 → 拒绝自动 add 并退出（CI 里不会卷进敏感文件）', async () => {
    const ctx = harness({ git: { staged: [], untracked: ['src/a.ts'] }, isTTY: false });
    const code = await ctx.run();
    expect(code).toBe(1);
    const text = ctx.text();
    expect(text).toContain(zh.commit.noStaged);
    expect(text).toContain(fmt(zh.commit.untracked, { count: 1 }));
    expect(text).toContain(zh.commit.addAllNeedsTty);
    expect(ctx.fake.calls.some((args) => args[0] === 'add')).toBe(false);
    expect(ctx.checkCalls).toHaveLength(0);
  });

  it('暂存区空 + 回答 n → 保持原样退出，一条都没提交', async () => {
    const ctx = harness({ git: { staged: [] }, ask: answers('n') });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.addAllSkipped);
    expect(ctx.text()).toContain(zh.commit.nothingToCommit);
    expect(ctx.fake.calls.some((args) => args[0] === 'add')).toBe(false);
    expect(ctx.checkCalls).toHaveLength(0);
  });

  it('暂存区空 + 回答 y → add -A 后继续走完体检与提交', async () => {
    const ctx = harness({
      git: { staged: [], untracked: ['src/a.ts', 'src/b.ts'] },
      ask: answers('y', 'y'),
    });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.text()).toContain(fmt(zh.commit.addAllDone, { count: 2 }));
    expect(commitCall(ctx.fake)).toBeDefined();
    expect(ctx.checkCalls).toHaveLength(1);
  });

  it('`git add -A` 失败 → 如实报错并退出（不假装已暂存）', async () => {
    const ctx = harness({
      git: { staged: [], untracked: ['src/a.ts'], addOk: false },
      ask: answers('y'),
    });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(
      fmt(zh.commit.addAllFailed, { error: 'error: unable to index file' }),
    );
    expect(commitCall(ctx.fake)).toBeUndefined();
  });

  it('add -A 成功但仍是空暂存区 → 明说没有可提交的，不空提交', async () => {
    // 真实场景：`git add -A` 退出码 0，但改动全被 .gitignore 吞了（加了等于没加）
    const ctx = harness({
      git: { staged: [], untracked: ['src/a.ts'], addStagesNothing: true },
      ask: answers('y', 'y'),
    });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(zh.commit.nothingToCommit);
    // 确实尝试过自动 add，但**没有**走到 commit（空 message 提交是绝对红线）
    expect(ctx.fake.calls.some((args) => args[0] === 'add')).toBe(true);
    expect(commitCall(ctx.fake)).toBeUndefined();
    // 连体检都不该起（提交前就停手了，白跑一遍 verify 是浪费）
    expect(ctx.checkCalls).toHaveLength(0);
  });
});

// ── 边缘④：超长输出 / 超长 diff 不淹没终端 ─────────────────

describe('边缘路径：超长清单与超长 diff', () => {
  it(`暂存文件超过 ${MAX_FILES_SHOWN} 个 → 只展示前 ${MAX_FILES_SHOWN} 个 + 「另有 N 个」`, async () => {
    const files = Array.from({ length: MAX_FILES_SHOWN + 5 }, (_, i) => `src/f${i}.ts`);
    const ctx = harness({ git: { staged: files } });
    const code = await ctx.run();
    expect(code).toBe(0);
    const shown = ctx.lines.filter((line) => line.startsWith('  src/f'));
    expect(shown).toHaveLength(MAX_FILES_SHOWN);
    expect(ctx.text()).toContain(fmt(zh.commit.filesMore, { count: 5 }));
  });

  it('diff 超过上限 → 提示已截断，送模型的 prompt 也被 clamp', async () => {
    const sink: string[] = [];
    const ctx = harness({
      git: { diff: `+${'a'.repeat(MAX_DIFF_CHARS * 2)}` },
      client: fakeClient(['chore: x'], sink),
    });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.text()).toContain(fmt(zh.commit.diffTruncated, { limit: MAX_DIFF_CHARS }));
    expect(sink).toHaveLength(1);
    expect(sink[0]?.length).toBeLessThan(MAX_DIFF_CHARS + 2000);
  });

  it('git 提交失败 → 退出码 1 + 一行错误摘要（不刷屏）', async () => {
    const ctx = harness({
      git: { commitOk: false, commitStderr: 'fatal: unable to auto-detect email address' },
    });
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.text()).toContain(
      fmt(zh.commit.commitFailed, { error: 'fatal: unable to auto-detect email address' }),
    );
    expect(ctx.text()).not.toContain(zh.commit.commitOk);
  });
});

// ── 安全边界（D3-B）：白名单 + 源码字面量护栏 ───────────────

describe('安全边界（决策 D3-B 硬约束）', () => {
  it('白名单本身只含本地只读 / 本地写入子命令', async () => {
    for (const forbidden of FORBIDDEN) {
      expect(ALLOWED_GIT_SUBCOMMANDS, `白名单里出现危险子命令 ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // 正向：确实需要的那几个在里面（否则白名单退化成空话）
    for (const required of ['rev-parse', 'status', 'diff', 'add', 'commit']) {
      expect(ALLOWED_GIT_SUBCOMMANDS).toContain(required);
    }
  });

  it('真实调用全部落在白名单内（走完整流程，逐个核对 args[0]）', async () => {
    const ctx = harness({ git: { staged: [], untracked: ['src/a.ts'] } });
    await ctx.run();
    expect(ctx.fake.calls.length).toBeGreaterThan(0);
    for (const args of ctx.fake.calls) {
      expect(ALLOWED_GIT_SUBCOMMANDS, `越权子命令：${args.join(' ')}`).toContain(args[0]);
    }
  });

  it('任何调用都不带危险开关 / 都不碰远程与历史改写', async () => {
    const ctx = harness({ git: { staged: [], untracked: ['src/a.ts'] } });
    await ctx.run();
    for (const args of ctx.fake.calls) {
      const flat = args.join(' ');
      for (const forbidden of FORBIDDEN) {
        expect(flat.includes(forbidden), `调用里出现 ${forbidden}：${flat}`).toBe(false);
      }
    }
  });

  it('源码护栏：无远程/改写历史/绕过检查的字面量调用', async () => {
    const source = await commitSource();
    for (const forbidden of FORBIDDEN) {
      expect(source.includes(`'${forbidden}'`), `commit.ts 里出现 '${forbidden}'`).toBe(false);
    }
    // 也不许自己再 spawn 一套 npm / verify
    expect(source).not.toContain('execSync');
    expect(source).not.toContain('npm run verify');
  });
});

// ── 薄包装（G6）：体检只复用 T15 ────────────────────────────

describe('薄包装护栏（G6）', () => {
  it('体检来自 `./check` 的 runCheck + formatCheckReport，没有第二套解析', async () => {
    const source = await commitSource();
    expect(source).toContain("from './check'");
    expect(source).toContain('runCheck');
    expect(source).toContain('formatCheckReport');
    // 第二套 verify 解析 = 双份耗时 + 双份失败面（禁止）
    expect(source).not.toContain('parseVerifyReport');
    expect(source).not.toContain('npm run build');
    expect(source).not.toContain('npm run lint');
  });

  it('体检失败报告的行确实由 formatCheckReport 产出（注入不同结果 → 输出跟着变）', async () => {
    const pass = harness({ check: checkResult(true) });
    await pass.run();
    const fail = harness({ check: checkResult(false) });
    await fail.run();
    expect(pass.text()).not.toContain('Unexpected any');
    expect(fail.text()).toContain('Unexpected any');
  });
});
