/**
 * 插件运行时装配（v4.0 M4 / T4.2 运行时权限拦截核心）。
 *
 * 链路：PluginLoader.loadAll → PluginManager.registerAll → 动态 import entry（ESM）→
 * 插件工具注册进 ToolRegistry（带 pluginSource / pluginPermission）→ 工具调用前
 * ToolRegistry.permissionCheck 拦截（fail-closed + 审计）；shell 权限额外走宿主审批流。
 *
 * 插件 entry 导出 `create(ctx)`，返回两种形态之一（兼容单工具与多工具插件）：
 * - `{ id, run, permission?, description?, parameters?, parallelSafe? }`（单工具）
 * - `{ tools: [...] }`（多工具，每项同上）
 *
 * 安全边界（v4.0）：插件代码在宿主进程内执行，guard 拦截「模型调用插件工具」路径；
 * 插件代码内部任意 Node 调用（fs / child_process）超出 v4.0 拦截范围，由 v4.1 子进程沙箱解决。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import type { AuditLogger } from '../observable/audit';
import type { ToolContext, ToolRegistry, ToolResult, ToolSpec } from '../tools/registry';
import { PluginLoader } from './loader';
import { PluginManager } from './manager';
import type { Plugin, PluginContext, PluginPermissionType } from './types';

/** 插件工具声明（entry 的 create 返回值元素）。 */
export interface PluginToolDef {
  /** 工具名（注册进 ToolRegistry，模型可直接调用）。 */
  id: string;
  /** 工具描述（模型 function-calling 用）。 */
  description?: string;
  /** 参数 zod schema（缺省宽松对象，不校验）。 */
  parameters?: z.ZodTypeAny;
  /** 是否可并行（只读工具为 true；shell/写盘必须 false）。 */
  parallelSafe?: boolean;
  /** 所需权限类型（缺省 = 无需敏感权限，直接放行）。 */
  permission?: PluginPermissionType;
  /** 执行体：入参（已过 parameters 校验）+ 插件上下文。 */
  run: (args: unknown, ctx: PluginContext) => unknown | Promise<unknown>;
}

/** entry 的 create 返回值：单工具或多工具。 */
export type PluginInstance = PluginToolDef | { tools: PluginToolDef[] };

/** 装配结果（mounted = 成功装配工具的插件；rejected = 加载或装配失败的条目）。 */
export interface PluginMountResult {
  mounted: Plugin[];
  rejected: { name: string; reason: string }[];
}

/**
 * 插件运行时：加载 → 注册 → 工具注入 → 权限钩子装配。
 * 由 chat/run 装配点创建（mount 时注入 cwd 与 ToolContext）。
 */
export class PluginRuntime {
  private readonly manager: PluginManager;
  /** 已装配工具的插件（mount 后可用）。 */
  private mounted = new Map<string, Plugin>();

  constructor(options: { audit?: AuditLogger } = {}) {
    this.manager = new PluginManager({ audit: options.audit });
  }

