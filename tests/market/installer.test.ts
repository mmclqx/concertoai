/**
 * Agent 安装器测试（v3.0 M4 / T4.2）。
 *
 * 覆盖验收标准：
 * - /agent install <name>：注册表匹配 → 下载 → sha256 校验 → 写入本地目录；
 * - 接口合规检查：AgentDef schema（interfaces/permissions 完整），不合规拒绝安装；
 * - sha256 不匹配（下载失败）→ 拒绝安装；
 * - 安装器与技能市场共用底层下载函数（fetchVerifiedContent 抽取）；
 * - 安装成功后自动刷新 AgentRegistry。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAgentRegistry } from '../../src/agents';
import {
  AgentInstaller,
  agentDefFromPackage,
  compareVersion,
  globalAgentsDir,
  type MarketRegistry,
  parseAgentPackage,
  parseMarketRegistry,
} from '../../src/market';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-market-install-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造合法 Agent 包内容（JSON）。 */
function makePackage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    def: {
      name: 'my-agent',
      version: '1.0.0',
      interfaces: { input: { shape: 'object' }, output: { shape: 'object' }, version: '1.0.0' },
      permissions: [{ tool: 'read_file' }],
    },
    entry: 'module.exports = { execute: async () => ({ ok: true }) };',
    ...overrides,
  });
}

/** 构造含单个 external Agent 条目的注册表（经 parseMarketRegistry 校验，类型安全）。 */
function makeRegistry(overrides: Record<string, unknown> = {}): MarketRegistry {
  return parseMarketRegistry(
    JSON.stringify({
      registry: 'https://example.com/registry.json',
      skills: [],
      agents: [
        {
          type: 'agent',
          name: 'my-agent',
          version: '1.0.0',
          description: '测试 Agent',
          author: 'tester',
          url: 'https://example.com/agents/my-agent.json',
          sha256: 'abc123',
          interfaces: { input: { shape: 'object' }, output: { shape: 'object' }, version: '1.0.0' },
          permissions: [{ tool: 'read_file' }],
          runtime: 'external',
          ...overrides,
        },
      ],
    }),
  );
}

// ── parseAgentPackage（接口合规检查）──────────────────────────

describe('parseAgentPackage（接口合规检查）', () => {
  it('合法包：def 完整（interfaces 含接口版本号 + permissions）', () => {
    const result = parseAgentPackage(makePackage());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.def.name).toBe('my-agent');
      expect(result.pkg.def.interfaces.version).toBe('1.0.0');
      expect(result.pkg.def.permissions[0]?.tool).toBe('read_file');
      expect(result.pkg.entry).toContain('module.exports');
    }
  });

  it('缺 permissions → INVALID_DEF（fail-closed：未声明工具一律拒绝）', () => {
    const pkg = makePackage({ def: { ...JSON.parse(makePackage()).def, permissions: [] } });
    const result = parseAgentPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_DEF');
      expect(result.message).toContain('permissions');
    }
  });

  it('缺 interfaces.version → INVALID_DEF', () => {
    const def = JSON.parse(makePackage()).def as Record<string, unknown>;
    const interfaces = def.interfaces as Record<string, unknown>;
    const pkg = JSON.stringify({ def: { ...def, interfaces: { ...interfaces, version: '' } } });
    const result = parseAgentPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_DEF');
    }
  });

  it('def.name 为空 → INVALID_DEF', () => {
    const def = JSON.parse(makePackage()).def as Record<string, unknown>;
    const pkg = JSON.stringify({ def: { ...def, name: '' } });
    const result = parseAgentPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_DEF');
    }
  });

  it('非法 JSON → INVALID_PACKAGE', () => {
    const result = parseAgentPackage('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PACKAGE');
      expect(result.message).toContain('不是合法 JSON');
    }
  });
});

// ── AgentInstaller.install ────────────────────────────────────

