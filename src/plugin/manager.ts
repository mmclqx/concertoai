/**
 * 插件管理器（v4.0 M4 / T4.2）。
 *
 * 插件生命周期：加载（PluginLoader）→ 注册 → 运行时权限拦截。
 * - 权限：每个插件一个 PermissionEnforcer，插件发起敏感操作前必须 guard()；
 * - shell 权限：guard 通过后仍走核心审批流（插件不可绕过，由工具层审批兜底）。
 *
 * v4.0 无 hooks（JSON 无法表达函数；生命周期钩子留待 v4.1 子进程沙箱统一设计）。
 * 本版进程内 + 权限拦截（§3.2/§3.6）；子进程隔离延后 v4.1。
 */

import type { AuditLogger } from '../observable/audit';
import { PermissionEnforcer } from './permissions';
import type { Plugin, PluginPermissionType } from './types';

/** 插件管理器选项（测试可注入）。 */
export interface PluginManagerOptions {
  /** 审计日志（权限拒绝事件落盘）。 */
  audit?: AuditLogger;
}

/**
 * 插件管理器：持有已加载插件 + 各自的权限强制器。
 * 由 chat/run 装配时创建（loadAll 注入 cwd），供插件钩子与权限拦截消费。
 */
export class PluginManager {
  private readonly plugins = new Map<string, Plugin>();
  private readonly enforcers = new Map<string, PermissionEnforcer>();
  private readonly audit?: AuditLogger;

  constructor(options: PluginManagerOptions = {}) {
    this.audit = options.audit;
  }

  /** 注册插件（加载器结果回填；重复注册覆盖）。 */
  register(plugin: Plugin): void {
    this.plugins.set(plugin.name, plugin);
    this.enforcers.set(
      plugin.name,
      new PermissionEnforcer(plugin.permissions, plugin.name, this.audit),
    );
  }

  /** 批量注册（loader.loadAll 结果）。 */
  registerAll(plugins: Plugin[]): void {
    for (const p of plugins) {
      this.register(p);
    }
  }

  /** 移除插件（卸载场景）。 */
  unregister(name: string): void {
    this.plugins.delete(name);
    this.enforcers.delete(name);
  }

  /** 已注册插件列表（按名称字典序）。 */
  list(): Plugin[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称获取插件。 */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /** 获取插件的权限强制器（未注册返回 undefined）。 */
  enforcerOf(name: string): PermissionEnforcer | undefined {
    return this.enforcers.get(name);
  }

  /**
   * 运行时权限守卫（T4.2 验收标准：未声明权限被拦截 + 提示 + 审计）。
   * @param pluginName 发起操作的插件名
   * @param type 请求权限类型
   * @param detail 附加详情（network url / shell command / mcp server / path）
   * @returns true = 允许；false = 拒绝（插件未注册 / 未声明权限 / 白名单不通过）
   */
  guard(
    pluginName: string,
    type: PluginPermissionType,
    detail?: { url?: string; command?: string; server?: string; path?: string },
  ): boolean {
    const enforcer = this.enforcers.get(pluginName);
    if (enforcer === undefined) {
      // 未注册插件 → 拒绝（fail-closed）
      return false;
    }
    return enforcer.guard(type, detail);
  }
}
