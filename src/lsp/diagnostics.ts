/**
 * LSP 三来源诊断 + CodeAction 构建（v4.0 M6 / T6.1~T6.2）。
 *
 * 诊断来源（对齐规划 T6.1）：
 * 1. lint（biome）→ Warning：`npx biome check <file>` 单文件，复用 self-heal
 *    classifier.parseLintErrors（平台样本已覆盖 Windows/POSIX）；
 * 2. type（tsc）→ Error：`npx tsc --noEmit` 项目级，过滤当前文件错误；
 * 3. self-heal 静态规则 → Information：未使用的 import / 显式 any /
 *    console.log 残留（启发式，无需调模型，本版交付 ConcertoAI 独有价值）。
 *
 * CodeAction（T6.2）：
 * - lint 诊断：「🔧 用 ConcertoAI 修复」——复制文件到临时目录跑 biome check --write，
 *   读取修复后内容生成整文件替换 edit（服务端不直接改用户文件，只产出 diff）；
 * - self-heal R1/R3：「移除未使用的 import / 移除 console.log」——行删除 edit；
 * - R2（显式 any）不可自动修复 → 不提供 CodeAction。
 *
 * 纯函数与 runner 分离：静态规则 / edit 构建 / applyTextEdits 可独立单测，
 * 子进程执行（ChildProcessDiagnosticRunner）可注入 Fake runner。
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseLintErrors } from '../loop/self-heal/classifier';
import { DIAGNOSTIC_SOURCE, type LspDiagnostic, LspSeverity, type TextEdit } from './protocol';

// 重新导出（兼容 barrel/server 直接引用；实现位于 protocol.ts）
export { CODE_ACTION_KIND } from './protocol';

const execFileAsync = promisify(execFile);

// ── URI / 路径工具 ───────────────────────────────────────────

/** file:// URI → 本地绝对路径（Windows 盘符 `file:///F:/x` 与 POSIX `file:///home/x`）。 */
export function uriToPath(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:') {
    return uri;
  }
  let p = decodeURIComponent(parsed.pathname);
  // Windows：`/F:/x` → `F:\x`（URL 解析把盘符冒号保留在 pathname：去掉前导斜杠 + 正斜杠转反斜杠）
  if (/^\/[A-Za-z]:\//.test(p)) {
    p = p.slice(1).replace(/\//g, '\\');
  }
  return p;
}

/** 本地绝对路径 → file:// URI（Windows 反斜杠转正斜杠）。 */
export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return `file:///${normalized.startsWith('/') ? normalized.slice(1) : normalized}`;
}

// ── self-heal 静态规则（纯函数，Information）────────────────

/** 提取 `import { A, B } from '...'` 具名导入；返回 {name, line}（0-based 行）。 */
export interface NamedImport {
  name: string;
  line: number;
  /** 该 import 语句整行（CodeAction 删除用）。 */
  lineText: string;
}

/** 解析具名导入（仅单行 import；多行展开延后）。 */
export function extractNamedImports(text: string): NamedImport[] {
  const imports: NamedImport[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const m = line.match(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/);
    if (m?.[1] === undefined) {
      continue;
    }
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name !== undefined && name !== '' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        imports.push({ name, line: i, lineText: line });
      }
    }
  }
  return imports;
}

/** 判断名称在文本（除声明行外）是否被使用。 */
function isNameUsed(name: string, text: string, excludeLine: number): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (i === excludeLine) {
      continue;
    }
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (new RegExp(`\\b${name}\\b`).test(line)) {
      return true;
    }
  }
  return false;
}

/** R1：未使用的 import → Information 诊断（CodeAction 可移除行）。 */
export function unusedImportDiagnostics(text: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const imports = extractNamedImports(text);
  for (const imp of imports) {
    if (isNameUsed(imp.name, text, imp.line)) {
      continue;
    }
    const start = imp.lineText.indexOf(imp.name);
    diagnostics.push({
      range: {
        start: { line: imp.line, character: Math.max(0, start) },
        end: { line: imp.line, character: Math.max(0, start) + imp.name.length },
      },
      severity: LspSeverity.Information,
      code: 'self-heal/unused-import',
      source: DIAGNOSTIC_SOURCE.selfHeal,
      message: `检测到未使用的 import {${imp.name}}，建议移除`,
    });
  }
  return diagnostics;
}

/** R2：显式 any → Information 诊断（不可自动修复，不提供 CodeAction）。 */
export function explicitAnyDiagnostics(text: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    // `: any`（含 `: any =` / `: any)`）或 `as any`
    const anyMatch = line.match(/(?::\s*any\b|\bas\s+any\b)/);
    if (anyMatch === null) {
      continue;
    }
    const index = anyMatch.index ?? 0;
    const startChar = Math.max(0, index);
    diagnostics.push({
      range: {
        start: { line: i, character: startChar },
        end: { line: i, character: startChar + 8 },
      },
      severity: LspSeverity.Information,
      code: 'self-heal/explicit-any',
      source: DIAGNOSTIC_SOURCE.selfHeal,
      message: '检测到显式 any，建议使用更具体的类型',
    });
  }
  return diagnostics;
}

