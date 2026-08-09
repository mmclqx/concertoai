/**
 * Coder Agent（v3.0 M3 / T3.2）。
 *
 * 职责：
 * 1. 按 ArchitectSpec（T3.1）编码实现 → 输出多文件（path + content），写盘前走审批流；
 * 2. 接收 Reviewer 的 ReviewResult 问题列表（ReviewIssue[]，🔴🟡🟢）→ 自动生成修复方案，
 *    修复前用户确认，修复后重新提交（由 T3.5 闭环编排驱动）；
 * 3. 文件修改通过注入的 CoderFileWriter 登记（T3.6 事务模块接入点：写前快照 → 支持任务级回滚）；
 * 4. 复用 v2.0 edit 工具的 SEARCH/REPLACE 语义（planEdit 纯函数生成 diff 供审批展示）。
 *
 * 设计：模型生成代码 → zod 校验（CoderOutputSchema）→ 审批（onApproval）→ writer 写盘。
 * 审批拒绝 → 抛错不写盘（fail-closed，无 yolo 模式）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ModelClient } from '../model/client';
import type { AgentContext, AgentDef } from '../orchestrator';
import { createAgentRuntimeState } from '../orchestrator';
import type { ReviewIssue } from '../reviewer/types';
import { planEdit } from '../tools/edit';
import type { ArchitectSpec } from './architect';
import type { Agent } from './protocol';

// ── 类型定义 ──────────────────────────────────────────────────

/** 单个生成文件（path + 完整内容）。 */
export interface CoderFile {
  /** 项目相对路径。 */
  path: string;
  /** 文件内容。 */
  content: string;
}

/** Coder 输出：一组文件（写盘前经审批）。 */
export interface CoderOutput {
  files: CoderFile[];
}

/** Coder 输入：实现模式（spec）或修复模式（issues）。 */
export interface CoderInput {
  /** 任务描述（实现模式必填；修复模式可省略）。 */
  description: string;
  /** ArchitectSpec（实现模式：architect 的结构化设计）。 */
  spec?: ArchitectSpec;
  /** Reviewer 反馈问题列表（修复模式：🔴🟡🟢）。 */
  issues?: ReviewIssue[];
}

/** 写文件审批回调：返回 false 拒绝（不写盘）。reason 区分实现/修复。 */
export type CoderApproval = (files: CoderFile[], reason: 'implement' | 'fix') => Promise<boolean>;

/**
 * 文件写入器抽象。
 *
 * 生产实现写磁盘（可在写前快照 → T3.6 事务登记接入点）；测试注入内存实现。
 */
export interface CoderFileWriter {
  /** 写一个文件（相对 cwd）。 */
  write(relPath: string, content: string): Promise<void>;
}

// ── zod schema ────────────────────────────────────────────────

const coderFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/** Coder 输出运行时校验 schema（z.infer 与 CoderOutput 同步）。 */
export const coderOutputSchema = z.object({
  files: z.array(coderFileSchema).min(1, '至少产出 1 个文件'),
});

/** Coder 输入 schema（description 必填；spec/issues 可选）。 */
export const coderInputSchema = z.object({
  description: z.string().min(1),
  spec: z.unknown().optional(),
  issues: z
    .array(
      z.object({
        severity: z.enum(['critical', 'medium', 'suggestion']),
        file: z.string(),
        title: z.string(),
        description: z.string(),
        line: z.number().optional(),
        suggestion: z.string().optional(),
      }),
    )
    .optional(),
});

// ── 模型生成 ──────────────────────────────────────────────────

/** 实现模式 system prompt：按 spec 输出严格 JSON 文件集合。 */
const IMPLEMENT_SYSTEM_PROMPT = [
  '你是 Lumen 的编码 Agent。根据架构师给出的 ArchitectSpec 输出实现代码。',
  '输出严格为 JSON 对象（不要 markdown 围栏，不要其他文字），结构：',
  '{"files":[{"path":"src/a.ts","content":"// 完整文件内容"}]}',
  '要求：',
  '- files 覆盖 spec.files 中全部文件（path 保持一致），content 为完整可编译文件内容；',
  '- 严格按 spec.interfaces 的签名实现（导出名/签名一致），满足 spec.constraints 的约束；',
  '- 不要省略文件，不要输出注释占位（除非 spec 要求）；',
  '- 至少产出 1 个文件。',
].join('\n');

