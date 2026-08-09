/**
 * Architect Agent（v3.0 M3 / T3.1）。
 *
 * 职责：接收需求 → 输出结构化 ArchitectSpec（接口定义 + 文件结构 + 约束条件），
 * 供 Coder Agent（T3.2）直接消费。
 *
 * 关键设计：
 * - 标准 Agent 契约（T1.2）：def.interfaces.input/output 均为 zod schema
 *   （输出 = architectSpecSchema，运行时校验 + 编译期推导 ArchitectSpec）；
 * - spec 生成依赖注入 ModelClient（测试注入 Fake，生产注入 DeepSeekClient）；
 * - spec 输出前走审批流：onSpec 回调（用户确认设计方向，对齐 T2.3 onPlan）；
 *   拒绝则抛错（不产出任何工件），与「无 spec 明确报错」语义一致；
 * - 模型输出不可解析 / 结构不符 / 空设计（无文件无接口）→ 明确抛错，不产出空工件。
 */

import { z } from 'zod';
import type { ModelClient } from '../model/client';
import type { AgentContext, AgentDef } from '../orchestrator';
import { createAgentRuntimeState } from '../orchestrator';
import type { Agent } from './protocol';

// ── ArchitectSpec（结构化设计输出，供 Coder 直接消费）────────

/** 单个接口签名（文件级导出）。 */
export interface ArchitectInterface {
  /** 所在文件路径。 */
  file: string;
  /** 该文件/模块的职责描述。 */
  responsibility: string;
  /** 关键导出（接口/函数/类）签名列表。 */
  exports: Array<{
    /** 导出名。 */
    name: string;
    /** 接口签名（TS 类型描述，如 `function foo(a: string): number`）。 */
    signature: string;
    /** 可选说明。 */
    description?: string;
  }>;
}

/** 单个文件结构描述。 */
export interface ArchitectFile {
  /** 文件路径。 */
  path: string;
  /** 用途说明。 */
  purpose: string;
  /** 依赖的其他文件路径（可选）。 */
  dependsOn?: string[];
}

/** Architect 输出的完整设计规格（结构化 JSON）。 */
export interface ArchitectSpec {
  /** 需求概述（原始需求回显，供追溯）。 */
  requirement: string;
  /** 接口定义（按文件组织，含职责与关键签名）。 */
  interfaces: ArchitectInterface[];
  /** 文件结构（新建/修改文件清单）。 */
  files: ArchitectFile[];
  /** 约束条件（编码约束、技术选型、边界）。 */
  constraints: string[];
  /** 技术要点/风险说明（可选）。 */
  notes?: string[];
}

// ── zod schema（运行时校验 + 类型推导同步）───────────────────

