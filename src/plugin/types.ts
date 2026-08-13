/**
 * 插件类型定义（v4.0 M4 / T4.4）。
 *
 * 统一插件描述格式 plugin.json（name/version/description/author/category/permissions/entry/hooks/i18n），
 * 开发者只需写一个 JSON + 一个 ESM 入口文件。插件必须 ESM（与运行时一致，§3.5 破坏性变更）。
 *
 * 权限模型（T4.2）：六类权限 read / write / network / shell / knowledge / mcp，
 * 安装时展示权限清单（彩色图标），运行时未声明权限 → 拒绝 + 审计（fail-closed）。
 */

import { z } from 'zod';

/** 插件分类（browse 按此分类：🔧工具 / 📋工作流 / 🤖Agent）。 */
export type PluginCategory = 'tool' | 'workflow' | 'agent';

/** 六类权限（T4.2）：read / write / network（allowedDomains 白名单）/ shell / knowledge / mcp。 */
export type PluginPermission =
  | { type: 'read'; paths?: string[] }
  | { type: 'write'; paths?: string[] }
  | { type: 'network'; allowedDomains?: string[] }
  | { type: 'shell'; allowlist?: string[] }
  | { type: 'knowledge' }
  | { type: 'mcp'; servers?: string[] };

/** 权限类型字面量（guard 请求用）。 */
export type PluginPermissionType = PluginPermission['type'];

/**
 * 插件运行时上下文（v4.0 M4 装配时注入）。
 * - t()：i18n（插件自带字典优先，核心字典兜底）；
 * - logger：插件日志（不落审计）；
 * - requestApproval：宿主审批回调（shell 权限插件不可绕过，fail-closed）；
 * - guard：运行时权限细粒度检查（network 域名 / shell 命令 / mcp 服务白名单）。
 *
 * v4.0 无 hooks（JSON 无法表达函数；生命周期钩子留待 v4.1 子进程沙箱统一设计）。
 */
export interface PluginContext {
  /** i18n 翻译函数（核心字典 + 插件自带 i18n 字典合并）。 */
  t: (key: string) => string;
  /** 日志输出（写插件日志，不落审计）。 */
  logger: (message: string) => void;
  /** 项目根目录（cwd）。 */
  cwd: string;
  /** 宿主审批回调（透传 ToolContext.requestApproval；shell 权限必须经此审批）。 */
  requestApproval?: (request: {
    kind: 'edit' | 'shell';
    summary: string;
    detail: string;
  }) => Promise<boolean> | boolean;
  /** 运行时权限细粒度检查（network/shell/mcp 白名单；未声明 → false + 审计）。 */
  guard: (
    type: PluginPermissionType,
    detail?: { url?: string; command?: string; server?: string; path?: string },
  ) => boolean;
}

/** 插件定义（plugin.json 解析结果，加载器校验后注册）。 */
export interface Plugin {
  /** 插件名（唯一，目录名 = 插件名）。 */
  name: string;
  /** 版本号（semver）。 */
  version: string;
  /** 描述。 */
  description: string;
  /** 作者。 */
  author: string;
  /** 分类（tool / workflow / agent）。 */
  category: PluginCategory;
  /** 权限声明（六类权限；空 = 无权限，运行时一切敏感操作拒绝）。 */
  permissions: PluginPermission[];
  /** ESM 入口文件（相对插件目录，如 index.mjs；.js 需目录 package.json type=module）。 */
  entry: string;
  /** 插件自带 i18n 字典（键 → 文案，与核心字典合并；可选）。 */
  i18n?: Record<string, string>;
  /** 来源路径（plugin.json 所在目录）。 */
  sourceDir?: string;
}

// ── plugin.json zod schema（T4.4 验收标准：解析 + zod schema 校验）────────

/** 六类权限 zod schema（network 白名单 / shell 白名单校验）。 */
export const pluginPermissionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), paths: z.array(z.string()).optional() }),
  z.object({ type: z.literal('write'), paths: z.array(z.string()).optional() }),
  z.object({
    type: z.literal('network'),
    allowedDomains: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('shell'), allowlist: z.array(z.string()).optional() }),
  z.object({ type: z.literal('knowledge') }),
  z.object({ type: z.literal('mcp'), servers: z.array(z.string()).optional() }),
]);

/** plugin.json 完整 schema（entry 必填 = ESM 入口；i18n 可选；v4.0 无 hooks 字段）。 */
export const pluginJsonSchema = z
  .object({
    name: z.string().min(1, 'name 不能为空'),
    version: z.string().min(1, 'version 不能为空'),
    description: z.string().default(''),
    author: z.string().default(''),
    category: z.enum(['tool', 'workflow', 'agent']).default('tool'),
    permissions: z.array(pluginPermissionSchema).default([]),
    entry: z.string().min(1, 'entry 不能为空（ESM 入口文件）'),
    i18n: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** 解析并校验 plugin.json 内容（失败返回 null + 错误信息）。 */
export function parsePluginJson(json: string): { plugin: Plugin } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    return { error: `不是合法 JSON（${err instanceof Error ? err.message : String(err)}）` };
  }
  const result = pluginJsonSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { error: `结构不符合 plugin.json 协议（${issues}）` };
  }
  return { plugin: result.data as Plugin };
}
