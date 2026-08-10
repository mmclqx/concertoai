/**
 * /agent 斜杠命令测试（v3.0 M4 / T4.3，接口化 + stub 风格）。
 *
 * 覆盖验收标准：
 * - /agent list：列出内置 Agent（名称/版本/权限）+ 已安装外部 Agent；
 * - /agent install <name>：调用 AgentManager.install（成功 / 各失败码中文提示）；
 * - /agent remove <name>：卸载外部 Agent 并注销 AgentRegistry；内置拒绝卸载；
 * - /agent promote <skill>：技能升级为 Agent（T4.4；命令层文案 + 注册表，磁盘由 market 测试覆盖）；
 * - 命令层不依赖具体类内部细节（registry/fetch*），installer 用 vi.fn stub 精确控制，
 *   根治「测试绑定 AgentInstaller 内部注入」的反复失败。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryAgentRegistry } from '../../src/agents';
import {
  type AgentCommandDeps,
  type AgentManager,
  executeAgentCommand,
  executeAgentMarketCommand,
  formatAgentList,
  parseAgentCommand,
} from '../../src/cli/slash/agent';
import type { InstalledAgent, InstallResult } from '../../src/market';
import type { SkillLoader } from '../../src/skill/loader';

// promote 命令层会真实落盘（promoteSkill 内部 mkdirSync），仅该组用例使用临时目录。
let promoteTmp: string;
beforeEach(() => {
  promoteTmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-promote-'));
});
afterEach(() => {
  rmSync(promoteTmp, { recursive: true, force: true });
});

// ── 测试辅助（stub installer，不触碰磁盘/网络）───────────────

/** 构造一个已安装 Agent 元数据（listInstalled stub 返回值）。 */
function makeInstalled(name = 'my-agent', version = '1.0.0'): InstalledAgent {
  return {
    name,
    version,
    def: {
      name,
      version,
      interfaces: { input: {}, output: {}, version: '1.0.0' },
      permissions: [{ tool: 'read_file' }],
    },
    installedAt: 1_739_000_000_000,
  };
}

/** 构造命令依赖：installer 为 vi.fn stub（命令层不依赖 AgentInstaller 内部细节）。 */
function makeDeps(
  overrides: Partial<AgentCommandDeps> = {},
): AgentCommandDeps & { installer: AgentManager } {
  const installer: AgentManager = {
    install: vi.fn(),
    remove: vi.fn(),
    listInstalled: vi.fn(),
  };
  return { installer, registry: new InMemoryAgentRegistry(), ...overrides };
}

/** 便捷访问 stub installer 的 mock（断言调用/控制返回值）。 */
function installerMock(deps: AgentCommandDeps) {
  return {
    install: vi.mocked(deps.installer.install),
    remove: vi.mocked(deps.installer.remove),
    listInstalled: vi.mocked(deps.installer.listInstalled),
  };
}

