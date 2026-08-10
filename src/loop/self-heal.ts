/**
 * AI 自我修复闭环（v3.1 M1）。
 *
 * 职责：
 * - Verify 分类器（T1.1）：把 `npm run verify` 输出解析为统一的 VerifyReport
 *   （四段：build / lint / typecheck / test），供修复策略执行器决策；
 * - 修复策略执行器（T1.2）：按错误分类执行确定性修复——
 *   lint → `npm run lint:fix`（白名单免审批）；type 简单错误 → 模型生成修复（走审批）；
 *   build/test/type 复杂错误 → 结构化反馈不自动修。
 * - 快照与回滚（T1.3）：模型修复落盘前用 `SnapshotManager` 登记快照（begin + recordWrite），
 *   修复后强制 verify + diff 审查（变更文件 + 变更行数）；目标错误未消失或引入新错误 →
 *   rollback 恢复原状；修复有效 → commit 清理快照；回滚失败（外部修改）→ 报错保留快照。
 * - 触发入口（T1.4）：`runSelfHeal` 主流程（执行 verify → 失败走 M1 闭环）供两入口共用——
 *   chat 内 `/self-heal` 斜杠命令（App.tsx 拦截）与 `concertoai self-heal` CLI（非交互）。
 *
 * 设计（分类器）：
 * - 复用 `src/agents/qa.ts` 的 `parseVerifyOutput` 解析 vitest（test）段；
 * - 新增 Biome（lint）段与 tsc（typecheck）段解析；
 * - build 段：tsup 失败标记（无法定位时 file/line 为空）；
 * - 四段均在一次 `npm run verify` 输出中解析（按 npm 段标记 `> @concertoai/cli@x.y.z <script>` 切分）；
 * - 解析是尽力而为：无法解析的段标记 `parseFailed` 而非崩溃。
 *
 * 设计（修复执行器）：
 * - 确定性优先：lint 格式错误机械修复（lint:fix），不调用模型；
 * - 仅 type 简单错误（缺 import / 缺类型标注）允许模型介入，且必须走审批 + 每次只修 1 个；
 * - 修复次数上限 `MAX_SELF_HEAL_ATTEMPTS = 2`，超限保留详细报告转人工。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ChildProcessQaRunner, DEFAULT_VERIFY_TIMEOUT_MS, parseVerifyOutput } from '../agents/qa';
import type { ModelClient } from '../model/client';
import { SnapshotManager } from '../orchestrator/transaction';
import { planEdit } from '../tools/edit';
import type { ApprovalRequest } from '../tools/registry';
import { shellTool } from '../tools/shell';

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

/** npm 段标记：`> @concertoai/cli@3.1.0 build`（verify 内嵌各脚本）。 */
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

// ══════════════════════════════════════════════════════════════
// T1.2 修复策略执行器
// ══════════════════════════════════════════════════════════════

/** 变更行数统计（SEARCH/REPLACE 行数近似 diff stat）。 */
export interface DiffLineStat {
  /** 新增行数。 */
  added: number;
  /** 删除行数。 */
  removed: number;
}

/** 计算 SEARCH/REPLACE 的变更行数（可读 diff 摘要；空串按 0 行处理）。 */
export function diffLineStat(search: string, replace: string): DiffLineStat {
  const countLines = (s: string): number => (s === '' ? 0 : s.split('\n').length);
  return { added: countLines(replace), removed: countLines(search) };
}

/** 错误指纹：`file:code`（忽略行号——修复后行号会漂移，仅凭 file+code 判定错误是否新增/消失）。 */
function errorFingerprint(error: VerifyError): string {
  return `${error.file ?? '<unknown>'}:${error.code ?? error.message}`;
}

/** 自我修复最大尝试次数（超限转人工）。 */
export const MAX_SELF_HEAL_ATTEMPTS = 2;

/** 每次模型修复仅修 1 个错误（避免连锁引入新错误）。 */
export const MAX_MODEL_FIXES_PER_ATTEMPT = 1;

