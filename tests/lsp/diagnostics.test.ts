/**
 * LSP 三来源诊断纯函数测试（v4.0 M6 / T6.1~T6.2）。
 *
 * 覆盖：
 * - URI/路径转换（Windows 盘符 + POSIX，AGENTS.md 自查第 10 条双平台样本）；
 * - self-heal 静态规则（R1 未使用 import / R2 显式 any / R3 console.log）；
 * - lint（biome）解析 → Warning；
 * - type（tsc）解析 → Error（std + pretty 格式，Windows/POSIX 路径）；
 * - 排序（Error → Warning → Information）；
 * - TextEdit 应用（行删除 / 整文件替换）；
 * - CodeAction 构建（R1/R3 有修复，R2 无）。
 */

import { describe, expect, it } from 'vitest';
import {
  applyTextEdits,
  consoleLogDiagnostics,
  explicitAnyDiagnostics,
  extractNamedImports,
  fullFileReplacementEdit,
  parseBiomeLintOutput,
  parseTscOutput,
  pathToUri,
  selfHealCodeActions,
  selfHealStaticDiagnostics,
  sortDiagnostics,
  unusedImportDiagnostics,
  uriToPath,
} from '../../src/lsp';
import { DIAGNOSTIC_SOURCE, LspSeverity } from '../../src/lsp/protocol';

describe('uriToPath / pathToUri', () => {
  it('Windows 盘符 URI → 本地路径（file:///F:/x → F:\\x）', () => {
    expect(uriToPath('file:///F:/dev/src/a.ts')).toBe('F:\\dev\\src\\a.ts');
    expect(uriToPath('file:///c:/Users/me/app.ts')).toBe('c:\\Users\\me\\app.ts');
  });

  it('POSIX URI → 本地路径（file:///home/x → /home/x）', () => {
    expect(uriToPath('file:///home/user/a.ts')).toBe('/home/user/a.ts');
  });

  it('非 file 协议原样返回', () => {
    expect(uriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1');
  });

  it('本地路径 → file:// URI（反斜杠转正斜杠）', () => {
    expect(pathToUri('F:\\dev\\src\\a.ts')).toBe('file:///F:/dev/src/a.ts');
    expect(pathToUri('/home/user/a.ts')).toBe('file:///home/user/a.ts');
  });
});

describe('extractNamedImports', () => {
  it('提取单行具名导入（含别名）', () => {
    const text = [
      "import { readFileSync, writeFileSync as wf } from 'node:fs';",
      "import { foo } from './foo';",
      "import def from './def';",
    ].join('\n');
    const imports = extractNamedImports(text);
    expect(imports.map((i) => i.name)).toEqual(['readFileSync', 'writeFileSync', 'foo']);
    expect(imports[0]?.line).toBe(0);
    expect(imports[1]?.line).toBe(0);
    expect(imports[2]?.line).toBe(1);
  });
});

describe('unusedImportDiagnostics（R1）', () => {
  it('未使用的 import → Information 诊断（code 含 self-heal/unused-import）', () => {
    const text = ["import { unused } from './x';", 'const a = 1;', 'console.log(a);'].join('\n');
    const diags = unusedImportDiagnostics(text);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: LspSeverity.Information,
      code: 'self-heal/unused-import',
      source: DIAGNOSTIC_SOURCE.selfHeal,
      // `import { unused }` — 'unused' 从 index 9 开始，长度 6 → [9, 15)
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
    });
    expect(diags[0]?.message).toContain('unused');
  });

  it('已使用的 import 不报诊断', () => {
    const text = ["import { used } from './x';", 'const a = used + 1;', 'console.log(a);'].join(
      '\n',
    );
    expect(unusedImportDiagnostics(text)).toHaveLength(0);
  });
});

describe('explicitAnyDiagnostics（R2）', () => {
  it('`: any` 与 `as any` → Information 诊断（不可修复，无 CodeAction）', () => {
    const text = ['function f(x: any): number {', '  return x as any;', '}'].join('\n');
    const diags = explicitAnyDiagnostics(text);
    expect(diags).toHaveLength(2);
    for (const d of diags) {
      expect(d).toMatchObject({
        severity: LspSeverity.Information,
        source: DIAGNOSTIC_SOURCE.selfHeal,
      });
    }
    expect(diags[0]?.range.start.line).toBe(0);
    expect(diags[1]?.range.start.line).toBe(1);
  });
});

describe('consoleLogDiagnostics（R3）', () => {
  it('console.log → Information 诊断', () => {
    const diags = consoleLogDiagnostics('console.log("debug");\n');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: LspSeverity.Information,
      code: 'self-heal/console-log',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } },
    });
  });
});

describe('selfHealStaticDiagnostics', () => {
  it('聚合三规则并按行号排序', () => {
    const text = [
      "import { unused } from './x';",
      'function f(x: any) {',
      '  console.log(x);',
      '}',
    ].join('\n');
    const diags = selfHealStaticDiagnostics(text);
    expect(diags.map((d) => d.code)).toEqual([
      'self-heal/unused-import',
      'self-heal/explicit-any',
      'self-heal/console-log',
    ]);
    expect(diags.every((d) => d.severity === LspSeverity.Information)).toBe(true);
  });
});