/** R3：console.log 残留 → Information 诊断（CodeAction 可移除行）。 */
export function consoleLogDiagnostics(text: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const m = line.match(/console\.log\s*\(/);
    if (m === null) {
      continue;
    }
    const index = m.index ?? 0;
    diagnostics.push({
      range: {
        start: { line: i, character: index },
        end: { line: i, character: index + 11 }, // console.log
      },
      severity: LspSeverity.Information,
      code: 'self-heal/console-log',
      source: DIAGNOSTIC_SOURCE.selfHeal,
      message: '检测到 console.log 调试语句，建议移除',
    });
  }
  return diagnostics;
}

/** 全部 self-heal 静态规则诊断（按行号排序）。 */
export function selfHealStaticDiagnostics(text: string): LspDiagnostic[] {
  return [
    ...unusedImportDiagnostics(text),
    ...explicitAnyDiagnostics(text),
    ...consoleLogDiagnostics(text),
  ].sort(
    (a, b) =>
      a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
}

// ── TextEdit 工具（纯函数）───────────────────────────────────

/** 构造整文件替换 edit（lint fix 后 diff 用）。 */
export function fullFileReplacementEdit(newText: string, lineCount: number): TextEdit {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: lineCount, character: 0 },
    },
    newText,
  };
}

/** 应用 TextEdit[] 到文本（测试断言修复结果；按行倒序应用避免偏移）。 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const sorted = [...edits].sort((a, b) => b.range.start.line - a.range.start.line);
  let result = [...lines];
  for (const edit of sorted) {
    const startLine = edit.range.start.line;
    const endLine = edit.range.end.line;
    if (startLine < 0 || startLine >= result.length) {
      continue;
    }
    if (edit.newText === '') {
      // 行删除：移除 [startLine, endLine) 行（保留 \n 结构由 join 处理）
      result = [...result.slice(0, startLine), ...result.slice(Math.min(endLine, result.length))];
    } else {
      result = [...result.slice(0, startLine), edit.newText, ...result.slice(endLine)];
    }
  }
  return result.join('\n');
}

// ── CodeAction 构建（纯函数）────────────────────────────────

/** 由 self-heal 静态诊断构建 CodeAction（R1/R3 行删除；R2 无）。 */
export function selfHealCodeActions(
  text: string,
  diagnostics: LspDiagnostic[],
): Record<string, TextEdit[]> {
  const lines = text.split('\n');
  const changes: Record<string, TextEdit[]> = {};
  for (const diag of diagnostics) {
    if (diag.code === 'self-heal/unused-import' || diag.code === 'self-heal/console-log') {
      const line = diag.range.start.line;
      const lineText = lines[line];
      if (lineText === undefined) {
        continue;
      }
      const uri = 'current'; // 占位，server 填充实际 uri
      const edits = changes[uri] ?? [];
      edits.push({
        range: {
          start: { line, character: 0 },
          end: { line: line + 1, character: 0 },
        },
        newText: '',
      });
      changes[uri] = edits;
    }
  }
  return changes;
}

// ── Runner（子进程执行；可注入 Fake）─────────────────────────

/** 诊断执行器接口（测试注入 Fake，避免真实 spawn biome/tsc）。 */
export interface DiagnosticRunner {
  /** lint 诊断（biome 单文件）。 */
  lint(file: string, cwd: string): Promise<LspDiagnostic[]>;
  /** type 诊断（tsc 项目级，过滤当前文件）。 */
  type(file: string, cwd: string): Promise<LspDiagnostic[]>;
}

/** 子进程执行器：npx biome check <file> + npx tsc --noEmit（跨平台 npx.cmd）。 */
export class ChildProcessDiagnosticRunner implements DiagnosticRunner {
  private readonly npxCommand: string;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.npxCommand = platform === 'win32' ? 'npx.cmd' : 'npx';
  }

  /** 运行 biome 单文件检查；解析为 Warning 诊断（复用 parseLintErrors）。 */
  async lint(file: string, cwd: string): Promise<LspDiagnostic[]> {
    try {
      const { stdout, stderr } = await execFileAsync(this.npxCommand, ['biome', 'check', file], {
        cwd,
        timeout: 30000,
        windowsHide: true,
      });
      return parseBiomeLintOutput(`${stdout}\n${stderr}`);
    } catch (err) {
      // biome 退出码非 0 = 有错误；stdout/stderr 已包含在错误对象（execFile 抛错带 stdout/stderr）
      const e = err as { stdout?: string; stderr?: string };
      return parseBiomeLintOutput(`${e.stdout ?? ''}\n${e.stderr ?? ''}`);
    }
  }

  /** 运行 tsc --noEmit；过滤当前文件错误为 Error 诊断。 */
  async type(file: string, cwd: string): Promise<LspDiagnostic[]> {
    try {
      const { stdout, stderr } = await execFileAsync(this.npxCommand, ['tsc', '--noEmit'], {
        cwd,
        timeout: 120000,
        windowsHide: true,
      });
      return parseTscOutput(`${stdout}\n${stderr}`, file);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return parseTscOutput(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, file);
    }
  }
}

