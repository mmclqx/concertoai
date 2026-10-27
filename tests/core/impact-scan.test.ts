/**
 * 影响面扫描测试（v5.0 T8）。
 *
 * 最要紧的四条（都是「不做就会毁掉审批体验」的）：
 * 1. **并发数有上限**（裸 Promise.all 铺 2000 文件 → Windows EMFILE → 审批直接崩）；
 * 2. **单文件失败不中断**（EACCES/EPERM/ENOENT 只计 skippedCount）；
 * 3. **300ms 硬超时保留部分结果**；
 * 4. **缓存按 mtime 失效**（连续编辑同一文件不重复扫，但文件变了必须重扫）。
 */

import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearImpactCache,
  extractExportedSymbols,
  IMPACT_LIMITS,
  lineReferencesTarget,
  normalizePath,
  runWithConcurrency,
  scanImpact,
} from '../../src/core/impact-scan';

beforeEach(() => {
  clearImpactCache();
});

/**
 * 构造虚拟文件系统。
 *
 * `dirs` 的键是**目录相对路径**（`'.'` = cwd 根，`'src'` = 子目录），值是条目名；
 * `contents` 的键是**文件相对路径**（`'src/a.ts'`）。
 *
 * 注意：`readFile`/`stat` 收到的是**绝对路径**（真实实现如此），所以这里统一
 * 「归一化 → 取相对 cwd 的部分」再查表，否则测试会因为绝对/相对不一致而假失败。
 */
function fakeFs(contents: Record<string, string>, dirs: Record<string, string[]>) {
  const rel = (p: string): string => {
    const abs = normalizePath(path.resolve(p));
    const root = normalizePath(path.resolve('.'));
    return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  };
  return {
    readdirImpl: async (dir: string) => {
      const key = rel(dir) === normalizePath(path.resolve('.')) ? '.' : rel(dir);
      const names = dirs[key] ?? [];
      return names.map((name) => ({
        name,
        isDirectory: contents[`${key === '.' ? '' : `${key}/`}${name}`] === undefined,
      }));
    },
    readFileImpl: async (file: string) => {
      const text = contents[rel(file)];
      if (text === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return text;
    },
    statImpl: async () => ({ mtimeMs: 1 }),
  };
}

describe('默认约束（改动前先读这里）', () => {
  it('硬超时 300ms / 上限 2000 文件 / 并发 32 / 缓存 5s', () => {
    expect(IMPACT_LIMITS).toEqual({
      timeoutMs: 300,
      maxFiles: 2000,
      concurrency: 32,
      cacheTtlMs: 5000,
    });
  });
});

describe('runWithConcurrency（禁止裸 Promise.all 的落地实现）', () => {
  it('并发数不超过上限', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 50 }, () => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return 'ok';
    });
    const results = await runWithConcurrency(tasks, 8);
    expect(results).toHaveLength(50);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('结果顺序与任务顺序一致（不能乱序，否则引用列表会错位）', async () => {
    const tasks = [3, 1, 2].map((delay) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });
    expect(await runWithConcurrency(tasks, 3)).toEqual([3, 1, 2]);
  });

  it('空任务列表返回空数组（不挂死）', async () => {
    expect(await runWithConcurrency([], 4)).toEqual([]);
  });

  it('limit 大于任务数时不报错', async () => {
    expect(await runWithConcurrency([async () => 1], 32)).toEqual([1]);
  });
});

describe('normalizePath（W3/W4/W5）', () => {
  it('反斜杠→正斜杠、小写、保留盘符', () => {
    expect(normalizePath('A\\B\\C.TS')).toBe('a/b/c.ts');
    expect(normalizePath('D:\\proj\\x.ts')).toBe('d:/proj/x.ts');
  });
});

