/**
 * 插件安装器测试（v4.0 M4 / T4.1 + T4.3）。
 *
 * 覆盖验收标准：
 * - install 全流程：注册表匹配 → 下载/builtin 直装 → sha256 校验 → 权限确认 → 写入本地目录；
 * - 权限拒绝（fail-closed）→ CANCELED 不落盘；
 * - 内置插件（sha256='builtin'）从 builtin.ts 直装（不下载）；
 * - 包 name 与注册表条目名一致性校验；
 * - listInstalled / remove / readInstalled；
 * - 市场分发包解析（parsePluginPackage）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findPluginItem,
  listPluginItems,
  type MarketRegistry,
  parseMarketRegistry,
  searchPluginItems,
} from '../../src/market';
import { BUILTIN_PLUGIN_CONTENTS } from '../../src/plugin/builtin';
import { PluginInstaller, parsePluginPackage } from '../../src/plugin/installer';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-plugin-install-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造合法插件包内容（JSON：plugin + entry）。 */
function makePackage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    plugin: {
      name: 'my-plugin',
      version: '1.0.0',
      description: '测试插件',
      author: 'tester',
      category: 'tool',
      permissions: [{ type: 'read', paths: ['src'] }],
    },
    entry: 'export const create = () => ({ id: "my-plugin" });',
    ...overrides,
  });
}

/** 构造含单个 external 插件条目的注册表（经 parseMarketRegistry 校验）。 */
function makeRegistry(overrides: Record<string, unknown> = {}): MarketRegistry {
  return parseMarketRegistry(
    JSON.stringify({
      registry: 'https://example.com/registry.json',
      skills: [],
      agents: [],
      plugins: [
        {
          type: 'plugin',
          name: 'my-plugin',
          version: '1.0.0',
          description: '测试插件',
          author: 'tester',
          url: 'https://example.com/plugins/my-plugin.json',
          sha256: 'abc123',
          category: 'tool',
          downloads: 100,
          rating: 4.5,
          permissions: [{ type: 'read', paths: ['src'] }],
          ...overrides,
        },
      ],
    }),
  );
}

// ── parsePluginPackage（包解析）───────────────────────────────

describe('parsePluginPackage（市场分发包解析）', () => {
  it('合法包：plugin 字段 + entry 源码 → PluginPackage', () => {
    const result = parsePluginPackage(makePackage());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.plugin.name).toBe('my-plugin');
      expect(result.pkg.plugin.entry).toBe('index.mjs');
      expect(result.pkg.entry).toContain('export const create');
    }
  });

  it('缺 entry → 解析失败', () => {
    const result = parsePluginPackage(JSON.stringify({ plugin: { name: 'x' } }));
    expect(result.ok).toBe(false);
  });

  it('非法 JSON → 解析失败（中文错误）', () => {
    const result = parsePluginPackage('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('不是合法 JSON');
    }
  });
});

// ── PluginInstaller.install ───────────────────────────────────

