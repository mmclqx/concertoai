/**
 * 市场注册表测试（v3.0 M4 / T4.1；v4.0 M4 / T4.3 扩展 plugins[]）。
 *
 * 覆盖验收标准：
 * - 复用技能市场 registry.json 结构（registry + skills[] / agents[] / plugins[]），条目含 type 区分；
 * - Agent 条目扩展 AgentDef 字段（interfaces/permissions/runtime）+ 接口版本号；
 * - 注册表读写用 zod schema 校验（共用校验逻辑）；
 * - 内置注册表初始包含 4 个内置 Agent 条目 + 4 个示例插件条目；
 * - plugins[] 扩展对旧 skill/agent 条目完全兼容（回归）。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_ITEMS,
  BUILTIN_PLUGIN_ITEMS,
  BUILTIN_REGISTRY,
  findAgentItem,
  findPluginItem,
  listAgentItems,
  listPluginItems,
  loadBuiltinRegistry,
  type MarketRegistry,
  parseAgentItem,
  parseMarketRegistry,
  searchPluginItems,
} from '../../src/market';

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造一个合法 Agent 条目 JSON。 */
function makeAgentJson(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: 'agent',
    name: 'my-agent',
    version: '1.0.0',
    description: '测试 Agent',
    author: 'tester',
    url: 'https://example.com/agent.js',
    sha256: 'abc123',
    interfaces: { input: { x: 1 }, output: { y: 2 }, version: '1.0.0' },
    permissions: [{ tool: 'read_file' }],
    runtime: 'external',
    ...overrides,
  });
}

/** 构造一个完整注册表 JSON。 */
function makeRegistryJson(): string {
  return JSON.stringify({
    registry: 'https://example.com/registry.json',
    skills: [
      {
        type: 'skill',
        name: 'code-review',
        version: '1.0.0',
        description: '审查',
        author: 'ConcertoAI',
        url: 'https://example.com/skill.md',
        sha256: 'def456',
      },
    ],
    agents: [JSON.parse(makeAgentJson()) as unknown],
  });
}

// ── parseMarketRegistry ───────────────────────────────────────

describe('parseMarketRegistry（注册表校验）', () => {
  it('解析合法注册表：skills[] + agents[] 均保留，type 区分', () => {
    const registry = parseMarketRegistry(makeRegistryJson());
    expect(registry.skills).toHaveLength(1);
    expect(registry.skills[0]?.type).toBe('skill');
    expect(registry.agents).toHaveLength(1);
    expect(registry.agents[0]?.type).toBe('agent');
    expect(registry.agents[0]?.name).toBe('my-agent');
  });

  it('缺 registry 字段 → 抛中文错误', () => {
    const json = JSON.stringify({ skills: [], agents: [] });
    expect(() => parseMarketRegistry(json)).toThrow(/注册表解析失败.*结构不符合协议/s);
  });

  it('条目缺 sha256 → 抛错', () => {
    const json = JSON.stringify({
      registry: 'https://example.com/r.json',
      skills: [],
      agents: [JSON.parse(makeAgentJson({ sha256: undefined })) as unknown],
    });
    expect(() => parseMarketRegistry(json)).toThrow(/结构不符合协议/);
  });

  it('非法 JSON → 抛中文错误', () => {
    expect(() => parseMarketRegistry('{not json')).toThrow(/不是合法 JSON/);
  });
});

// ── parseAgentItem / 条目字段 ─────────────────────────────────

describe('parseAgentItem（Agent 条目校验）', () => {
  it('合法条目：interfaces（含接口版本号）+ permissions + runtime', () => {
    const item = parseAgentItem(makeAgentJson());
    expect(item.type).toBe('agent');
    expect(item.interfaces.version).toBe('1.0.0');
    expect(item.permissions).toHaveLength(1);
    expect(item.permissions[0]?.tool).toBe('read_file');
    expect(item.runtime).toBe('external');
  });

  it('缺 runtime → 默认 external（schema default）', () => {
    const item = parseAgentItem(makeAgentJson({ runtime: undefined }));
    expect(item.runtime).toBe('external');
  });

  it('缺 permissions → 抛错（Agent 必须声明权限，fail-closed）', () => {
    expect(() => parseAgentItem(makeAgentJson({ permissions: undefined }))).toThrow(
      /结构不符合协议/,
    );
  });

  it('type 为 skill → 不匹配 agent schema，抛错', () => {
    expect(() => parseAgentItem(makeAgentJson({ type: 'skill' }))).toThrow(/结构不符合协议/);
  });
});

// ── plugins[] 扩展（v4.0 M4 / T4.3）──────────────────────────