describe('extractExportedSymbols', () => {
  it('提取 function/const/class/interface/type/enum', () => {
    const source = [
      'export function a() {}',
      'export const b = 1;',
      'export class C {}',
      'export interface D {}',
      'export type E = string;',
      'export enum F { X }',
      'export async function g() {}',
    ].join('\n');
    expect(extractExportedSymbols(source).sort()).toEqual(
      ['a', 'b', 'C', 'D', 'E', 'F', 'g'].sort(),
    );
  });

  it('export { } 聚合取导出名（含 as 别名）', () => {
    const symbols = extractExportedSymbols('export { canAccess, foo as bar, type Baz };');
    expect(symbols).toContain('canAccess');
    expect(symbols).toContain('bar'); // 别名
    expect(symbols).toContain('Baz');
    expect(symbols).not.toContain('foo'); // 原名不导出
  });

  it('无导出返回空数组', () => {
    expect(extractExportedSymbols('const x = 1;')).toEqual([]);
  });
});

describe('lineReferencesTarget（谁 import 了我）', () => {
  it('ESM from（带/不带扩展名）都识别', () => {
    expect(lineReferencesTarget("import { a } from './a';", 'src', 'src/a.ts')).toBe(true);
    expect(lineReferencesTarget("import { a } from './a.ts';", 'src', 'src/a.ts')).toBe(true);
    expect(lineReferencesTarget("import { a } from './a.js';", 'src', 'src/a.ts')).toBe(true);
  });

  it('require / 动态 import 识别', () => {
    expect(lineReferencesTarget("const a = require('./a');", 'src', 'src/a.ts')).toBe(true);
    expect(lineReferencesTarget("const a = await import('./a');", 'src', 'src/a.ts')).toBe(true);
  });

  it('index 文件约定识别', () => {
    expect(lineReferencesTarget("import { a } from './a';", 'src', 'src/a/index.ts')).toBe(true);
  });

  it('目录层级不同则不算引用（避免把同名文件全算上）', () => {
    expect(lineReferencesTarget("import { a } from './a';", 'src/other', 'src/a.ts')).toBe(false);
  });

  it('包名（非相对路径）不算引用', () => {
    expect(lineReferencesTarget("import fs from 'node:fs';", 'src', 'src/fs.ts')).toBe(false);
  });

  it('多段文件名带点（a/b.e.ts）也能匹配省略扩展名的 import', () => {
    expect(lineReferencesTarget("import x from './b.e';", 'src/a', 'src/a/b.e.ts')).toBe(true);
  });

  // W1/W3：反斜杠路径（Windows 风格 import 不常见，但归一化必须一致）
  it('反斜杠形式 from 也能识别（归一化后比较）', () => {
    expect(lineReferencesTarget("import { a } from '.\\\\a';", 'src', 'src/a.ts')).toBe(true);
  });
});

describe('scanImpact：引用统计', () => {
  it('统计引用者数量与前 3 个路径', async () => {
    const fs = fakeFs(
      {
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': "import { a } from './a';",
        'src/c.ts': "import { a } from './a';",
        'src/d.ts': "import { a } from './a';",
        'src/e.ts': "import { a } from './a';",
        'src/f.ts': 'const x = 1;',
      },
      { '.': ['src'], src: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] },
    );
    const summary = await scanImpact({ file: 'src/a.ts', cwd: '.', ...fs });
    expect(summary.status).toBe('ok');
    expect(summary.referenceCount).toBe(4);
    expect(summary.topPaths).toHaveLength(3);
    expect(summary.exportedSymbols).toContain('a');
  });

  it('无人引用 → 0（这是「随便改」的信号，必须准确）', async () => {
    const fs = fakeFs(
      { 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'const x = 1;' },
      { '.': ['src'], src: ['a.ts', 'b.ts'] },
    );
    const summary = await scanImpact({ file: 'src/a.ts', cwd: '.', ...fs });
    expect(summary.referenceCount).toBe(0);
    expect(summary.status).toBe('ok');
  });

  it('跳过 node_modules / dist / .git（不扫构建产物）', async () => {
    const fs = fakeFs(
      { 'src/a.ts': 'export const a = 1;', 'node_modules/x.ts': "import './a';" },
      { '.': ['src', 'node_modules', 'dist', '.git'], src: ['a.ts'] },
    );
    const summary = await scanImpact({ file: 'src/a.ts', cwd: '.', ...fs });
    expect(summary.referenceCount).toBe(0);
  });
});

