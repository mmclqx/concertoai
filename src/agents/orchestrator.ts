/**
 * Orchestrator Agent（v3.0 M2 / T2.3，多 Agent 协作编排核心）。
 *
 * 职责（对齐 §3.2 Orchestrator 模式）：
 * 1. 接收用户需求 → 调用模型拆解为结构化 Task[]（负责人 Agent + 验收标准 + 依赖）；
 * 2. 拆解结果可预览/确认（审批流：onPlan 回调，用户确认或修改后执行，对齐 PlanConfirm）；
 * 3. 按调度器（T2.2 TaskScheduler）分配任务给对应 Agent（Architect/Coder/Reviewer/QA）；
 * 4. 收集各 Agent 结果，聚合为最终输出（含中间工件引用 Artifact）。
 *
 * 与 Plan 模式兼容：拆解出的 Task[] 即计划步骤清单，可作为 /plan 的后端引擎
 * （用户审批后执行，拒绝则取消且不产出任何副作用）。
 */

import { z } from 'zod';
import type { ModelClient } from '../model/client';
import type { AgentContext, Artifact, ArtifactType } from '../orchestrator';
import { createArtifact, type SchedulerTask, TaskScheduler } from '../orchestrator';
import type { Agent } from './protocol';
import type { AgentRegistry } from './registry';

// ── 类型定义 ──────────────────────────────────────────────────

/** 拆解后的任务：负责人 Agent + 验收标准 + 依赖 + 涉及文件。 */
export interface OrchestratorTask {
  /** 任务 ID（全局唯一，调度器依赖引用）。 */
  id: string;
  /** 任务描述（含验收标准，供 Agent 理解目标）。 */
  description: string;
  /** 负责人 Agent 名（architect / coder / reviewer / qa 或扩展角色）。 */
  agent: string;
  /** 依赖任务 ID 列表（必须先完成）。 */
  dependencies: string[];
  /** 该任务修改的文件路径（文件级冲突检测用，可选）。 */
  files?: string[];
}

/** 单个任务执行记录（聚合结果用）。 */
export interface TaskExecution {
  /** 任务 ID。 */
  taskId: string;
  /** 负责人 Agent 名。 */
  agent: string;
  /** 是否成功。 */
  ok: boolean;
  /** 结构化输出（成功时由 Agent 实现定义形状）。 */
  data?: unknown;
  /** 失败原因（ok 为 false 时给出）。 */
  error?: string;
  /** 该任务产出的工件（按 Agent 角色映射类型）。 */
  artifacts: Artifact[];
}

/** Orchestrator 整体执行结果。 */
export interface OrchestratorRunResult {
  /** 是否全部成功（无失败 / 无跳过 / 未被用户取消）。 */
  ok: boolean;
  /** 拓扑排序的执行顺序（计划顺序）。 */
  order: string[];
  /** 每个任务的执行记录（按 taskId 索引，去重覆盖）。 */
  executions: TaskExecution[];
  /** 失败任务 id → 错误信息。 */
  failed: Record<string, string>;
  /** 因依赖失败而级联跳过的任务 id 列表。 */
  skipped: string[];
  /** 全部成功任务的工件（中间工件引用，供可观测性/审计）。 */
  artifacts: Artifact[];
  /** 聚合摘要（中文，供用户快速了解结果）。 */
  summary: string;
}

/** Orchestrator 选项。 */
export interface OrchestratorOptions {
  /** 模型客户端（需求拆解）。 */
  client: ModelClient;
  /** 拆解使用的模型 ID。 */
  model: string;
  /** Agent 注册表（调度执行时按 task.agent 查找实现）。 */
  registry: AgentRegistry;
  /** 审批回调：拆解完成后询问用户是否确认（返回 false 取消执行）。 */
  onPlan?: (tasks: OrchestratorTask[]) => Promise<boolean>;
  /** 调度并发数（默认 TaskScheduler 默认值 3）。 */
  concurrency?: number;
}

// ── 拆解：模型输出解析 ────────────────────────────────────────