  /**
   * 装配全部插件到工具注册表：
   * 1. PluginLoader.loadAll(cwd) 扫描全局 + 项目插件目录；
   * 2. PluginManager.registerAll（权限强制器就绪）；
   * 3. 逐个动态 import entry → create → 工具注册（shell 审批包装 + 权限标记）；
   * 4. registry.setPermissionCheck（插件工具调用前 guard）。
   *
   * @returns 装配结果（单个插件失败不影响其他，隔离记录 rejected）。
   */
  async mount(
    registry: ToolRegistry,
    cwd: string,
    toolCtx: ToolContext,
  ): Promise<PluginMountResult> {
    const loader = new PluginLoader();
    const loaded = loader.loadAll(cwd);
    this.manager.registerAll(loaded.plugins);

    const rejected: { name: string; reason: string }[] = [...loaded.rejected];
    for (const plugin of loaded.plugins) {
      try {
        const tools = await this.loadPluginTools(plugin, toolCtx);
        for (const def of tools) {
          registry.register(this.buildToolSpec(plugin, def, toolCtx));
        }
        this.mounted.set(plugin.name, plugin);
      } catch (err) {
        rejected.push({
          name: plugin.name,
          reason: `工具装配失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 权限钩子：插件工具调用前检查（未设置 permissionCheck = 无插件场景，保持旧行为）
    registry.setPermissionCheck((pluginSource, permission) => {
      const pluginName = pluginSource.startsWith('plugin:')
        ? pluginSource.slice('plugin:'.length)
        : pluginSource;
      const plugin = this.manager.get(pluginName);
      if (plugin === undefined) {
        return false; // 未注册插件 → 拒绝（fail-closed）
      }
      if (permission === undefined) {
        return true; // 无需敏感权限的工具直接放行
      }
      return this.manager.guard(pluginName, permission);
    });

    return { mounted: this.list(), rejected };
  }

  /** 已装配插件列表（按名称字典序）。 */
  list(): Plugin[] {
    return [...this.mounted.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称获取已装配插件。 */
  get(name: string): Plugin | undefined {
    return this.mounted.get(name);
  }

  // ── 内部 ─────────────────────────────────────────────────────

  /** 动态 import 插件 entry（ESM），调 create(ctx) 提取工具列表。 */
  private async loadPluginTools(plugin: Plugin, toolCtx: ToolContext): Promise<PluginToolDef[]> {
    const sourceDir = plugin.sourceDir;
    if (sourceDir === undefined) {
      throw new Error('插件缺少 sourceDir（未从磁盘加载）');
    }
    const entryPath = path.join(sourceDir, plugin.entry);
    const mod = (await import(pathToFileURL(entryPath).href)) as {
      create?: (ctx: PluginContext) => PluginInstance;
    };
    if (typeof mod.create !== 'function') {
      throw new Error(`入口未导出 create() 函数（${plugin.entry}）`);
    }
    const ctx = this.buildPluginContext(plugin, toolCtx);
    const instance = mod.create(ctx);
    // 兼容两种形态：{ id, run } 单工具 / { tools: [...] } 多工具
    const multi = instance as { tools?: PluginToolDef[] };
    const tools: PluginToolDef[] = Array.isArray(multi.tools)
      ? multi.tools
      : [instance as PluginToolDef];
    return tools;
  }

  /** 插件上下文：t() 合并、logger、cwd、requestApproval 透传、guard 细粒度检查。 */
  private buildPluginContext(plugin: Plugin, toolCtx: ToolContext): PluginContext {
    return {
      t: (key: string): string => plugin.i18n?.[key] ?? key,
      logger: (message: string): void => {
        console.log(`[plugin:${plugin.name}] ${message}`);
      },
      cwd: toolCtx.cwd,
      requestApproval: toolCtx.requestApproval,
      guard: (type, detail): boolean => this.manager.guard(plugin.name, type, detail),
    };
  }

  /** 构建 ToolSpec：权限标记 + shell 审批包装 + 异常隔离。 */
  private buildToolSpec(plugin: Plugin, def: PluginToolDef, toolCtx: ToolContext): ToolSpec {
    const pluginSource = `plugin:${plugin.name}`;
    const spec: ToolSpec = {
      name: def.id,
      description: def.description ?? `插件 ${plugin.name} 提供的工具`,
      parameters: def.parameters ?? z.object({}).passthrough(),
      parallelSafe: def.parallelSafe ?? false,
      pluginSource,
      pluginPermission: def.permission,
      execute: async (args: unknown, execCtx: ToolContext): Promise<ToolResult> => {
        // shell 权限：guard 通过后仍走宿主审批流（插件不可绕过，fail-closed）。
        // 审批回调取 mount 时注入的 toolCtx（闭包捕获），而非 run 时传入的 execCtx——
        // run 调用方可能只传 { cwd }，不携带 requestApproval，导致审批被静默跳过。
        const approvalCtx = toolCtx.requestApproval ?? execCtx.requestApproval;
        if (def.permission === 'shell' && approvalCtx !== undefined) {
          const approved = await approvalCtx({
            kind: 'shell',
            summary: `插件 ${plugin.name} 请求执行 Shell 命令`,
            detail: JSON.stringify(args),
          });
          if (!approved) {
            return {
              ok: false,
              error: `插件 ${plugin.name} 的 Shell 命令未获批准，已拒绝执行。`,
              code: 'APPROVAL_DENIED',
              repairable: false,
            };
          }
        }
        try {
          const result = await def.run(args, this.buildPluginContext(plugin, toolCtx));
          return { ok: true, data: result };
        } catch (err) {
          return {
            ok: false,
            error: `插件 ${plugin.name} 工具 ${def.id} 执行失败: ${err instanceof Error ? err.message : String(err)}`,
            repairable: true,
          };
        }
      },
    };
    return spec;
  }
}