describe('parseBiomeLintOutput（lint → Warning）', () => {
  it('Windows 路径：lint/suspicious/noExplicitAny → Warning 诊断（1-based → 0-based）', () => {
    const output =
      'src\\foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━\n  × Unexpected any.';
    const diags = parseBiomeLintOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: LspSeverity.Warning,
      source: DIAGNOSTIC_SOURCE.lint,
      code: 'lint/suspicious/noExplicitAny',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
    expect(diags[0]?.message).toContain('Unexpected any');
  });

  it('POSIX 路径 + assist 类别 → Warning 诊断', () => {
    const output = 'src/bar.ts:10:3  assist/useImportType  FIXABLE  ━━━\n  × Use import type.';
    const diags = parseBiomeLintOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe('assist/useImportType');
    expect(diags[0]?.range.start.line).toBe(9);
  });
});

describe('parseTscOutput（type → Error）', () => {
  it('Windows 标准格式：src\\foo.ts(1,5) → Error 诊断（仅目标文件）', () => {
    const target = 'F:\\dev\\src\\foo.ts';
    const output = [
      "F:\\dev\\src\\foo.ts(1,5): error TS2304: Cannot find name 'missing'.",
      "F:\\dev\\src\\other.ts(2,3): error TS2304: Cannot find name 'other'.",
    ].join('\n');
    const diags = parseTscOutput(output, target);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: LspSeverity.Error,
      source: DIAGNOSTIC_SOURCE.type,
      code: 'TS2304',
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
    });
    expect(diags[0]?.message).toContain('missing');
  });

  it('POSIX pretty 格式：src/foo.ts:3:7 → Error 诊断', () => {
    const target = '/home/user/src/foo.ts';
    const output = [
      '/home/user/src/foo.ts:3:7 - error TS7006: Parameter "x" implicitly has an "any" type.',
    ].join('\n');
    const diags = parseTscOutput(output, target);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      code: 'TS7006',
      range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } },
    });
  });

  it('非目标文件错误被过滤（大小写不敏感比较）', () => {
    const target = 'F:\\DEV\\SRC\\FOO.TS';
    const output =
      'F:\\dev\\src\\foo.ts(1,5): error TS2304: Cannot find name "x".\nF:\\dev\\src\\bar.ts(1,5): error TS2304: Cannot find name "y".';
    const diags = parseTscOutput(output, target);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toContain('"x"');
  });
});

describe('sortDiagnostics', () => {
  it('按严重性（Error → Warning → Information）再按行列排序', () => {
    const mk = (
      severity: LspSeverity,
      line: number,
    ): ReturnType<typeof sortDiagnostics>[number] => ({
      range: { start: { line, character: 0 }, end: { line, character: 0 } },
      severity,
      source: 'test',
      message: 'm',
    });
    const all = [
      mk(LspSeverity.Information, 1),
      mk(LspSeverity.Warning, 1),
      mk(LspSeverity.Error, 3),
      mk(LspSeverity.Error, 1),
    ];
    const sorted = sortDiagnostics(all);
    expect(sorted.map((d) => [d.severity, d.range.start.line])).toEqual([
      [LspSeverity.Error, 1],
      [LspSeverity.Error, 3],
      [LspSeverity.Warning, 1],
      [LspSeverity.Information, 1],
    ]);
  });
});

describe('TextEdit 工具', () => {
  it('applyTextEdits：行删除按倒序应用（多行不偏移）', () => {
    const text = ['import { a } from "./a";', 'const x = 1;', 'console.log(x);', ''].join('\n');
    const edits = [
      { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: '' },
      { range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } }, newText: '' },
    ];
    // 删除 import 行与 console.log 行后保留 `const x = 1;`（文件以换行结尾）
    expect(applyTextEdits(text, edits)).toBe('const x = 1;\n');
  });

  it('applyTextEdits：整文件替换 edit', () => {
    const text = ['a', 'b'].join('\n');
    const edit = fullFileReplacementEdit('new content', 2);
    expect(applyTextEdits(text, [edit])).toBe('new content');
  });

  it('fullFileReplacementEdit：range 覆盖全文', () => {
    const edit = fullFileReplacementEdit('x', 3);
    expect(edit.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 3, character: 0 },
    });
    expect(edit.newText).toBe('x');
  });
});

describe('selfHealCodeActions', () => {
  it('R1/R3 → 行删除 edit（按行）；R2 → 无 edit', () => {
    const text = [
      'import { unused } from "./x";',
      'function f(x: any) {',
      '  console.log(x);',
      '}',
    ].join('\n');
    const diags = selfHealStaticDiagnostics(text);
    const changes = selfHealCodeActions(text, diags);
    const edits = changes.current;
    expect(edits).toHaveLength(2); // 只有 R1 和 R3（R2 无修复）
    const lines = edits?.map((e) => e.range.start.line).sort();
    expect(lines).toEqual([0, 2]);
    for (const e of edits ?? []) {
      expect(e.newText).toBe('');
    }
  });
});