/** 拆解任务 zod schema（运行时校验模型输出，防脏数据流入调度）。 */
const orchestratorTaskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agent: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  files: z.array(z.string()).optional(),
});

const orchestratorTasksSchema = z.array(orchestratorTaskSchema);

/** 拆解系统提示：要求模型输出严格 JSON 数组（低温度，可解析优先）。 */
const DECOMPOSE_SYSTEM_PROMPT = [
  '你是 ConcertoAI 的任务编排器。将用户需求拆解为可串行/并行执行的任务清单。',
  '输出严格为 JSON 数组（不要 markdown 围栏，不要其他文字），每项格式：',
  '{"id":"t1","description":"任务描述（含验收标准）","agent":"architect|coder|reviewer|qa","dependencies":[],"files":["src/a.ts"]}',
  '要求：',
  '- id 全局唯一（如 t1/t2/t3）；dependencies 用任务 id 引用，无依赖留空数组；',
  '- agent 必须是 architect/coder/reviewer/qa 之一（architect 定接口、coder 实现、reviewer 审查、qa 测试验证）；',
  '- files 列出该任务修改的文件路径（无文件写操作时省略或留空）；',
  '- 依赖方在依赖完成后才能执行；无依赖任务可并行。',
].join('\n');

/**
 * 从模型回复文本中提取并解析任务清单。
 *
 * 容忍 ```json 围栏与前后空白；解析或结构校验失败时抛出携带原文的中文错误，
 * 便于调用方展示给用户（模型输出不符合协议 → 明确报错，不静默产出空清单）。
 */
export function parseOrchestratorTasks(text: string): OrchestratorTask[] {
  const trimmed = text.trim();
  // 去掉 ```json ... ``` 围栏（模型偶发包裹）
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `需求拆解失败: 模型输出不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  const result = orchestratorTasksSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `需求拆解失败: 任务清单结构不符合协议（${issues}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  return result.data;
}

/**
 * 调用模型将用户需求拆解为结构化任务清单。
 *
 * 流式收集回复文本后经 parseOrchestratorTasks 校验；模型调用错误直接上抛。
 */
