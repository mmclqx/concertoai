/**
 * 市场注册表读写（v3.0 M4 / T4.1；v4.0 M4 / T4.3 扩展 plugins[]）。
 *
 * 复用技能市场 registry.json 结构（registry + skills[] / agents[] / plugins[]），
 * 用 zod schema 校验注册表结构（与 T1.2 AgentDef zod schema 校验策略一致）。
 *
 * - parseMarketRegistry：校验任意注册表 JSON（skill + agent + plugin 条目，type 区分）；
 * - fetchMarketRegistry：网络获取注册表；
 * - fetchAgentContent：下载 Agent 包 + sha256 校验（复用共享 fetchVerifiedContent，
 *   T4.2 安装器 / 技能市场共用同一底层逻辑）；
 * - loadBuiltinRegistry：内置注册表（4 个 Agent + 4 个示例插件）。
 */

import { z } from 'zod';
import type { AgentDef } from '../orchestrator';
import { fetchVerifiedContent } from './download';
import type { AgentRegistryItem, MarketRegistry, PluginRegistryItem, RegistryItem } from './types';
import { BUILTIN_REGISTRY } from './types';

// ── zod schema（注册表校验，T4.1 验收标准 3：共用 schema 校验）─

/** Agent 条目 schema（扩展 AgentDef.interfaces/permissions + runtime）。 */
const agentItemSchema = z.object({
  type: z.literal('agent'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  author: z.string().default(''),
  url: z.string().url(),
  sha256: z.string().min(1),
  interfaces: z.object({
    // 条目中为描述性结构（真实 zod schema 在 Agent 实现侧）；类型对齐 AgentDef.interfaces
    input: z.custom<AgentDef['interfaces']['input']>(),
    output: z.custom<AgentDef['interfaces']['output']>(),
    version: z.string().min(1),
  }),
  permissions: z.array(
    z.object({
      tool: z.string().min(1),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  runtime: z.enum(['builtin', 'external']).default('external'),
});

/** 技能条目 schema（v2.1 技能市场兼容）。 */
const skillItemSchema = z.object({
  type: z.literal('skill'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  author: z.string().default(''),
  url: z.string().url(),
  sha256: z.string().min(1),
});

/** 插件条目 schema（v4.0 M4 / T4.3：category/downloads/rating/permissions 六类权限声明）。 */
const pluginItemSchema = z.object({
  type: z.literal('plugin'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  author: z.string().default(''),
  url: z.string().url(),
  sha256: z.string().min(1),
  category: z.enum(['tool', 'workflow', 'agent']).default('tool'),
  downloads: z.number().int().nonnegative().default(0),
  rating: z.number().min(0).max(5).default(0),
  permissions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('read'), paths: z.array(z.string()).optional() }),
        z.object({ type: z.literal('write'), paths: z.array(z.string()).optional() }),
        z.object({
          type: z.literal('network'),
          allowedDomains: z.array(z.string()).optional(),
        }),
        z.object({ type: z.literal('shell'), allowlist: z.array(z.string()).optional() }),
        z.object({ type: z.literal('knowledge') }),
        z.object({ type: z.literal('mcp'), servers: z.array(z.string()).optional() }),
      ]),
    )
    .default([]),
});

/** 完整注册表 schema（registry + skills[] + agents[] + plugins[]，旧条目完全兼容）。 */
const marketRegistrySchema = z.object({
  registry: z.string().url(),
  skills: z.array(skillItemSchema).default([]),
  agents: z.array(agentItemSchema).default([]),
  plugins: z.array(pluginItemSchema).default([]),
});

// ── 校验 / 解析 ───────────────────────────────────────────────

/**
 * 解析并校验注册表 JSON。
 * 结构不合法（缺 registry / 条目字段缺失 / 类型错误）→ 抛中文错误。
 */
export function parseMarketRegistry(json: string): MarketRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new Error(
      `注册表解析失败: 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  const result = marketRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`注册表解析失败: 结构不符合协议（${issues}）`);
  }
  return result.data;
}

/** 校验单个注册表条目是否为合法 Agent 条目（T4.2 接口合规检查前置）。 */
export function parseAgentItem(json: string): AgentRegistryItem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new Error(
      `Agent 条目解析失败: 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  const result = agentItemSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Agent 条目解析失败: 结构不符合协议（${issues}）`);
  }
  return result.data;
}

// ── 网络 / 内置加载 ───────────────────────────────────────────

/** 默认注册表 URL（内置）。 */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/concertoai/cli/main/skills/registry.json';

/** 从 URL fetch 并解析注册表（失败返回 null，与技能市场 fetchRegistry 一致）。 */
export async function fetchMarketRegistry(
  url: string = DEFAULT_REGISTRY_URL,
): Promise<MarketRegistry | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return null;
    }
    return parseMarketRegistry(await resp.text());
  } catch {
    return null;
  }
}

/** 下载 Agent 包内容并校验 sha256（失败返回 null；复用共享下载函数）。 */
export async function fetchAgentContent(
  url: string,
  expectedSha256: string,
): Promise<string | null> {
  return fetchVerifiedContent(url, expectedSha256);
}

/** 加载内置注册表（4 个内置 Agent 条目）。 */
export function loadBuiltinRegistry(): MarketRegistry {
  return BUILTIN_REGISTRY;
}

/** 列出全部 Agent 条目（内置 + 外部；按名称字典序）。 */
export function listAgentItems(registry: MarketRegistry): AgentRegistryItem[] {
  return [...registry.agents].sort((a, b) => a.name.localeCompare(b.name));
}

/** 按名称查找 Agent 条目（不存在返回 undefined）。 */
export function findAgentItem(
  registry: MarketRegistry,
  name: string,
): AgentRegistryItem | undefined {
  return registry.agents.find((a) => a.name === name);
}

// ── 插件条目（v4.0 M4 / T4.3）───────────────────────────────

/** 列出全部插件条目（内置 + 外部；按名称字典序）。 */
export function listPluginItems(registry: MarketRegistry): PluginRegistryItem[] {
  return [...registry.plugins].sort((a, b) => a.name.localeCompare(b.name));
}

/** 按名称查找插件条目（不存在返回 undefined）。 */
export function findPluginItem(
  registry: MarketRegistry,
  name: string,
): PluginRegistryItem | undefined {
  return registry.plugins.find((p) => p.name === name);
}

/**
 * 模糊搜索插件条目（名称 / 描述 / 作者 / 分类，不区分大小写）。
 * 关键词为空 → 返回全部（browse 无参场景复用）。命中按下载量降序。
 */
export function searchPluginItems(
  registry: MarketRegistry,
  keyword?: string,
): PluginRegistryItem[] {
  const kw = keyword?.trim().toLowerCase();
  const matched =
    kw === undefined || kw === ''
      ? registry.plugins
      : registry.plugins.filter(
          (p) =>
            p.name.toLowerCase().includes(kw) ||
            p.description.toLowerCase().includes(kw) ||
            p.author.toLowerCase().includes(kw) ||
            p.category.toLowerCase().includes(kw),
        );
  return [...matched].sort((a, b) => b.downloads - a.downloads);
}

/** 全部条目（skill + agent + plugin 合并，供 /agent search 等命令）。 */
export function listAllItems(registry: MarketRegistry): RegistryItem[] {
  return [...registry.skills, ...registry.agents, ...registry.plugins].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
