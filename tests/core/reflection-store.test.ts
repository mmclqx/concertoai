/**
 * 拒绝复盘记录测试（v5.0 T10）。
 *
 * 覆盖三条铁律 + 边缘路径：
 * - G8 零网络：扫源码断言无 `http`/`net`/`fetch`/`axios`；
 * - G2' 写盘失败不阻断：目录只读 / 路径非法 → `{ ok: false }` 而**不抛错**；
 * - 可关闭：`isReflectionsEnabled` 双轨（env > config）；
 * 边缘：首次（文件不存在）/ 损坏行跳过 / 超长截断 / 倒序 / limit / clear 幂等。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendReflection,
  buildReflection,
  clearReflections,
  defaultReflectionsPath,
  isReflectionsEnabled,
  MAX_CATEGORIES,
  MAX_FOCUS_LINES,
  projectNameOf,
  type ReflectionEntry,
  readReflections,
} from '../../src/core/reflection-store';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-reflect-'));
  file = path.join(tmp, 'reflections.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entryOf(overrides: Partial<ReflectionEntry> = {}): ReflectionEntry {
  return {
    ts: 1_700_000_000_000,
    project: 'demo',
    file: 'src/a.ts',
    level: 'high',
    categories: ['删除/破坏性'],
    focusLines: [3],
    intent: 'modify',
    decision: 'rejected',
    ...overrides,
  };
}

describe('G8：零网络（源码护栏）', () => {
  it('reflection-store.ts / reflect.ts 不 import 任何网络模块，也不用 fetch', () => {
    for (const rel of ['src/core/reflection-store.ts', 'src/cli/reflect.ts']) {
      const source = readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(source).not.toMatch(/from\s+['"](?:node:)?(?:http|https|net|tls|dns)['"]/);
      expect(source).not.toMatch(/from\s+['"]axios['"]/);
      // 允许注释里出现 "fetch"（说明零网络），但不得有真实的调用
      expect(source).not.toMatch(/[^/\w]fetch\s*\(/);
    }
  });
});

describe('buildReflection：字段规则', () => {
  it('字段齐全且 decision 固定为 rejected', () => {
    const entry = buildReflection({
      file: 'src/a.ts',
      level: 'high',
      categories: ['删除/破坏性'],
      focusLines: [3],
      intent: 'modify',
      cwd: path.join(tmp, 'my-proj'),
      now: () => 1234,
    });
    expect(entry).toEqual({
      ts: 1234,
      project: 'my-proj',
      file: 'src/a.ts',
      level: 'high',
      categories: ['删除/破坏性'],
      focusLines: [3],
      intent: 'modify',
      decision: 'rejected',
    });
  });

  it('未分析（level 缺失）→ unknown，且不落 categories（不谎报低风险）', () => {
    const entry = buildReflection({ level: null, categories: ['网络超时'], cwd: '/tmp/p' });
    expect(entry.level).toBe('unknown');
    expect(entry.categories).toEqual([]);
    expect(buildReflection({}).level).toBe('unknown');
  });

  it('categories 去重 + 截断 5 条；focusLines 去重 + 截断 10 条', () => {
    const entry = buildReflection({
      level: 'medium',
      categories: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
      focusLines: Array.from({ length: 15 }, (_, i) => (i % 15 === 0 ? 0 : i)),
    });
    expect(entry.categories).toHaveLength(MAX_CATEGORIES);
    expect(entry.categories[0]).toBe('a');
    expect(entry.categories.filter((c) => c === 'a')).toHaveLength(1);
    expect(entry.focusLines.length).toBeLessThanOrEqual(MAX_FOCUS_LINES);
    expect(new Set(entry.focusLines).size).toBe(entry.focusLines.length);
  });

  it('无文件上下文 → file 空串（不是 undefined / null，读取端字段类型稳定）', () => {
    expect(buildReflection({ level: 'low' }).file).toBe('');
  });
});

describe('projectNameOf：项目名推导', () => {
  it('正常路径取 basename（Windows 反斜杠与 POSIX 都行）', () => {
    expect(projectNameOf('/home/u/proj')).toBe('proj');
    expect(projectNameOf('F:\\developer\\2026\\concertoai')).toBe('concertoai');
  });

  it('空 / 根 / 点 → unknown（不编造）', () => {
    expect(projectNameOf(undefined)).toBe('unknown');
    expect(projectNameOf('   ')).toBe('unknown');
    expect(projectNameOf('/')).toBe('unknown');
    expect(projectNameOf('..')).toBe('unknown');
  });
});

describe('appendReflection / readReflections', () => {
  it('首次写入自动建目录（文件不存在 → 创建）', async () => {
    const nested = path.join(tmp, 'a', 'b', 'reflections.jsonl');
    const result = await appendReflection(entryOf(), { file: nested });
    expect(result.ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
    const read = await readReflections({ file: nested });
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.file).toBe('src/a.ts');
  });

  it('O_APPEND 追加：多次写入保留历史且逐行独立 JSON', async () => {
    await appendReflection(entryOf({ ts: 1000, file: 'a.ts' }), { file });
    await appendReflection(entryOf({ ts: 2000, file: 'b.ts' }), { file });
    const raw = readFileSync(file, 'utf8');
    expect(raw.split('\n').filter((line) => line.trim() !== '')).toHaveLength(2);
    // 每行都是可独立解析的 JSON（JSONL 的硬要求）
    for (const line of raw.split('\n').filter((l) => l.trim() !== '')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('倒序读取（最新在前）+ limit 生效', async () => {
    for (const ts of [1000, 3000, 2000]) {
      await appendReflection(entryOf({ ts, file: `${ts}.ts` }), { file });
    }
    const all = await readReflections({ file });
    expect(all.entries.map((e) => e.ts)).toEqual([3000, 2000, 1000]);
    const limited = await readReflections({ file, limit: 2 });
    expect(limited.entries.map((e) => e.ts)).toEqual([3000, 2000]);
  });

  it('同一毫秒的多条记录：后写的在上（排序稳定）', async () => {
    await appendReflection(entryOf({ ts: 5000, file: 'first.ts' }), { file });
    await appendReflection(entryOf({ ts: 5000, file: 'second.ts' }), { file });
    const { entries } = await readReflections({ file });
    expect(entries.map((e) => e.file)).toEqual(['second.ts', 'first.ts']);
  });

  it('文件不存在 → 空结果（首次运行不报错）', async () => {
    const read = await readReflections({ file: path.join(tmp, 'nope.jsonl') });
    expect(read.entries).toEqual([]);
    expect(read.skipped).toBe(0);
  });

  it('损坏行跳过并计数，不中断读取（半行 / 非 JSON / 字段缺失）', async () => {
    writeFileSync(
      file,
      [
        JSON.stringify(entryOf({ ts: 1 })),
        '{"ts": 2, "project": "p"', // 写入被打断的半行
        'not json at all',
        JSON.stringify({ ts: 3, project: 'p', file: 'x.ts', level: 'bogus' }), // level 非法
        '',
        JSON.stringify(entryOf({ ts: 4 })),
      ].join('\n'),
      'utf8',
    );
    const read = await readReflections({ file });
    expect(read.entries).toHaveLength(2);
    expect(read.skipped).toBe(3);
  });

  it('超长记录（500 条）只返回 limit 条，但全量文件仍完整', async () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify(entryOf({ ts: i, file: `f${i}.ts` })),
    );
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const read = await readReflections({ file, limit: 20 });
    expect(read.entries).toHaveLength(20);
    expect(read.entries[0]?.ts).toBe(499);
    expect(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== ''),
    ).toHaveLength(500);
  });
});

describe("G2'：写盘失败绝不阻断审批", () => {
  it('目标路径是不可写目录 → 返回 ok:false 且不抛错', async () => {
    // 用「文件当目录」制造确定性的失败（跨平台稳定，不依赖 chmod 语义）
    const blocker = path.join(tmp, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const result = await appendReflection(entryOf(), { file: path.join(blocker, 'r.jsonl') });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('目录只读（chmod 500）→ 不抛错（POSIX 语义；Windows 上跳过）', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const readOnly = path.join(tmp, 'ro');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      const result = await appendReflection(entryOf(), { file: path.join(readOnly, 'r.jsonl') });
      expect(result.ok).toBe(false);
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});

describe('clearReflections：幂等清空', () => {
  it('清空后文件不存在；重复清空不报错', async () => {
    await appendReflection(entryOf(), { file });
    const first = await clearReflections({ file });
    expect(first.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    const second = await clearReflections({ file });
    expect(second.ok).toBe(true); // 幂等：空目录上重复清空不算失败
  });

  it('清空后读取返回空', async () => {
    await appendReflection(entryOf(), { file });
    await clearReflections({ file });
    expect((await readReflections({ file })).entries).toEqual([]);
  });
});

describe('isReflectionsEnabled：双轨开关', () => {
  it('缺省 on（不配置也记录，但纯本地零上传）', () => {
    expect(isReflectionsEnabled()).toBe(true);
    expect(isReflectionsEnabled(undefined, undefined)).toBe(true);
  });

  it('config off → 关；config 其他值 → 开（写错字符串不悄悄关掉功能）', () => {
    expect(isReflectionsEnabled('off')).toBe(false);
    expect(isReflectionsEnabled('on')).toBe(true);
    expect(isReflectionsEnabled('oops')).toBe(true);
  });

  it('环境变量优先于 config（env 关 = 关，即使 config 是 on）', () => {
    expect(isReflectionsEnabled('on', 'off')).toBe(false);
    expect(isReflectionsEnabled('off', 'on')).toBe(true);
    expect(isReflectionsEnabled('off', 'false')).toBe(false);
    expect(isReflectionsEnabled('off', 'FALSE')).toBe(false);
    expect(isReflectionsEnabled('off', '')).toBe(false); // 空环境变量 = 未设置
  });
});

describe('defaultReflectionsPath', () => {
  it('指向 ~/.concertoai/reflections.jsonl（单一来源 store/paths.ts）', () => {
    expect(defaultReflectionsPath()).toBe(
      path.join(os.homedir(), '.concertoai', 'reflections.jsonl'),
    );
  });
});