export async function decomposeRequirement(
  client: ModelClient,
  model: string,
  requirement: string,
): Promise<OrchestratorTask[]> {
  const contentParts: string[] = [];
  for await (const chunk of client.streamChat({
    model,
    messages: [
      { role: 'system', content: DECOMPOSE_SYSTEM_PROMPT },
      { role: 'user', content: requirement },
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
  return parseOrchestratorTasks(contentParts.join(''));
}

// ── 聚合工具 ──────────────────────────────────────────────────

/** 按 Agent 角色映射工件类型（architect→spec / coder→code / reviewer→review-result / qa→test-report）。 */
export function artifactTypeForAgent(agent: string): ArtifactType {
  switch (agent) {
    case 'architect':
      return 'spec';
    case 'coder':
      return 'code';
    case 'reviewer':
      return 'review-result';
    case 'qa':
      return 'test-report';
    default:
      return 'file';
  }
}

/** 将 Agent 输出转为可追踪工件（来源追踪：fromAgent/messageId/taskId）。 */
function toArtifact(taskId: string, agent: string, data: unknown): Artifact {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return createArtifact({
    id: `artifact-${taskId}`,
    type: artifactTypeForAgent(agent),
    content,
    fromAgent: agent,
    messageId: `orch-${taskId}`,
    taskId,
  });
}

/** 汇总执行记录为中文摘要（成功/失败/跳过 + 执行顺序）。 */
function buildSummary(order: string[], failed: Map<string, string>, skipped: string[]): string {
  const successCount = order.length - failed.size - skipped.length;
  if (failed.size === 0 && skipped.length === 0) {
    return `✅ 全部 ${order.length} 个任务完成。执行顺序: ${order.join(' → ')}`;
  }
  const lines = [
    `⚠️ 完成 ${successCount} 个 / 失败 ${failed.size} 个 / 跳过 ${skipped.length} 个。`,
  ];
  if (failed.size > 0) {
    lines.push(`失败: ${[...failed.entries()].map(([id, err]) => `${id}(${err})`).join('; ')}`);
  }
  if (skipped.length > 0) {
    lines.push(`跳过: ${skipped.join('、')}`);
  }
  return lines.join(' ');
}

// ── Orchestrator ──────────────────────────────────────────────

/**
 * Orchestrator：拆解 → 审批 → 调度 → 聚合 全流程编排。
 *
 * 不实现标准 Agent 接口（它不是被调度的角色，而是调度发起方）；
 * 通过 AgentRegistry 查找任务负责人并调用其 execute。
 */
export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  /**
   * 执行一次编排：拆解需求 → 用户审批 → 调度分配 → 聚合输出。
   *
   * @param requirement 用户需求（自然语言）。
   * @param context     显式上下文（会话/任务骨架）。
   */
  async run(requirement: string, context: AgentContext): Promise<OrchestratorRunResult> {
    // 1. 拆解（调用模型，失败上抛由调用方展示）
    const tasks = await decomposeRequirement(this.options.client, this.options.model, requirement);

    // 2. 审批（用户确认/修改；拒绝则取消，不产出任何副作用）
    if (this.options.onPlan !== undefined) {
      const approved = await this.options.onPlan(tasks);
      if (!approved) {
        return {
          ok: false,
          order: [],
          executions: [],
          failed: {},
          skipped: [],
          artifacts: [],
          summary: '用户未确认拆解方案，已取消执行。',
        };
      }
    }

    // 3. 调度：每个任务委托给注册表对应 Agent（失败由调度器重试/级联跳过）
    const executions = new Map<string, TaskExecution>();
    const schedulerTasks: SchedulerTask[] = tasks.map((task) => ({
      id: task.id,
      dependencies: task.dependencies,
      files: task.files,
      run: () => this.executeTask(task, context, executions),
    }));
    const scheduler = new TaskScheduler({ concurrency: this.options.concurrency });
    const result = await scheduler.schedule(schedulerTasks);

    // 4. 聚合输出
    const failed: Record<string, string> = {};
    for (const [taskId, error] of result.failed) {
      failed[taskId] = error;
    }
    const artifacts = [...executions.values()].filter((e) => e.ok).flatMap((e) => e.artifacts);

    return {
      ok: result.ok && executions.size > 0,
      order: result.order,
      executions: [...executions.values()],
      failed,
      skipped: result.skipped,
      artifacts,
      summary: buildSummary(result.order, result.failed, result.skipped),
    };
  }

  /** 执行单个任务：查注册表 → 调用 Agent.execute → 记录执行结果（失败原因上抛给调度器重试）。 */
  private async executeTask(
    task: OrchestratorTask,
    context: AgentContext,
    executions: Map<string, TaskExecution>,
  ): Promise<{ ok: boolean; error?: string }> {
    const entry = this.options.registry.get(task.agent);
    // S3 建议修复：区分「未注册」与「已注册但无实现」，便于调用方定位问题
    if (entry === undefined) {
      const message = `Agent 未注册: ${task.agent}`;
      executions.set(task.id, {
        taskId: task.id,
        agent: task.agent,
        ok: false,
        error: message,
        artifacts: [],
      });
      return { ok: false, error: message };
    }
    const impl: Agent | undefined = entry.impl;
    if (impl === undefined) {
      const message = `Agent 已注册但未提供实现实例: ${task.agent}`;
      executions.set(task.id, {
        taskId: task.id,
        agent: task.agent,
        ok: false,
        error: message,
        artifacts: [],
      });
      return { ok: false, error: message };
    }
    try {
      const data = await impl.execute({ description: task.description }, context);
      const record: TaskExecution = {
        taskId: task.id,
        agent: task.agent,
        ok: true,
        data,
        artifacts: [toArtifact(task.id, task.agent, data)],
      };
      executions.set(task.id, record);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      executions.set(task.id, {
        taskId: task.id,
        agent: task.agent,
        ok: false,
        error: message,
        artifacts: [],
      });
      return { ok: false, error: message };
    }
  }
}
