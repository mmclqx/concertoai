/**
 * 插件运行时装配测试（v4.0 M4 / T4.2 运行时权限拦截核心）。
 *
 * 覆盖验收标准：
 * - mount 加载全局+项目插件 → 动态 import entry → 工具注入 ToolRegistry（带 pluginSource）；
 * - 工具调用前 permissionCheck 拦截：声明权限 → 放行；未声明 → 拒绝 + 审计（fail-closed）；
 * - shell 权限 → guard 通过后仍走宿主审批流（插件不可绕过）；
 * - 无 permission 声明的工具直接放行；
 * - 单个插件装配失败不影响其他（隔离 rejected）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginRuntime } from '../../src/plugin/runtime';
import { ToolRegistry } from '../../src/tools/registry';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-plugin-runtime-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 在项目插件目录（<cwd>/.concertoai/plugins/<name>）写入 plugin.json + entry（ESM .mjs）。
 * PluginLoader 项目目录约定：<cwd>/.concertoai/plugins/（T4.4），runtime.mount 内部
 * `new PluginLoader()` 无注入 → 按此路径扫描。
 */
function writePlugin(
  dir: string,
  name: string,
  entrySource: string,
  permissions: unknown[] = [],
): void {
  const pluginDir = path.join(dir, '.concertoai', 'plugins', name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      description: '测试插件',
      author: 'tester',
      category: 'tool',
      permissions,
      entry: 'index.mjs',
    }),
    'utf8',
  );
  writeFileSync(path.join(pluginDir, 'index.mjs'), entrySource, 'utf8');
}

describe('PluginRuntime.mount（装配 + 权限拦截）', () => {
  it('mount 加载插件 → 工具注册进 ToolRegistry（带 pluginSource）', async () => {
    writePlugin(
      tmp,
      'hello',
      `export const create = () => ({ id: 'hello', run: () => ({ msg: 'hi' }) });`,
    );
    const runtime = new PluginRuntime();
    const registry = new ToolRegistry();
    const result = await runtime.mount(registry, tmp, { cwd: tmp });
    expect(result.mounted.map((p) => p.name)).toEqual(['hello']);
    expect(result.rejected).toEqual([]);

    const spec = registry.get('hello');
    expect(spec?.pluginSource).toBe('plugin:hello');
    expect(spec?.pluginPermission).toBeUndefined(); // 未声明权限 → 直接放行
    const r = await registry.run('hello', {}, { cwd: tmp });
    expect(r.ok).toBe(true);
  });

  it('声明权限且已声明 → 放行；未声明 → 拒绝 + 审计（fail-closed）', async () => {
    // read 权限已声明 → 放行
    writePlugin(
      tmp,
      'reader',
      `export const create = () => ({ id: 'reader', permission: 'read', run: () => ({ ok: 1 }) });`,
      [{ type: 'read', paths: ['src'] }],
    );
    // read 权限未声明 → 拒绝
    writePlugin(
      tmp,
      'sneaky',
      `export const create = () => ({ id: 'sneaky', permission: 'read', run: () => ({ ok: 1 }) });`,
      [], // 未声明任何权限
    );

    const audits: unknown[] = [];
    const runtime = new PluginRuntime({
      audit: { append: async (e: unknown) => void audits.push(e) } as never,
    });
    const registry = new ToolRegistry();
    await runtime.mount(registry, tmp, { cwd: tmp });

    const allowed = await registry.run('reader', {}, { cwd: tmp });
    expect(allowed.ok).toBe(true);

    const denied = await registry.run('sneaky', {}, { cwd: tmp });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe('PLUGIN_PERMISSION_DENIED');
      expect(denied.error).toContain('sneaky');
    }
    // 审计日志记录了拒绝事件
    expect(audits.length).toBe(1);
    const audit = audits[0] as { detail: { action: string; plugin: string; permission: string } };
    expect(audit.detail.action).toBe('plugin-permission-denied');
    expect(audit.detail.plugin).toBe('sneaky');
    expect(audit.detail.permission).toBe('read');
  });

  it('shell 权限：guard 通过后仍走宿主审批流（拒绝 → 不执行）', async () => {
    writePlugin(
      tmp,
      'sheller',
      `export const create = () => ({ id: 'sheller', permission: 'shell', run: () => { globalThis.__ran = true; return { ran: true }; } });`,
      [{ type: 'shell', allowlist: ['npm run verify'] }],
    );
    const runtime = new PluginRuntime();
    const registry = new ToolRegistry();
    let approved = false;
    await runtime.mount(registry, tmp, {
      cwd: tmp,
      requestApproval: async () => approved,
    });

    // 用户拒绝 → 不执行
    approved = false;
    const denied = await registry.run('sheller', {}, { cwd: tmp });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe('APPROVAL_DENIED');
    }

    // 用户批准 → 执行
    approved = true;
    const allowed = await registry.run('sheller', {}, { cwd: tmp });
    expect(allowed.ok).toBe(true);
  });

  it('多工具插件（{ tools: [...] }）→ 全部注册', async () => {
    writePlugin(
      tmp,
      'multi',
      `export const create = () => ({ tools: [
        { id: 'multi-a', run: () => 'a' },
        { id: 'multi-b', run: () => 'b' },
      ] });`,
    );
    const runtime = new PluginRuntime();
    const registry = new ToolRegistry();
    await runtime.mount(registry, tmp, { cwd: tmp });
    expect(registry.get('multi-a')).toBeDefined();
    expect(registry.get('multi-b')).toBeDefined();
  });

  it('单个插件装配失败不影响其他（隔离 rejected）', async () => {
    // 正常插件
    writePlugin(tmp, 'good', `export const create = () => ({ id: 'good', run: () => 'ok' });`);
    // 损坏插件：entry 无 create 导出
    writePlugin(tmp, 'bad', `export const notCreate = 42;`);
    const runtime = new PluginRuntime();
    const registry = new ToolRegistry();
    const result = await runtime.mount(registry, tmp, { cwd: tmp });
    expect(result.mounted.map((p) => p.name)).toEqual(['good']);
    expect(result.rejected.map((r) => r.name)).toEqual(['bad']);
    expect(registry.get('good')).toBeDefined();
    expect(registry.get('bad')).toBeUndefined();
  });

  it('工具执行异常 → 隔离为 ok:false（不向上抛）', async () => {
    writePlugin(
      tmp,
      'boom',
      `export const create = () => ({ id: 'boom', run: () => { throw new Error('爆炸'); } });`,
    );
    const runtime = new PluginRuntime();
    const registry = new ToolRegistry();
    await runtime.mount(registry, tmp, { cwd: tmp });
    const r = await registry.run('boom', {}, { cwd: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('爆炸');
    }
  });
});
