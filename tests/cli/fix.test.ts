/**
 * `concertoai fix` 测试（v5.0 T16）。
 *
 * ## 这个命令最容易出的错，也不是「修不好」
 *
 * 是**骗人**与**偷偷动手**：
 * - `--dry-run` 说好只诊断，却偷偷跑了 `lint:fix` 或弹审批；
 * - 退出码非 0 但解析不出具体错误，却报告「✅ 无需修复」（T15 假通过教训的翻版）；
 * - 非 TTY / Ctrl+C 时把「没法审批」当成「同意」，直接写盘。
 *
 * 所以用例围绕两条线写：
 * 1. **零写入**（`--dry-run`）：lint:fix 零调用、审批零调用、退出码如实；
 * 2. **fail-closed**（真修）：非 TTY / 回答 n / 回答 undefined（Ctrl+C）→ 一个字节都不写。
 *
 * 外加一条护栏：**薄包装（G6）**——断言 `fix.ts` 里没有第二套 verify 解析、没有
 * 直接 spawn 子进程，判定一律来自 `src/loop/self-heal` 的 `strategyFor`。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildFixDiagnosis,
  type FixCommandOptions,
  type FixPlanEntry,
  formatFixPlan,
  MAX_DIAGNOSIS_ENTRIES,
  runFixCommand,
} from '../../src/cli/fix';
import { fmt } from '../../src/i18n';
import { zh } from '../../src/i18n/zh';
import { MAX_SELF_HEAL_ATTEMPTS, parseVerifyReport } from '../../src/loop/self-heal';
import type { ModelClient } from '../../src/model/client';
import { SNAPSHOT_ROOT } from '../../src/orchestrator/transaction';

// ── 样本 ──────────────────────────────────────────────────────

/** 构造 verify 输出（npm 段标记 + 各段文本），与真实 `npm run verify` 形态一致。 */
function verifyOutput(segments: Array<[stage: string, body: string]>): {
  stdout: string;
  stderr: string;
} {
  return {
    stdout: segments.map(([stage, body]) => `> @concertoai/cli@4.1.1 ${stage}\n${body}`).join('\n'),
    stderr: '',
  };
}

/** 全绿。 */
const VERIFY_PASS = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** lint 失败（Biome FIXABLE）：可 lint 直修。 */
const LINT_FAIL = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━\n  × Unexpected any.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** type 简单错误（缺 import，TS2304）：可模型修复。 */
const TYPE_MISSING_IMPORT = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'."],
  ['test', 'Test Files  1 passed (1)'],
]);