/** 简单类型错误特征（缺 import）：`Cannot find name` / `Cannot find module`。 */
const SIMPLE_TYPE_MISSING_IMPORT_RE = /Cannot find (?:name|module)/;
/** 简单类型错误特征（缺类型标注）：`implicitly has an 'any' type` / `Property 'x' has no initializer...`（容忍属性名）。 */
const SIMPLE_TYPE_MISSING_ANNOTATION_RE =
  /implicitly has an 'any' type|Property .* has no initializer/;

/**
 * 判断是否为「简单类型错误」（可交给模型生成修复）。
 * 缺 import / 缺类型标注 属简单；类型不兼容（TS2322 等）属复杂，不自动修。
 */
export function isSimpleTypeError(error: VerifyError): boolean {
  const message = error.message;
  return (
    error.stage === 'type' &&
    (SIMPLE_TYPE_MISSING_IMPORT_RE.test(message) || SIMPLE_TYPE_MISSING_ANNOTATION_RE.test(message))
  );
}

/** 模型生成的修复方案（search/replace 唯一匹配，经 planEdit 校验）。 */
export interface ModelFixPlan {
  /** 相对 cwd 的文件路径。 */
  file: string;
  /** 唯一匹配块（SEARCH）。 */
  search: string;
  /** 替换内容（REPLACE）。 */
  replace: string;
  /** 统一 diff（供审批框展示）。 */
  diff: string;
  /** 修复后的完整内容。 */
  newContent: string;
}

/** 模型修复输出 schema（JSON：file / search / replace）。 */
const modelFixSchema = z.object({
  file: z.string().min(1),
  search: z.string(),
  replace: z.string(),
});

/** 模型修复系统提示：只输出一个 SEARCH/REPLACE 修复，严禁多修。 */
const MODEL_FIX_SYSTEM_PROMPT = [
  '你是 TypeScript 修复专家。针对给定的「文件 + 单条类型错误」，生成最小 SEARCH/REPLACE 修复。',
  '输出严格为 JSON（不要 markdown 围栏，不要其他文字），格式：',
  '{"file":"相对路径","search":"文件中唯一出现的原片段","replace":"替换后的新片段"}',
  '要求：',
  '- 只修复这一个错误；search 必须在文件中唯一出现（用足够上下文保证唯一）；',
  '- 不改变无关代码；不新增多余 import（除非错误明确是缺 import）；',
  '- search/replace 保持原文件换行风格。',
].join('\n');