describe('parseMarketRegistry（plugins[] 扩展）', () => {
  it('解析含 plugins[] 的注册表：type 区分 + 六类权限保留', () => {
    const json = JSON.stringify({
      registry: 'https://example.com/registry.json',
      skills: [],
      agents: [],
      plugins: [
        {
          type: 'plugin',
          name: 'api-docs',
          version: '1.0.0',
          description: 'API 文档生成',
          author: 'ConcertoAI',
          url: 'https://example.com/api-docs.mjs',
          sha256: 'abc123',
          category: 'tool',
          downloads: 980,
          rating: 4.5,
          permissions: [
            { type: 'read', paths: ['src'] },
            { type: 'network', allowedDomains: ['api.example.com'] },
          ],
        },
      ],
    });
    const registry = parseMarketRegistry(json);
    expect(registry.plugins).toHaveLength(1);
    const p = registry.plugins[0];
    expect(p?.type).toBe('plugin');
    expect(p?.name).toBe('api-docs');
    expect(p?.category).toBe('tool');
    expect(p?.downloads).toBe(980);
    expect(p?.rating).toBe(4.5);
    expect(p?.permissions).toHaveLength(2);
    expect(p?.permissions[1]).toEqual({ type: 'network', allowedDomains: ['api.example.com'] });
  });

  it('缺 plugins 字段 → 默认空数组（旧注册表完全兼容）', () => {
    const json = JSON.stringify({
      registry: 'https://example.com/registry.json',
      skills: [],
      agents: [JSON.parse(makeAgentJson()) as unknown],
    });
    const registry = parseMarketRegistry(json);
    expect(registry.plugins).toEqual([]);
    expect(registry.agents).toHaveLength(1);
  });

  it('插件条目权限声明非法 → 抛中文错误（fail-closed）', () => {
    const json = JSON.stringify({
      registry: 'https://example.com/registry.json',
      plugins: [
        {
          type: 'plugin',
          name: 'evil',
          version: '1.0.0',
          url: 'https://example.com/evil.mjs',
          sha256: 'x',
          permissions: [{ type: 'sudo' }],
        },
      ],
    });
    expect(() => parseMarketRegistry(json)).toThrow(/结构不符合协议/);
  });
});

// ── 内置注册表 ────────────────────────────────────────────────

describe('内置注册表（4 个内置 Agent）', () => {
  it('loadBuiltinRegistry 返回 skills + 4 个 agents', () => {
    const registry = loadBuiltinRegistry();
    expect(registry.agents).toHaveLength(4);
    expect(registry.skills).toEqual([]);
  });

  it('内置 4 个 Agent：architect/coder/reviewer/qa（名称与权限匹配）', () => {
    const names = BUILTIN_AGENT_ITEMS.map((a) => a.name).sort();
    expect(names).toEqual(['architect', 'coder', 'qa', 'reviewer']);

    const architect = findAgentItem(BUILTIN_REGISTRY, 'architect');
    expect(architect?.runtime).toBe('builtin');
    // architect 只读权限
    expect(architect?.permissions.map((p) => p.tool)).toEqual([
      'read_file',
      'list_directory',
      'search_content',
    ]);

    const coder = findAgentItem(BUILTIN_REGISTRY, 'coder');
    expect(coder?.permissions.map((p) => p.tool)).toEqual(['edit_file']);

    const qa = findAgentItem(BUILTIN_REGISTRY, 'qa');
    expect(qa?.permissions[0]?.tool).toBe('run_command');
    expect((qa?.permissions[0]?.args as { command?: string } | undefined)?.command).toBe(
      'npm run verify',
    );
  });

  it('listAgentItems 按名称字典序', () => {
    const items = listAgentItems(BUILTIN_REGISTRY);
    const names = items.map((i) => i.name);
    expect(names).toEqual(['architect', 'coder', 'qa', 'reviewer']);
  });

  it('findAgentItem 不存在返回 undefined', () => {
    expect(findAgentItem(BUILTIN_REGISTRY, 'ghost')).toBeUndefined();
  });

  it('全部条目可序列化为 MarketRegistry（AgentRegistryItem[] 结构）', () => {
    const registry: MarketRegistry = BUILTIN_REGISTRY;
    const agentNames: string[] = [];
    for (const item of registry.agents) {
      agentNames.push(item.name);
    }
    expect(agentNames).toHaveLength(4);
  });
});

// ── 内置插件条目（v4.0 M4 / T4.3）────────────────────────────

describe('内置插件条目（4 个示例插件）', () => {
  it('BUILTIN_PLUGIN_ITEMS：4 个示例插件（git-status/api-docs/todo-tracker/release-helper）', () => {
    const names = BUILTIN_PLUGIN_ITEMS.map((p) => p.name).sort();
    expect(names).toEqual(['api-docs', 'git-status', 'release-helper', 'todo-tracker']);
    // 全部 sha256='builtin'（内置直装，不下载）
    for (const p of BUILTIN_PLUGIN_ITEMS) {
      expect(p.sha256).toBe('builtin');
    }
  });

  it('findPluginItem 命中内置条目并返回权限声明', () => {
    const item = findPluginItem(BUILTIN_REGISTRY, 'release-helper');
    expect(item?.category).toBe('workflow');
    expect(item?.permissions).toEqual([
      { type: 'read', paths: ['package.json'] },
      { type: 'shell', allowlist: ['npm run verify'] },
    ]);
    expect(findPluginItem(BUILTIN_REGISTRY, 'ghost')).toBeUndefined();
  });

  it('listPluginItems 按名称字典序', () => {
    const items = listPluginItems(BUILTIN_REGISTRY);
    expect(items.map((i) => i.name)).toEqual([
      'api-docs',
      'git-status',
      'release-helper',
      'todo-tracker',
    ]);
  });

  it('searchPluginItems：按名称/描述/分类匹配 + 下载量降序', () => {
    const byName = searchPluginItems(BUILTIN_REGISTRY, 'todo');
    expect(byName.map((p) => p.name)).toEqual(['todo-tracker']);

    const byDesc = searchPluginItems(BUILTIN_REGISTRY, '文档');
    expect(byDesc.map((p) => p.name)).toEqual(['api-docs']);

    const byCategory = searchPluginItems(BUILTIN_REGISTRY, 'workflow');
    expect(byCategory.map((p) => p.name)).toEqual(['release-helper']);

    const all = searchPluginItems(BUILTIN_REGISTRY);
    expect(all[0]?.name).toBe('git-status'); // downloads 最高（1200）排第一
    expect(all).toHaveLength(4);
  });
});
