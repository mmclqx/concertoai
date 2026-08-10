/**
 * AI 自我修复闭环（v3.1 M1）。
 *
 * 职责：把 `npm run verify` 输出解析为统一的 VerifyReport（四段：
 * build / lint / typecheck / test），供修复策略执行器（T1.2）决策。
 *
 * 设计：
 * - 复用 `src/agents/qa.ts` 的 `parseVerifyOutput` 解析 vitest（test）段；
 * - 新增 Biome（lint）段与 tsc（typecheck）段解析；
 * - build 段：tsup 失败标记（无法定位时 file/line 为空）；
 * - 四段均在一次 `npm run verify` 输出中解析（按 npm 段标记 `> @concertoai/cli@x.y.z <script>` 切分）；
 * - 解析是尽力而为：无法解析的段标记 `parseFailed` 而非崩溃。
 */

import { parseVerifyOutput } from '../agents/qa';

// ── 类型定义 ──────────────────────────────────────────────────

/** verify 四段。 */
export type VerifyStage = 'build' | 'lint' | 'type' | 'test';

/** 单个错误（尽力提取 file/line/code）。 */
export interface VerifyError {
  /** 所属阶段。 */
  stage: VerifyStage;
  /** 文件路径（尽力而为，无法定位时缺省）。 */
  file?: string;
  /** 行号（1-based，尽力而为）。 */
  line?: number;
  /** 错误码（如 TS2304 / lint/suspicious/noExplicitAny）。 */
  code?: string;
  /** 错误信息（原文或中文说明）。 */
  message: string;
}

/** 统一 verify 报告。 */
export interface VerifyReport {
  /** 是否全部通过（无任何段错误，且至少识别到一个段输出）。 */
  passed: boolean;
  /** 全部错误（按 build/lint/type/test 顺序聚合）。 */
  errors: VerifyError[];
  /** 各段是否解析失败（有输出但无法识别成功/失败形态）。 */
  parseFailed: Record<VerifyStage, boolean>;
  /** 中文摘要。 */
  summary: string;
}

/** 段解析结果（内部）。 */
interface StageParseResult {
  errors: VerifyError[];
  parseFailed: boolean;
}

// ── 段切分 ────────────────────────────────────────────────────

/** npm 段标记：`> @concertoai/cli@3.0.0 build`（verify 内嵌各脚本）。 */
const STAGE_MARKER_RE = /^>\s+@concertoai\/cli@[\d.]+\s+(build|lint|typecheck|test)\s*$/;

const ALL_STAGES: readonly VerifyStage[] = ['build', 'lint', 'type', 'test'];

// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 ANSI ESC 转义序列必须包含控制字符 \u001b
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** 剥离 ANSI 转义序列。 */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 按 npm 段标记切分合并输出为四段文本。
 * 标记行之前的内容（verify 头部）忽略；无标记时对应段为空字符串。
 * 入口统一剥离 ANSI（真实子进程输出可能含颜色码）。
 */
function splitStages(stdout: string, stderr: string): Record<VerifyStage, string> {
  const combined = `${stripAnsi(stdout)}\n${stripAnsi(stderr)}`;
  const segments: Record<VerifyStage, string> = { build: '', lint: '', type: '', test: '' };
  let current: VerifyStage | undefined;
  for (const line of combined.split('\n')) {
    const m = line.match(STAGE_MARKER_RE);
    const stage = m?.[1];
    if (stage === 'build' || stage === 'lint' || stage === 'typecheck' || stage === 'test') {
      // 段标记用 npm 脚本名（typecheck），内部统一为缩写 type
      current = stage === 'typecheck' ? 'type' : stage;
      segments[current] = '';
      continue;
    }
    if (current !== undefined) {
      segments[current] += `${line}\n`;
    }
  }
  return segments;
}

// ── lint 段解析（Biome）────────────────────────────────────────

/**
 * Biome 错误行（2.x）：`src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━`。
 * 文件路径允许含 Windows 盘符冒号（`F:\...\src\foo.ts`），`[^\s]+?` 非贪婪至 `.ts` 后缀。
 */