describe('PluginInstaller.install（全流程）', () => {
  it('成功安装：下载 → 写入 plugin.json + ESM 入口', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    const result = await installer.install('my-plugin', makeRegistry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('install');
    expect(result.version).toBe('1.0.0');

    const pluginJson = path.join(tmp, 'my-plugin', 'plugin.json');
    const entry = path.join(tmp, 'my-plugin', 'index.mjs');
    expect(existsSync(pluginJson)).toBe(true);
    expect(existsSync(entry)).toBe(true);
    const meta = JSON.parse(readFileSync(pluginJson, 'utf8')) as {
      name: string;
      version: string;
      installedAt: number;
    };
    expect(meta.name).toBe('my-plugin');
    expect(meta.version).toBe('1.0.0');
    expect(typeof meta.installedAt).toBe('number');
  });

  it('内置插件（sha256=builtin）→ 从 builtin.ts 直装，不下载', async () => {
    let fetched = false;
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => {
        fetched = true;
        return null;
      },
    });
    const reg = makeRegistry({
      name: 'git-status',
      sha256: 'builtin',
      url: 'builtin://git-status',
    });
    const result = await installer.install('git-status', reg);
    expect(result.ok).toBe(true);
    expect(fetched).toBe(false);
    expect(existsSync(path.join(tmp, 'git-status', 'plugin.json'))).toBe(true);
  });

  it('内置条目内容来自 BUILTIN_PLUGIN_CONTENTS（4 个内置插件可安装）', async () => {
    expect(Object.keys(BUILTIN_PLUGIN_CONTENTS).sort()).toEqual([
      'api-docs',
      'git-status',
      'release-helper',
      'todo-tracker',
    ]);
  });

  it('权限确认拒绝 → CANCELED，不落盘（fail-closed）', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
      confirm: async () => false,
    });
    const result = await installer.install('my-plugin', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CANCELED');
    }
    expect(existsSync(path.join(tmp, 'my-plugin'))).toBe(false);
  });

  it('权限确认回调收到权限清单（含白名单详情）', async () => {
    let received: unknown;
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
      confirm: async (perms) => {
        received = perms;
        return true;
      },
    });
    await installer.install('my-plugin', makeRegistry());
    expect(received).toEqual([{ type: 'read', paths: ['src'] }]);
  });

  it('注册表不可达 → REGISTRY_UNREACHABLE', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchRegistry: async () => null,
    });
    const result = await installer.install('my-plugin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('REGISTRY_UNREACHABLE');
    }
  });

  it('注册表未找到 → NOT_FOUND', async () => {
    const installer = new PluginInstaller({ installDir: tmp });
    const result = await installer.install('ghost', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toContain('ghost');
    }
  });

  it('sha256 校验失败（下载 null）→ DOWNLOAD_FAILED，拒绝安装', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => null,
    });
    const result = await installer.install('my-plugin', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOWNLOAD_FAILED');
      expect(result.message).toContain('sha256');
    }
    expect(existsSync(path.join(tmp, 'my-plugin'))).toBe(false);
  });

  it('包 name 与注册表条目名不一致 → INVALID_PACKAGE', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () =>
        makePackage({ plugin: { ...JSON.parse(makePackage()).plugin, name: 'other' } }),
    });
    const result = await installer.install('my-plugin', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PACKAGE');
      expect(result.message).toContain('不一致');
    }
  });

  it('已安装最新版 → ALREADY_INSTALLED（跳过重复下载）', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    const reg = makeRegistry();
    expect((await installer.install('my-plugin', reg)).ok).toBe(true);
    const result = await installer.install('my-plugin', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ALREADY_INSTALLED');
    }
  });

  it('更新场景：旧版已装 + 注册表新版 → action update', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    expect((await installer.install('my-plugin', makeRegistry())).ok).toBe(true);
    const newer = makeRegistry({ version: '1.1.0' });
    const result = await installer.install('my-plugin', newer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('update');
    expect(result.version).toBe('1.1.0');
    const meta = JSON.parse(readFileSync(path.join(tmp, 'my-plugin', 'plugin.json'), 'utf8')) as {
      version: string;
    };
    expect(meta.version).toBe('1.1.0');
  });
});

// ── 本地管理（listInstalled / remove / readInstalled）────────

describe('PluginInstaller 本地管理', () => {
  it('listInstalled：空目录返回 []；安装后按名称字典序', async () => {
    const installer = new PluginInstaller({ installDir: tmp });
    expect(installer.listInstalled()).toEqual([]);

    const pkgNames = ['alpha', 'beta'];
    let idx = 0;
    const installer2 = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () =>
        makePackage({
          plugin: { ...JSON.parse(makePackage()).plugin, name: pkgNames[idx] ?? 'x' },
        }),
    });
    idx = 0;
    expect((await installer2.install('alpha', makeRegistry({ name: 'alpha' }))).ok).toBe(true);
    idx = 1;
    expect((await installer2.install('beta', makeRegistry({ name: 'beta' }))).ok).toBe(true);
    expect(installer2.listInstalled().map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('remove：删除安装目录；不存在返回 false', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    expect((await installer.install('my-plugin', makeRegistry())).ok).toBe(true);
    expect(installer.remove('my-plugin')).toBe(true);
    expect(existsSync(path.join(tmp, 'my-plugin'))).toBe(false);
    expect(installer.remove('my-plugin')).toBe(false);
  });

  it('readInstalled：未安装返回 undefined；已安装含 installedAt', async () => {
    const installer = new PluginInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    expect(installer.readInstalled('my-plugin')).toBeUndefined();
    await installer.install('my-plugin', makeRegistry());
    const inst = installer.readInstalled('my-plugin');
    expect(inst?.name).toBe('my-plugin');
    expect(typeof inst?.installedAt).toBe('number');
  });
});

// ── installByType 分派（T4.3 验收标准：按 type 分派，零破坏旧调用）──

