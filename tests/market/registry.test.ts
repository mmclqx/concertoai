/**
 * Agent 市场注册表测试（v3.0 M4 / T4.1）。
 *
 * 覆盖验收标准：
 * - 复用技能市场 registry.json 结构（registry + skills[] 或 agents[]），条目含 type 区分；
 * - Agent 条目扩展 AgentDef 字段（interfaces/permissions/runtime）+ 接口版本号；
 * - 注册表读写用 zod schema 校验（共用校验逻辑）；
 * - 内置注册表初始包含 4 个内置 Agent 条目（architect/coder/reviewer/qa）。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_ITEMS,
  BUILTIN_REGISTRY,
  findAgentItem,
  listAgentItems,
  loadBuiltinRegistry,
  type MarketRegistry,
  parseAgentItem,
  parseMarketRegistry,
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
        author: 'Lumen',
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
