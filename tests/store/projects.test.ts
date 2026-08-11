/**
 * 项目注册表测试（v3.1 M2 / T2.1）。
 *
 * 覆盖：
 * - 读写：load/save 落盘 ~/.concertoai/projects.json（原子写 + 自动建目录）；
 * - 重名拒绝：add 同名抛 PROJECT_ALREADY_EXISTS；
 * - 路径规范化：Windows 反斜杠转正斜杠；
 * - 嵌套拒绝：新项目是已注册项目子目录时抛 PROJECT_NESTED；
 * - remove（卸载不删目录）/ get / list / has；
 * - 损坏 JSON / 版本不匹配 → 空注册表 + 警告（宽松读取）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  isNested,
  normalizeProjectPath,
  ProjectRegistry,
  type ProjectRegistryError,
} from '../../src/store/projects';
import {
  POSIX_ABS_PATH,
  UNC_ABS_PATH,
  UNC_POSIX_PATH,
  WIN_ABS_PATH,
  WIN_POSIX_PATH,
} from '../fixtures/platform-samples';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'projects-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const regFile = (): string => path.join(tmp, 'projects.json');

describe('normalizeProjectPath（路径规范化）', () => {
  it('Windows 反斜杠转正斜杠', () => {
    expect(normalizeProjectPath('C:\\foo\\bar')).toBe('C:/foo/bar');
  });

  it('相对路径转绝对（基于 cwd）', () => {
    const abs = normalizeProjectPath('src');
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs.includes('\\')).toBe(false);
  });

  it('归一化 .. 与重复分隔符（等价于直接路径）', () => {
    expect(normalizeProjectPath('/tmp/a/../b//c')).toBe(normalizeProjectPath('/tmp/b/c'));
    // Windows 盘符路径的 .. 归一化不依赖当前平台
    expect(normalizeProjectPath('C:\\work\\a\\..\\b')).toBe('C:/work/b');
  });
});

describe('isNested（嵌套判定）', () => {
  it('子目录 → true', () => {
    expect(isNested('/work/demo/src', ['/work/demo'])).toBe(true);
    expect(isNested('/work/demo', ['/work/demo/src'])).toBe(true);
  });

  it('同前缀但非子目录 → false（边界分隔符）', () => {
    expect(isNested('/work/demo2', ['/work/demo'])).toBe(false);
    expect(isNested('/work/demo', ['/work/demo2'])).toBe(false);
  });

  it('相同路径 → false（不是嵌套）', () => {
    expect(isNested('/work/demo', ['/work/demo'])).toBe(false);
  });

  it('Windows 盘符大小写不敏感', () => {
    expect(isNested('C:/work/demo/src', ['c:/work/demo'])).toBe(true);
  });
});

describe('normalizeProjectPath / isNested（UNC 网络共享，v3.2 M1 / T1.3）', () => {
  it('UNC 反斜杠路径 → 正斜杠（保留 //server/share 双斜杠前缀）', () => {
    expect(normalizeProjectPath(UNC_ABS_PATH)).toBe(UNC_POSIX_PATH);
  });

  it('UNC 路径 .. 归一化', () => {
    expect(normalizeProjectPath('\\\\server\\share\\demo\\..\\src')).toBe('//server/share/src');
  });

  it('UNC 单组件（\\server）→ 不当作 UNC，走 path.resolve（保持原行为）', () => {
    // 只有 server 一个组件不是合法 UNC（需 \\server\share 两级），回退普通路径处理
    const result = normalizeProjectPath('\\\\server');
    expect(result.includes('\\\\')).toBe(false);
  });

  it('UNC 嵌套判定：共享内子目录 → true', () => {
    expect(isNested('//server/share/demo/src', ['//server/share/demo'])).toBe(true);
    expect(isNested('//server/share/demo', ['//server/share/demo/src'])).toBe(true);
  });

  it('UNC 同前缀非子目录 → false（分隔符边界）', () => {
    expect(isNested('//server/share/demo2', ['//server/share/demo'])).toBe(false);
  });

  it('UNC 大小写不敏感（服务器名/共享名）', () => {
    expect(isNested('//SERVER/Share/demo/src', ['//server/share/demo'])).toBe(true);
  });

  it('UNC 与 POSIX 路径不互判嵌套', () => {
    expect(isNested('//server/share/demo', [POSIX_ABS_PATH])).toBe(false);
    expect(isNested(POSIX_ABS_PATH, ['//server/share/demo'])).toBe(false);
  });

  it('注册表 add 支持 UNC 路径并规范化', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('share', UNC_ABS_PATH);
    expect(reg.get('share')?.path).toBe(UNC_POSIX_PATH);
    // 反斜杠/正斜杠形态可互相 findByPath
    expect(reg.findByPath(UNC_POSIX_PATH)?.name).toBe('share');
  });

  it('UNC 嵌套注册拒绝（PROJECT_NESTED）', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('parent', '\\\\server\\share\\demo');
    let caught: ProjectRegistryError | undefined;
    try {
      reg.add('child', '\\\\server\\share\\demo\\sub');
    } catch (err) {
      caught = err as ProjectRegistryError;
    }
    expect(caught?.code).toBe('PROJECT_NESTED');
  });

  it('盘符路径样本回归（引用样本库 WIN_ABS_PATH）', () => {
    expect(normalizeProjectPath(WIN_ABS_PATH)).toBe(WIN_POSIX_PATH);
  });
});

describe('ProjectRegistry 读写', () => {
  it('文件不存在 → 空注册表（无警告）', async () => {
    const reg = await ProjectRegistry.load(regFile());
    expect(reg.list()).toEqual([]);
    expect(reg.warningsList()).toEqual([]);
    expect(reg.dataSnapshot()).toEqual(emptyRegistry());
  });

  it('add + save + load 持久化（含 addedAt 与规范化路径）', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', path.join(tmp, 'demo'));
    await reg.save();

    const reloaded = await ProjectRegistry.load(regFile());
    expect(reloaded.has('demo')).toBe(true);
    const entry = reloaded.get('demo');
    expect(entry?.path).toBe(normalizeProjectPath(path.join(tmp, 'demo')));
    expect(entry?.addedAt).toBeTruthy();
    expect(() => new Date(entry?.addedAt ?? '')).not.toThrow();
  });

  it('磁盘文件结构：schemaVersion + projects 映射', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', path.join(tmp, 'demo'));
    await reg.save();
    const raw = JSON.parse(readFileSync(regFile(), 'utf8')) as {
      schemaVersion: number;
      projects: Record<string, { path: string }>;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.projects.demo?.path).toBe(normalizeProjectPath(path.join(tmp, 'demo')));
  });
});

describe('ProjectRegistry add 拒绝', () => {
  it('重名抛 PROJECT_ALREADY_EXISTS', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', path.join(tmp, 'demo'));
    let caught: ProjectRegistryError | undefined;
    try {
      reg.add('demo', path.join(tmp, 'other'));
    } catch (err) {
      caught = err as ProjectRegistryError;
    }
    expect(caught?.code).toBe('PROJECT_ALREADY_EXISTS');
  });

  it('嵌套（子目录）抛 PROJECT_NESTED', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('parent', path.join(tmp, 'parent'));
    let caught: ProjectRegistryError | undefined;
    try {
      reg.add('child', path.join(tmp, 'parent', 'sub'));
    } catch (err) {
      caught = err as ProjectRegistryError;
    }
    expect(caught?.code).toBe('PROJECT_NESTED');
  });

  it('空名 / 含分隔符名 → 抛普通错误', async () => {
    const reg = await ProjectRegistry.load(regFile());
    expect(() => reg.add('', tmp)).toThrow(/项目名/);
    expect(() => reg.add('a/b', tmp)).toThrow(/项目名/);
    expect(() => reg.add('a\\b', tmp)).toThrow(/项目名/);
  });
});

describe('ProjectRegistry remove / get / list', () => {
  it('remove 卸载（不删除项目目录）', async () => {
    const projDir = path.join(tmp, 'demo');
    mkdirSync(projDir, { recursive: true });
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', projDir);
    expect(reg.remove('demo')).toBe(true);
    expect(reg.remove('demo')).toBe(false);
    expect(reg.has('demo')).toBe(false);
    // 卸载不触碰项目目录
    expect(existsSync(projDir)).toBe(true);
  });

  it('list 按名排序', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('b', path.join(tmp, 'b'));
    reg.add('a', path.join(tmp, 'a'));
    expect(reg.list().map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('get 返回副本（修改不影响内部）', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('demo', path.join(tmp, 'demo'));
    const entry = reg.get('demo');
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      entry.path = 'hacked';
    }
    expect(reg.get('demo')?.path).toBe(normalizeProjectPath(path.join(tmp, 'demo')));
  });
});

describe('ProjectRegistry 宽松读取', () => {
  it('损坏 JSON → 空注册表 + 警告', async () => {
    writeFileSync(regFile(), '{broken json', 'utf8');
    const reg = await ProjectRegistry.load(regFile());
    expect(reg.list()).toEqual([]);
    expect(reg.warningsList().length).toBeGreaterThan(0);
  });

  it('schema 版本不匹配 → 空注册表 + 警告', async () => {
    writeFileSync(regFile(), JSON.stringify({ schemaVersion: 999, projects: {} }), 'utf8');
    const reg = await ProjectRegistry.load(regFile());
    expect(reg.list()).toEqual([]);
    expect(reg.warningsList().length).toBeGreaterThan(0);
  });

  it('save 自动创建父目录', async () => {
    const nested = path.join(tmp, 'a', 'b', 'projects.json');
    const reg = await ProjectRegistry.load(nested);
    reg.add('demo', path.join(tmp, 'demo'));
    await reg.save();
    expect(readFileSync(nested, 'utf8')).toContain('demo');
  });
});