describe('installByType（市场安装统一分派）', () => {
  it('plugin 类型 → 分派到 PluginInstaller（含权限确认 + 落盘）', async () => {
    const { installByType } = await import('../../src/market/installer');
    const result = await installByType('plugin', 'my-plugin', {
      installDir: tmp,
      fetchRegistry: async () => makeRegistry(),
      fetchPackage: async () => makePackage(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('install');
      expect(result.version).toBe('1.0.0');
    }
    expect(existsSync(path.join(tmp, 'my-plugin', 'plugin.json'))).toBe(true);
  });

  it('agent 类型 → 分派到 AgentInstaller', async () => {
    const { installByType } = await import('../../src/market/installer');
    const agentReg = parseMarketRegistry(
      JSON.stringify({
        registry: 'https://example.com/r.json',
        skills: [],
        agents: [
          {
            type: 'agent',
            name: 'my-agent',
            version: '1.0.0',
            description: '测试 agent',
            author: 'tester',
            url: 'https://example.com/agents/my-agent.json',
            sha256: 'abc',
            interfaces: { input: {}, output: {}, version: '1.0.0' },
            permissions: [{ tool: 'read_file' }],
            runtime: 'external',
          },
        ],
        plugins: [],
      }),
    );
    const result = await installByType('agent', 'my-agent', {
      installDir: tmp,
      fetchRegistry: async () => agentReg,
      fetchPackage: async () =>
        JSON.stringify({
          def: {
            name: 'my-agent',
            version: '1.0.0',
            interfaces: { input: {}, output: {}, version: '1.0.0' },
            permissions: [{ tool: 'read_file' }],
          },
          entry: 'export {}',
        }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('my-agent');
    }
    expect(existsSync(path.join(tmp, 'my-agent', 'agent.json'))).toBe(true);
  });

  it('skill 类型 → 分派到 installSkillFromRegistry（写 SKILL.md）', async () => {
    const { installByType } = await import('../../src/market/installer');
    const result = await installByType('skill', 'my-skill', {
      installDir: tmp,
      fetchRegistry: async () => ({
        registry: 'https://example.com/r.json',
        skills: [
          {
            type: 'skill',
            name: 'my-skill',
            version: '1.0.0',
            description: '测试技能',
            author: 'tester',
            url: 'https://example.com/skills/my-skill.md',
            sha256: 'abc',
          },
        ],
        agents: [],
        plugins: [],
      }),
      fetchSkill: async () => '---\nname: my-skill\nversion: 1.0.0\n---\n正文',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('my-skill');
      expect(result.action).toBe('install');
    }
    expect(existsSync(path.join(tmp, 'my-skill', 'SKILL.md'))).toBe(true);
  });
});

// ── 注册表插件条目查询（T4.3）────────────────────────────────

describe('注册表插件条目查询（findPluginItem / listPluginItems / searchPluginItems）', () => {
  it('findPluginItem：按名称查找；不存在返回 undefined', () => {
    const reg = makeRegistry();
    expect(findPluginItem(reg, 'my-plugin')?.version).toBe('1.0.0');
    expect(findPluginItem(reg, 'ghost')).toBeUndefined();
  });

  it('listPluginItems：按名称字典序', () => {
    const reg = makeRegistry();
    expect(listPluginItems(reg).map((p) => p.name)).toEqual(['my-plugin']);
  });

  it('searchPluginItems：关键词匹配名称/描述/作者/分类，按下载量降序', () => {
    const reg = parseMarketRegistry(
      JSON.stringify({
        registry: 'https://example.com/r.json',
        skills: [],
        agents: [],
        plugins: [
          {
            type: 'plugin',
            name: 'api-docs',
            version: '1.0.0',
            description: '生成 API 文档',
            author: 'a',
            url: 'https://e.com/1',
            sha256: 'x',
            category: 'tool',
            downloads: 500,
            rating: 4.5,
            permissions: [],
          },
          {
            type: 'plugin',
            name: 'git-status',
            version: '1.0.0',
            description: 'git 摘要',
            author: 'b',
            url: 'https://e.com/2',
            sha256: 'y',
            category: 'tool',
            downloads: 900,
            rating: 4.8,
            permissions: [],
          },
        ],
      }),
    );
    // 按名称匹配
    expect(searchPluginItems(reg, 'api').map((p) => p.name)).toEqual(['api-docs']);
    // 按描述匹配
    expect(searchPluginItems(reg, 'git 摘要').map((p) => p.name)).toEqual(['git-status']);
    // 空关键词 → 全部，按下载量降序
    expect(searchPluginItems(reg).map((p) => p.name)).toEqual(['git-status', 'api-docs']);
  });
});