const architectInterfaceSchema = z.object({
  file: z.string().min(1),
  responsibility: z.string().min(1),
  exports: z
    .array(
      z.object({
        name: z.string().min(1),
        signature: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .default([]),
});

const architectFileSchema = z.object({
  path: z.string().min(1),
  purpose: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
});

/** ArchitectSpec 运行时校验 schema（z.infer 与 ArchitectSpec 类型同步）。 */
export const architectSpecSchema = z.object({
  requirement: z.string().min(1),
  interfaces: z.array(architectInterfaceSchema).default([]),
  files: z.array(architectFileSchema).default([]),
  constraints: z.array(z.string()).default([]),
  notes: z.array(z.string()).optional(),
});

// ── 模型生成 ──────────────────────────────────────────────────

/** 生成 system prompt：要求模型输出严格 JSON（含接口/文件/约束）。 */
const ARCHITECT_SYSTEM_PROMPT = [
  '你是 Lumen 的架构师 Agent。根据用户需求输出结构化设计规格（ArchitectSpec），供编码 Agent 直接实现。',
  '输出严格为 JSON 对象（不要 markdown 围栏，不要其他文字），结构：',
  '{',
  '  "requirement": "需求概述",',
  '  "interfaces": [{"file": "src/a.ts", "responsibility": "模块职责", "exports": [{"name": "foo", "signature": "export function foo(x: string): number", "description": "说明"}]}],',
  '  "files": [{"path": "src/a.ts", "purpose": "用途", "dependsOn": ["src/types.ts"]}],',
  '  "constraints": ["约束1", "约束2"],',
  '  "notes": ["要点"]',
  '}',
  '要求：',
  '- interfaces 按文件组织，exports 给出关键接口签名（TS 类型，供 Coder 直接照写）；',
  '- files 列出全部新建/修改文件及依赖关系；',
  '- constraints 给出编码约束、技术选型与边界（必须具体、可执行）；',
  '- 无 notes 时可省略；不要输出空设计（至少 1 个文件）。',
].join('\n');

/**
 * 调用模型生成 ArchitectSpec。
 *
 * 流式收集回复 → 去除 ```json 围栏 → JSON.parse → zod 校验。
 * 解析/校验失败或空设计（无文件）时抛中文错误（不产出空工件）。
 */
export async function generateArchitectSpec(
  client: ModelClient,
  model: string,
  requirement: string,
  context: AgentContext,
): Promise<ArchitectSpec> {
  const contentParts: string[] = [];
  for await (const chunk of client.streamChat({
    model,
    messages: [
      { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `需求：${requirement}\n\n已有上下文：${JSON.stringify(context)}`,
      },
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
  return parseArchitectSpec(contentParts.join(''));
}

/**
 * 从模型回复文本中解析并校验 ArchitectSpec。
 * 与 parseOrchestratorTasks（T2.3）同一容错策略：容忍围栏、失败带原文报错。
 */
export function parseArchitectSpec(text: string): ArchitectSpec {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `架构设计失败: 模型输出不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  const result = architectSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `架构设计失败: spec 结构不符合协议（${issues}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  if (result.data.files.length === 0) {
    throw new Error(
      '架构设计失败: 模型未给出任何文件（空设计），不产出空 spec。请补充需求细节后重试',
    );
  }
  return result.data;
}

// ── Architect Agent ───────────────────────────────────────────

/** Architect Agent 选项。 */
export interface ArchitectAgentOptions {
  /** 模型客户端（spec 生成）。 */
  client: ModelClient;
  /** 生成使用的模型 ID。 */
  model: string;
  /** 审批回调：spec 生成后询问用户确认设计方向（返回 false 拒绝 → 抛错取消）。 */
  onSpec?: (spec: ArchitectSpec) => Promise<boolean>;
}

/**
 * Architect Agent（标准 Agent 契约）。
 *
 * execute(input, context)：生成 spec → 审批 → 返回 spec。
 * 审批拒绝或生成失败 → 抛错（Orchestrator 记录任务失败，不产出工件）。
 */
export class ArchitectAgent implements Agent {
  /** Agent 定义（name=architect，输入 description / 输出 ArchitectSpec）。 */
  readonly def: AgentDef = {
    name: 'architect',
    version: '1.0.0',
    interfaces: {
      input: z.object({ description: z.string().min(1) }),
      output: architectSpecSchema,
      version: '1.0.0',
    },
    permissions: [
      // architect 只读（读文件/目录），不写文件、不执行命令（fail-closed 最小权限）
      { tool: 'read_file' },
      { tool: 'list_directory' },
      { tool: 'search_content' },
    ],
  };

  /** 运行时状态（与任务级 AgentState 解耦，ADR-016 #3）。 */
  runtimeState = createAgentRuntimeState();

  private readonly options: ArchitectAgentOptions;

  constructor(options: ArchitectAgentOptions) {
    this.options = options;
  }

  /** 执行核心：生成 spec → 审批 → 返回（失败/拒绝抛错，不产出空工件）。 */
  async execute(input: { description: string }, context: AgentContext): Promise<ArchitectSpec> {
    const spec = await generateArchitectSpec(
      this.options.client,
      this.options.model,
      input.description,
      context,
    );
    if (this.options.onSpec !== undefined) {
      const approved = await this.options.onSpec(spec);
      if (!approved) {
        throw new Error('用户未确认设计方向，已取消（不产出 spec）');
      }
    }
    return spec;
  }

  /** 发送消息（闭环暂未启用，no-op 占位）。 */
  async send(): Promise<void> {
    // 闭环消息路由由 T3.5 编排层接入，当前 Agent 直连调度。
  }

  /** 接收消息（闭环暂未启用，返回无回复）。 */
  async receive(): Promise<undefined> {
    return undefined;
  }
}
