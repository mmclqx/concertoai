import { z } from 'zod';
import type { DeepSeekApiTool } from '../model/client';
import type { SnapshotStore } from '../planner/rollback';
import type { PluginPermissionType } from '../plugin/types';
import { inferErrorCode, TOOL_ERROR_SUGGESTIONS } from './error-codes';

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
  /** 文件快照管理器（v1.1 计划回滚）：编辑前自动快照。 */
  snapshotStore?: SnapshotStore;
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
  /** 机器可读错误码（v3.1 M4 结构化错误增强；可选，向后兼容）。 */
  code?: string;
  /** 中文修复建议（v3.1 M4 结构化错误增强；可选，向后兼容）。 */
  suggestion?: string;
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
  /**
   * 插件工具来源（v4.0 M4）：`plugin:<name>`；内置工具无此字段。
   * 存在时 run 前经 permissionCheck 钩子拦截（fail-closed + 审计）。
   */
  pluginSource?: string;
  /**
   * 插件工具所需权限类型（v4.0 M4）：声明后调用前经 permissionCheck guard；
   * 未声明（undefined）表示该工具无需敏感权限，直接放行。
   */
  pluginPermission?: PluginPermissionType;
}

/** 插件工具调用前权限检查钩子（v4.0 M4 方案 C：对内置工具零影响）。 */
export type PermissionCheck = (
  pluginSource: string,
  permission: PluginPermissionType | undefined,
  args: unknown,
) => boolean | Promise<boolean>;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  /**
   * v2.1 性能优化：缓存 DeepSeek function-calling 格式的工具定义，
   * 避免每轮模型调用重复执行 zod → JSON Schema 转换；register 时失效。
   */
  private apiToolsCache: DeepSeekApiTool[] | null = null;
  /** v4.0 M4：插件工具权限钩子（未设置 = 不拦截，内置工具场景默认无钩子）。 */
  private permissionCheck: PermissionCheck | undefined;

  /**
   * 设置插件工具权限钩子（v4.0 M4）。只影响带 pluginSource 的工具，内置工具零影响。
   * 返回 this 便于链式装配。
   */
  setPermissionCheck(check: PermissionCheck): this {
    this.permissionCheck = check;
    return this;
  }

  register(spec: ToolSpec): this {
    if (this.tools.has(spec.name)) {
      throw new Error(`工具重复注册: ${spec.name}`);
    }
    this.tools.set(spec.name, spec);
    this.apiToolsCache = null;
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /** 返回 DeepSeek function-calling 格式的工具定义（缓存结果，register 后自动失效）。 */
  toApiTools(): DeepSeekApiTool[] {
    if (this.apiToolsCache === null) {
      this.apiToolsCache = toApiTools(this.list());
    }
    return this.apiToolsCache;
  }

  /**
   * 按名分发：zod 校验参数 → 执行 → 结果。
   * 未知工具、参数校验失败、执行异常均转为 ok:false 的结构化结果，不向上抛。
   */
  async run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const spec = this.tools.get(name);
    if (spec === undefined) {
      return {
        ok: false,
        error: `未知工具: ${name}`,
        code: 'UNKNOWN_TOOL',
        suggestion: `工具 ${name} 不存在：请使用注册表可用工具（如 read_file / list_directory / edit_file / run_command）`,
        repairable: false,
      };
    }
    const parsed = spec.parameters.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `参数校验失败: ${formatIssues(parsed.error)}`, repairable: true };
    }
    // v4.0 M4：插件工具权限拦截（方案 C——只影响带 pluginSource 的工具，内置工具零影响）。
    // 未设置 permissionCheck 钩子 = 无插件装配场景，直接放行（保持旧行为）。
    if (spec.pluginSource !== undefined && this.permissionCheck !== undefined) {
      let allowed: boolean;
      try {
        allowed = await this.permissionCheck(spec.pluginSource, spec.pluginPermission, parsed.data);
      } catch {
        // 钩子异常 → fail-closed（权限检查失败即拒绝）
        allowed = false;
      }
      if (!allowed) {
        return {
          ok: false,
          error: `插件 ${spec.pluginSource} 未声明执行 ${name} 所需权限，已拒绝。`,
          code: 'PLUGIN_PERMISSION_DENIED',
          repairable: false,
        };
      }
    }
    try {
      return await spec.execute(parsed.data, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 兜底：工具未显式分类的异常，按错误特征补 code/suggestion（v3.1 M4）
      const code = inferErrorCode(error);
      // 路径越界属不可修复错误（模型侧幻觉路径），其余异常视为可修复
      return {
        ok: false,
        error: message,
        repairable: !message.includes('越界'),
        ...(code !== undefined ? { code, suggestion: TOOL_ERROR_SUGGESTIONS[code] } : {}),
      };
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
