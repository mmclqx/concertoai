/**
 * plugin CLI 命令测试（v4.0 M4 / T4.1 + T4.1a + T4.5）。
 *
 * 覆盖验收标准：
 * - install（内置直装 / 权限确认 fail-closed）/ search / list / remove / browse / recommend / popular；
 * - formatPluginLine 展示行（名称/版本/描述/下载量/评分/已安装标记）；
 * - detectProjectTraits 项目特征启发式（Express / TODO / package.json / git）；
 * - recommendPlugins 特征 → 推荐映射；
 * - makePermissionConfirm：非 TTY 且未 --yes → 拒绝（fail-closed），--yes → 通过；
 * - /plugin 斜杠命令解析（parsePluginCommand）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectProjectTraits,
  formatPluginLine,
  makePermissionConfirm,
  type PluginCliOptions,
  recommendPlugins,
  runPluginCli,
} from '../../src/cli/plugin';
import { parsePluginCommand } from '../../src/cli/slash/plugin';
import { BUILTIN_REGISTRY } from '../../src/market';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-cli-plugin-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 构造 CLI 选项（内置注册表注入，避免网络；installDir 用临时目录）。 */
function makeOpts(overrides: Partial<PluginCliOptions> = {}): PluginCliOptions {
  return {
    cwd: tmp,
    installDir: tmp,
    fetchRegistry: async () => BUILTIN_REGISTRY,
    ...overrides,
  };
}

// ── 命令族（T4.1/T4.1a/T4.5）─────────────────────────────────

