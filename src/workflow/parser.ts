/**
 * 工作流 YAML 解析 / 序列化 + zod schema 校验 + 依赖推断（v4.0 M2 T2.2/T2.4/T2.5）。
 *
 * - parseWorkflowYaml：轻量 YAML 子集解析（专为工作流 schema 设计，不引入 yaml 依赖）；
 * - serializeWorkflowYaml：Workflow → YAML 文本（`workflow export` 输出）；
 * - inferDependencies：命令语义启发式推断依赖边（test→build、publish→build 等），
 *   结果**提示用户确认**，不静默写入（T2.4）。
 */

import { z } from 'zod';

import type { InferredDependency, Workflow, WorkflowStep } from './types';

// ── zod schema（T2.2 校验）──────────────────────────────────

const stepSchema = z.object({
  name: z.string().min(1, '步骤名不能为空'),
  run: z.string().min(1, 'run 命令不能为空'),
  depends: z.array(z.string().min(1)).optional(),
  retry: z.number().int().min(0).max(10).optional(),
  require: z.enum(['none', 'approval']).optional(),
  files: z.array(z.string().min(1)).optional(),
  description: z.string().optional(),
});

const workflowSchema = z.object({
  name: z
    .string()
    .min(1, '工作流名不能为空')
    .regex(/^[a-zA-Z0-9_-]+$/, '工作流名仅允许字母/数字/下划线/连字符'),
  description: z.string().optional(),
  steps: z.array(stepSchema).min(1, '至少需要一个步骤'),
  version: z.number().int().min(1).optional(),
});

// ── YAML 子集解析 ───────────────────────────────────────────

interface Line {
  /** 行号（1 基，报错用）。 */
  lineNo: number;
  /** 缩进空格数。 */
  indent: number;
  /** 去除缩进与注释后的内容（可能为空串）。 */
  content: string;
}

/** 解析行：计算缩进 + 剥离行尾注释（# 前必须有空白，避免 URL 中的 # 被误删）。 */
function analyzeLine(raw: string, lineNo: number): Line {
  const indentMatch = raw.match(/^[ \t]*/);
  const indent = indentMatch?.[0]?.replace(/\t/g, '  ').length ?? 0;
  const rest = raw.slice(indentMatch?.[0]?.length ?? 0);
  // 行尾注释：仅当 # 前有空白且不在引号内（简化：剥离前先保护引号串）
  const noComment = stripComment(rest);
  return { lineNo, indent, content: noComment.trim() };
}

/** 剥离行尾注释：追踪引号状态，仅剥离引号外的 #（前导空白）注释。 */
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1] ?? ''))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** 解析 `key: value`；无冒号返回 null；有冒号但无值返回 { key, value: undefined }。 */
function splitKeyValue(content: string): { key: string; value: string | undefined } | null {
  const colon = content.indexOf(':');
  if (colon === -1) {
    return null;
  }
  const key = content.slice(0, colon).trim();
  const rawValue = content.slice(colon + 1).trim();
  if (key === '') {
    return null;
  }
  return { key, value: rawValue === '' ? undefined : rawValue };
}

/** 解析标量：去引号（双引号还原 `\"` 转义）；数字转 number；布尔转 boolean；其余原样。 */
function parseScalar(raw: string): string | number | boolean {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    // YAML 双引号字符串：\" → "（与序列化 quoteIfNeeded 的转义对称）
    value = value.slice(1, -1).replace(/\\"/g, '"');
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** 解析工作流 YAML（轻量子集）。非法结构抛错（含行号），供 T2.2 降级人工。 */
export function parseWorkflowYaml(text: string): Workflow {
  const lines = text
    .split(/\r?\n/)
    .map(analyzeLine)
    .filter((l) => l.content !== '');
  if (lines.length === 0) {
    throw new Error('工作流 YAML 为空');
  }

  let pos = 0;
  const top: { name?: string; description?: string; version?: number; steps?: unknown[] } = {};

  while (pos < lines.length) {
    const line = lines[pos];
    if (line === undefined) {
      break;
    }
    if (line.indent !== 0) {
      throw new Error(`第 ${line.lineNo} 行：顶层键不允许缩进`);
    }
    const kv = splitKeyValue(line.content);
    if (kv === null) {
      throw new Error(`第 ${line.lineNo} 行：无法解析的顶层键值对`);
    }
    if (kv.key === 'steps') {
      const parsed = parseSteps(lines, pos + 1, line.indent + 2);
      top.steps = parsed.steps;
      pos = parsed.nextPos;
      continue;
    }
    if (kv.value === undefined) {
      throw new Error(`第 ${line.lineNo} 行：顶层键 ${kv.key} 缺少值`);
    }
    if (kv.key === 'name' || kv.key === 'description') {
      const scalar = parseScalar(kv.value);
      top[kv.key] = typeof scalar === 'string' ? scalar : String(scalar);
    } else if (kv.key === 'version') {
      const scalar = parseScalar(kv.value);
      if (typeof scalar !== 'number') {
        throw new Error(`第 ${line.lineNo} 行：version 必须为数字`);
      }
      top.version = scalar;
    } else {
      throw new Error(`第 ${line.lineNo} 行：未知顶层键 ${kv.key}`);
    }
    pos += 1;
  }

  if (top.steps === undefined) {
    throw new Error('工作流缺少 steps 列表');
  }

  const parsed = workflowSchema.safeParse(top);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`工作流校验失败（${detail}）`);
  }
  return parsed.data as Workflow;
}

