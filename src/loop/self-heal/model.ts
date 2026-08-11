/**
 * self-heal 模型修复计划生成（v3.2 M2 / T2.1 拆分，原 self-heal.ts T1.2 的模型部分）。
 *
 * 职责：为单个 type 简单错误调用模型生成 SEARCH/REPLACE 修复计划（不落盘）。
 * - 仅 type 简单错误（缺 import / 缺类型标注）允许模型介入，每次只修 1 个；
 * - 输出经 planEdit 校验唯一性（search 必须文件中唯一出现）；
 * - 独立模块（不依赖 repair / snapshot-guard），打破模块循环依赖。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { fmt, t } from '../../i18n';
import { planEdit } from '../../tools/edit';
import type { VerifyError } from './classifier';
import type { ModelFixPlan, ModelFixPlanInput, RepairVerifyOptions } from './types';

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

/** 计算 SEARCH/REPLACE 的变更行数（可读 diff 摘要；空串按 0 行处理）。 */
export function diffLineStat(search: string, replace: string): { added: number; removed: number } {
  const countLines = (s: string): number => (s === '' ? 0 : s.split('\n').length);
  return { added: countLines(replace), removed: countLines(search) };
}

/**
 * 未自动修错误的修复建议（结构化反馈，v3.4 T1.4 I1：文案走 i18n，en 下全英文）。
 * 返回当前 locale 的文案；调用方（repair / snapshot-guard）写入 feedback.suggestion 供报告展示。
 */
export function suggestionFor(error: VerifyError): string {
  const d = t().selfHeal;
  switch (error.stage) {
    case 'build':
      return d.feedbackBuildFailed;
    case 'test':
      return d.feedbackTestFailed;
    case 'type':
      return fmt(d.feedbackTypeError, { code: error.code ?? 'TS' });
    case 'lint':
      return d.feedbackFormatError;
    default:
      return d.feedbackUnknown;
  }
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