/** 解析 biome lint 输出为 LSP 诊断（Warning）。 */
export function parseBiomeLintOutput(output: string): LspDiagnostic[] {
  const { errors } = parseLintErrors(output);
  return errors.map((e) => {
    const line = (e.line ?? 1) - 1; // classifier 1-based → LSP 0-based
    return {
      range: {
        start: { line: Math.max(0, line), character: 0 },
        end: { line: Math.max(0, line), character: 0 },
      },
      severity: LspSeverity.Warning,
      code: e.code,
      source: DIAGNOSTIC_SOURCE.lint,
      message: e.message,
    };
  });
}

/** tsc 标准/pretty 格式解析（过滤目标文件）。 */
const TSC_STD_RE = /(.+?\.(?:ts|tsx|mts|cts))\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;
const TSC_PRETTY_RE = /(.+?\.(?:ts|tsx|mts|cts)):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/;

/** 解析 tsc 输出为 LSP 诊断（Error，仅目标文件）。 */
export function parseTscOutput(output: string, targetFile: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const targetPath = path.resolve(targetFile);
  for (const line of output.split('\n')) {
    const m = line.match(TSC_STD_RE) ?? line.match(TSC_PRETTY_RE);
    if (m === null) {
      continue;
    }
    const file = m[1];
    if (file === undefined) {
      continue;
    }
    // 路径归一化比较（Windows 反斜杠 vs POSIX 正斜杠）
    const resolved = path.resolve(file);
    if (resolved.toLowerCase() !== targetPath.toLowerCase()) {
      continue;
    }
    const lineNum = Number(m[2]) - 1;
    const charNum = Number(m[3]) - 1;
    diagnostics.push({
      range: {
        start: { line: Math.max(0, lineNum), character: Math.max(0, charNum) },
        end: { line: Math.max(0, lineNum), character: Math.max(0, charNum) + 1 },
      },
      severity: LspSeverity.Error,
      code: m[4],
      source: DIAGNOSTIC_SOURCE.type,
      message: m[5]?.trim() ?? 'tsc 类型错误',
    });
  }
  return diagnostics;
}

// ── lint fix diff（T6.2：biome check --write 到副本）─────────

/**
 * 生成 lint 修复的整文件替换 edit：
 * 复制文件到临时目录 → biome check --write 副本 → 读回新内容 → 生成 edit → 清理副本。
 * 服务端不直接修改用户文件，只产出 diff 供客户端应用。
 */
export async function biomeFixEdits(
  file: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TextEdit[] | undefined> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-lsp-fix-'));
  const ext = path.extname(file);
  const tmpFile = path.join(tmpDir, `fix${ext}`);
  try {
    const content = readFileSync(file, 'utf8');
    writeFileSync(tmpFile, content, 'utf8');
    const npxCommand = platform === 'win32' ? 'npx.cmd' : 'npx';
    try {
      await execFileAsync(npxCommand, ['biome', 'check', '--write', tmpFile], {
        cwd,
        timeout: 30000,
        windowsHide: true,
      });
    } catch {
      // biome 退出码非 0 = 有错误（fix 后仍有）→ 仍尝试读回修复后内容
    }
    const fixed = readFileSync(tmpFile, 'utf8');
    if (fixed === content) {
      return undefined; // 无变化 → 无修复
    }
    const lineCount = content.split('\n').length;
    return [fullFileReplacementEdit(fixed, lineCount)];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 聚合三来源诊断（lint Warning / type Error / self-heal Information）。 */
export interface FileDiagnostics {
  lint: LspDiagnostic[];
  type: LspDiagnostic[];
  selfHeal: LspDiagnostic[];
}

/** 聚合全部（含排序：Error → Warning → Information）。 */
export function sortDiagnostics(all: LspDiagnostic[]): LspDiagnostic[] {
  return [...all].sort(
    (a, b) =>
      (a.severity ?? LspSeverity.Error) - (b.severity ?? LspSeverity.Error) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
  );
}
