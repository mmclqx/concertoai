/**
 * `concertoai commit` 命令（v5.0 M4 / T17）：写完代码一条命令提交。
 *
 * ## 它回答一个问题
 *
 * 「现在这份改动，能不能提交、该怎么描述？」——先体检（复用 T15 的 `check`），
 * 再按真实暂存区 diff 生成 commit message，**展示给用户审批后**才落成一次本地提交。
 *
 * ## 五条不可妥协的边界
 *
 * 1. **薄包装（G6，专家点名）**：体检**只**调 `./check` 的 `runCheck`，并用它的
 *    `formatCheckReport` 渲染失败结论。本文件里**没有任何** verify 输出解析、
 *    没有第二套段分类、不自己 spawn 检测命令——双份 verify 调用 = 双份耗时 + 双份失败面
 *    （v4.1.1「装好却跑不通」的同类分叉）。T19 会断言这条依赖真实存在。
 * 2. **人工审批，默认 N**：message + 将提交的文件清单必须先展示，用户回答 y 才提交。
 *    非交互终端（没法审批）→ 直接不提交并说明用 `--yes`（fail-closed，与 `fix` 同口径）。
 * 3. **`--yes` 只跳过 message 审批，绝不跳过体检**：CI 里「我已经看过了」是合理的，
 *    「我不需要体检」不是——那等于把 T15 的意义作废。
 * 4. **只做本地提交**：本文件只会用到
 *    `rev-parse` / `symbolic-ref` / `status` / `ls-files` / `diff` / `add` / `commit` 这些
 *    本地只读或本地写入的子命令；**不执行任何远程操作、不改写历史、不加绕过检查的开关、
 *    不用强制类参数**（决策 D3-B 硬约束，T19 有字面量护栏）。
 * 5. **不静默成功**：不是 git 仓库 / 合并冲突中 / 暂存区为空 / 体检没过 / 用户拒绝 /
 *    git 提交失败——每一种都明确说清「一条都没提交」，绝不给出含混的成功感。
 *
 * ## detached HEAD 为什么只警告不拦
 *
 * 用户可能就是在看某个历史提交（`git checkout <sha>`）后想试一版改动；拦下来是自作主张。
 * 但必须**明确告知**：这些提交不属于任何分支，切走后容易丢。警告 + 允许是诚实的折中。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  type CommitMessage,
  clampDiff,
  estimateCommitTokens,
  generateCommitMessage,
  MAX_DIFF_CHARS,
  type StagedDiff,
} from '../core/commit-message';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { DeepSeekClient, type ModelClient } from '../model/client';
// G6 薄包装：体检完全复用 T15（禁止在本文件里跑 verify / 解析 verify 输出）
import { type CheckResult, formatCheckReport, runCheck } from './check';
import { resolveModel } from './common';
import { promptLine } from './prompt';

// ── 常量 ──────────────────────────────────────────────────────

/** 展示的暂存文件清单上限（G5 边缘路径：超长清单不淹没终端）。 */
export const MAX_FILES_SHOWN = 20;

/** 展示 git 输出的行数上限（提交成功回执通常 1-3 行，失败信息要有界）。 */
export const MAX_GIT_OUTPUT_LINES = 10;

/**
 * 本命令允许调用的 git 子命令白名单。
 *
 * 这是一份**可断言的清单**（测试会收集真实调用并逐个核对）：
 * 全部是本地操作，没有任何一项能影响远程仓库或改写已有历史。
 */
export const ALLOWED_GIT_SUBCOMMANDS: readonly string[] = [
  'rev-parse',
  'symbolic-ref',
  'status',
  'ls-files',
  'diff',
  'add',
  'commit',
];

// ── git 执行层（可注入）────────────────────────────────────────