describe('runPluginCli 命令族', () => {
  it('install：内置插件直装成功（sha256=builtin，不下载）', async () => {
    const code = await runPluginCli({
      ...makeOpts(),
      action: 'install',
      param: 'git-status',
      confirm: async () => true,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(tmp, 'git-status', 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(tmp, 'git-status', 'index.mjs'))).toBe(true);
  });

  it('install：缺参数 → 1（用法提示）', async () => {
    const code = await runPluginCli({ ...makeOpts(), action: 'install' });
    expect(code).toBe(1);
  });

  it('install：注册表不可达 → 1', async () => {
    const code = await runPluginCli({
      ...makeOpts({ fetchRegistry: async () => null }),
      action: 'install',
      param: 'git-status',
    });
    expect(code).toBe(1);
  });

  it('list：空目录 → 0（空提示）；安装后 → 列出', async () => {
    expect(await runPluginCli({ ...makeOpts(), action: 'list' })).toBe(0);
    await runPluginCli({
      ...makeOpts(),
      action: 'install',
      param: 'todo-tracker',
      confirm: async () => true,
    });
    expect(await runPluginCli({ ...makeOpts(), action: 'list' })).toBe(0);
  });

  it('search：按关键词命中；无结果 → 0', async () => {
    expect(await runPluginCli({ ...makeOpts(), action: 'search', param: '文档' })).toBe(0);
    expect(await runPluginCli({ ...makeOpts(), action: 'search', param: '不存在关键词xyz' })).toBe(
      0,
    );
    // 缺关键词 → 1
    expect(await runPluginCli({ ...makeOpts(), action: 'search' })).toBe(1);
  });

  it('remove：安装后卸载成功；未安装 → 1', async () => {
    await runPluginCli({
      ...makeOpts(),
      action: 'install',
      param: 'api-docs',
      confirm: async () => true,
    });
    expect(await runPluginCli({ ...makeOpts(), action: 'remove', param: 'api-docs' })).toBe(0);
    expect(existsSync(path.join(tmp, 'api-docs'))).toBe(false);
    expect(await runPluginCli({ ...makeOpts(), action: 'remove', param: 'ghost' })).toBe(1);
  });

  it('browse：全部分类 + 按分类过滤；非法分类 → 1', async () => {
    expect(await runPluginCli({ ...makeOpts(), action: 'browse' })).toBe(0);
    expect(await runPluginCli({ ...makeOpts(), action: 'browse', param: 'tool' })).toBe(0);
    expect(await runPluginCli({ ...makeOpts(), action: 'browse', param: 'bad' })).toBe(1);
  });

  it('recommend：无特征 → 0（空提示）', async () => {
    expect(await runPluginCli({ ...makeOpts(), action: 'recommend' })).toBe(0);
  });

  it('popular：Top 10（内置 4 个全部展示）', async () => {
    expect(await runPluginCli({ ...makeOpts(), action: 'popular' })).toBe(0);
  });

  it('未知 action → 1（usage）', async () => {
    expect(await runPluginCli({ ...makeOpts(), action: 'frobnicate' })).toBe(1);
  });
});

// ── 展示行（formatPluginLine）────────────────────────────────

describe('formatPluginLine', () => {
  it('包含名称/版本/描述/下载量/评分', () => {
    const item = BUILTIN_REGISTRY.plugins[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    const line = formatPluginLine(item);
    expect(line).toContain(item.name);
    expect(line).toContain(item.version);
    expect(line).toContain(item.description);
    expect(line).toContain(String(item.downloads));
    expect(line).toContain(item.rating.toFixed(1));
  });

  it('已安装 → 追加已安装标记', () => {
    const item = BUILTIN_REGISTRY.plugins[1];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(formatPluginLine(item, '1.0.0')).toContain('已安装 1.0.0');
  });
});

// ── 项目特征推荐（T4.1a）─────────────────────────────────────

describe('detectProjectTraits / recommendPlugins', () => {
  it('Express + package.json + git 仓库 → 检测命中', () => {
    writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.19.0' } }),
      'utf8',
    );
    mkdirSync(path.join(tmp, '.git'));
    const traits = detectProjectTraits(tmp);
    expect(traits.express).toBe(true);
    expect(traits.hasPackageJson).toBe(true);
    expect(traits.isGitRepo).toBe(true);
    expect(traits.hasTodo).toBe(false);
  });

  it('src/ 下 TODO 标记 → hasTodo 命中（含子目录）', () => {
    mkdirSync(path.join(tmp, 'src', 'routes'), { recursive: true });
    writeFileSync(path.join(tmp, 'src', 'routes', 'api.ts'), '// TODO: 补鉴权', 'utf8');
    expect(detectProjectTraits(tmp).hasTodo).toBe(true);
  });

  it('空目录 → 全部 false', () => {
    const traits = detectProjectTraits(tmp);
    expect(traits).toEqual({
      express: false,
      hasTodo: false,
      hasPackageJson: false,
      isGitRepo: false,
    });
  });

  it('recommendPlugins：Express 特征 → 推荐 api-docs（含理由）', () => {
    const recs = recommendPlugins(BUILTIN_REGISTRY, {
      express: true,
      hasTodo: false,
      hasPackageJson: false,
      isGitRepo: false,
    });
    expect(recs.map((r) => r.item.name)).toEqual(['api-docs']);
    expect(recs[0]?.reason).toContain('api-docs');
  });

  it('recommendPlugins：git 仓库 → 推荐 git-status', () => {
    const recs = recommendPlugins(BUILTIN_REGISTRY, {
      express: false,
      hasTodo: false,
      hasPackageJson: false,
      isGitRepo: true,
    });
    expect(recs.map((r) => r.item.name)).toEqual(['git-status']);
  });
});

// ── 权限确认（T4.2 fail-closed）──────────────────────────────

describe('makePermissionConfirm', () => {
  it('非 TTY 且未 --yes → 拒绝（fail-closed）', async () => {
    const confirm = makePermissionConfirm(false);
    expect(await confirm([])).toBe(false);
  });

  it('--yes → 直接通过（不读 stdin）', async () => {
    const confirm = makePermissionConfirm(true);
    expect(await confirm([{ type: 'shell', allowlist: ['npm run verify'] }])).toBe(true);
  });
});

// ── /plugin 斜杠命令解析（T4.5）──────────────────────────────

describe('parsePluginCommand（/plugin）', () => {
  it('list / install / search / remove / browse / recommend / popular 全部解析', () => {
    expect(parsePluginCommand('/plugin')).toEqual({ type: 'list' });
    expect(parsePluginCommand('/plugin list')).toEqual({ type: 'list' });
    expect(parsePluginCommand('/plugin install api-docs')).toEqual({
      type: 'install',
      name: 'api-docs',
    });
    expect(parsePluginCommand('/plugin search 文档')).toEqual({
      type: 'search',
      keyword: '文档',
    });
    expect(parsePluginCommand('/plugin search')).toEqual({ type: 'search', keyword: undefined });
    expect(parsePluginCommand('/plugin remove todo-tracker')).toEqual({
      type: 'remove',
      name: 'todo-tracker',
    });
    expect(parsePluginCommand('/plugin browse workflow')).toEqual({
      type: 'browse',
      category: 'workflow',
    });
    expect(parsePluginCommand('/plugin browse')).toEqual({ type: 'browse', category: undefined });
    expect(parsePluginCommand('/plugin recommend')).toEqual({ type: 'recommend' });
    expect(parsePluginCommand('/plugin popular')).toEqual({ type: 'popular' });
  });

  it('未知子命令 → unknown + 用法', () => {
    const cmd = parsePluginCommand('/plugin frobnicate');
    expect(cmd?.type).toBe('unknown');
    if (cmd?.type === 'unknown') {
      expect(cmd.message).toContain('用法');
    }
  });

  it('非 /plugin → null', () => {
    expect(parsePluginCommand('/agent list')).toBeNull();
    expect(parsePluginCommand('hello')).toBeNull();
  });
});
