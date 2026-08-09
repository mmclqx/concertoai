/**
 * /agent 斜杠命令测试（v3.0 M4 / T4.3）。
 *
 * 覆盖验收标准：
 * - /agent list：列出内置 Agent（名称/版本/权限）+ 已安装外部 Agent；
 * - /agent install <name>：调用 T4.2 安装器（成功/注册表不可达/未找到）；
 * - /agent remove <name>：卸载外部 Agent 并注销 AgentRegistry；内置拒绝卸载；
 * - 网络/磁盘错误 → 中文友好提示（与技能市场文案风格一致）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryAgentRegistry } from '../../src/agents';
import {
  type AgentCommandDeps,
  executeAgentCommand,
  executeAgentMarketCommand,
  formatAgentList,
  parseAgentCommand,
} from '../../src/cli/slash/agent';
import { AgentInstaller, type MarketRegistry, parseMarketRegistry } from '../../src/market';
import { SkillLoader } from '../../src/skill/loader';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-slash-agent-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造合法 Agent 包内容（JSON，def.name 可覆盖）。 */
function makePackage(name = 'my-agent'): string {
  return JSON.stringify({
    def: {
      name,
      version: '1.0.0',
      interfaces: { input: { shape: 'object' }, output: { shape: 'object' }, version: '1.0.0' },
      permissions: [{ tool: 'read_file' }],
    },
    entry: 'module.exports = { execute: async () => ({ ok: true }) };',
  });
}

/** 构造含单个 Agent 条目的注册表（经 parseMarketRegistry 校验，类型安全；runtime 可覆盖）。 */
function makeRegistry(
  name = 'my-agent',
  runtime: 'builtin' | 'external' = 'external',
): MarketRegistry {
  return parseMarketRegistry(
    JSON.stringify({
      registry: 'https://example.com/registry.json',
      skills: [],
      agents: [
        {
          type: 'agent',
          name,
          version: '1.0.0',
          description: '测试 Agent',
          author: 'tester',
          url: 'https://example.com/agents/my-agent.json',
          sha256: 'abc123',
          interfaces: { input: { shape: 'object' }, output: { shape: 'object' }, version: '1.0.0' },
          permissions: [{ tool: 'read_file' }],
          runtime,
        },
      ],
    }),
  );
}

/** 构造命令依赖（真实 AgentInstaller + 注入注册表下载，避免真实网络 + 内存注册表）。 */
function makeDeps(overrides: Partial<AgentCommandDeps> = {}): AgentCommandDeps {
  const installer = new AgentInstaller({
    installDir: tmp,
    fetchRegistry: async () => makeRegistry(),
  });
  return { installer, registry: new InMemoryAgentRegistry(), ...overrides };
}

// ── parseAgentCommand ─────────────────────────────────────────

describe('parseAgentCommand', () => {
  it('/agent → list', () => {
    expect(parseAgentCommand('/agent')).toEqual({ type: 'list' });
  });

  it('/agent list → list', () => {
    expect(parseAgentCommand('/agent list')).toEqual({ type: 'list' });
  });

  it('/agent install <name> → install', () => {
    expect(parseAgentCommand('/agent install my-agent')).toEqual({
      type: 'install',
      name: 'my-agent',
    });
  });

  it('/agent remove <name> → remove', () => {
    expect(parseAgentCommand('/agent remove my-agent')).toEqual({
      type: 'remove',
      name: 'my-agent',
    });
  });

  it('/agent install（无参数）→ 提示用法', () => {
    const result = parseAgentCommand('/agent install');
    expect(result).not.toBeNull();
    if (result !== null && 'message' in result) {
      expect(result.message).toContain('用法');
    }
  });

  it('/agent promote <skill> → promote', () => {
    expect(parseAgentCommand('/agent promote code-review')).toEqual({
      type: 'promote',
      skillName: 'code-review',
    });
  });

  it('/agent promote（无参数）→ 提示用法', () => {
    const result = parseAgentCommand('/agent promote');
    expect(result).not.toBeNull();
    if (result !== null && 'message' in result) {
      expect(result.message).toContain('用法');
    }
  });

  it('/agent <未知子命令> → unknown', () => {
    const result = parseAgentCommand('/agent foo');
    expect(result).not.toBeNull();
    if (result !== null && 'message' in result) {
      expect(result.message).toContain('未知子命令');
    }
  });

  it('非 /agent 命令 → null', () => {
    expect(parseAgentCommand('hello')).toBeNull();
    expect(parseAgentCommand('/skill list')).toBeNull();
    expect(parseAgentCommand('/plan task')).toBeNull();
  });
});

// ── executeAgentCommand（list）────────────────────────────────

describe('executeAgentCommand（/agent list）', () => {
  it('无已安装 Agent 时列出内置 4 个', () => {
    const deps = makeDeps();
    const result = executeAgentCommand({ type: 'list' }, deps);
    expect(result.handled).toBe(true);
    const content = result.message?.content ?? '';
    expect(content).toContain('📋');
    expect(content).toContain('architect');
    expect(content).toContain('coder');
    expect(content).toContain('reviewer');
    expect(content).toContain('qa');
    expect(content).toContain('read_file');
    expect(content).toContain('edit_file');
    expect(content).toContain('已安装外部 Agent：无');
  });

  it('有已安装 Agent 时同时展示内置 + 已安装', async () => {
    const deps = makeDeps();
    // 先安装一个外部 Agent（真实安装器 + 注入下载）
    const installerWithFetch = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage('my-agent'),
    });
    const result = await installerWithFetch.install('my-agent', makeRegistry('my-agent'));
    expect(result.ok).toBe(true);
    deps.installer = installerWithFetch;

    const content = formatAgentList(deps);
    expect(content).toContain('内置 4 个');
    expect(content).toContain('已安装外部 Agent（1 个）');
    expect(content).toContain('my-agent');
    expect(content).toContain('1.0.0');
  });

  it('unknown 子命令直接回显提示', () => {
    const deps = makeDeps();
    const result = executeAgentCommand({ type: 'unknown', message: '未知子命令: foo' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未知子命令');
  });
});