/** 修复模式 system prompt：按 Reviewer 问题列表输出修复后的文件。 */
const FIX_SYSTEM_PROMPT = [
  '你是 Lumen 的编码 Agent。根据 Reviewer 的代码审查问题列表修复代码。',
  '你收到当前全部文件的 JSON 以及问题列表，输出修复后的文件集合。',
  '输出严格为 JSON 对象（不要 markdown 围栏，不要其他文字），结构：',
  '{"files":[{"path":"src/a.ts","content":"// 修复后的完整文件内容"}]}',
  '要求：',
  '- files 应包含全部文件（未修改的文件原样输出，修改的文件输出修复后内容）；',
  '- 修复 🔴 critical 与 🟡 medium 问题；🟢 suggestion 可选择性采纳；',
  '- 不要引入新问题，保持与现有代码风格一致；',
  '- 至少产出 1 个文件。',
].join('\n');

/**
 * 调用模型生成实现代码。
 * 流式收集 → parseCoderOutput 校验；模型调用错误直接上抛。
 */
export async function generateImplementation(
  client: ModelClient,
  model: string,
  spec: ArchitectSpec,
  context: AgentContext,
): Promise<CoderOutput> {
  const userContent = [
    `需求：${spec.requirement}`,
    `设计规格：${JSON.stringify(spec, null, 2)}`,
    `上下文：${JSON.stringify(context)}`,
  ].join('\n');
  return generateCoderOutput(client, model, IMPLEMENT_SYSTEM_PROMPT, userContent);
}

/**
 * 调用模型生成修复方案。
 * 输入当前文件集合 + Reviewer 问题列表，输出修复后的文件集合。
 */
export async function generateFix(
  client: ModelClient,
  model: string,
  currentFiles: CoderFile[],
  issues: ReviewIssue[],
  context: AgentContext,
): Promise<CoderOutput> {
  const userContent = [
    '当前文件：',
    JSON.stringify(currentFiles, null, 2),
    'Reviewer 问题列表：',
    JSON.stringify(
      issues.map((i) => ({
        severity: i.severity,
        file: i.file,
        line: i.line,
        title: i.title,
        description: i.description,
        suggestion: i.suggestion,
      })),
      null,
      2,
    ),
    `上下文：${JSON.stringify(context)}`,
  ].join('\n');
  return generateCoderOutput(client, model, FIX_SYSTEM_PROMPT, userContent);
}

/** 公共生成入口：发 prompt → 流式收集 → 解析校验。 */
async function generateCoderOutput(
  client: ModelClient,
  model: string,
  systemPrompt: string,
  userContent: string,
): Promise<CoderOutput> {
  const contentParts: string[] = [];
  for await (const chunk of client.streamChat({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
  })) {
    for (const choice of chunk.choices) {
      const text = choice.delta.content ?? '';
      if (text !== '') {
        contentParts.push(text);
      }
    }
  }
  return parseCoderOutput(contentParts.join(''));
}

/** 从模型回复文本解析并校验 CoderOutput（容忍围栏，失败带原文报错）。 */
export function parseCoderOutput(text: string): CoderOutput {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `代码生成失败: 模型输出不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  const result = coderOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `代码生成失败: 输出结构不符合协议（${issues}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  return result.data;
}

// ── 写盘（复用 edit 工具 SEARCH/REPLACE 语义）────────────────

/**
 * 计算「从 original 到 target」的 SEARCH/REPLACE 编辑 diff（审批展示用）。
 * 通过 planEdit（v2.0 edit 工具纯函数）复用 SEARCH/REPLACE 语义。
 */
export function diffForWrite(original: string, target: string): string {
  // 全部替换：search = 原内容，replace = 新内容（新文件 original 为空 → 创建）
  return planEdit(original, original === '' ? '' : original, target).diff;
}