/** build 失败（无 file/line，只能转人工）——永远修不好，用来打超限/转人工路径。 */
const BUILD_FAIL = verifyOutput([
  ['build', 'CLI Build Error: RollupError: Could not resolve "./missing" from src/index.ts'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

// ── 工具 ──────────────────────────────────────────────────────

/** 输出收集器（stdout / stderr 分开）。 */
function collector(): {
  lines: string[];
  text: string;
  log: (line: string) => void;
  errors: string[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    get text(): string {
      return lines.join('\n');
    },
    log: (line: string) => lines.push(line),
  };
}

/** 从 verify 输出解析出报告（诊断纯函数要的输入）。 */
function reportOf(output: { stdout: string; stderr: string }) {
  return parseVerifyReport(output.stdout, output.stderr);
}

/** 返回固定修复 JSON 的 fake ModelClient。 */
function fakeClient(fixJson: string): ModelClient {
  return {
    async *streamChat() {
      yield {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta: { content: fixJson }, finish_reason: null }],
      } as never;
    },
  };
}

/** 临时工作区：src/foo.ts 初始内容（模型修复需要真实文件落盘）。 */
async function makeWorkspace(original: string): Promise<{ cwd: string; fooPath: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fixcmd-'));
  const dir = path.join(cwd, 'src');
  await mkdir(dir, { recursive: true });
  const fooPath = path.join(dir, 'foo.ts');
  await writeFile(fooPath, original, 'utf8');
  return { cwd, fooPath };
}

/** 带清理的工作区执行（进程被硬杀也不会漏删：try/finally + maxRetries 对付 Windows EBUSY）。 */
async function withWorkspace(
  original: string,
  body: (workspace: { cwd: string; fooPath: string }) => Promise<void>,
): Promise<void> {
  const workspace = await makeWorkspace(original);
  try {
    await body(workspace);
  } finally {
    await rm(workspace.cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/**
 * 去掉源码注释（只留代码），供「源码护栏」使用。
 *
 * `fix.ts` 的 JSDoc 正常地写着「本文件里**没有**第二套 verify 解析」，
 * 直接对原文做子串检查会把这句**否认**当成**罪证**（假阳性）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** 读 fix.ts 源码（去注释）。 */
async function fixSource(): Promise<string> {
  const url = new URL('../../src/cli/fix.ts', import.meta.url);
  return stripComments(await readFile(fileURLToPath(url), 'utf8'));
}

// ── buildFixDiagnosis：纯函数 ─────────────────────────────────

describe('buildFixDiagnosis（诊断纯函数）', () => {
  it('verify 通过 → passed=true、无条目、counts 全 0、次数上限复用 MAX_SELF_HEAL_ATTEMPTS', async () => {
    const diagnosis = buildFixDiagnosis({ passed: true, report: reportOf(VERIFY_PASS) });
    expect(diagnosis.passed).toBe(true);
    expect(diagnosis.entries).toEqual([]);
    expect(diagnosis.hiddenCount).toBe(0);
    expect(diagnosis.counts).toEqual({ lintFix: 0, modelFix: 0, manual: 0 });
    // 不另写一份数字：上限必须来自 self-heal 常量
    expect(diagnosis.attempts).toBe(MAX_SELF_HEAL_ATTEMPTS);
  });

  it('动作一律来自 strategyFor：lint→lint-fix / type 简单→model-fix / build→none+建议', async () => {
    const mixed = verifyOutput([
      ['build', 'CLI Build Error: RollupError: Could not resolve "./missing" from src/index.ts'],
      ['lint', 'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━\n  × Unexpected any.'],
      ['typecheck', "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'."],
      ['test', 'Test Files  1 passed (1)'],
    ]);
    const diagnosis = buildFixDiagnosis({ passed: false, report: reportOf(mixed) });
    const byStage = new Map(diagnosis.entries.map((entry) => [entry.stage, entry]));
    expect(byStage.get('lint')?.action).toBe('lint-fix');
    expect(byStage.get('type')?.action).toBe('model-fix');
    const build = byStage.get('build');
    expect(build?.action).toBe('none');
    // 不自动修的条目必须给可操作建议（否则用户拿到一条「不行」没下文）
    expect((build?.suggestion ?? '').length).toBeGreaterThan(0);
    // 能自动修的条目不再堆建议（避免与动作文案重复）
    expect(byStage.get('lint')?.suggestion).toBe('');
  });

  it('错误数超上限 → 截断展示 + hiddenCount 记录被隐藏条数（边缘④不刷屏）', () => {
    const bodies = Array.from(
      { length: MAX_DIAGNOSIS_ENTRIES + 7 },
      (_, i) => `src/f${i}.ts(${i + 1},1): error TS2322: Type 'number' is not assignable.`,
    );
    const many = verifyOutput([
      ['build', 'Build success.'],
      ['lint', 'All checks passed.'],
      ['typecheck', bodies.join('\n')],
      ['test', 'Test Files  1 passed (1)'],
    ]);
    const diagnosis = buildFixDiagnosis({ passed: false, report: reportOf(many) });
    expect(diagnosis.entries.length).toBe(MAX_DIAGNOSIS_ENTRIES);
    expect(diagnosis.hiddenCount).toBeGreaterThan(0);
    // counts 按全部错误统计，不受展示截断影响
    expect(diagnosis.counts.modelFix + diagnosis.counts.manual).toBeGreaterThan(
      MAX_DIAGNOSIS_ENTRIES,
    );
  });

  it('退出码非 0 但解析不出错误 → passed 仍为 false（不冒充通过，T15 假通过教训）', () => {
    const silent = { stdout: '> @concertoai/cli@4.1.1 verify\n（无法识别的输出形态）', stderr: '' };
    const diagnosis = buildFixDiagnosis({ passed: false, report: reportOf(silent) });
    expect(diagnosis.passed).toBe(false);
    expect(diagnosis.entries).toEqual([]);
  });
});

// ── formatFixPlan：文案 ──────────────────────────────────────

describe('formatFixPlan（诊断文案）', () => {
  const entry: FixPlanEntry = {
    stage: 'lint',
    action: 'lint-fix',
    location: 'src/foo.ts:1',
    message: 'Unexpected any.',
    suggestion: '',
  };

  it('通过 → 只有标题 + 「无需修复」，不渲染策略清单', () => {
    const lines = formatFixPlan({
      passed: true,
      entries: [],
      hiddenCount: 0,
      counts: { lintFix: 0, modelFix: 0, manual: 0 },
      attempts: MAX_SELF_HEAL_ATTEMPTS,
    });
    expect(lines).toEqual([zh.fix.title, zh.fix.passed]);
  });

  it('未通过却一条都定位不到 → 明说「没能定位」，不写成「无需修复」', () => {
    const text = formatFixPlan({
      passed: false,
      entries: [],
      hiddenCount: 0,
      counts: { lintFix: 0, modelFix: 0, manual: 0 },
      attempts: MAX_SELF_HEAL_ATTEMPTS,
    }).join('\n');
    expect(text).toContain(zh.fix.unattributed);
    expect(text).not.toContain(zh.fix.passed);
    // 零写入声明必须照旧（哪怕定位不到错误，也要说清「这一趟一个字节都没写」）
    expect(text).toContain(zh.fix.dryRunNotice);
  });

  it('有计划 → 摘要 + 每条一行 + 截断提示 + dry-run 零写入声明', () => {
    const text = formatFixPlan({
      passed: false,
      entries: [entry],
      hiddenCount: 3,
      counts: { lintFix: 1, modelFix: 2, manual: 0 },
      attempts: MAX_SELF_HEAL_ATTEMPTS,
    }).join('\n');
    expect(text).toContain(fmt(zh.fix.summaryLine, { count: 3, lint: 1, model: 2, manual: 0 }));
    expect(text).toContain('src/foo.ts:1');
    expect(text).toContain(zh.fix.actionLintFix);
    expect(text).toContain(fmt(zh.fix.moreErrors, { count: 3 }));
    expect(text).toContain(zh.fix.dryRunNotice);
    expect(text).toContain(fmt(zh.fix.planTitle, { attempts: MAX_SELF_HEAL_ATTEMPTS }));
  });
});

// ── runFixCommand --dry-run：零写入 ──────────────────────────

describe('runFixCommand --dry-run（只诊断，零写入）', () => {
  it('verify 通过 → 退出码 0、无需修复，且 lint:fix / 审批零调用', async () => {
    const out = collector();
    let lintFixCalls = 0;
    let approvalCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      dryRun: true,
      runVerify: async () => ({ ok: true, ...VERIFY_PASS }),
      runLintFix: async () => {
        lintFixCalls += 1;
        return { ok: true };
      },
      requestApproval: () => {
        approvalCalls += 1;
        return true;
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(0);
    expect(out.text).toContain(zh.fix.passed);
    expect(lintFixCalls).toBe(0);
    expect(approvalCalls).toBe(0);
  });

  it('verify 失败 → 退出码 1、给出策略清单，且仍然一次都没写盘', async () => {
    const out = collector();
    let lintFixCalls = 0;
    let approvalCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      dryRun: true,
      runVerify: async () => ({ ok: false, ...LINT_FAIL }),
      runLintFix: async () => {
        lintFixCalls += 1;
        return { ok: true };
      },
      requestApproval: () => {
        approvalCalls += 1;
        return true;
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).toContain(zh.fix.title);
    expect(out.text).toContain(zh.fix.actionLintFix);
    expect(out.text).toContain(zh.fix.dryRunNotice);
    // 零写入核心断言：哪怕用户注入的 lint:fix 是假的，也不许被调用
    expect(lintFixCalls).toBe(0);
    expect(approvalCalls).toBe(0);
  });

  it('verify 根本跑不起来（首次进裸项目）→ 退出码 1 + 可操作提示，不崩', async () => {
    const out = collector();
    const code = await runFixCommand({
      cwd: process.cwd(),
      dryRun: true,
      runVerify: async () => {
        throw new Error('spawn npm ENOENT');
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).toContain(fmt(zh.fix.verifyRunFailed, { error: 'spawn npm ENOENT' }));
    expect(out.text).toContain('项目根目录');
  });

  it('不带 API Key 也能诊断（不提示缺 Key、不构造模型客户端）', async () => {
    const out = collector();
    const code = await runFixCommand({
      cwd: process.cwd(),
      dryRun: true,
      runVerify: async () => ({ ok: false, ...LINT_FAIL }),
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).not.toContain(zh.fix.noApiKey);
  });
});

// ── runFixCommand 真修：两道门与 fail-closed ────────────────

describe('runFixCommand 真修（每次写盘审批 + fail-closed）', () => {
  it('非交互终端 → 退出码 1、明确要求交互式终端，且 verify 一次都没跑', async () => {
    const out = collector();
    let verifyCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      isTTY: false,
      runVerify: async () => {
        verifyCalls += 1;
        return { ok: true, ...VERIFY_PASS };
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).toContain(zh.fix.needsTty);
    expect(verifyCalls).toBe(0);
  });

  it('开跑前回答 n → 已取消、退出码 1，且 verify / lint:fix 均零调用', async () => {
    const out = collector();
    let verifyCalls = 0;
    let lintFixCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      isTTY: true,
      ask: async () => 'n',
      runVerify: async () => {
        verifyCalls += 1;
        return { ok: false, ...LINT_FAIL };
      },
      runLintFix: async () => {
        lintFixCalls += 1;
        return { ok: true };
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).toContain(zh.fix.cancelled);
    expect(verifyCalls).toBe(0);
    expect(lintFixCalls).toBe(0);
  });

  it('Ctrl+C（回答 undefined）→ 当作取消，退出码 1，不写盘', async () => {
    const out = collector();
    let verifyCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      isTTY: true,
      ask: async () => undefined,
      runVerify: async () => {
        verifyCalls += 1;
        return { ok: true, ...VERIFY_PASS };
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).toContain(zh.fix.cancelled);
    expect(verifyCalls).toBe(0);
  });

  it('真修且 verify 通过 → 退出码 0，不跑 lint:fix、不提缺 Key 以外的多余噪声', async () => {
    const out = collector();
    let verifyCalls = 0;
    let lintFixCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      isTTY: true,
      ask: async () => 'y',
      runVerify: async () => {
        verifyCalls += 1;
        return { ok: true, ...VERIFY_PASS };
      },
      runLintFix: async () => {
        lintFixCalls += 1;
        return { ok: true };
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(0);
    expect(verifyCalls).toBe(1);
    expect(lintFixCalls).toBe(0);
  });

  it('lint 失败 → 走确定性 lint:fix 后通过 → 退出码 0', async () => {
    const out = collector();
    let lintFixed = false;
    let lintFixCalls = 0;
    const code = await runFixCommand({
      cwd: process.cwd(),
      isTTY: true,
      ask: async () => 'y',
      runVerify: async () =>
        lintFixed ? { ok: true, ...VERIFY_PASS } : { ok: false, ...LINT_FAIL },
      runLintFix: async () => {
        lintFixCalls += 1;
        lintFixed = true;
        return { ok: true };
      },
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(0);
    expect(lintFixCalls).toBe(1);
  });

  it('模型修复写盘走审批且被拒绝 → 文件原样未改、退出码 1、转人工', async () => {
    await withWorkspace('export const a = bar;\n', async ({ cwd, fooPath }) => {
      const out = collector();
      let approvalCalls = 0;
      const options: FixCommandOptions = {
        cwd,
        isTTY: true,
        ask: (question) =>
          // 门①（开跑前）回答 y；门②（写盘前）回答 n —— 模拟用户「先看看，但这次不批」
          Promise.resolve(question.includes('继续') ? 'y' : 'n'),
        client: fakeClient(
          JSON.stringify({
            file: 'src/foo.ts',
            search: 'export const a = bar;',
            replace: 'export const a = foo;',
          }),
        ),
        model: 'deepseek-v4-flash',
        requestApproval: () => {
          approvalCalls += 1;
          return false;
        },
        runVerify: async () => ({ ok: false, ...TYPE_MISSING_IMPORT }),
        runLintFix: async () => ({ ok: true }),
        log: out.log,
        logErr: (line) => out.errors.push(line),
      };
      const code = await runFixCommand(options);
      expect(code).toBe(1);
      // 每次模型修复写盘前都必须过一次审批（拒绝 → fail-closed）
      expect(approvalCalls).toBe(1);
      expect(await readFile(fooPath, 'utf8')).toBe('export const a = bar;\n');
      expect(out.text).toContain(zh.fix.failedHint.split('{')[0]?.slice(0, 6) ?? '转人工');
    });
  });

  it('模型修复审批通过 → 落盘生效、退出码 0、审批恰好一次', async () => {
    await withWorkspace('export const a = bar;\n', async ({ cwd, fooPath }) => {
      const out = collector();
      let approvalCalls = 0;
      let fixed = false;
      const code = await runFixCommand({
        cwd,
        isTTY: true,
        ask: async () => 'y',
        client: fakeClient(
          JSON.stringify({
            file: 'src/foo.ts',
            search: 'export const a = bar;',
            replace: 'export const a = foo;',
          }),
        ),
        model: 'deepseek-v4-flash',
        requestApproval: () => {
          approvalCalls += 1;
          return true;
        },
        runVerify: async () => {
          fixed = fixed || approvalCalls > 0;
          return fixed ? { ok: true, ...VERIFY_PASS } : { ok: false, ...TYPE_MISSING_IMPORT };
        },
        runLintFix: async () => ({ ok: true }),
        log: out.log,
        logErr: (line) => out.errors.push(line),
      });
      expect(code).toBe(0);
      expect(approvalCalls).toBe(1);
      expect(await readFile(fooPath, 'utf8')).toBe('export const a = foo;\n');
    });
  });

  it('修不好 → 转人工 + 保留现场（给出真实存在的 snapshot 命令），退出码 1', async () => {
    const out = collector();
    const code = await runFixCommand({
      cwd: process.cwd(),
      isTTY: true,
      autoApprove: true,
      runVerify: async () => ({ ok: false, ...BUILD_FAIL }),
      runLintFix: async () => ({ ok: true }),
      log: out.log,
      logErr: (line) => out.errors.push(line),
    });
    expect(code).toBe(1);
    expect(out.text).toContain(fmt(zh.fix.failedHint, { attempts: MAX_SELF_HEAL_ATTEMPTS }));
    expect(out.text).toContain(SNAPSHOT_ROOT);
    // 只许给真实存在的命令（T10/T12 空头支票教训）
    expect(out.text).toContain('concertoai snapshot list');
    expect(out.text).toContain('concertoai snapshot clean');
    expect(out.text).not.toContain('snapshot restore');
  });
});

// ── 源码护栏：薄包装（G6） ───────────────────────────────────

describe('fix.ts 薄包装护栏（G6）', () => {
  it('复用 self-heal 的判定，不新造 verify 解析 / 不直接起子进程', async () => {
    const source = await fixSource();
    // 判定来源唯一：strategyFor（真修与诊断共用同一份优先级）
    expect(source).toContain('strategyFor');
    expect(source).toContain('parseVerifyReport');
    expect(source).toContain('runSelfHeal');
    // 不得自建第二套解析
    expect(source).not.toContain('parseLintErrors');
    expect(source).not.toContain('mergeLintPassed');
    // 不得绕过 self-heal 直接执行命令
    expect(source).not.toContain('execSync');
    expect(source).not.toContain('child_process');
    // lint:fix 只能由 self-heal 触发（本文件不许自己拼命令）
    expect(source).not.toContain("'npm run lint:fix'");
  });
});