/** 解析 steps 列表（`- name: x` 起始，后续缩进行为字段）。 */
function parseSteps(
  lines: Line[],
  start: number,
  itemIndent: number,
): { steps: unknown[]; nextPos: number } {
  const steps: unknown[] = [];
  let pos = start;
  while (pos < lines.length) {
    const line = lines[pos];
    if (line === undefined) {
      break;
    }
    if (line.indent < itemIndent) {
      break; // 回到顶层
    }
    if (line.indent !== itemIndent || !line.content.startsWith('- ')) {
      throw new Error(`第 ${line.lineNo} 行：steps 列表项必须以 "- " 开头且缩进一致`);
    }
    const first = line.content.slice(2).trim();
    const firstKv = splitKeyValue(first);
    if (firstKv === null || firstKv.key !== 'name') {
      throw new Error(`第 ${line.lineNo} 行：步骤列表项必须以 "- name: <名称>" 开头`);
    }
    const step: Record<string, unknown> = { name: String(parseScalar(firstKv.value ?? '')) };
    pos += 1;
    // 读取该步骤的字段（缩进 > itemIndent）
    const fieldIndent = itemIndent + 2;
    while (pos < lines.length) {
      const fieldLine = lines[pos];
      if (fieldLine === undefined) {
        break;
      }
      if (fieldLine.indent < fieldIndent) {
        break; // 下一个步骤或顶层
      }
      if (fieldLine.indent !== fieldIndent) {
        throw new Error(`第 ${fieldLine.lineNo} 行：步骤字段缩进不一致`);
      }
      const kv = splitKeyValue(fieldLine.content);
      if (kv === null) {
        throw new Error(`第 ${fieldLine.lineNo} 行：无法解析的步骤字段`);
      }
      if (kv.key === 'depends' || kv.key === 'files') {
        if (kv.value !== undefined) {
          throw new Error(`第 ${fieldLine.lineNo} 行：${kv.key} 必须是列表（下一行以 "- " 开头）`);
        }
        const list = parseList(lines, pos + 1, fieldIndent + 2);
        step[kv.key] = list.items;
        pos = list.nextPos;
        continue;
      }
      if (kv.value === undefined) {
        throw new Error(`第 ${fieldLine.lineNo} 行：步骤字段 ${kv.key} 缺少值`);
      }
      const scalar = parseScalar(kv.value);
      if (kv.key === 'retry') {
        if (typeof scalar !== 'number') {
          throw new Error(`第 ${fieldLine.lineNo} 行：retry 必须为数字`);
        }
        step.retry = scalar;
      } else if (kv.key === 'require') {
        step.require = String(scalar);
      } else {
        step[kv.key] = typeof scalar === 'string' ? scalar : String(scalar);
      }
      pos += 1;
    }
    steps.push(step);
  }
  return { steps, nextPos: pos };
}

/** 解析纯列表（每项 "- x"，缩进一致）。 */
function parseList(
  lines: Line[],
  start: number,
  itemIndent: number,
): { items: string[]; nextPos: number } {
  const items: string[] = [];
  let pos = start;
  while (pos < lines.length) {
    const line = lines[pos];
    if (line === undefined) {
      break;
    }
    if (line.indent < itemIndent) {
      break;
    }
    if (line.indent !== itemIndent || !line.content.startsWith('- ')) {
      throw new Error(`第 ${line.lineNo} 行：列表项必须以 "- " 开头且缩进一致`);
    }
    const value = line.content.slice(2).trim();
    if (value === '') {
      throw new Error(`第 ${line.lineNo} 行：列表项不能为空`);
    }
    items.push(String(parseScalar(value)));
    pos += 1;
  }
  return { items, nextPos: pos };
}

