/**
 * 项目扫描器测试（v5.0 T5）。
 *
 * 重点覆盖**误报抑制**——这是 init 价值的生死线（R2「狼来了」）：
 * - import 行不得被判为鉴权风险（实测 ConcertoAI 自身代码 1/3 条 auth 误报来自 import）；
 * - 文档里列举 "TODO" 这个词不得被当技术债（实测误报）；
 * - hasTodo 之类标识符不得命中；
 * 同时覆盖：CRLF/LF 等价（AGENTS W2）、路径归一化（W3）、扫描上限、跳过目录。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractLocalImports,
  extractRiskyCalls,
  extractTodos,
  isImportLine,
  isTodoMark,
  looksLikeProject,
  resolveImportSpec,
  scanProject,
  toPosix,
} from '../../src/core/project-scan';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'scan-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 便捷写文件（自动建目录）。 */
function write(rel: string, content: string): void {
  const full = path.join(tmp, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('extractTodos：技术债识别（含误报抑制）', () => {
  it('识别标准 TODO / FIXME 标记', () => {
    const content = ['// TODO: 实现登录', 'const a = 1;', '// FIXME 这里有空指针'].join('\n');
    const out = extractTodos(content, 'src/a.ts');
    expect(out).toHaveLength(2);
    expect(out[0]?.line).toBe(1);
    expect(out[1]?.line).toBe(3);
    expect(out[0]?.file).toBe('src/a.ts');
  });

  it('行尾 TODO（无说明）也识别', () => {
    expect(extractTodos('const x = 1; // TODO', 'a.ts')).toHaveLength(1);
  });

  it('【误报回归】文档里列举 TODO 这个词不算技术债', () => {
    // 实测误报原文（ConcertoAI 自身代码）
    const content = '* - plugin recommend 基于项目特征推荐（Express / TODO / package.json / git）';
    expect(extractTodos(content, 'src/cli/plugin.ts')).toHaveLength(0);
  });

  it('【误报回归】标识符 hasTodo / todoList 不算技术债', () => {
    const content = ['hasTodo: boolean;', 'const todoList = [];', 'todoCount = 3;'].join('\n');
    expect(extractTodos(content, 'a.ts')).toHaveLength(0);
  });

  it('CRLF 与 LF 结果一致（AGENTS W2）', () => {
    const lf = 'a\n// TODO: x\nb\n';
    const crlf = 'a\r\n// TODO: x\r\nb\r\n';
    const a = extractTodos(lf, 'f.ts');
    const b = extractTodos(crlf, 'f.ts');
    expect(a).toEqual(b);
    expect(a[0]?.line).toBe(2);
  });

  it('isTodoMark 直判', () => {
    expect(isTodoMark('// TODO: x')).toBe(true);
    expect(isTodoMark('// TODO x')).toBe(true);
    expect(isTodoMark('// TODO')).toBe(true);
    expect(isTodoMark('（A / TODO / B）')).toBe(false);
    expect(isTodoMark('hasTodo')).toBe(false);
  });
});

describe('extractRiskyCalls：风险调用识别（含误报抑制）', () => {
  it('识别网络 / 超时 / 环境变量 / 删除 / 写入', () => {
    const content = [
      'const r = await fetch(url);',
      'const c = new AbortController();',
      'const k = process.env.KEY;',
      'await unlink(tmp);',
      'await fs.writeFile(p, data, "utf8");',
    ].join('\n');
    const kinds = extractRiskyCalls(content, 'a.ts').map((e) => e.kind);
    expect(kinds).toContain('network');
    expect(kinds).toContain('timeout');
    expect(kinds).toContain('env');
    expect(kinds).toContain('delete');
    expect(kinds).toContain('write');
  });

  it('识别真实鉴权语义（Authorization / Bearer / permission）', () => {
    const content = [
      'headers: { Authorization: "Bearer " + key },',
      'if (!canAccess(user)) throw new Error("no");',
      'const permission = getUserPermissions(u);',
    ].join('\n');
    const kinds = extractRiskyCalls(content, 'a.ts').map((e) => e.kind);
    expect(kinds.filter((k) => k === 'auth').length).toBeGreaterThan(0);
  });

  it('【误报回归】import 行不算鉴权风险（实测 ConcertoAI 自身代码误报）', () => {
    const content = [
      "import { SessionStore } from '../store/session';",
      "import { getSession } from './session';",
      "import { auth } from './auth';",
    ].join('\n');
    expect(extractRiskyCalls(content, 'src/cli/chat.tsx')).toHaveLength(0);
  });

  it('【误报回归】导出聚合行 { canAccess } 不算鉴权调用（实测误报）', () => {
    const content = 'export const lib = { u, get, canAccess };';
    expect(extractRiskyCalls(content, 'src/index.ts')).toHaveLength(0);
    // 真实调用形式仍要命中
    expect(extractRiskyCalls('if (!canAccess(user)) {', 'src/a.ts')[0]?.kind).toBe('auth');
    expect(extractRiskyCalls('if (!isAdmin(user)) {', 'src/a.ts')[0]?.kind).toBe('auth');
  });

  it('【误报回归】日志打印会话信息不算鉴权风险', () => {
    const content = 'console.log(fmt(t().session.resumed, { id, count }));';
    const out = extractRiskyCalls(content, 'a.ts');
    expect(out.filter((e) => e.kind === 'auth')).toHaveLength(0);
  });

  it('注释里的关键词不算调用', () => {
    const content = ['// 这里调用 fetch(url) 获取数据', ' * await unlink(tmp)'].join('\n');
    expect(extractRiskyCalls(content, 'a.ts')).toHaveLength(0);
  });

  it('每类有条数上限（防单文件刷屏）', () => {
    const content = Array.from({ length: 20 }, () => 'const k = process.env.X;').join('\n');
    const envHits = extractRiskyCalls(content, 'a.ts').filter((e) => e.kind === 'env');
    expect(envHits.length).toBe(3);
  });

  it('同一行只归一类（不重复标记）', () => {
    const content = 'await fetch(url, { signal: AbortSignal.timeout(5000) });';
    expect(extractRiskyCalls(content, 'a.ts')).toHaveLength(1);
  });

  it('isImportLine 直判', () => {
    expect(isImportLine("import { a } from './a';")).toBe(true);
    expect(isImportLine("export { b } from './b';")).toBe(true);
    expect(isImportLine("const m = await import('./m');")).toBe(true);
    expect(isImportLine('const a = 1;')).toBe(false);
    expect(isImportLine('const auth = 1;')).toBe(false);
  });
});

describe('extractLocalImports / resolveImportSpec（AGENTS W3/W4）', () => {
  it('抽取本地相对 import', () => {
    const content = [
      "import { a } from './a';",
      "import { b } from '../b';",
      "import fs from 'node:fs';",
      "const c = await import('./c');",
    ].join('\n');
    expect(extractLocalImports(content)).toEqual(['./a', '../b', './c']);
  });

  it('解析为相对项目根路径（去扩展名 / 去 index）', () => {
    expect(resolveImportSpec('src/cli/a.ts', '../core/b')).toBe('src/core/b');
    expect(resolveImportSpec('src/cli/a.ts', './c')).toBe('src/cli/c');
    expect(resolveImportSpec('src/a.ts', './ui')).toBe('src/ui');
    expect(resolveImportSpec('src/a.ts', './ui/index')).toBe('src/ui');
    expect(resolveImportSpec('src/a.ts', './x.ts')).toBe('src/x');
  });

  it('toPosix 归一化反斜杠（Windows 与 POSIX 一致）', () => {
    expect(toPosix('src\\cli\\index.ts')).toBe('src/cli/index.ts');
    expect(toPosix('src/cli/index.ts')).toBe('src/cli/index.ts');
  });
});

describe('scanProject：端到端扫描（v5.0 T5）', () => {
  it('读取 package.json 元信息与配置存在性', async () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'demo',
        description: '一个演示项目',
        scripts: { dev: 'tsx src/index.ts', test: 'vitest run', verify: 'npm run test' },
        dependencies: { zod: '^1' },
        devDependencies: { vitest: '^1' },
      }),
    );
    write('tsconfig.json', '{}');
    write('biome.json', '{}');
    write('src/index.ts', 'export const a = 1;');

    const p = await scanProject(tmp);
    expect(p.name).toBe('demo');
    expect(p.description).toBe('一个演示项目');
    expect(p.scripts.verify).toBe('npm run test');
    expect(p.deps).toEqual(['zod']);
    expect(p.devDeps).toEqual(['vitest']);
    expect(p.config.hasTsconfig).toBe(true);
    expect(p.config.hasBiome).toBe(true);
    expect(p.entryFiles).toContain('src/index.ts');
    expect(p.topDirs).toContain('src');
    expect(p.scannedFiles).toBeGreaterThan(0);
  });

  it('跳过 node_modules / dist / 隐藏目录', async () => {
    write('src/a.ts', 'export const a = 1;');
    write('node_modules/x/index.ts', 'export const x = 1;');
    write('dist/bundle.ts', 'export const y = 1;');
    write('.git/hooks/z.ts', 'export const z = 1;');

    const p = await scanProject(tmp);
    const files = [...p.todos, ...p.riskyCalls].map((e) => e.file);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('dist'))).toBe(false);
    expect(files.some((f) => f.includes('.git'))).toBe(false);
  });

  it('统计被多处引用的文件（连锁风险）', async () => {
    write('src/util.ts', 'export const u = 1;');
    write('src/a.ts', "import { u } from './util';");
    write('src/b.ts', "import { u } from './util';");
    write('src/c.ts', "import { u } from './util';");

    const p = await scanProject(tmp);
    expect(p.mostImported[0]?.file).toBe('src/util');
    expect(p.mostImported[0]?.count).toBe(3);
  });

  it('扫描上限生效并标记 truncated（巨型仓库不卡死）', async () => {
    for (let i = 0; i < 10; i += 1) {
      write(`src/f${i}.ts`, `export const v${i} = ${i};`);
    }
    const p = await scanProject(tmp, { maxFiles: 3 });
    expect(p.scannedFiles).toBe(3);
    expect(p.truncated).toBe(true);
  });

  it('package.json 缺失不崩（字段为空，由渲染层写「未检测到」）', async () => {
    write('src/a.ts', 'export const a = 1;');
    const p = await scanProject(tmp);
    expect(p.name).toBeUndefined();
    expect(p.scripts).toEqual({});
    expect(p.deps).toEqual([]);
    expect(p.scannedFiles).toBeGreaterThan(0);
  });

  it('package.json 损坏不崩', async () => {
    write('package.json', '{ not valid json');
    write('src/a.ts', 'export const a = 1;');
    await expect(scanProject(tmp)).resolves.toBeDefined();
  });

  it('扫描结果稳定可复现（同目录两次结果一致）', async () => {
    write('src/b.ts', 'export const b = 1;');
    write('src/a.ts', 'export const a = 1;');
    const first = await scanProject(tmp);
    const second = await scanProject(tmp);
    expect(first.scannedFiles).toBe(second.scannedFiles);
    expect(first.topDirs).toEqual(second.topDirs);
  });
});

describe('looksLikeProject：非项目目录守卫（v5.0 T5）', () => {
  it('有 package.json → 是项目', () => {
    write('package.json', '{}');
    expect(looksLikeProject(tmp)).toBe(true);
  });

  it('只有 src 目录 → 视为项目', () => {
    mkdirSync(path.join(tmp, 'src'), { recursive: true });
    expect(looksLikeProject(tmp)).toBe(true);
  });

  it('其他生态（pyproject.toml / Cargo.toml / go.mod）也视为项目', () => {
    write('pyproject.toml', '');
    expect(looksLikeProject(tmp)).toBe(true);
  });

  it('空目录 → 不是项目（不生成空文件污染）', () => {
    expect(looksLikeProject(tmp)).toBe(false);
  });
});
