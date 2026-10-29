/**
 * `concertoai check` 测试（v5.0 T15）。
 *
 * ## 这个命令最容易出的错，都不是「算错了」
 *
 * 是**假通过**：没跑检测 / 跑挂了 / 解析不出来，却对用户说「✅ 可以提交」。
 * 所以下面每组用例都围绕「会不会骗人」写：
 * - 无 package.json → 明确「无法体检」，退出 1；
 * - 无任何检测脚本 → 明确「没做检测」，退出 1；
 * - 退出码非 0 但解析不出原因 → 四段全「无法判定」，退出 1；
 * - verify 前后段 `&&` 链没跑到的段 → 标「未执行」，不冒充通过。
 *
 * 另外两条护栏：
 * - **只读**：执行过的脚本里永远不出现 `lint:fix`（check 不修东西）；
 * - **薄包装（G6）**：四段分类复用 `parseVerifyReport`，摘要复用
 *   `extractErrorSummary`，本文件断言 check.ts 里没有第二套解析。
 */

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QaRunResult } from '../../src/agents/qa';
import {
  formatCheckReport,
  MAX_STAGE_OUTPUT_LINES,
  pickStageScripts,
  readPackageScripts,
  runCheck,
  runCheckCommand,
  stageOrderFromVerifyScript,
  truncateStageOutput,
} from '../../src/cli/check';
import { zh } from '../../src/i18n/zh';

// ── 样本与工具 ────────────────────────────────────────────────

/** 构造 verify 输出（npm 段标记 + 各段文本），与真实 `npm run verify` 形态一致。 */
function verifyOutput(segments: Array<[stage: string, body: string]>): {
  stdout: string;
  stderr: string;
} {
  return {
    stdout: segments.map(([stage, body]) => `> @concertoai/cli@5.0.0 ${stage}\n${body}`).join('\n'),
    stderr: '',
  };
}

/** 全绿的 verify 输出。 */
const VERIFY_PASS = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** lint 段失败（Biome）；build 通过，type/test 因 `&&` 短路未执行。 */
const VERIFY_LINT_FAIL = {
  stdout: [
    '> @concertoai/cli@5.0.0 build',
    'Build success.',
    '> @concertoai/cli@5.0.0 lint',
    'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━',
    '  × Unexpected any. Specify a different type.',
  ].join('\n'),
  stderr: '',
};

/** type 段失败（tsc 错误写在 stderr——真实行为）。 */
const VERIFY_TYPE_FAIL = {
  stdout: [
    '> @concertoai/cli@5.0.0 build',
    'Build success.',
    '> @concertoai/cli@5.0.0 lint',
    'All checks passed.',
    '> @concertoai/cli@5.0.0 typecheck',
    '> tsc --noEmit',
  ].join('\n'),
  stderr: "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'.\n",
};

/** 收集输出行。 */
function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

/** 记录被执行的脚本名（只读护栏 + 分项顺序都用它）。 */
function makeRunner(byScript: Record<string, Partial<QaRunResult>>, calls: string[] = []) {
  return async (script: string): Promise<QaRunResult> => {
    calls.push(script);
    const result: QaRunResult = {
      ok: true,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...byScript[script],
    };
    if (byScript[script] === undefined) {
      throw new Error(`测试未准备脚本 ${script} 的输出`);
    }
    return result;
  };
}

/** 固定 scripts 的读取器。 */
function scriptsOf(scripts: Record<string, string> | undefined) {
  return async (): Promise<Record<string, string> | undefined> => scripts;
}