// ── executeAgentMarketCommand（install / remove）──────────────

describe('executeAgentMarketCommand（/agent install）', () => {
  it('安装成功 → ✅ 提示', async () => {
    const registry = new InMemoryAgentRegistry();
    const installer = new AgentInstaller({
      installDir: tmp,
      registry,
      fetchRegistry: async () => makeRegistry('my-agent'),
      fetchPackage: async () => makePackage('my-agent'),
    });
    const result = await executeAgentMarketCommand(
      { type: 'install', name: 'my-agent' },
      { installer, registry },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain('my-agent');
    // AgentRegistry 已刷新
    expect(registry.has('my-agent')).toBe(true);
  });

  it('注册表不可达 → 中文友好提示', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchRegistry: async () => null,
    });
    const result = await executeAgentMarketCommand(
      { type: 'install', name: 'my-agent' },
      { installer, registry: new InMemoryAgentRegistry() },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('无法访问');
  });

  it('注册表未找到 → 提示可用 Agent', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchRegistry: async () => makeRegistry(),
    });
    const result = await executeAgentMarketCommand(
      { type: 'install', name: 'ghost' },
      { installer, registry: new InMemoryAgentRegistry() },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('ghost');
  });

  it('内置 Agent → 提示无需安装', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchRegistry: async () => makeRegistry('architect', 'builtin'),
    });
    const result = await executeAgentMarketCommand(
      { type: 'install', name: 'architect' },
      { installer, registry: new InMemoryAgentRegistry() },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('内置');
  });
});

describe('executeAgentMarketCommand（/agent remove）', () => {
  it('卸载成功 → 🗑️ 提示 + 注销 AgentRegistry', async () => {
    const registry = new InMemoryAgentRegistry();
    const installer = new AgentInstaller({
      installDir: tmp,
      registry,
      fetchPackage: async () => makePackage('my-agent'),
    });
    // 先安装（installer 注入 registry → 安装成功后自动刷新）
    const installed = await installer.install('my-agent', makeRegistry('my-agent'));
    expect(installed.ok).toBe(true);
    expect(registry.has('my-agent')).toBe(true);

    const result = await executeAgentMarketCommand(
      { type: 'remove', name: 'my-agent' },
      { installer, registry },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('🗑️');
    expect(registry.has('my-agent')).toBe(false);
  });

  it('内置 Agent → 拒绝卸载', async () => {
    const deps = makeDeps();
    const result = await executeAgentMarketCommand({ type: 'remove', name: 'coder' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('内置');
    expect(result.message?.content).toContain('不可卸载');
  });

  it('未安装 → 提示未安装', async () => {
    const deps = makeDeps();
    const result = await executeAgentMarketCommand({ type: 'remove', name: 'no-such' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未安装');
  });
});

// ── executeAgentMarketCommand（/agent promote，T4.4）──────────

describe('executeAgentMarketCommand（/agent promote）', () => {
  /** 写入一个项目级技能（临时 cwd）。 */
  function writeSkill(cwd: string, name: string, body: string): void {
    const dir = path.join(cwd, '.lumen', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---
name: ${name}
description: ${name} 描述
version: 1.0.0
---

${body}`,
      'utf8',
    );
  }

  it('promote 成功 → ✅ 提示 + 注册 AgentRegistry + agent.json 落盘', async () => {
    writeSkill(tmp, 'code-review', '## 审查\n输出 ReviewResult。');
    const loader = new SkillLoader();
    loader.loadAll(tmp);
    const registry = new InMemoryAgentRegistry();
    const installer = new AgentInstaller({ installDir: path.join(tmp, 'agents') });

    const result = await executeAgentMarketCommand(
      { type: 'promote', skillName: 'code-review' },
      { installer, registry, loader, installDir: path.join(tmp, 'agents') },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain('code-review');
    expect(registry.has('code-review')).toBe(true);
    // agent.json 落盘（/agent list 数据源可识别）
    const installer2 = new AgentInstaller({ installDir: path.join(tmp, 'agents') });
    expect(installer2.listInstalled().map((a) => a.name)).toEqual(['code-review']);
  });

  it('promote 技能不存在 → SKILL_NOT_FOUND 提示', async () => {
    const loader = new SkillLoader();
    loader.loadAll(tmp);
    const result = await executeAgentMarketCommand(
      { type: 'promote', skillName: 'no-such' },
      {
        installer: new AgentInstaller({ installDir: tmp }),
        registry: new InMemoryAgentRegistry(),
        loader,
      },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('技能不存在');
  });

  it('promote 无 loader → 提示加载器不可用', async () => {
    const result = await executeAgentMarketCommand(
      { type: 'promote', skillName: 'code-review' },
      { installer: new AgentInstaller({ installDir: tmp }), registry: new InMemoryAgentRegistry() },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('技能加载器不可用');
  });
});