/** 构造 InstallResult 成功值。 */
function installOk(name = 'my-agent'): InstallResult {
  return { ok: true, name, version: '1.0.0', action: 'install', dir: '/tmp/agents' };
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

  it('/agent update <name> → update', () => {
    expect(parseAgentCommand('/agent update my-agent')).toEqual({
      type: 'update',
      name: 'my-agent',
    });
  });

  it('/agent update（无参数）→ update 全部', () => {
    expect(parseAgentCommand('/agent update')).toEqual({ type: 'update', name: undefined });
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
    installerMock(deps).listInstalled.mockReturnValue([]);
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

  it('有已安装 Agent 时同时展示内置 + 已安装', () => {
    const deps = makeDeps();
    installerMock(deps).listInstalled.mockReturnValue([makeInstalled('my-agent')]);
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
  it('安装成功 → ✅ 提示，installer.install 被调用', async () => {
    const deps = makeDeps();
    installerMock(deps).install.mockResolvedValue(installOk('my-agent'));
    const result = await executeAgentMarketCommand({ type: 'install', name: 'my-agent' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain('my-agent');
    expect(installerMock(deps).install).toHaveBeenCalledWith('my-agent');
  });

  it('注册表不可达 → 中文友好提示', async () => {
    const deps = makeDeps();
    installerMock(deps).install.mockResolvedValue({
      ok: false,
      code: 'REGISTRY_UNREACHABLE',
      message: '无法访问 Agent 注册表，请检查网络连接。',
    });
    const result = await executeAgentMarketCommand({ type: 'install', name: 'my-agent' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('无法访问');
  });

  it('注册表未找到 → 提示可用 Agent', async () => {
    const deps = makeDeps();
    installerMock(deps).install.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      message: '注册表中未找到 Agent: ghost。\n\n可用 Agent: my-agent',
    });
    const result = await executeAgentMarketCommand({ type: 'install', name: 'ghost' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('ghost');
  });

  it('内置 Agent → 提示无需安装（BUILTIN 失败码）', async () => {
    const deps = makeDeps();
    installerMock(deps).install.mockResolvedValue({
      ok: false,
      code: 'BUILTIN',
      message: 'architect 是内置 Agent，已随 ConcertoAI 分发，无需安装（可用 /agent list 查看）。',
    });
    const result = await executeAgentMarketCommand({ type: 'install', name: 'architect' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('内置');
  });
});

describe('executeAgentMarketCommand（/agent remove）', () => {
  it('卸载成功 → 🗑️ 提示 + 注销 AgentRegistry，remove 被调用', async () => {
    const deps = makeDeps();
    // 先注册到 registry（模拟此前 install 成功），再卸载
    deps.registry.register({
      name: 'my-agent',
      version: '1.0.0',
      interfaces: {
        input: { safeParse: () => ({ success: true }) },
        output: { safeParse: () => ({ success: true }) },
        version: '1.0.0',
      },
      permissions: [{ tool: 'read_file' }],
    } as never);
    installerMock(deps).remove.mockReturnValue(true);

    const result = await executeAgentMarketCommand({ type: 'remove', name: 'my-agent' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('🗑️');
    expect(installerMock(deps).remove).toHaveBeenCalledWith('my-agent');
    expect(deps.registry.has('my-agent')).toBe(false);
  });

  it('内置 Agent → 拒绝卸载，remove 不被调用', async () => {
    const deps = makeDeps();
    const result = await executeAgentMarketCommand({ type: 'remove', name: 'coder' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('内置');
    expect(result.message?.content).toContain('不可卸载');
    expect(installerMock(deps).remove).not.toHaveBeenCalled();
  });

  it('未安装 → 提示未安装，registry 不注销', async () => {
    const deps = makeDeps();
    installerMock(deps).remove.mockReturnValue(false);
    const result = await executeAgentMarketCommand({ type: 'remove', name: 'no-such' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未安装');
  });
});

// ── executeAgentMarketCommand（/agent update，v3.1 M5 / T5.4）──

describe('executeAgentMarketCommand（/agent update）', () => {
  it('指定名称：更新成功 → ✅ 提示（installer.install 被调用）', async () => {
    const deps = makeDeps();
    installerMock(deps).install.mockResolvedValue({
      ok: true,
      name: 'my-agent',
      version: '2.0.0',
      action: 'update',
      dir: '/tmp/agents',
    });
    const result = await executeAgentMarketCommand({ type: 'update', name: 'my-agent' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain('2.0.0');
    expect(installerMock(deps).install).toHaveBeenCalledWith('my-agent');
  });

  it('指定名称：已是最新 → ALREADY_INSTALLED 提示无需更新', async () => {
    const deps = makeDeps();
    installerMock(deps).install.mockResolvedValue({
      ok: false,
      code: 'ALREADY_INSTALLED',
      message: 'Agent my-agent 已安装（版本 2.0.0），注册表版本 2.0.0 未更新。',
    });
    const result = await executeAgentMarketCommand({ type: 'update', name: 'my-agent' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('已是最新');
  });

  it('无参数：注册表不可达 → 中文提示', async () => {
    const deps = makeDeps({ fetchRegistry: async () => null });
    const result = await executeAgentMarketCommand({ type: 'update' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('无法访问');
  });

  it('无参数：列出所有可更新 Agent（版本落后对比）', async () => {
    const deps = makeDeps({
      fetchRegistry: async () =>
        ({
          registry: 'https://example.com/registry.json',
          skills: [],
          agents: [
            {
              type: 'agent',
              name: 'my-agent',
              version: '2.0.0',
              description: '',
              author: '',
              url: 'https://example.com/a.json',
              sha256: 'abc',
              interfaces: { input: {}, output: {}, version: '1.0.0' },
              permissions: [{ tool: 'read_file' }],
              runtime: 'external',
            },
            {
              type: 'agent',
              name: 'new-agent',
              version: '1.0.0',
              description: '',
              author: '',
              url: 'https://example.com/n.json',
              sha256: 'def',
              interfaces: { input: {}, output: {}, version: '1.0.0' },
              permissions: [{ tool: 'read_file' }],
              runtime: 'external',
            },
          ],
        }) as never,
    });
    // 已安装 my-agent@1.0.0（落后 2.0.0 → 可更新）；new-agent 未安装（不列出）
    installerMock(deps).listInstalled.mockReturnValue([makeInstalled('my-agent', '1.0.0')]);
    const result = await executeAgentMarketCommand({ type: 'update' }, deps);
    expect(result.handled).toBe(true);
    const content = result.message?.content ?? '';
    expect(content).toContain('可更新');
    expect(content).toContain('my-agent');
    expect(content).toContain('1.0.0 → 2.0.0');
    expect(content).not.toContain('new-agent');
  });

  it('无参数：全部最新 → 「所有已安装 Agent 均是最新版本」', async () => {
    const deps = makeDeps({
      fetchRegistry: async () =>
        ({
          registry: 'https://example.com/registry.json',
          skills: [],
          agents: [
            {
              type: 'agent',
              name: 'my-agent',
              version: '1.0.0',
              description: '',
              author: '',
              url: 'https://example.com/a.json',
              sha256: 'abc',
              interfaces: { input: {}, output: {}, version: '1.0.0' },
              permissions: [{ tool: 'read_file' }],
              runtime: 'external',
            },
          ],
        }) as never,
    });
    installerMock(deps).listInstalled.mockReturnValue([makeInstalled('my-agent', '1.0.0')]);
    const result = await executeAgentMarketCommand({ type: 'update' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('均是最新版本');
  });
});

// ── executeAgentMarketCommand（/agent promote，T4.4）──────────

describe('executeAgentMarketCommand（/agent promote）', () => {
  it('promote 无 loader → 提示加载器不可用（命令层守卫）', async () => {
    const deps = makeDeps();
    const result = await executeAgentMarketCommand(
      { type: 'promote', skillName: 'code-review' },
      deps,
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('技能加载器不可用');
  });

  it('promote 成功 → ✅ 提示 + 注册 AgentRegistry', async () => {
    // promote 依赖 loader.get 返回技能 def：stub loader，不触碰磁盘
    // （脚手架落盘细节由 tests/market/promote.test.ts 覆盖）
    const stubLoader = {
      loadAll: () => {},
      get: () => ({
        name: 'code-review',
        description: '审查',
        version: '1.0.0',
        tools: ['read_file', 'search_content', 'list_directory'],
        body: '## 审查\n输出 ReviewResult。',
        sourcePath: '/tmp/skills/code-review/SKILL.md',
      }),
    } as unknown as SkillLoader;
    const deps = makeDeps();
    deps.loader = stubLoader;
    deps.installDir = promoteTmp;

    const result = await executeAgentMarketCommand(
      { type: 'promote', skillName: 'code-review' },
      deps,
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain('code-review');
    expect(deps.registry.has('code-review')).toBe(true);
  });

  it('promote 技能不存在 → ❌ 提示 SKILL_NOT_FOUND', async () => {
    const stubLoader = {
      loadAll: () => {},
      get: () => undefined,
    } as unknown as SkillLoader;
    const deps = makeDeps();
    deps.loader = stubLoader;
    deps.installDir = promoteTmp;

    const result = await executeAgentMarketCommand({ type: 'promote', skillName: 'no-such' }, deps);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('技能不存在');
  });
});