describe('scanImpact：失败隔离（绝不中断整体）', () => {
  it('单文件读失败 → skippedCount +1，其余照常统计', async () => {
    // 目标与引用者都放在 cwd 根（扫描范围就是根，相对路径才能对上）
    const summary = await scanImpact({
      file: 'a.ts',
      cwd: '.',
      readdirImpl: async () => [
        { name: 'b.ts', isDirectory: false },
        { name: 'c.ts', isDirectory: false },
      ],
      readFileImpl: async (file: string) => {
        if (file.endsWith('a.ts')) return 'export const a = 1;';
        if (file.endsWith('b.ts')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return "import { a } from './a';";
      },
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(summary.status).toBe('ok');
    expect(summary.skippedCount).toBe(1);
    expect(summary.referenceCount).toBe(1);
    expect(summary.scannedCount).toBe(1);
  });

  it('目录列举抛错 → 整体 status=error 但不向上抛（G2）', async () => {
    const summary = await scanImpact({
      file: 'src/a.ts',
      cwd: '.',
      readdirImpl: async () => {
        throw new Error('EACCES');
      },
      readFileImpl: async () => 'export const a = 1;',
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(summary.status).toBe('error');
    expect(summary.referenceCount).toBe(0);
  });

  it('目标文件读不到 → 导出符号为空但引用统计照常', async () => {
    const summary = await scanImpact({
      file: 'missing.ts',
      cwd: '.',
      readdirImpl: async () => [{ name: 'b.ts', isDirectory: false }],
      readFileImpl: async (file: string) => {
        if (file.includes('missing')) throw new Error('ENOENT');
        return "import x from './missing';";
      },
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(summary.exportedSymbols).toEqual([]);
    expect(summary.referenceCount).toBe(1);
  });
});

describe('scanImpact：超时与上限', () => {
  it('超时 → status=timeout，保留已完成的部分结果', async () => {
    let clock = 0;
    const summary = await scanImpact({
      file: 'src/a.ts',
      cwd: '.',
      timeoutMs: 10,
      concurrency: 1,
      now: () => (clock += 20), // 每次取时间都超过 deadline
      readdirImpl: async () => [
        { name: 'b.ts', isDirectory: false },
        { name: 'c.ts', isDirectory: false },
      ],
      readFileImpl: async (file: string) =>
        file.includes('a.ts') ? 'export const a = 1;' : "import { a } from './a';",
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(summary.status).toBe('timeout');
    // 不抛错、结构完整（即便一个文件都没来得及扫）
    expect(summary.referenceCount).toBeGreaterThanOrEqual(0);
  });

  it('文件数超上限 → status=skipped（不硬扫大项目）', async () => {
    const summary = await scanImpact({
      file: 'src/a.ts',
      cwd: '.',
      maxFiles: 5,
      readdirImpl: async () =>
        Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false })),
      readFileImpl: async () => 'export const a = 1;',
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(summary.status).toBe('skipped');
    expect(summary.scannedCount).toBe(0);
  });
});

describe('scanImpact：5s TTL 缓存', () => {
  it('同文件同 mtime 第二次命中缓存（不重复读盘）', async () => {
    let reads = 0;
    const readFileImpl = async (file: string) => {
      reads += 1;
      return file.includes('a.ts') ? 'export const a = 1;' : "import { a } from './a';";
    };
    const options = {
      file: 'src/a.ts',
      cwd: '.',
      readdirImpl: async () => [{ name: 'b.ts', isDirectory: false }],
      readFileImpl,
      statImpl: async () => ({ mtimeMs: 100 }),
    };
    const first = await scanImpact(options);
    const readsAfterFirst = reads;
    const second = await scanImpact(options);
    expect(second.referenceCount).toBe(first.referenceCount);
    expect(reads).toBe(readsAfterFirst); // 没有新增读取
  });

  it('mtime 变化 → 缓存失效并重新扫描（文件变了必须重算）', async () => {
    let mtime = 100;
    let reads = 0;
    const options = {
      file: 'src/a.ts',
      cwd: '.',
      readdirImpl: async () => [{ name: 'b.ts', isDirectory: false }],
      readFileImpl: async (file: string) => {
        reads += 1;
        return file.includes('a.ts') ? 'export const a = 1;' : "import { a } from './a';";
      },
      statImpl: async () => ({ mtimeMs: mtime }),
    };
    await scanImpact(options);
    const readsAfterFirst = reads;
    mtime = 200; // 文件被改
    await scanImpact(options);
    expect(reads).toBeGreaterThan(readsAfterFirst);
  });

  it('TTL 过期 → 重新扫描', async () => {
    let clock = 0;
    let reads = 0;
    const options = {
      file: 'src/a.ts',
      cwd: '.',
      cacheTtlMs: 50,
      now: () => (clock += 30),
      readdirImpl: async () => [{ name: 'b.ts', isDirectory: false }],
      readFileImpl: async (file: string) => {
        reads += 1;
        return file.includes('a.ts') ? 'export const a = 1;' : "import { a } from './a';";
      },
      statImpl: async () => ({ mtimeMs: 100 }),
    };
    await scanImpact(options);
    const readsAfterFirst = reads;
    // 连续调用直到时钟跨过 TTL
    for (let i = 0; i < 3; i += 1) {
      await scanImpact(options);
    }
    expect(reads).toBeGreaterThan(readsAfterFirst);
  });

  it('clearImpactCache 后重新扫描', async () => {
    let reads = 0;
    const options = {
      file: 'src/a.ts',
      cwd: '.',
      readdirImpl: async () => [{ name: 'b.ts', isDirectory: false }],
      readFileImpl: async (file: string) => {
        reads += 1;
        return file.includes('a.ts') ? 'export const a = 1;' : "import { a } from './a';";
      },
      statImpl: async () => ({ mtimeMs: 100 }),
    };
    await scanImpact(options);
    const readsAfterFirst = reads;
    clearImpactCache();
    await scanImpact(options);
    expect(reads).toBeGreaterThan(readsAfterFirst);
  });

  it('cacheTtlMs=0 → 完全禁用缓存', async () => {
    let reads = 0;
    const options = {
      file: 'src/a.ts',
      cwd: '.',
      cacheTtlMs: 0,
      readdirImpl: async () => [{ name: 'b.ts', isDirectory: false }],
      readFileImpl: async (file: string) => {
        reads += 1;
        return file.includes('a.ts') ? 'export const a = 1;' : "import { a } from './a';";
      },
      statImpl: async () => ({ mtimeMs: 100 }),
    };
    await scanImpact(options);
    const readsAfterFirst = reads;
    await scanImpact(options);
    expect(reads).toBeGreaterThan(readsAfterFirst);
  });
});

describe('scanImpact：性能与并发（发布门）', () => {
  it('200 文件项目 < 80ms（常态预算）', async () => {
    const summary = await scanImpact({
      file: 'src/target.ts',
      cwd: '.',
      readdirImpl: async () =>
        Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false })),
      readFileImpl: async () => "import x from './target';",
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(summary.status).toBe('ok');
    expect(summary.elapsedMs).toBeLessThan(80);
  });

  it('500 文件下并发读取不超过 32（防 EMFILE）', async () => {
    let running = 0;
    let peak = 0;
    await scanImpact({
      file: 'src/target.ts',
      cwd: '.',
      readdirImpl: async () =>
        Array.from({ length: 500 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false })),
      readFileImpl: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running -= 1;
        return "import x from './target';";
      },
      statImpl: async () => ({ mtimeMs: 1 }),
    });
    expect(peak).toBeLessThanOrEqual(IMPACT_LIMITS.concurrency);
  });
});
