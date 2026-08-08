/**
 * 子代理 spawner（v2.0）。
 *
 * 在当前进程中创建隔离的 runLoop 实例执行子代理任务，只回传结论不污染主上下文。
 *
 * 安全边界：
 * - 子代理使用受限的 ToolRegistry（仅 `def.allowedTools` 指定的只读工具）；
 * - 子代理不继承审批回调（只读工具本身不触发审批）；
 * - 子代理拥有独立的 systemPrompt 和对话历史；
 * - 超时与轮数限制由 `SubagentDef.maxTurns` / `timeoutMs` 控制；
 * - 子代理执行期间不向主 TUI 发送事件。
 */

import type { RunLoopResult } from '../loop/loop';
import { runLoop } from '../loop/loop';
import type { ModelClient } from '../model/client';
import { getModel } from '../model/models';
import { listDirectoryTool, readFileTool, searchContentTool } from '../tools/read';
import type { ToolContext } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import type { SubagentDef, SubagentResult, SubagentTask } from './types';

/** 所有可分配给子代理的只读工具映射。 */
const READONLY_TOOL_MAP: Record<string, typeof readFileTool> = {
  read_file: readFileTool,
  search_content: searchContentTool,
  list_directory: listDirectoryTool,
};

export class SubagentSpawner {
  private readonly defs = new Map<string, SubagentDef>();
  private readonly client: ModelClient;
  private readonly ctx: ToolContext;
  private readonly model: string;

  constructor(client: ModelClient, ctx: ToolContext, model: string) {
    this.client = client;
    this.ctx = ctx;
    this.model = model;
  }

  /** 注册一个子代理定义。同名覆盖。 */
  register(def: SubagentDef): this {
    this.defs.set(def.name, def);
    return this;
  }

  /** 按 name 查找子代理定义。 */
  get(name: string): SubagentDef | undefined {
    return this.defs.get(name);
  }

  /** 列出所有已注册的子代理名。 */
  listNames(): string[] {
    return [...this.defs.keys()];
  }

  /**
   * 执行子代理任务。
   *
   * 流程：
   * 1. 查找子代理定义 → 不存在则返回 ok:false；
   * 2. 创建隔离的 ToolRegistry（仅白名单工具）；
   * 3. 调用 runLoop（新实例，独立上下文）执行任务；
   * 4. 格式化结果回传。
   */
  async spawn(task: SubagentTask): Promise<SubagentResult> {
    const startedAt = Date.now();
    const def = this.defs.get(task.agentName);
    if (def === undefined) {
      return {
        ok: false,
        summary: `未知子代理: ${task.agentName}。可用: ${this.listNames().join(', ')}`,
        error: `unknown_agent: ${task.agentName}`,
        toolCallCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // 创建隔离的工具注册表（仅白名单工具）
    const isolatedRegistry = new ToolRegistry();
    for (const name of def.allowedTools) {
      const tool = READONLY_TOOL_MAP[name];
      if (tool !== undefined) {
        isolatedRegistry.register(tool);
      }
    }

    // 子代理的 ToolContext：共享 cwd，不提供审批回调（只读无需审批）
    const isolatedCtx: ToolContext = { cwd: this.ctx.cwd };

    // 构建子代理 system prompt（可附加 context）
    let systemPrompt = def.systemPrompt;
    if (task.context !== undefined && task.context.length > 0) {
      systemPrompt = `${systemPrompt}\n\n## 附加上下文\n${task.context}`;
    }

    // 获取模型上下文窗口
    const profile = getModel(this.model);
    const contextWindow = profile?.contextWindow;

    let toolCallCount = 0;
    let lastResult: RunLoopResult | undefined;

    try {
      // 带超时的子代理执行
      const result = await withTimeout(
        this.runIsolated(
          isolatedRegistry,
          isolatedCtx,
          systemPrompt,
          task.prompt,
          def.maxTurns,
          contextWindow,
          def.maxRepairs,
        ),
        def.timeoutMs,
      );

      lastResult = result;

      // 统计工具调用次数
      toolCallCount = result.messages.filter((m) => m.role === 'tool').length;

      // 提取子代理的最终回复
      const lastAssistant = result.messages
        .slice()
        .reverse()
        .find((m) => m.role === 'assistant');
      const summary = lastAssistant?.content ?? '（子代理未返回结论）';

      return {
        ok: !result.interrupted,
        summary,
        error: result.interrupted ? `子代理达到 ${def.maxTurns} 轮上限，结论可能不完整` : undefined,
        toolCallCount,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // 尝试从已有结果中提取部分结论
      let partialSummary = '';
      if (lastResult !== undefined) {
        const last = lastResult.messages
          .slice()
          .reverse()
          .find((m) => m.role === 'assistant');
        partialSummary = last?.content ?? '';
      }
      return {
        ok: false,
        summary: partialSummary || `子代理执行失败: ${error}`,
        error,
        toolCallCount,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** 在隔离的 runLoop 实例中执行子代理任务。 */
  private async runIsolated(
    registry: ToolRegistry,
    ctx: ToolContext,
    systemPrompt: string,
    taskPrompt: string,
    maxTurns: number,
    contextWindow: number | undefined,
    maxRepairs: number | undefined,
  ): Promise<RunLoopResult> {
    // 子代理的 runLoop：无历史消息，无 systemPrompt 注入（由 runLoop 内部处理）
    // 注意：子代理使用同一个 client（共享 API key 和连接）
    return runLoop(
      {
        model: this.model,
        client: this.client,
        registry,
        ctx,
        systemPrompt,
        contextWindow,
        maxTurns,
        maxRepairs,
      },
      [],
      taskPrompt,
    );
  }
}

/** 带超时的 Promise 包装。超时时抛 Error。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`子代理执行超时（${timeoutMs}ms）`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
