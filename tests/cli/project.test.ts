/**
 * project 命令测试（v3.1 M2 / T2.2 + T2.3）。
 *
 * 覆盖：
 * - add：缺省 path 用 cwd；成功输出「✅ 项目 x 已注册」；重名输出明确错误；
 * - list：表格含 name / path / addedAt；空注册表提示；
 * - remove：卸载输出「🗑️」；未注册输出「未注册」；
 * - info：显示 path / whitelist / mcpServers；未注册输出「未注册」；
 * - switch：已注册输出「✅ 已切换到项目」；未注册输出「未注册」；
 * - 无副作用：add/remove 不触碰项目目录。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProjectCommand } from '../../src/cli/project';
import { ProjectRegistry } from '../../src/store/projects';

let tmp: string;
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'project-cli-'));
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  logSpy.mockRestore();
});

const regFile = (): string => path.join(tmp, 'projects.json');

describe('project add', () => {
  it('注册成功：path 缺省用 cwd，输出 ✅ 与规范化路径', async () => {
    const projDir = path.join(tmp, 'demo');
    mkdirSync(projDir, { recursive: true });
    await runProjectCommand({ cwd: projDir, action: 'add', name: 'demo', registryFile: regFile() });
    const out = logs.join('\n');
    expect(out).toContain('✅ 项目 demo 已注册');
    expect(out).toContain(projDir.replace(/\\/g, '/'));
    // 落盘
    const reg = await ProjectRegistry.load(regFile());
    expect(reg.has('demo')).toBe(true);
  });

  it('重名 → 明确错误且不覆盖', async () => {
    await runProjectCommand({
      cwd: tmp,
      action: 'add',
      name: 'demo',
      path: path.join(tmp, 'a'),
      registryFile: regFile(),
    });
    logs = [];
    await runProjectCommand({
      cwd: tmp,
      action: 'add',
      name: 'demo',
      path: path.join(tmp, 'b'),
      registryFile: regFile(),
    });
    expect(logs.join('\n')).toContain('已注册');
    const reg = await ProjectRegistry.load(regFile());
    expect(reg.get('demo')?.path).toBe(path.join(tmp, 'a').replace(/\\/g, '/'));
  });

  it('嵌套注册 → 明确错误', async () => {
    await runProjectCommand({
      cwd: tmp,
      action: 'add',
      name: 'parent',
      path: path.join(tmp, 'parent'),
      registryFile: regFile(),
    });
    logs = [];
    await runProjectCommand({
      cwd: tmp,
      action: 'add',
      name: 'child',
      path: path.join(tmp, 'parent', 'sub'),
      registryFile: regFile(),
    });
    expect(logs.join('\n')).toContain('子目录');
    expect(logs.join('\n')).toContain('❌');
  });

  it('无副作用：add 不创建/修改项目目录内容', async () => {
    const projDir = path.join(tmp, 'empty-dir');
    // 目录不存在也不创建（注册表只记录路径）
    await runProjectCommand({ cwd: projDir, action: 'add', name: 'demo', registryFile: regFile() });
    expect(existsSync(projDir)).toBe(false);
  });
});

describe('project list', () => {
  it('列出 name / path / addedAt', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', path.join(tmp, 'demo'));
    reg.add('alpha', path.join(tmp, 'alpha'));
    await reg.save();

    await runProjectCommand({ cwd: tmp, action: 'list', registryFile: regFile() });
    const out = logs.join('\n');
    expect(out).toContain('demo');
    expect(out).toContain('alpha');
    expect(out).toContain(path.join(tmp, 'demo').replace(/\\/g, '/'));
    expect(out).toContain('注册时间');
  });

  it('空注册表 → 提示暂无', async () => {
    await runProjectCommand({ cwd: tmp, action: 'list', registryFile: regFile() });
    expect(logs.join('\n')).toContain('暂无');
  });
});

describe('project remove', () => {
  it('卸载成功：输出 🗑️，注册表移除，项目目录保留', async () => {
    const projDir = path.join(tmp, 'demo');
    mkdirSync(projDir, { recursive: true });
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', projDir);
    await reg.save();

    await runProjectCommand({ cwd: tmp, action: 'remove', name: 'demo', registryFile: regFile() });
    expect(logs.join('\n')).toContain('🗑️ 项目 demo 已卸载');
    const reloaded = await ProjectRegistry.load(regFile());
    expect(reloaded.has('demo')).toBe(false);
    // 项目目录未被删除
    expect(existsSync(projDir)).toBe(true);
  });

  it('未注册 → 输出「未注册」', async () => {
    await runProjectCommand({ cwd: tmp, action: 'remove', name: 'ghost', registryFile: regFile() });
    expect(logs.join('\n')).toContain('项目 ghost 未注册');
  });
});

describe('project switch（T2.3）', () => {
  it('已注册 → 输出「✅ 已切换到项目」与路径', async () => {
    const projDir = path.join(tmp, 'demo');
    mkdirSync(projDir, { recursive: true });
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', projDir);
    await reg.save();

    await runProjectCommand({ cwd: tmp, action: 'switch', name: 'demo', registryFile: regFile() });
    const out = logs.join('\n');
    expect(out).toContain('✅ 已切换到项目 demo');
    expect(out).toContain(projDir.replace(/\\/g, '/'));
    expect(out).toContain('-p');
  });

  it('未注册 → 输出「未注册」并提示先注册', async () => {
    await runProjectCommand({ cwd: tmp, action: 'switch', name: 'ghost', registryFile: regFile() });
    const out = logs.join('\n');
    expect(out).toContain('项目 ghost 未注册');
    expect(out).toContain('project add');
  });
});

describe('project info', () => {
  it('显示 path / whitelist / mcpServers（未设置提示用全局）', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', path.join(tmp, 'demo'));
    await reg.save();

    await runProjectCommand({ cwd: tmp, action: 'info', name: 'demo', registryFile: regFile() });
    const out = logs.join('\n');
    expect(out).toContain('路径');
    expect(out).toContain('注册时间');
    expect(out).toContain('白名单');
    expect(out).toContain('MCP 服务');
    expect(out).toContain('使用全局');
  });

  it('未注册 → 输出「未注册」', async () => {
    await runProjectCommand({ cwd: tmp, action: 'info', name: 'ghost', registryFile: regFile() });
    expect(logs.join('\n')).toContain('项目 ghost 未注册');
  });
});