/** 解析模型修复输出（容忍 ```json 围栏与前后空白；结构不合法抛中文错误）。 */
export function parseModelFixOutput(text: string): ModelFixPlanInput {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `模型修复输出不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  const result = modelFixSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`模型修复输出结构不符合协议（${issues}）。原文: ${trimmed.slice(0, 200)}`);
  }
  return result.data;
}

/** 模型修复输出（解析后的 file/search/replace）。 */
interface ModelFixPlanInput {
  file: string;
  search: string;
  replace: string;
}

/**
 * 调用模型为单个 type 简单错误生成修复计划（不落盘）。
 * 读取错误文件 → 组装 prompt → 模型输出 JSON → planEdit 校验唯一性 → 返回计划。
 * 模型调用/解析失败返回 undefined（不中断整体修复流程）。
 */
export async function generateModelFixPlan(
  error: VerifyError,
  options: RepairVerifyOptions,
): Promise<ModelFixPlan | undefined> {
  const client = options.client;
  if (client === undefined || options.model === undefined || error.file === undefined) {
    return undefined;
  }
  const absolute = path.resolve(options.cwd, error.file);
  let content: string;
  try {
    content = await fs.readFile(absolute, 'utf8');
  } catch {
    return undefined;
  }
  const location = error.line !== undefined ? `${error.file}:${error.line}` : error.file;
  const userPrompt = [
    `文件: ${error.file}`,
    `错误位置: ${location}`,
    `错误码: ${error.code ?? 'TS'}`,
    `错误信息: ${error.message}`,
    '',
    '===== 文件内容 =====',
    content.slice(0, 20_000),
  ].join('\n');

  const parts: string[] = [];
  try {
    for await (const chunk of client.streamChat({
      model: options.model,
      messages: [
        { role: 'system', content: MODEL_FIX_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    })) {
      for (const choice of chunk.choices) {
        const text = choice.delta.content ?? '';
        if (text !== '') {
          parts.push(text);
        }
      }
    }
  } catch {
    return undefined;
  }

  let input: ModelFixPlanInput;
  try {
    input = parseModelFixOutput(parts.join(''));
  } catch {
    return undefined;
  }
  // 路径规范化：模型可能输出反斜杠（Windows），统一转正斜杠并相对 cwd
  const normalizedFile = input.file.replace(/\\/g, '/');
  try {
    const plan = planEdit(content, input.search, input.replace);
    return {
      file: normalizedFile,
      search: input.search,
      replace: input.replace,
      diff: plan.diff,
      newContent: plan.newContent,
    };
  } catch {
    return undefined;
  }
}

/** 单个错误的修复动作（lint 直修 / 模型修复 / 跳过）。 */
export type SelfHealAction = 'lint-fix' | 'model-fix' | 'none';

/** 单次尝试结果。 */
export interface SelfHealAttempt {
  /** 尝试序号（1-based）。 */
  attempt: number;
  /** 本次执行的修复动作。 */
  action: SelfHealAction;
  /** 本次修复后的 verify 报告。 */
  report: VerifyReport;
  /** 模型修复应用的文件 diff（action=model-fix 时非空）。 */
  appliedFixes: Array<{ file: string; diff: string }>;
  /** 结构化反馈（未自动修的错误：code + suggestion）。 */
  feedback: Array<{ code?: string; suggestion: string }>;
  /** 模型修复是否被回滚（T1.3：修复后 verify 失败或引入新错误 → rollback 恢复原状）。 */
  rolledBack?: boolean;
  /** 回滚原因 / 回滚失败详情（rolledBack=true 或回滚失败时）。 */
  rollbackReason?: string;
}

/** 修复执行器选项。 */
export interface RepairVerifyOptions {
  /** 工作目录（沙箱根）。 */
  cwd: string;
  /** 执行 verify（返回原始输出；测试注入 fake）。 */
  runVerify: () => Promise<{ stdout: string; stderr: string }>;
  /** 执行 `npm run lint:fix`（返回是否成功；生产走 shell 白名单免审批，测试注入 fake）。 */
  runLintFix: () => Promise<{ ok: boolean }>;
  /** 模型客户端（type 简单错误修复；未提供则跳过模型修复）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
  /** 审批回调（模型修复前逐项确认，fail-closed；缺省拒绝）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 快照管理器（T1.3）：模型修复落盘前登记快照，失败/引入新错误自动回滚；缺省不启用快照保护。 */
  snapshots?: SnapshotManager;
  /** 快照 taskId 前缀（默认 `self-heal`，快照目录 `.concertoai/snapshots/<prefix>-<ts>/`）。 */
  snapshotPrefix?: string;
  /** 日志输出。 */
  log?: (message: string) => void;
}

/** 修复执行结果。 */
export interface RepairVerifyResult {
  /** 最终是否全部通过。 */
  passed: boolean;
  /** 最终 verify 报告。 */
  report: VerifyReport;
  /** 每次尝试记录。 */
  attempts: SelfHealAttempt[];
  /** 是否超限转人工（失败且尝试次数达到上限）。 */
  exceeded: boolean;
}

/** 解析 verify 输出（生产：跑真实 npm run verify → parseVerifyReport）。 */
export async function runVerifyAndParse(options: RepairVerifyOptions): Promise<VerifyReport> {
  const { stdout, stderr } = await options.runVerify();
  return parseVerifyReport(stdout, stderr);
}

/** 未自动修错误的修复建议（中文，结构化反馈）。 */
export function suggestionFor(error: VerifyError): string {
  switch (error.stage) {
    case 'build':
      return '构建失败：请检查 tsup.config.ts 入口、缺失依赖或导出语法';
    case 'test':
      return '测试失败：请检查测试断言或被测试模块实现（self-heal 不自动修测试）';
    case 'type':
      return `类型错误（${error.code ?? 'TS'}）：请手动补全类型标注或调整类型（self-heal 仅自动修缺 import / 缺标注）`;
    case 'lint':
      return '格式错误：请运行 npm run lint:fix 自动修复';
    default:
      return '未知错误：请人工检查';
  }
}

/**
 * 修复策略执行器主流程。
 *
 * 每轮：
 * 1. lint 错误 → 确定性执行 lint:fix（免审批）→ 重新 verify；
 * 2. 首个 type 简单错误 → 模型生成修复 → 审批（fail-closed）→ 应用 → 重新 verify；
 * 3. 剩余（type 复杂 / build / test）→ 结构化反馈，不自动修。
 *
 * 尝试次数上限 MAX_SELF_HEAL_ATTEMPTS = 2，超限保留详细报告转人工。
 * 每次模型修复仅修 1 个错误。
 */
export async function repairVerifyReport(
  initial: VerifyReport,
  options: RepairVerifyOptions,
): Promise<RepairVerifyResult> {
  const log = options.log ?? (() => {});
  const attempts: SelfHealAttempt[] = [];
  let report = initial;

  for (let attempt = 1; attempt <= MAX_SELF_HEAL_ATTEMPTS; attempt += 1) {
    if (report.passed) {
      break;
    }

    // 1) lint 错误 → 确定性 lint:fix
    const lintErrors = report.errors.filter((e) => e.stage === 'lint');
    if (lintErrors.length > 0) {
      log(
        `[self-heal] 第 ${attempt} 次尝试：执行 npm run lint:fix（${lintErrors.length} 个 lint 错误）`,
      );
      const fix = await options.runLintFix();
      const fresh = await runVerifyAndParse(options);
      attempts.push({
        attempt,
        action: 'lint-fix',
        report: fresh,
        appliedFixes: [],
        feedback: [],
      });
      report = fresh;
      if (!fix.ok) {
        log('[self-heal] lint:fix 执行失败，转人工');
        break;
      }
      continue;
    }

    // 2) 首个 type 简单错误 → 模型生成修复（每次 1 个）
    const simpleType = report.errors.find((e) => isSimpleTypeError(e));
    if (simpleType !== undefined) {
      log(
        `[self-heal] 第 ${attempt} 次尝试：模型修复类型错误 ${simpleType.code ?? 'TS'} @ ${simpleType.file ?? '?'}:${simpleType.line ?? '?'}`,
      );
      const plan = await generateModelFixPlan(simpleType, options);
      if (plan === undefined) {
        log('[self-heal] 模型无法生成修复计划，跳过该错误');
        attempts.push({
          attempt,
          action: 'none',
          report,
          appliedFixes: [],
          feedback: [{ code: simpleType.code, suggestion: suggestionFor(simpleType) }],
        });
        break;
      }
      const approved =
        (await options.requestApproval?.({
          kind: 'edit',
          summary: `self-heal 修复类型错误: ${simpleType.code ?? 'TS'} @ ${plan.file}:${simpleType.line ?? '?'}`,
          detail: plan.diff,
        })) ?? false;
      if (!approved) {
        log('[self-heal] 用户拒绝模型修复，跳过该错误');
        attempts.push({
          attempt,
          action: 'none',
          report,
          appliedFixes: [],
          feedback: [{ code: simpleType.code, suggestion: '用户拒绝了自动修复，请手动处理' }],
        });
        // fail-closed：审批拒绝后停止所有模型修复（不再尝试其他 type 错误），
        // 保留完整报告转人工——避免用户已表达不信任后继续自动改码。
        break;
      }
      // 审批通过 → 落盘（T1.3：落盘前登记快照，修复失败/引入新错误自动回滚）
      const absolute = path.resolve(options.cwd, plan.file);
      // taskId 加随机后缀：连续两轮修复可能落在同一毫秒，避免快照目录冲突
      const taskId = `${options.snapshotPrefix ?? 'self-heal'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const snapshots = options.snapshots;
      let txStarted = false;
      if (snapshots !== undefined) {
        try {
          await snapshots.begin(taskId, [plan.file]);
          await snapshots.recordWrite(taskId, plan.file, plan.newContent);
          txStarted = true;
        } catch (err) {
          // 快照登记失败 → 放弃回滚保护，与 T1.2 行为一致继续写盘
          await snapshots.commit(taskId).catch(() => {});
          log(
            `[self-heal] 快照登记失败，跳过回滚保护: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // 修复前错误指纹（回滚判定基准：目标错误是否消失 / 是否引入新错误）
      const beforeFingerprints = new Set(report.errors.map(errorFingerprint));
      try {
        await fs.writeFile(absolute, plan.newContent, 'utf8');
      } catch (err) {
        log(`[self-heal] 写盘失败: ${err instanceof Error ? err.message : String(err)}`);
        if (txStarted && snapshots !== undefined) {
          const rb = await snapshots.rollback(taskId);
          log(
            `[self-heal] 写盘失败，快照${rb.ok ? '已回滚清理' : `回滚失败（${rb.failed.map((f) => f.error).join('; ')}，快照保留）`}`,
          );
          attempts.push({
            attempt,
            action: 'none',
            report,
            appliedFixes: [],
            feedback: [{ code: simpleType.code, suggestion: '修复写盘失败，已回滚，请手动处理' }],
            rolledBack: true,
            rollbackReason: `写盘失败${rb.ok ? '' : `（回滚失败: ${rb.failed.map((f) => f.error).join('; ')}）`}`,
          });
        } else {
          attempts.push({
            attempt,
            action: 'none',
            report,
            appliedFixes: [],
            feedback: [{ code: simpleType.code, suggestion: '修复写盘失败，请手动处理' }],
          });
        }
        break;
      }
      const fresh = await runVerifyAndParse(options);
      // diff 审查：变更文件 + 每文件变更行数（可读摘要）
      const stat = diffLineStat(plan.search, plan.replace);
      log(`[self-heal] diff 审查: ${plan.file}（+${stat.added} -${stat.removed}）`);
      // 回滚判定：目标类型错误未消失（修复无效）或引入了新错误 → rollback 恢复原状
      const targetGone = !fresh.errors.some(
        (e) => errorFingerprint(e) === errorFingerprint(simpleType),
      );
      const newErrors = fresh.errors.filter((e) => !beforeFingerprints.has(errorFingerprint(e)));
      const regressed = !targetGone || newErrors.length > 0;
      let rolledBack = false;
      let rollbackReason: string | undefined;
      if (regressed) {
        const reason = !targetGone
          ? `目标类型错误 ${simpleType.code ?? 'TS'} 未修复`
          : `引入新错误: ${newErrors
              .map((e) => e.code ?? e.message)
              .slice(0, 3)
              .join(', ')}`;
        if (txStarted && snapshots !== undefined) {
          const rb = await snapshots.rollback(taskId);
          rolledBack = rb.ok;
          rollbackReason = rb.ok
            ? reason
            : `${reason}；回滚失败（${rb.failed.map((f) => f.error).join('; ')}），快照保留待人工检查`;
          log(`[self-heal] 修复${rb.ok ? '已回滚' : '回滚失败，快照保留'}: ${reason}`);
        } else {
          rollbackReason = `${reason}（未启用快照，未回滚）`;
          log(`[self-heal] 修复疑似无效: ${reason}（无快照，请人工检查 ${plan.file}）`);
        }
      } else {
        if (txStarted && snapshots !== undefined) {
          await snapshots.commit(taskId);
        }
        log(`[self-heal] 修复有效，已${txStarted ? '提交快照' : '保留变更'}`);
      }
      attempts.push({
        attempt,
        action: 'model-fix',
        report: fresh,
        appliedFixes: [{ file: plan.file, diff: plan.diff }],
        feedback: [],
        // 回滚成功 → rolledBack=true；回滚失败/未启用快照 → 仅保留 rollbackReason（含失败详情）
        ...(rolledBack ? { rolledBack: true } : {}),
        ...(rollbackReason !== undefined ? { rollbackReason } : {}),
      });
      // 回滚成功 → 磁盘已恢复原状，report 维持修复前（下一轮重新处理）；否则磁盘为修复后状态
      report = rolledBack ? report : fresh;
      continue;
    }

    // 3) 剩余（type 复杂 / build / test）→ 结构化反馈，不自动修
    const feedback = report.errors.map((e) => ({
      code: e.code,
      suggestion: suggestionFor(e),
    }));
    attempts.push({ attempt, action: 'none', report, appliedFixes: [], feedback });
    log('[self-heal] 剩余错误不可自动修复，转人工');
    break;
  }

  const exceeded = !report.passed && attempts.length >= MAX_SELF_HEAL_ATTEMPTS;
  return { passed: report.passed, report, attempts, exceeded };
}

// ══════════════════════════════════════════════════════════════
// 生产辅助：真实执行 npm run verify / npm run lint:fix
// ══════════════════════════════════════════════════════════════

/**
 * 生产 verify 执行器：spawn `npm run verify`（复用 ChildProcessQaRunner），
 * 返回原始输出供 parseVerifyReport 解析。
 */
export async function runVerifyCommand(
  cwd: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  const runner = new ChildProcessQaRunner({ cwd });
  const result = await runner.run(timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * 生产 lint:fix 执行器：走 shell 工具 + 白名单 `npm run lint:fix` 免审批直跑。
 * 返回是否成功（退出码 0）。
 */
export async function runLintFixCommand(cwd: string): Promise<{ ok: boolean }> {
  const result = await shellTool.execute(
    { command: 'npm run lint:fix' },
    { cwd, allowlistedPrefixes: ['npm run lint:fix'] },
  );
  return { ok: result.ok };
}

// ══════════════════════════════════════════════════════════════
// T1.4 触发入口：runSelfHeal 主流程（/self-heal 与 CLI 共用）
// ══════════════════════════════════════════════════════════════

/** runSelfHeal 选项。 */
export interface RunSelfHealOptions {
  /** 工作目录（沙箱根）。 */
  cwd: string;
  /** 模型客户端（type 简单错误修复；未提供则仅 lint 直修 + 结构化反馈）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
  /** 审批回调（模型修复前逐项确认，fail-closed；缺省拒绝）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 日志输出。 */
  log?: (message: string) => void;
  /** 测试注入：执行 verify（缺省跑真实 `npm run verify`）。 */
  runVerify?: () => Promise<{ stdout: string; stderr: string }>;
  /** 测试注入：执行 lint:fix（缺省走 shell 白名单 `npm run lint:fix`）。 */
  runLintFix?: () => Promise<{ ok: boolean }>;
}

/**
 * 触发入口主流程（T1.4）：执行 `npm run verify` → 通过则直接返回；
 * 失败则自动走 M1 闭环（分类 → 修复 → 验证 → 回滚），全程启用快照保护。
 *
 * 供两入口共用：
 * - chat 内 `/self-heal` 斜杠命令（App.tsx 拦截 → executeSelfHealCommand）；
 * - `concertoai self-heal` CLI（非交互，src/cli/self-heal.ts）。
 */
export async function runSelfHeal(options: RunSelfHealOptions): Promise<RepairVerifyResult> {
  const log = options.log ?? (() => {});
  // 测试注入优先；缺省走生产实现（spawn npm run verify / shell 白名单 lint:fix）
  const runVerify =
    options.runVerify ??
    ((): Promise<{ stdout: string; stderr: string }> => runVerifyCommand(options.cwd));
  const runLintFix =
    options.runLintFix ?? ((): Promise<{ ok: boolean }> => runLintFixCommand(options.cwd));

  log('[self-heal] 执行 npm run verify …');
  const initial = await runVerifyAndParse({ cwd: options.cwd, runVerify, runLintFix, log });
  if (initial.passed) {
    log(initial.summary);
    return { passed: true, report: initial, attempts: [], exceeded: false };
  }

  log(`[self-heal] ${initial.summary}`);
  const snapshots = new SnapshotManager(options.cwd);
  const result = await repairVerifyReport(initial, {
    cwd: options.cwd,
    runVerify,
    runLintFix,
    client: options.client,
    model: options.model,
    requestApproval: options.requestApproval,
    snapshots,
    log,
  });
  return result;
}