/** 一次 git 调用的结果（`ok` 看进程退出码，与 check 同口径）。 */
export interface GitOutcome {
  /** 退出码为 0。 */
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** git 执行器（测试注入假实现，绝不真跑 git）。 */
export type GitRunner = (args: string[], input?: string) => Promise<GitOutcome>;

/**
 * 默认执行器：`spawn('git', args)`，message 通过 **stdin** 传入（`commit -F -`）。
 *
 * 为什么用 spawn + stdin 而不是拼命令行字符串：
 * - 不经过 shell，message 里的引号 / 换行 / `$` 不会被解释（Windows 与 POSIX 行为一致）；
 * - message 永远不落临时文件，也就不需要「用完删除」的收尾（AGENTS 第 17 条）。
 */
export function createGitRunner(cwd: string): GitRunner {
  return (args: string[], input?: string): Promise<GitOutcome> =>
    new Promise((resolve) => {
      const child = spawn('git', args, { cwd, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      // git 没装 / 不在 PATH：spawn 直接报错，如实吞进 stderr 由调用方判断
      child.on('error', (err: Error) => {
        resolve({ ok: false, stdout, stderr: `${stderr}${err.message}` });
      });
      child.on('close', (code: number | null) => {
        resolve({ ok: code === 0, stdout, stderr });
      });
      child.stdin.on('error', () => {
        // 子进程提前退出时写 stdin 会 EPIPE：忽略（结果由 close 的退出码决定）
      });
      child.stdin.end(input ?? '');
    });
}

// ── 类型定义 ──────────────────────────────────────────────────

/** commit 命令选项（git / 体检 / 模型 / 交互全部可注入，测试不真跑 git 与 verify）。 */
export interface CommitCommandOptions {
  /** 工作目录（默认 process.cwd()）。 */
  cwd?: string;
  /** 跳过 message 审批（CI 用；**不跳过体检**）。 */
  yes?: boolean;
  /** DeepSeek API Key（缺省 → 不调模型，走本地兜底 message）。 */
  apiKey?: string;
  /** 模型 ID（缺省用默认模型）。 */
  model?: string;
  /** 界面语言。 */
  lang?: string;
  /** 是否交互式终端（缺省 `process.stdin.isTTY`）。 */
  isTTY?: boolean;
  /** 输出（stdout）。 */
  log?: (line: string) => void;
  /** 过程日志（stderr）。 */
  logErr?: (line: string) => void;
  /** 测试注入：git 执行器（缺省 spawn 真实 git）。 */
  runGit?: GitRunner;
  /** 测试注入：体检（缺省 `runCheck`，即 T15）。 */
  check?: (cwd: string) => Promise<CheckResult>;
  /** 测试注入：模型客户端（缺省按 apiKey 构造；无 apiKey 则不调模型）。 */
  client?: ModelClient;
  /** 测试注入：读一行回答（缺省走 `promptLine`）。 */
  ask?: (question: string) => Promise<string | undefined>;
}

// ── 小工具 ────────────────────────────────────────────────────

/** 回答是否为「是」（y / yes；其余含 undefined = 否，fail-closed）。 */
function isYes(answer: string | undefined): boolean {
  const value = answer?.trim().toLowerCase();
  return value === 'y' || value === 'yes';
}

/** 按行切分 git 输出（丢空行）。 */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 单行化 + 截断（错误信息可能是一大段 stderr）。 */
function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 打印有界行数（G5：git 输出可能很长）。 */
function logBlock(lines: readonly string[], log: (line: string) => void, template: string): void {
  for (const line of lines.slice(0, MAX_GIT_OUTPUT_LINES)) {
    log(fmt(template, { line }));
  }
}

// ── 命令入口 ──────────────────────────────────────────────────

/**
 * 执行 `concertoai commit`。
 *
 * @returns 退出码：0 = 已提交；1 = 未提交（每条路径都说明了原因）或提交失败。
 */
export async function runCommitCommand(options: CommitCommandOptions = {}): Promise<number> {
  if (options.lang !== undefined) {
    setLocale(resolveLocale(options.lang));
  }
  const dict = t().commit;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.log(line));
  const logErr = options.logErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  const ask = options.ask ?? ((question: string) => promptLine(question));
  // 统一走这一个注入点：测试用假 runner，真实环境走 spawn git（参数逐条白名单核对见测试）
  const git: GitRunner = options.runGit ?? createGitRunner(cwd);

  log(dict.title);

  // ── ① 是不是 git 仓库（顺带区分「git 都没装」）──
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    const stderr = `${inside.stderr}${inside.stdout}`;
    if (/ENOENT|not recognized|not found|command not found/i.test(stderr)) {
      log(dict.gitMissing);
      log(dict.gitMissingHint);
      return 1;
    }
    log(dict.notRepo);
    log(dict.notRepoHint);
    return 1;
  }

  // ── ② 合并冲突中：拒绝（会把冲突标记一起提交进去）──
  const gitDir = await git(['rev-parse', '--git-dir']);
  const gitDirPath = path.resolve(cwd, gitDir.stdout.trim() === '' ? '.git' : gitDir.stdout.trim());
  if (existsSync(path.join(gitDirPath, 'MERGE_HEAD'))) {
    log(dict.conflict);
    log(dict.conflictHint);
    return 1;
  }

  // ── ③ detached HEAD：警告但允许（明确告知后果）──
  const head = await git(['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : '';
  if (head.ok && branch !== '') {
    log(fmt(dict.branch, { branch }));
  } else {
    log(dict.detached);
    log(dict.detachedHint);
  }

  // ── ④ 暂存区守卫：空则提示先 add；问是否自动 add -A（默认 N，--yes 不代答）──
  let files = splitLines((await git(['diff', '--staged', '--name-only'])).stdout);
  if (files.length === 0) {
    log(dict.noStaged);
    log(dict.noStagedHint);
    const untracked = splitLines(
      (await git(['ls-files', '--others', '--exclude-standard'])).stdout,
    );
    if (untracked.length > 0) {
      log(fmt(dict.untracked, { count: untracked.length }));
    }
    // 为什么 --yes 不代答：暂存范围是「提交什么」的决定，与「要不要读我的回答」无关；
    // 一旦让 --yes 顺手 add -A，CI 里一次误跑就会把全部改动（含敏感文件）卷进提交。
    if (!isTTY) {
      log(dict.addAllNeedsTty);
      return 1;
    }
    const addAnswer = await ask(dict.addAllPrompt);
    if (!isYes(addAnswer)) {
      log(dict.addAllSkipped);
      log(dict.nothingToCommit);
      return 1;
    }
    const added = await git(['add', '-A']);
    if (!added.ok) {
      log(fmt(dict.addAllFailed, { error: oneLine(added.stderr || added.stdout) }));
      return 1;
    }
    files = splitLines((await git(['diff', '--staged', '--name-only'])).stdout);
    if (files.length === 0) {
      log(dict.nothingToCommit);
      return 1;
    }
    log(fmt(dict.addAllDone, { count: files.length }));
  }

  // ── ⑤ 体检：完全复用 T15（薄包装，任何副作用都没有）──
  logErr(dict.checking);
  const check = options.check ?? ((dir: string) => runCheck({ cwd: dir }));
  const result = await check(cwd);
  if (!result.ok) {
    for (const line of formatCheckReport(result)) {
      log(line);
    }
    log('');
    log(dict.checkFailed);
    log(dict.checkFailedHint);
    return 1;
  }
  log(fmt(dict.checkPassed, { seconds: (result.durationMs / 1000).toFixed(1) }));

  // ── ⑥ 采集真实 diff → 生成 message（成本提示在调模型之前）──
  const stat = (await git(['diff', '--staged', '--stat'])).stdout.trimEnd();
  const rawDiff = (await git(['diff', '--staged'])).stdout;
  const clamped = clampDiff(rawDiff, MAX_DIFF_CHARS);
  const staged: StagedDiff = {
    files,
    stat,
    diff: clamped.text,
    truncated: clamped.truncated,
    branch,
  };

  const client =
    options.client ??
    (options.apiKey !== undefined ? new DeepSeekClient({ apiKey: options.apiKey }) : undefined);
  const model = client === undefined ? undefined : (options.model ?? resolveModel(undefined));
  if (client !== undefined) {
    log(fmt(dict.costNotice, { tokens: estimateCommitTokens(staged) }));
  }
  const message: CommitMessage = await generateCommitMessage({ diff: staged, client, model });
  if (message.source === 'local') {
    // 如实说明「这次没调模型」——不能让用户以为 message 是模型写的
    log(
      fmt(dict.localNotice, {
        reason:
          message.fallbackReason === 'no-client'
            ? dict.localReasonNoClient
            : message.fallbackReason === 'model-failed'
              ? dict.localReasonModelFailed
              : dict.localReasonModelEmpty,
      }),
    );
  }

  // ── ⑦ 展示 message + 将提交的文件清单（审批前必须看见）──
  log('');
  log(dict.messageTitle);
  log(`  ${message.subject}`);
  for (const point of message.body) {
    log(`  - ${point}`);
  }
  log('');
  log(fmt(dict.filesTitle, { count: files.length }));
  for (const file of files.slice(0, MAX_FILES_SHOWN)) {
    log(`  ${file}`);
  }
  if (files.length > MAX_FILES_SHOWN) {
    log(fmt(dict.filesMore, { count: files.length - MAX_FILES_SHOWN }));
  }
  if (clamped.truncated) {
    log(fmt(dict.diffTruncated, { limit: MAX_DIFF_CHARS }));
  }

  // ── ⑧ 审批门（默认 N；非 TTY 无法审批 → 不提交）──
  if (options.yes !== true) {
    if (!isTTY) {
      log(dict.needsTty);
      return 1;
    }
    log('');
    const answer = await ask(dict.confirmPrompt);
    if (!isYes(answer)) {
      // 含 Ctrl+C（promptLine 返回 undefined）：体面退出，一个字节都没提交
      log(dict.cancelled);
      return 1;
    }
  }

  // ── ⑨ 本地提交（message 走 stdin，不落临时文件）──
  const commit = await git(['commit', '-F', '-'], message.text);
  if (!commit.ok) {
    log(fmt(dict.commitFailed, { error: oneLine(commit.stderr || commit.stdout) }));
    return 1;
  }
  log(dict.commitOk);
  logBlock(splitLines(commit.stdout), log, dict.commitOutput);
  log(dict.localOnly);
  return 0;
}
