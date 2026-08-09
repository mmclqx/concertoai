/**
 * Agent 注册表（v3.0 M1 / T1.2）。
 *
 * 管理 Agent 定义与实现实例，供 Orchestrator 调度器、审批流与 Agent 市场
 * （T4.1/T4.2）消费。类型与 T1.1（src/orchestrator/types.ts）一致，不重复定义。
 * 权限声明直接读取自 AgentDef.permissions（ADR-004 fail-closed：未声明工具一律拒绝）。
 */

import type { AgentDef, AgentPermission } from '../orchestrator';
import type { Agent } from './protocol';

/** 注册条目：Agent 定义 + 可选实现实例。 */
export interface AgentEntry<TDef extends AgentDef = AgentDef> {
  /** Agent 定义（名称/版本/接口 Schema/权限声明）。 */
  def: TDef;
  /** 实现实例（未提供时仅注册定义，执行由外部解析器接管）。 */
  impl?: Agent<TDef>;
}

/**
 * Agent 注册表接口。
 *
 * 注册/查询/卸载的最小契约，供调度器、审批流与市场安装器使用。
 */
export interface AgentRegistry {
  /** 注册一个 Agent 定义（可选关联实现实例）。同名重复注册抛错。 */
  register(def: AgentDef, impl?: Agent): void;

  /** 卸载指定名称的 Agent，返回是否成功（不存在返回 false）。 */
  unregister(name: string): boolean;

  /** 按名称查询注册条目（不存在返回 undefined）。 */
  get(name: string): AgentEntry | undefined;

  /** 列出全部注册条目（按名称字典序）。 */
  list(): AgentEntry[];

  /** 是否存在指定名称的 Agent。 */
  has(name: string): boolean;

  /** 读取指定 Agent 的权限声明（供调度器与审批流做 fail-closed 校验）。 */
  permissionsOf(name: string): AgentPermission[] | undefined;
}

/** 内存版 Agent 注册表（单线程 JS 天然安全，无需锁；实例级隔离）。 */
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();

  register(def: AgentDef, impl?: Agent): void {
    if (this.entries.has(def.name)) {
      throw new Error(`Agent 已存在: ${def.name}（需先 unregister 或使用其他名称）`);
    }
    this.entries.set(def.name, { def, impl });
  }

  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  get(name: string): AgentEntry | undefined {
    return this.entries.get(name);
  }

  list(): AgentEntry[] {
    return [...this.entries.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  permissionsOf(name: string): AgentPermission[] | undefined {
    return this.entries.get(name)?.def.permissions;
  }
}
