import { z } from 'zod';
import type { DeepSeekApiTool } from '../model/client';

export interface ToolContext {
  /** 项目根目录（沙箱根），所有工具路径以此为基准解析。 */
  cwd: string;
  /**
   * 危险操作（编辑/shell）落盘或执行前的审批回调。
   * 未提供时工具默认拒绝（fail-closed）；TUI 注入模态框，测试注入 stub。
   */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /**
   * shell 命令白名单前缀：命中（按命令词边界匹配）可免审批直跑；
   * 未配置 = 无白名单，所有命令一律走审批。
   */
  allowlistedPrefixes?: readonly string[];
}

export interface ApprovalRequest {
  kind: 'edit' | 'shell';
  /** 给审批者的一句话摘要（中文）。 */
  summary: string;
  /** 详细内容（edit：统一 diff；shell：命令文本）。 */
  detail: string;
}

/** 统一审批入口：未配置回调时默认拒绝（fail-closed），无 yolo 模式。 */
export async function requestApproval(
  ctx: ToolContext,
  request: ApprovalRequest,
): Promise<boolean> {
  if (ctx.requestApproval === undefined) {
    return false;
  }
  return ctx.requestApproval(request);
}

export interface ToolResult {
  ok: boolean;
  /** 成功时的结构化数据（由 loop 层负责格式化回填）。 */
  data?: unknown;
  /** 失败时的错误说明（中文，回填给模型）。 */
  error?: string;
  /**
   * 失败是否可修复（模型修正后重试，T3.2 修复管线）。
   * 缺省视为可修复；显式 false = 不可修复（路径越界、审批拒绝、未知工具），
   * 不进入修复计数、不会触发修复终止。
   */
  repairable?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  /**
   * 是否可与其他 parallelSafe 工具并行执行（T3.1 起由 loop 调度消费）。
   * 只读工具为 true；审批类（edit/shell）必须为 false。
   */
  parallelSafe: boolean;
  /** 执行工具。入参已被 parameters 校验通过（实现内按需断言类型）。 */
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): this {
    if (this.tools.has(spec.name)) {
      throw new Error(`工具重复注册: ${spec.name}`);
    }
    this.tools.set(spec.name, spec);
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /**
   * 按名分发：zod 校验参数 → 执行 → 结果。
   * 未知工具、参数校验失败、执行异常均转为 ok:false 的结构化结果，不向上抛。
   */
  async run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const spec = this.tools.get(name);
    if (spec === undefined) {
      return { ok: false, error: `未知工具: ${name}`, repairable: false };
    }
    const parsed = spec.parameters.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `参数校验失败: ${formatIssues(parsed.error)}`, repairable: true };
    }
    try {
      return await spec.execute(parsed.data, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 路径越界属不可修复错误（模型侧幻觉路径），其余异常视为可修复
      return { ok: false, error: message, repairable: !message.includes('越界') };
    }
  }
}

/** 将 ToolSpec[] 转为 DeepSeek API function-calling 格式。 */
export function toApiTools(specs: readonly ToolSpec[]): DeepSeekApiTool[] {
  return specs.map((spec) => ({
    type: 'function' as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.parameters) as Record<string, unknown>,
    },
  }));
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
    .join('; ');
}