const BIOME_ERROR_RE =
  /([^\s]+?\.(?:ts|tsx|js|jsx|mts|cts)):(\d+):(\d+)\s+lint\/([A-Za-z0-9/_-]+)/g;

/** Biome 成功标记（无错误输出时）。 */
const BIOME_OK_RE = /(?:No fixes applied|All checks passed|Checked\s+\d+\s+files)/;

/** 错误行之后若干行内提取说明行（`× Unexpected ...` / `✗ ...`）。 */
const BIOME_DETAIL_RE = /^\s*(?:×|✗|✖|error\[)\s*(.+)$/;

/** 解析 Biome（lint）段。 */
function parseLintErrors(text: string): StageParseResult {
  const errors: VerifyError[] = [];
  if (text.trim() === '') {
    return { errors, parseFailed: false };
  }
  const re = new RegExp(BIOME_ERROR_RE.source, 'g');
  const lines = text.split('\n');
  for (const m of text.matchAll(re)) {
    const file = m[1];
    const line = m[2] !== undefined ? Number(m[2]) : undefined;
    const code = m[4] !== undefined ? `lint/${m[4]}` : undefined;
    // 说明行：错误行之后最近一个含 ×/✗/error[ 的行（最多向后找 5 行）
    const errorLineNumber = text.slice(0, m.index).split('\n').length - 1;
    let detail: string | undefined;
    for (let i = errorLineNumber + 1; i < Math.min(errorLineNumber + 6, lines.length); i += 1) {
      const dl = lines[i]?.match(BIOME_DETAIL_RE);
      if (dl?.[1] !== undefined) {
        detail = dl[1].trim();
        break;
      }
    }
    errors.push({
      stage: 'lint',
      file,
      line,
      code,
      message: detail !== undefined && detail !== '' ? detail : (code ?? 'Biome lint 错误'),
    });
  }
  const parseFailed = errors.length === 0 && !BIOME_OK_RE.test(text);
  return { errors, parseFailed };
}

// ── type 段解析（tsc）────────────────────────────────────────

/** tsc 标准格式：`src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.` */
const TSC_ERROR_RE = /([^\s]+?\.(?:ts|tsx|mts|cts))\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;

/** tsc pretty 格式：`src/foo.ts:1:5 - error TS2304: Cannot find name 'bar'.` */
const TSC_ERROR_PRETTY_RE =
  /([^\s]+?\.(?:ts|tsx|mts|cts)):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/gm;

/** 解析 tsc（typecheck）段。 */
function parseTypeErrors(text: string): StageParseResult {
  const errors: VerifyError[] = [];
  if (text.trim() === '') {
    return { errors, parseFailed: false };
  }
  const pushFrom = (re: RegExp): void => {
    for (const m of text.matchAll(re)) {
      const file = m[1];
      const line = m[2] !== undefined ? Number(m[2]) : undefined;
      const code = m[4];
      const message = m[5]?.trim() ?? code ?? 'tsc 类型错误';
      errors.push({ stage: 'type', file, line, code, message });
    }
  };
  pushFrom(new RegExp(TSC_ERROR_RE.source, 'gm'));
  pushFrom(new RegExp(TSC_ERROR_PRETTY_RE.source, 'gm'));
  // 有输出、未匹配到标准错误行、但文本含 tsc 错误特征（error TSxxxx）→ 尽力而为标记解析失败；
  // 否则（如仅脚本头 `> tsc --noEmit`）视为成功/跳过。
  const parseFailed = errors.length === 0 && /error\s+TS\d+/i.test(text);
  return { errors, parseFailed };
}

// ── build 段解析（tsup）───────────────────────────────────────

/** tsup 失败标记。 */
const BUILD_FAIL_RE = /(?:Build error|Build failed|error during build|RollupError|Error:)/i;

/** tsup 成功标记。 */
const BUILD_OK_RE = /(?:Build success)/;

/** 解析 tsup（build）段：失败标记 → 一条 build 错误（无法定位 file/line）。 */
function parseBuildErrors(text: string): StageParseResult {
  const errors: VerifyError[] = [];
  if (text.trim() === '') {
    return { errors, parseFailed: false };
  }
  if (BUILD_FAIL_RE.test(text) && !BUILD_OK_RE.test(text)) {
    // 提取首条含 Error 的行作为 message（尽力而为）
    const lines = text.split('\n');
    const errorLine = lines.find((l) =>
      /(?:Build error|Build failed|error during build|RollupError|Error:)/i.test(l),
    );
    errors.push({
      stage: 'build',
      message: (errorLine ?? 'build 失败（tsup 构建错误）').trim().slice(0, 500),
    });
    return { errors, parseFailed: false };
  }
  const parseFailed = !BUILD_OK_RE.test(text);
  return { errors, parseFailed };
}

// ── test 段解析（复用 qa.parseVerifyOutput）───────────────────

/** 解析 vitest（test）段：复用 `parseVerifyOutput` 的 FAIL 段提取。 */
function parseTestErrors(text: string): StageParseResult {
  const errors: VerifyError[] = [];
  if (text.trim() === '') {
    return { errors, parseFailed: false };
  }
  const qa = parseVerifyOutput(text, '', 0);
  for (const item of qa.failedItems) {
    errors.push({
      stage: 'test',
      file: item.file,
      code: 'TEST_FAIL',
      message: item.testName !== undefined ? `[${item.testName}] ${item.error}` : item.error,
    });
  }
  // 有输出但报告既非通过又无失败项 → 解析失败（尽力而为）
  const parseFailed = !qa.passed && qa.failedItems.length === 0;
  return { errors, parseFailed };
}

// ── 主入口 ────────────────────────────────────────────────────

/** 构造中文摘要。 */
function buildVerifySummary(
  passed: boolean,
  errors: VerifyError[],
  parseFailed: Record<VerifyStage, boolean>,
): string {
  const failedStages = ALL_STAGES.filter((s) => parseFailed[s] === true);
  if (passed) {
    return '✅ npm run verify 全部通过，无需修复';
  }
  const byStage = errors.length > 0 ? [...new Set(errors.map((e) => e.stage))].join('/') : '—';
  const parseNote =
    failedStages.length > 0 ? `（${failedStages.join('/')} 段解析失败，请人工查看原始输出）` : '';
  return `❌ npm run verify 失败：${errors.length} 个错误（${byStage}）${parseNote}`;
}

/**
 * 解析 `npm run verify` 输出为统一 VerifyReport。
 *
 * 四段均在一次输出中解析（按 npm 段标记切分）；test 段复用 qa.parseVerifyOutput。
 * 解析是尽力而为：某段有输出但无法识别成功/失败形态时标记 `parseFailed` 而非抛错。
 */
export function parseVerifyReport(stdout: string, stderr: string): VerifyReport {
  const segments = splitStages(stdout, stderr);
  const errors: VerifyError[] = [];
  const parseFailed: Record<VerifyStage, boolean> = {
    build: false,
    lint: false,
    type: false,
    test: false,
  };

  const build = parseBuildErrors(segments.build);
  errors.push(...build.errors);
  parseFailed.build = build.parseFailed;

  const lint = parseLintErrors(segments.lint);
  errors.push(...lint.errors);
  parseFailed.lint = lint.parseFailed;

  const type = parseTypeErrors(segments.type);
  errors.push(...type.errors);
  parseFailed.type = type.parseFailed;

  const test = parseTestErrors(segments.test);
  errors.push(...test.errors);
  parseFailed.test = test.parseFailed;

  const seenStage = ALL_STAGES.some((s) => segments[s].trim() !== '');
  const passed = seenStage && errors.length === 0;
  const summary = buildVerifySummary(passed, errors, parseFailed);
  return { passed, errors, parseFailed, summary };
}
