/**
 * 插件加载器测试（v4.0 M4 / T4.4）。
 *
 * 覆盖验收标准：
 * - plugin.json 解析 + zod schema 校验；
 * - 全局/项目双路径扫描（同名项目级覆盖全局级）；
 * - 动态注册（loadAll → list/get）；
 * - 非 ESM 插件拒绝加载并明确报错（ESM 强制）；
 * - 目录名与 plugin.json name 一致性校验、entry 缺失拒绝。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEsm, PluginLoader } from '../../src/plugin/loader';
import { parsePluginJson } from '../../src/plugin/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-plugin-loader-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 测试辅助 ──────────────────────────────────────────────────

/** 写入一个插件目录（global 或 project 下），返回插件目录路径。 */
function writePlugin(
  base: string,
  name: string,
  overrides: Record<string, unknown> = {},
  entryExt = 'index.mjs',
): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  const pluginJson = {
    name,
    version: '1.0.0',
    description: '测试插件',
    author: 'tester',
    category: 'tool',
    permissions: [{ type: 'read', paths: ['src'] }],
    entry: `index${entryExt}`,
    ...overrides,
  };
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(pluginJson, null, 2), 'utf8');
  // 写入入口（.js 时按需补 package.json type=module）
  writeFileSync(path.join(dir, `index${entryExt}`), 'export const create = () => ({});', 'utf8');
  if (entryExt === '.js') {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  }
  return dir;
}

// ── parsePluginJson（T4.4 验收 1：解析 + zod 校验）─────────────

describe('parsePluginJson（plugin.json 解析 + zod 校验）', () => {
  it('合法 plugin.json：字段齐全 → Plugin 对象', () => {
    const result = parsePluginJson(
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        description: '演示',
        author: 'tester',
        category: 'workflow',
        permissions: [{ type: 'network', allowedDomains: ['api.github.com'] }],
        entry: 'index.mjs',
      }),
    );
    expect('plugin' in result).toBe(true);
    if ('plugin' in result) {
      expect(result.plugin.name).toBe('demo');
      expect(result.plugin.category).toBe('workflow');
      expect(result.plugin.permissions[0]?.type).toBe('network');
    }
  });

  it('缺 entry → 报错（entry 必填 = ESM 入口）', () => {
    const result = parsePluginJson(JSON.stringify({ name: 'demo', version: '1.0.0' }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('entry');
    }
  });

  it('未知字段（strict）→ 报错', () => {
    const result = parsePluginJson(
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        entry: 'index.mjs',
        unknownField: 1,
      }),
    );
    expect('error' in result).toBe(true);
  });

  it('非法 JSON / 空 permissions 默认 [] → 均可解析', () => {
    expect('error' in parsePluginJson('{not json')).toBe(true);
    const result = parsePluginJson(
      JSON.stringify({ name: 'demo', version: '1.0.0', entry: 'index.mjs' }),
    );
    expect('plugin' in result).toBe(true);
    if ('plugin' in result) {
      expect(result.plugin.permissions).toEqual([]);
    }
  });
});

// ── PluginLoader 双路径扫描（T4.4 验收 2）─────────────────────

describe('PluginLoader（全局/项目双路径扫描）', () => {
  it('扫描全局 + 项目目录，全部加载', () => {
    const globalDir = path.join(tmp, 'global');
    const projectDir = path.join(tmp, 'project');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writePlugin(globalDir, 'alpha');
    writePlugin(globalDir, 'beta');
    writePlugin(projectDir, 'gamma');

    const loader = new PluginLoader({ globalDir, projectDir });
    const result = loader.loadAll(tmp);
    expect(result.rejected).toEqual([]);
    expect(result.plugins.map((p) => p.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('同名插件：项目级覆盖全局级（后注册覆盖先注册）', () => {
    const globalDir = path.join(tmp, 'global');
    const projectDir = path.join(tmp, 'project');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writePlugin(globalDir, 'shared', { version: '1.0.0' });
    writePlugin(projectDir, 'shared', { version: '2.0.0' });

    const loader = new PluginLoader({ globalDir, projectDir });
    loader.loadAll(tmp);
    expect(loader.get('shared')?.version).toBe('2.0.0');
    expect(loader.list()).toHaveLength(1);
  });

  it('目录名与 plugin.json name 不一致 → 拒绝并记录原因', () => {
    const globalDir = path.join(tmp, 'global');
    mkdirSync(globalDir, { recursive: true });
    const dir = writePlugin(globalDir, 'real-name');
    // 改 plugin.json 的 name 使其与目录名不一致
    writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ name: 'other-name', version: '1.0.0', entry: 'index.mjs' }),
      'utf8',
    );

    const loader = new PluginLoader({ globalDir });
    const result = loader.loadAll(tmp);
    expect(result.plugins).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('不一致');
  });

  it('entry 不存在 → 拒绝', () => {
    const globalDir = path.join(tmp, 'global');
    mkdirSync(globalDir, { recursive: true });
    writePlugin(globalDir, 'demo', { entry: 'missing.mjs' });

    const loader = new PluginLoader({ globalDir });
    const result = loader.loadAll(tmp);
    expect(result.rejected[0]?.reason).toContain('入口不存在');
  });
});

// ── ESM 强制（T4.4 验收 4）────────────────────────────────────

describe('checkEsm（ESM 强制，非 ESM 拒绝并明确报错）', () => {
  it('.mjs 入口 → 通过', () => {
    const dir = path.join(tmp, 'p1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.mjs'), 'export {};', 'utf8');
    expect(checkEsm(path.join(dir, 'index.mjs'))).toBeNull();
  });

  it('.js 入口 + 同目录 package.json type=module → 通过', () => {
    const dir = path.join(tmp, 'p2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.js'), 'export {};', 'utf8');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    expect(checkEsm(path.join(dir, 'index.js'))).toBeNull();
  });

  it('.js 入口无 type=module → 拒绝（明确报错提示）', () => {
    const dir = path.join(tmp, 'p3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};', 'utf8');
    const err = checkEsm(path.join(dir, 'index.js'));
    expect(err).not.toBeNull();
    expect(err).toContain('type');
    expect(err).toContain('module');
  });

  it('.cjs / 无扩展名 → 拒绝', () => {
    const dir = path.join(tmp, 'p4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.cjs'), 'module.exports = {};', 'utf8');
    const err = checkEsm(path.join(dir, 'index.cjs'));
    expect(err).not.toBeNull();
    expect(err).toContain('ESM');
  });
});