// ── YAML 序列化（T2.5 export）───────────────────────────────

/** Workflow → YAML 文本（2 空格缩进，与解析器一致）。 */
export function serializeWorkflowYaml(workflow: Workflow): string {
  const lines: string[] = [];
  lines.push(`name: ${quoteIfNeeded(workflow.name)}`);
  if (workflow.description !== undefined) {
    lines.push(`description: ${quoteIfNeeded(workflow.description)}`);
  }
  if (workflow.version !== undefined) {
    lines.push(`version: ${workflow.version}`);
  }
  lines.push('steps:');
  for (const step of workflow.steps) {
    lines.push(`  - name: ${quoteIfNeeded(step.name)}`);
    if (step.description !== undefined) {
      lines.push(`    description: ${quoteIfNeeded(step.description)}`);
    }
    lines.push(`    run: ${quoteIfNeeded(step.run)}`);
    if (step.depends !== undefined && step.depends.length > 0) {
      lines.push('    depends:');
      for (const dep of step.depends) {
        lines.push(`      - ${quoteIfNeeded(dep)}`);
      }
    }
    if (step.retry !== undefined && step.retry > 0) {
      lines.push(`    retry: ${step.retry}`);
    }
    if (step.require !== undefined && step.require !== 'none') {
      lines.push(`    require: ${step.require}`);
    }
    if (step.files !== undefined && step.files.length > 0) {
      lines.push('    files:');
      for (const file of step.files) {
        lines.push(`      - ${quoteIfNeeded(file)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 仅当值含特殊字符（冒号/引号/列表符号/注释符）时加双引号。 */
function quoteIfNeeded(value: string): string {
  if (/[:#"'\s[\],{}&*!|>%@`]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ── 依赖推断（T2.4）────────────────────────────────────────

/**
 * 命令语义启发式规则：子串 → 依赖意图。按顺序匹配（越靠前优先级越高）。
 * 注意 to 语义 = 被依赖方（依赖边 from 依赖 to，与 InferredDependency 注释一致）：
 * 规则表达「匹配步骤 X 应依赖目标 T」→ 边 { from: X, to: T } → X.depends += T。
 */
const DEPENDENCY_RULES: Array<{ pattern: RegExp; to: string; reason: string }> = [
  { pattern: /\bnpm run publish\b/, to: 'build', reason: 'publish 前通常需要先 build' },
  { pattern: /\bnpm publish\b/, to: 'build', reason: 'publish 前通常需要先 build' },
  {
    pattern: /\bnpm run test\b|\bnpm test\b|vitest run\b/,
    to: 'build',
    reason: 'test 前通常需要先 build',
  },
  {
    pattern: /\bnpm run typecheck\b/,
    to: 'lint',
    reason: 'lint 与 typecheck 通常一起做（先 lint 后 typecheck）',
  },
  { pattern: /\bnpm run typecheck\b/, to: 'build', reason: 'typecheck 前通常需要先 build' },
  { pattern: /\bnpm run build\b/, to: 'lint', reason: 'build 前通常需要先通过 lint' },
];

/**
 * 推断步骤间依赖边（T2.4）。
 *
 * 规则：对每个步骤命令匹配规则 → 若「被依赖目标」是已存在步骤名 → 建议加边。
 * 已显式声明依赖的跳过；结果由调用方提示用户确认，**不静默写入**。
 */
export function inferDependencies(steps: WorkflowStep[]): InferredDependency[] {
  const inferred: InferredDependency[] = [];
  const names = new Set(steps.map((s) => s.name));
  const declared = new Set<string>();
  for (const step of steps) {
    for (const dep of step.depends ?? []) {
      declared.add(`${step.name}->${dep}`);
    }
  }
  for (const step of steps) {
    for (const rule of DEPENDENCY_RULES) {
      if (!rule.pattern.test(step.run)) {
        continue;
      }
      // 目标步骤存在且未被声明（含反向）且不是自身 → 命中（本步骤只推一条）
      if (
        names.has(rule.to) &&
        rule.to !== step.name &&
        !declared.has(`${step.name}->${rule.to}`)
      ) {
        inferred.push({ from: step.name, to: rule.to, reason: rule.reason });
        break;
      }
      // 目标步骤不存在或已声明 → 继续尝试下一条规则（如 typecheck 无 lint 时落到 build）
    }
  }
  return inferred;
}