/** 磁盘文件写入器：写文件 + 目录自动创建。T3.6 事务登记接入点（写前快照）。 */
export class DiskFileWriter implements CoderFileWriter {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async write(relPath: string, content: string): Promise<void> {
    const resolved = path.resolve(this.cwd, relPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
  }
}

// ── Coder Agent ───────────────────────────────────────────────

/** Coder Agent 选项。 */
export interface CoderAgentOptions {
  /** 模型客户端（代码生成）。 */
  client: ModelClient;
  /** 生成使用的模型 ID。 */
  model: string;
  /** 文件写入器（生产 DiskFileWriter / 测试内存实现）。 */
  writer: CoderFileWriter;
  /** 写盘审批回调（实现/修复前用户确认）。 */
  onApproval?: CoderApproval;
}

/**
 * Coder Agent（标准 Agent 契约）。
 *
 * execute(input, context)：
 * - 实现模式（无 issues）：生成代码 → 审批 → 写盘 → 返回 CoderOutput；
 * - 修复模式（有 issues）：基于当前文件生成修复 → 审批 → 写盘 → 返回 CoderOutput。
 * 审批拒绝 / 生成失败 → 抛错（不写盘，不产出工件）。
 */
export class CoderAgent implements Agent {
  /** Agent 定义（name=coder，输入 CoderInput / 输出 CoderOutput，权限 = edit_file）。 */
  readonly def: AgentDef = {
    name: 'coder',
    version: '1.0.0',
    interfaces: {
      input: coderInputSchema,
      output: coderOutputSchema,
      version: '1.0.0',
    },
    permissions: [
      // coder 写文件（edit_file），fail-closed：不声明 shell（命令执行权限最小化）
      { tool: 'edit_file' },
    ],
  };

  /** 运行时状态（与任务级 AgentState 解耦，ADR-016 #3）。 */
  runtimeState = createAgentRuntimeState();

  private readonly options: CoderAgentOptions;

  constructor(options: CoderAgentOptions) {
    this.options = options;
  }

  /** 执行核心：实现或修复 → 审批 → 写盘 → 返回文件集合。 */
  async execute(input: CoderInput, context: AgentContext): Promise<CoderOutput> {
    const isFix = input.issues !== undefined && input.issues.length > 0;
    const output = isFix
      ? await this.fixMode(input, context)
      : await this.implementMode(input, context);
    return output;
  }

  /** 实现模式：按 spec 生成代码。 */
  private async implementMode(input: CoderInput, context: AgentContext): Promise<CoderOutput> {
    if (input.spec === undefined) {
      throw new Error('编码失败: 缺少 ArchitectSpec（实现模式必须提供 spec 输入）');
    }
    const output = await generateImplementation(
      this.options.client,
      this.options.model,
      input.spec,
      context,
    );
    await this.approveAndWrite(output, 'implement');
    return output;
  }

  /** 修复模式：基于当前文件 + Reviewer 问题生成修复。 */
  private async fixMode(input: CoderInput, context: AgentContext): Promise<CoderOutput> {
    // 当前文件来源：context.artifacts 中的 code 工件（T3.5 闭环传入），或 input 外部提供
    const currentFiles = this.collectCurrentFiles(input, context);
    const issues = input.issues ?? [];
    const output = await generateFix(
      this.options.client,
      this.options.model,
      currentFiles,
      issues,
      context,
    );
    await this.approveAndWrite(output, 'fix');
    return output;
  }

  /** 从 context.artifacts（type === 'code'）收集当前文件（修复模式的基线）。 */
  private collectCurrentFiles(_input: CoderInput, context: AgentContext): CoderFile[] {
    // 优先用输入携带的文件（扩展字段），否则从上下文 code 工件恢复
    const fromArtifacts: CoderFile[] = context.artifacts
      .filter((a) => a.type === 'code')
      .map((a) => ({ path: a.path ?? `artifact-${a.id}.txt`, content: a.content }));
    if (fromArtifacts.length > 0) {
      return fromArtifacts;
    }
    // 兜底：单个空文件（模型可基于 issues 描述直接重写；真实闭环由 T3.5 提供基线）
    return [{ path: 'src/unknown.ts', content: '' }];
  }

  /** 审批 → 写盘（审批拒绝抛错，不写盘）。 */
  private async approveAndWrite(output: CoderOutput, reason: 'implement' | 'fix'): Promise<void> {
    if (this.options.onApproval !== undefined) {
      const approved = await this.options.onApproval(output.files, reason);
      if (!approved) {
        throw new Error('用户未确认代码方案，已取消（不写盘）');
      }
    }
    for (const file of output.files) {
      await this.options.writer.write(file.path, file.content);
    }
  }

  /** 发送消息（闭环暂未启用，no-op 占位）。 */
  async send(): Promise<void> {
    // 闭环消息路由由 T3.5 编排层接入。
  }

  /** 接收消息（闭环暂未启用，返回无回复）。 */
  async receive(): Promise<undefined> {
    return undefined;
  }
}