describe('AgentInstaller.install', () => {
  it('成功安装：写入本地目录 + 刷新 AgentRegistry', async () => {
    const registry = new InMemoryAgentRegistry();
    const installer = new AgentInstaller({
      installDir: tmp,
      registry,
      fetchPackage: async () => makePackage(),
    });

    const result = await installer.install('my-agent', makeRegistry());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('install');
    expect(result.version).toBe('1.0.0');

    // 本地文件写入
    const agentJson = path.join(tmp, 'my-agent', 'agent.json');
    const indexJs = path.join(tmp, 'my-agent', 'index.js');
    expect(existsSync(agentJson)).toBe(true);
    expect(existsSync(indexJs)).toBe(true);
    const meta = JSON.parse(readFileSync(agentJson, 'utf8')) as {
      name: string;
      version: string;
      installedAt: number;
    };
    expect(meta.name).toBe('my-agent');
    expect(meta.version).toBe('1.0.0');
    expect(typeof meta.installedAt).toBe('number');

    // AgentRegistry 刷新：权限声明保留（fail-closed 消费）
    expect(registry.has('my-agent')).toBe(true);
    const entry = registry.get('my-agent');
    expect(entry?.def.version).toBe('1.0.0');
    expect(registry.permissionsOf('my-agent')?.map((p) => p.tool)).toEqual(['read_file']);
  });

  it('安装后 readInstalled / listInstalled 可查询', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    const result = await installer.install('my-agent', makeRegistry());
    expect(result.ok).toBe(true);

    const inst = installer.readInstalled('my-agent');
    expect(inst?.name).toBe('my-agent');
    expect(inst?.version).toBe('1.0.0');

    const list = installer.listInstalled();
    expect(list.map((a) => a.name)).toEqual(['my-agent']);
  });

  it('注册表不可达 → REGISTRY_UNREACHABLE', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchRegistry: async () => null,
    });
    const result = await installer.install('my-agent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('REGISTRY_UNREACHABLE');
      expect(result.message).toContain('无法访问');
    }
  });

  it('注册表未找到条目 → NOT_FOUND', async () => {
    const installer = new AgentInstaller({ installDir: tmp });
    const result = await installer.install('ghost', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toContain('ghost');
    }
  });

  it('内置 Agent → BUILTIN（无需安装）', async () => {
    const installer = new AgentInstaller({ installDir: tmp });
    const reg = makeRegistry({ runtime: 'builtin', sha256: 'builtin' });
    const result = await installer.install('my-agent', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BUILTIN');
      expect(result.message).toContain('内置');
    }
  });

  it('已安装最新版 → ALREADY_INSTALLED（跳过重复下载）', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    const reg = makeRegistry();
    expect((await installer.install('my-agent', reg)).ok).toBe(true);
    // 第二次安装同一版本
    const result = await installer.install('my-agent', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ALREADY_INSTALLED');
    }
  });

  it('sha256 不匹配（下载失败）→ DOWNLOAD_FAILED，拒绝安装', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => null, // 模拟校验不通过
    });
    const result = await installer.install('my-agent', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOWNLOAD_FAILED');
      expect(result.message).toContain('sha256');
    }
    expect(existsSync(path.join(tmp, 'my-agent'))).toBe(false);
  });

  it('包不合规（缺 permissions）→ INVALID_DEF，拒绝安装', async () => {
    const badDef = JSON.parse(makePackage()).def as Record<string, unknown>;
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => JSON.stringify({ def: { ...badDef, permissions: [] } }),
    });
    const result = await installer.install('my-agent', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_DEF');
      expect(result.message).toContain('安装被拒绝');
    }
    expect(existsSync(path.join(tmp, 'my-agent'))).toBe(false);
  });

  it('包 def.name 与注册表条目名不一致 → INVALID_DEF', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () =>
        makePackage({ def: { ...JSON.parse(makePackage()).def, name: 'other' } }),
    });
    const result = await installer.install('my-agent', makeRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_DEF');
      expect(result.message).toContain('不一致');
    }
  });

  it('更新场景：旧版已装 + 注册表新版 → action update，AgentRegistry 刷新为新版', async () => {
    const registry = new InMemoryAgentRegistry();
    const installer = new AgentInstaller({
      installDir: tmp,
      registry,
      fetchPackage: async () => makePackage(),
    });
    // 安装 1.0.0
    expect((await installer.install('my-agent', makeRegistry())).ok).toBe(true);
    // 注册表升级到 1.1.0
    const newer = makeRegistry({ version: '1.1.0' });
    const result = await installer.install('my-agent', newer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('update');
    expect(registry.get('my-agent')?.def.version).toBe('1.1.0');
    const meta = JSON.parse(readFileSync(path.join(tmp, 'my-agent', 'agent.json'), 'utf8')) as {
      version: string;
    };
    expect(meta.version).toBe('1.1.0');
  });
});

// ── listInstalled / remove（T4.3 预埋）────────────────────────

describe('AgentInstaller 本地管理（T4.3 预埋）', () => {
  it('listInstalled：空目录返回 []', () => {
    const installer = new AgentInstaller({ installDir: tmp });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('listInstalled：按名称字典序', async () => {
    // 包 def.name 需与注册表条目名一致（否则接口合规检查拒绝）
    const toInstall = ['alpha', 'beta'];
    let pkgIdx = 0;
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => {
        const pkgName = toInstall[pkgIdx] ?? 'my-agent';
        pkgIdx += 1;
        return makePackage({ def: { ...JSON.parse(makePackage()).def, name: pkgName } });
      },
    });
    expect((await installer.install('alpha', makeRegistry({ name: 'alpha' }))).ok).toBe(true);
    expect((await installer.install('beta', makeRegistry({ name: 'beta' }))).ok).toBe(true);
    const names = installer.listInstalled().map((a) => a.name);
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('remove：删除安装目录；不存在返回 false', async () => {
    const installer = new AgentInstaller({
      installDir: tmp,
      fetchPackage: async () => makePackage(),
    });
    expect((await installer.install('my-agent', makeRegistry())).ok).toBe(true);
    expect(installer.remove('my-agent')).toBe(true);
    expect(existsSync(path.join(tmp, 'my-agent'))).toBe(false);
    expect(installer.remove('my-agent')).toBe(false);
  });
});

// ── agentDefFromPackage / compareVersion ──────────────────────

describe('agentDefFromPackage / compareVersion', () => {
  it('agentDefFromPackage：生成可注册 AgentDef（permissions 保留）', () => {
    const pkg = parseAgentPackage(makePackage());
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    const def = agentDefFromPackage(pkg.pkg.def, '1.0.0');
    expect(def.name).toBe('my-agent');
    expect(def.version).toBe('1.0.0');
    expect(def.interfaces.version).toBe('1.0.0');
    expect(def.permissions.map((p) => p.tool)).toEqual(['read_file']);
    // 宽松 zod schema 可运行（描述性 interfaces 兜底）
    expect(def.interfaces.input.safeParse({}).success).toBe(true);
  });

  it('compareVersion：semver 比较', () => {
    expect(compareVersion('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersion('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersion('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersion('2.0.0', '1.9.9')).toBe(1);
  });

  it('globalAgentsDir 指向 ~/.lumen/agents', () => {
    expect(globalAgentsDir()).toContain('.lumen');
    expect(globalAgentsDir()).toContain('agents');
  });
});