/**
 * 去掉源码里的注释（只留代码），供「源码护栏」使用。
 *
 * 为什么需要：`check.ts` 的 JSDoc 里正常地写着「本模块**不调用** `lint:fix`」，
 * 直接对原文做子串检查会把这句**否认**当成**罪证**（假阳性）。护栏要看的是
 * 代码做了什么，不是注释说了什么。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ── 主路径 ────────────────────────────────────────────────────

describe('runCheck：verify 模式（v5.0 T15）', () => {
  it('全绿 → ok=true、四段全 pass、退出码 0、结论是「可以提交」', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({
        verify: 'npm run build && npm run lint && npm run typecheck && npm run test',
      }),
      runScript: makeRunner({ verify: { ok: true, ...VERIFY_PASS } }),
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.mode).toBe('verify');
    expect(result.stages.map((stage) => stage.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(result.failedStages).toEqual([]);
    expect(result.nextCommands).toEqual([]);
    expect(result.conclusion).toContain('可以提交');
    expect(result.conclusion).not.toContain('待修');
  });

  it('lint 段失败 → 归因到 lint；build 通过、type/test 标「未执行」（不冒充通过）', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({
        verify: 'npm run build && npm run lint && npm run typecheck && npm run test',
        'lint:fix': 'biome check --write src tests',
      }),
      runScript: makeRunner({ verify: { ok: false, ...VERIFY_LINT_FAIL } }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.failedStages).toEqual(['lint']);
    const byStage = new Map(result.stages.map((stage) => [stage.stage, stage]));
    expect(byStage.get('build')?.status).toBe('pass');
    expect(byStage.get('lint')?.status).toBe('fail');
    expect(byStage.get('lint')?.errorCount).toBe(1);
    expect(byStage.get('lint')?.summary).toContain('noExplicitAny');
    expect(byStage.get('type')?.status).toBe('skipped');
    expect(byStage.get('test')?.status).toBe('skipped');
    expect(result.conclusion).toContain('1 项待修');
    expect(result.conclusion).toContain('lint');
    // 段专属命令在前，闭环入口在后（两个都必须真实存在）
    expect(result.nextCommands).toEqual(['npm run lint:fix', 'concertoai self-heal']);
  });

  it('type 段失败（错误写在 stderr）→ 归因到 type，下一步指向 concertoai self-heal', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({
        verify: 'npm run build && npm run lint && npm run typecheck && npm run test',
      }),
      runScript: makeRunner({ verify: { ok: false, ...VERIFY_TYPE_FAIL } }),
    });
    expect(result.failedStages).toEqual(['type']);
    const typeStage = result.stages.find((stage) => stage.stage === 'type');
    expect(typeStage?.status).toBe('fail');
    expect(typeStage?.summary).toContain('TS2304');
    // 没有 lint:fix 脚本时绝不给这条命令（不打空头支票）
    expect(result.nextCommands).toEqual(['concertoai self-heal']);
  });

  it('退出码非 0 但解析不出任何错误 → 四段全「无法判定」，绝不报可以提交', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      runScript: makeRunner({
        verify: { ok: false, stdout: 'something exploded\nsecond line', stderr: '' },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stages.every((stage) => stage.status === 'unknown')).toBe(true);
    expect(result.conclusion).toContain('待修');
    expect(result.conclusion).not.toContain('可以提交');
  });

  it('verify 顺序来自脚本定义：verify 先跑 test 时，test 失败 → build 标「未执行」', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ verify: 'npm run test && npm run build' }),
      runScript: makeRunner({
        verify: {
          ok: false,
          stdout: [
            '> @concertoai/cli@5.0.0 test',
            'Test Files  1 failed (1)',
            '  FAIL src/foo.test.ts',
            '  ✗ 加法应该正确',
            'AssertionError: expected 1 to be 2',
          ].join('\n'),
          stderr: '',
        },
      }),
    });
    expect(result.stages.map((stage) => stage.stage)).toEqual(['test', 'build', 'lint', 'type']);
    const testStage = result.stages.find((stage) => stage.stage === 'test');
    expect(testStage?.status).toBe('fail');
    expect(result.stages.find((stage) => stage.stage === 'build')?.status).toBe('skipped');
    expect(result.failedStages).toContain('test');
  });
});

// ── 分项检测 / 无法体检 ───────────────────────────────────────

describe('runCheck：无 verify 脚本时（v5.0 T15）', () => {
  it('分项跑 build / lint / typecheck / test，退出码逐段判定，顺序固定', async () => {
    const calls: string[] = [];
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({
        build: 'tsup',
        lint: 'biome check src tests',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
      }),
      runScript: makeRunner(
        {
          build: { ok: true, stdout: 'Build success.' },
          lint: { ok: true, stdout: 'All checks passed.' },
          typecheck: { ok: true, stdout: '' },
          test: { ok: false, stdout: 'Test Files  1 failed (1)', stderr: '' },
        },
        calls,
      ),
    });
    expect(calls).toEqual(['build', 'lint', 'typecheck', 'test']);
    expect(result.mode).toBe('per-stage');
    expect(result.ok).toBe(false);
    expect(result.failedStages).toEqual(['test']);
    expect(result.stages.map((stage) => stage.status)).toEqual(['pass', 'pass', 'pass', 'fail']);
    expect(result.conclusion).toContain('1 项待修');
  });

  it('某段脚本缺失 → 标「未配置检测脚本」，不算通过也不算失败', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ lint: 'biome check src tests' }),
      runScript: makeRunner({ lint: { ok: true, stdout: 'All checks passed.' } }),
    });
    expect(result.mode).toBe('per-stage');
    expect(result.ok).toBe(true);
    const byStage = new Map(result.stages.map((stage) => [stage.stage, stage]));
    expect(byStage.get('lint')?.status).toBe('pass');
    expect(byStage.get('build')?.status).toBe('unavailable');
    expect(byStage.get('build')?.script).toBeNull();
    // 渲染时必须让用户看见「没检测」而不是空白
    const lines = formatCheckReport(result).join('\n');
    expect(lines).toContain(zh.check.stageNoScript);
  });

  it('没有 package.json → 如实说无法体检 + 退出 1（不静默成功）', async () => {
    const result = await runCheck({ cwd: '/empty', readScripts: scriptsOf(undefined) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.mode).toBe('none');
    expect(result.conclusion).toContain('package.json');
    expect(result.conclusion).not.toContain('可以提交');
    expect(result.conclusionHint).toContain('项目根目录');
  });

  it('有 package.json 但一个检测脚本都没有 → 明确「没做检测」，退出 1', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ dev: 'tsx src/index.ts' }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.mode).toBe('none');
    expect(result.conclusion).toContain('未找到任何检测脚本');
    expect(result.stages.every((stage) => stage.status === 'unavailable')).toBe(true);
  });
});

// ── 边缘路径（G5）─────────────────────────────────────────────

describe('runCheck：边缘路径（v5.0 T15）', () => {
  it('超时 → 判失败（不判通过），摘要说明超时', async () => {
    const result = await runCheck({
      cwd: '/proj',
      timeoutMs: 3000,
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      runScript: makeRunner({
        verify: { ok: false, stdout: '', stderr: '', timedOut: true },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.conclusion).toContain('超时');
    expect(result.nextCommands).toContain('concertoai self-heal');
  });

  it('命令根本跑不起来（抛错）→ 友好提示，不崩溃、不判通过', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      runScript: async () => {
        throw new Error('spawn npm ENOENT');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.conclusion).toContain('ENOENT');
    expect(result.stages.every((stage) => stage.status === 'unknown')).toBe(true);
  });

  it('用户 Ctrl+C 中断（子进程被杀：既没超时也没报错）→ 判不了、退出 1，不冒充通过', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      // 真实形态：进程被 Ctrl+C 杀掉 → ok=false、timedOut=false、stderr 只有 ^C
      runScript: makeRunner({ verify: { ok: false, stdout: '', stderr: '^C' } }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stages.every((stage) => stage.status === 'unknown')).toBe(true);
    expect(result.conclusion).not.toContain('可以提交');
    // 中断也必须给出可执行的下一步（而不是一屏原始输出就结束）
    expect(result.nextCommands).toContain('concertoai self-heal');
    expect(formatCheckReport(result).join('\n')).toContain(zh.check.stageUnknown);
  });

  it('超长输出被截断到每段 40 行（不淹没终端）', async () => {
    const noise = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`);
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      runScript: makeRunner({
        verify: { ok: false, stdout: noise.join('\n'), stderr: 'npm error boom' },
      }),
    });
    const lintStage = result.stages.find((stage) => stage.stage === 'lint');
    const truncated = lintStage?.output ?? [];
    expect(truncated.length).toBeLessThanOrEqual(MAX_STAGE_OUTPUT_LINES);
    expect(lintStage?.outputTruncated).toBe(true);
    expect(formatCheckReport(result).join('\n')).toContain(String(MAX_STAGE_OUTPUT_LINES));
  });

  it('truncateStageOutput：短输出不截断、空行丢弃、总行数保留', () => {
    expect(truncateStageOutput('a\n\n b \n')).toEqual({ lines: ['a', ' b '], total: 2 });
    const long = Array.from({ length: 60 }, (_, index) => `l${index}`).join('\n');
    const result = truncateStageOutput(long);
    expect(result.lines).toHaveLength(MAX_STAGE_OUTPUT_LINES);
    expect(result.total).toBe(60);
  });
});

// ── 只读与薄包装护栏 ─────────────────────────────────────────

describe('check 的两条红线（v5.0 T15）', () => {
  it('零写入：整个体检过程从不执行任何修复脚本', async () => {
    const calls: string[] = [];
    await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({
        verify: 'npm run build && npm run lint',
        'lint:fix': 'biome check --write src tests',
        'format:fix': 'biome format --write .',
      }),
      runScript: makeRunner({ verify: { ok: false, ...VERIFY_LINT_FAIL } }, calls),
    });
    expect(calls).toEqual(['verify']);
    expect(calls.some((script) => script.includes('fix'))).toBe(false);
  });

  it('薄包装（G6）：源码复用既有分类器与摘要器，没有第二套解析', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/cli/check.ts'), 'utf8');
    expect(source).toContain("from '../loop/self-heal'");
    expect(source).toContain('parseVerifyReport');
    expect(source).toContain("from '../utils/error-summary'");
    expect(source).toContain('extractErrorSummary');
    // 不得自带段标记 / tsc 错误行解析（第二套 verify 解析的典型特征）
    expect(source).not.toContain('STAGE_MARKER');
    expect(source).not.toContain('error TS');
    expect(source).not.toContain('lint/suspicious');
  });

  it('只读实现细节：不写盘、不建快照、不把修复脚本送进执行器', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/cli/check.ts'), 'utf8');
    const code = stripComments(source);

    // ① 写盘 / 快照 / 自带执行器全部不许出现（执行一律走注入的 runScript 或既有 QaRunner）
    for (const forbidden of [
      'writeFile',
      'appendFile',
      'SnapshotManager',
      'runLintFix',
      'spawn',
      'execSync',
      'execFile',
    ]) {
      expect(code.includes(forbidden), `check.ts 的代码里不应出现 ${forbidden}`).toBe(false);
    }

    // ② `lint:fix` 只许有两种身份：存在性探测 `scripts['lint:fix']`（读 package.json）
    //    与给用户看的建议命令 `'npm run lint:fix'`；
    //    ⚠️ 绝不许作为 runScript(...) 的实参被执行——那才是「体检时顺手改代码」
    const occurrences = [...code.matchAll(/lint:fix/g)];
    expect(occurrences.length).toBeGreaterThan(0); // 护栏必须真的在盯东西（否则是空护栏）
    for (const match of occurrences) {
      const around = code.slice(Math.max(0, match.index - 40), match.index + 20);
      const isLookup = /scripts\[\s*['"]lint:fix['"]\s*\]/.test(around);
      const isSuggestion = /['"]npm run lint:fix['"]/.test(around);
      expect(
        isLookup || isSuggestion,
        `lint:fix 出现了不该有的用法（既不是存在性探测也不是建议命令）：${around}`,
      ).toBe(true);
    }
  });

  it('零写入（真实落盘）：体检前后项目文件的内容与 mtime 一律不变', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'concertoai-check-ro-'));
    try {
      const pkgPath = path.join(cwd, 'package.json');
      const srcPath = path.join(cwd, 'index.ts');
      await writeFile(pkgPath, JSON.stringify({ scripts: { verify: 'npm run lint' } }), 'utf8');
      await writeFile(srcPath, 'export const a = 1;\n', 'utf8');
      // mtime 推回过去：任何写入 / 格式化都会改它（不依赖毫秒级精度，Windows 也稳）
      const past = new Date(Date.now() - 60_000);
      await utimes(pkgPath, past, past);
      await utimes(srcPath, past, past);

      const beforeMtime = [(await stat(pkgPath)).mtimeMs, (await stat(srcPath)).mtimeMs];
      const beforeContents = [await readFile(pkgPath, 'utf8'), await readFile(srcPath, 'utf8')];

      // 走真实读盘路径（不注入 readScripts），只把子进程执行换成假输出
      const result = await runCheck({
        cwd,
        runScript: makeRunner({ verify: { ok: false, ...VERIFY_LINT_FAIL } }),
      });
      expect(result.ok).toBe(false);

      const afterMtime = [(await stat(pkgPath)).mtimeMs, (await stat(srcPath)).mtimeMs];
      const afterContents = [await readFile(pkgPath, 'utf8'), await readFile(srcPath, 'utf8')];
      expect(afterMtime).toEqual(beforeMtime);
      expect(afterContents).toEqual(beforeContents);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

// ── 纯函数 ────────────────────────────────────────────────────

describe('check 纯函数（v5.0 T15）', () => {
  it('stageOrderFromVerifyScript 按脚本定义排序，缺失段补在末尾', () => {
    expect(
      stageOrderFromVerifyScript(
        'npm run build && npm run lint && npm run typecheck && npm run test',
      ),
    ).toEqual(['build', 'lint', 'type', 'test']);
    expect(stageOrderFromVerifyScript('npm run test && npm run build')).toEqual([
      'test',
      'build',
      'lint',
      'type',
    ]);
    // 非 npm run 形式（如直接 tsc）→ 退回规范顺序，不崩
    expect(stageOrderFromVerifyScript('tsc --noEmit')).toEqual(['build', 'lint', 'type', 'test']);
  });

  it('pickStageScripts 兼容 typecheck / type 两种写法', () => {
    expect(pickStageScripts({ type: 'tsc --noEmit' })).toEqual([{ stage: 'type', script: 'type' }]);
    expect(pickStageScripts({ typecheck: 'tsc --noEmit' })).toEqual([
      { stage: 'type', script: 'typecheck' },
    ]);
    expect(pickStageScripts({ dev: 'tsx src/index.ts' })).toEqual([]);
  });

  it('readPackageScripts：真实读盘 + 缺文件/坏 JSON 返回 undefined', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'concertoai-check-'));
    try {
      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify({ scripts: { lint: 'biome check', count: 1 } }),
        'utf8',
      );
      // 非字符串脚本值被忽略（不让坏数据进执行路径）
      expect(await readPackageScripts(cwd)).toEqual({ lint: 'biome check' });

      // package.json 里压根没有 scripts 字段 → 空表（不是 undefined：文件是好的，只是没脚本）
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
      expect(await readPackageScripts(cwd)).toEqual({});

      await writeFile(path.join(cwd, 'package.json'), '{ broken json', 'utf8');
      expect(await readPackageScripts(cwd)).toBeUndefined();

      await rm(path.join(cwd, 'package.json'));
      expect(await readPackageScripts(cwd)).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

// ── 命令入口 ──────────────────────────────────────────────────

describe('runCheckCommand（v5.0 T15）', () => {
  it('人类可读报告：标题 + 四段各一行 + 结论 + 下一步命令', async () => {
    const { lines, log } = collector();
    const code = await runCheckCommand({
      cwd: '/proj',
      log,
      readScripts: scriptsOf({
        verify: 'npm run build && npm run lint && npm run typecheck && npm run test',
        'lint:fix': 'biome check --write src tests',
      }),
      runScript: makeRunner({ verify: { ok: false, ...VERIFY_LINT_FAIL } }),
    });
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(lines[0]).toBe(zh.check.modeVerify);
    expect(text).toContain(zh.check.stageSkipped);
    expect(text).toContain(zh.check.nextTitle);
    expect(text).toContain('concertoai self-heal');
    // 每段最多一行 + 标题 + 结论 + 提示 + 命令，行数受控（不淹没终端）
    expect(lines.length).toBeLessThan(20);
  });

  it('--json 只输出可解析的 JSON（供后续自动化消费）', async () => {
    const { lines, log } = collector();
    const code = await runCheckCommand({
      cwd: '/proj',
      json: true,
      log,
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      runScript: makeRunner({ verify: { ok: true, ...VERIFY_PASS } }),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      mode: string;
      stages: unknown[];
      conclusion: string;
      code: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('verify');
    expect(parsed.stages).toHaveLength(4);
    expect(parsed.code).toBe(0);
    expect(parsed.conclusion).toContain('可以提交');
  });

  it('formatCheckReport：全绿时不含「下一步」，也不含任何待修字样', async () => {
    const result = await runCheck({
      cwd: '/proj',
      readScripts: scriptsOf({ verify: 'npm run verify' }),
      runScript: makeRunner({ verify: { ok: true, ...VERIFY_PASS } }),
    });
    const lines = formatCheckReport(result);
    const text = lines.join('\n');
    expect(text).toContain(zh.check.allPass.slice(0, 4));
    expect(text).not.toContain(zh.check.nextTitle);
    expect(text).not.toContain('待修');
  });

  it('命令注册护栏：`concertoai check --help` 里真的有这个命令（不打空头支票）', async () => {
    const { execFileSync } = await import('node:child_process');
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const root = await mkdtemp(path.join(os.tmpdir(), 'concertoai-check-home-'));
    try {
      const help = execFileSync(process.execPath, [tsxCli, 'src/cli/index.ts', 'check', '--help'], {
        encoding: 'utf8',
        timeout: 180_000,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CONCERTOAI_HINTS: 'off',
          // v5.0 T22：入口现在按 LUMEN_LOCALE > LANG 在 commander 解析前定语言，
          // 不钉死就会随开发机 shell 的语言漂移（断言的是中文描述），
          // 与 v3.3「漏隔离 LUMEN_LOCALE 导致 config.test.ts 假失败」同型。
          LUMEN_LOCALE: 'zh',
          HOME: root,
          USERPROFILE: root,
        },
      });
      expect(help).toContain('--json');
      expect(help).toContain(zh.cli.check.description);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 240_000);
});
