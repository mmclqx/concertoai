/**
 * VS Code 健康诊断（v3.4 M3 / T3.1-T3.3）：`concertoai doctor --vscode` 四维检查。
 *
 * 四维：
 * - T3.1 进程数：Code.exe（Windows）/ Code（POSIX）进程计数，阈值分级（>60 ❌ / >40 ⚠️ / ≤40 ✅）；
 * - T3.2 崩溃转储：Crashpad reports 目录 *.dmp 数量 + 总体积（>5 个或 >100MB ❌，1~5 个 ⚠️）；
 * - T3.3 AI 扩展 + argv.json：`code --list-extensions` 与已知 AI 扩展清单比对（>3 告警），
 *   读取 `~/.vscode/argv.json` 核对 disable-extension（**单数**）字段名 / 值格式（字符串数组）/
 *   扩展 ID 引号（以 " 开头和结尾）——踩坑记录 §七（更正 §六）：正确字段是**单数**
 *   `disable-extension`（值 = 字符串数组，禁用指定扩展）；复数 `disable-extensions` 只接受
 *   布尔值（true = 禁用全部），写成数组 VS Code 类型不匹配会**静默忽略**（本次崩溃根因）；
 *   修复验证须覆盖「位置 + 字段名 + 值格式」三要素；
 *   无效位置检测（Windows `%APPDATA%\Code\argv.json` 存在但 VS Code 实际读取 `~/.vscode/argv.json`）。
 *
 * 设计：纯解析函数 + 依赖注入（exec / readFile / scanDir / 平台路径），
 * 测试用样本字符串注入，不真跑 tasklist / ps / code；所有检测失败均降级为
 * 「无法检测」而非崩溃（诊断只读，破坏性动作仅输出建议命令）。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fmt, t } from '../i18n';

// ── 类型与常量 ──────────────────────────────────────────────────

/** 诊断结果（与 doctor.ts Diagnostic 同构：ok=false 影响退出码）。 */
export interface VscodeDiagnostic {
  ok: boolean;
  lines: string[];
}

/** 命令执行结果。 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 目录条目（名称 + 字节大小）。 */
export interface DirEntry {
  name: string;
  size: number;
}

/** VS Code 健康诊断环境（依赖注入；生产用默认实现，测试注入样本）。 */
export interface VscodeHealthEnv {
  /** 平台标识（默认 process.platform）。 */
  platform: NodeJS.Platform;
  /** 用户主目录（默认 os.homedir()）。 */
  homedir: string;
  /** Windows %APPDATA%（仅 win32 用；默认 os.appdata 不存在 → 用 process.env.APPDATA ?? homedir/AppData/Roaming）。 */
  appData: string;
  /** 执行命令（默认 spawn；测试注入样本输出）。 */
  exec: (command: string, args: string[]) => Promise<ExecResult>;
  /** 读文件（默认 fs.readFile；测试注入内容）。 */
  readFile: (p: string) => Promise<string>;
  /** 扫描目录（默认 fs.readdir+stat；测试注入）。 */
  scanDir: (p: string) => Promise<DirEntry[]>;
}

/** 已知 AI 编码助手扩展 ID 清单（可维护；>3 个视为冗余）。 */
export const AI_EXTENSION_IDS: readonly string[] = [
  'anthropic.claude-code',
  'continue.continue',
  'openai.chatgpt',
  'marscode.marscode-extension',
  'alibaba-cloud.tongyi-lingma',
  'danielsanmedium.dscodegpt',
  'ms-dotnettools.csdevkit', // C# DevKit 进程大户（28+ ServiceHub 子进程）
];

/** 进程数严重阈值（14 窗口×扩展组合爆炸场景 ≈ 80+）。 */
export const PROCESS_CRITICAL_THRESHOLD = 60;
/** 进程数警告阈值。 */
export const PROCESS_WARN_THRESHOLD = 40;
/** 崩溃转储数量告警阈值。 */
export const DUMP_COUNT_WARN = 5;
/** 崩溃转储总体积告警阈值（字节）。 */
export const DUMP_BYTES_WARN = 100 * 1024 * 1024;
/** 命令执行超时（ms）。 */
const EXEC_TIMEOUT_MS = 5_000;

/**
 * argv.json 中禁用**指定**扩展的字段名（**单数** `disable-extension`，值 = 字符串数组）。
 * 踩坑记录 §七（更正 §六）：复数 `disable-extensions` 只接受布尔值（true = 禁用全部扩展），
 * 写成数组 VS Code 类型不匹配会静默忽略 → 禁用不生效（2026-08-13 崩溃复发根因）。
 */
export const DISABLE_EXTENSIONS_FIELD = 'disable-extension';
/** 复数形式字段名（`disable-extensions`，仅接受布尔值；数组为无效用法）。 */
export const DISABLE_EXTENSIONS_PLURAL = 'disable-extensions';

// ── 平台路径适配 ──────────────────────────────────────────────

/** 按平台选择路径实现（win32 用反斜杠分隔，POSIX 用正斜杠；与生产平台解耦，测试可注入模拟）。 */
function platformPath(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Crashpad 转储目录（平台适配；T3.2）。 */
export function crashpadDirFor(env: VscodeHealthEnv): string {
  const p = platformPath(env.platform);
  if (env.platform === 'win32') {
    return p.join(env.appData, 'Code', 'Crashpad', 'reports');
  }
  if (env.platform === 'darwin') {
    return p.join(env.homedir, 'Library', 'Application Support', 'Code', 'Crashpad', 'reports');
  }
  return p.join(env.homedir, '.config', 'Code', 'Crashpad', 'reports');
}

/** VS Code 实际读取的 argv.json（三平台一致，`~/.vscode/argv.json`）。 */
export function argvJsonPathFor(env: VscodeHealthEnv): string {
  return platformPath(env.platform).join(env.homedir, '.vscode', 'argv.json');
}

/** Windows 无效位置 argv.json（`%APPDATA%\Code\argv.json`；存在但 VS Code 不读取）。 */
export function ineffectiveArgvJsonPathFor(env: VscodeHealthEnv): string {
  return env.platform === 'win32'
    ? platformPath(env.platform).join(env.appData, 'Code', 'argv.json')
    : '';
}

// ── 默认环境实现 ──────────────────────────────────────────────

/** 默认命令执行：spawn（Windows shell:true 解析 .cmd/exe），5s 超时，异常降级不抛。 */
async function defaultExec(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      try {
        child.kill();
      } catch {
        // 已退出
      }
      resolve({ stdout, stderr, exitCode: -1 });
    }, EXEC_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: -1 });
    });
    child.on('close', (code) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/** 默认目录扫描。 */
async function defaultScanDir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const stat = await fs.stat(path.join(dir, entry.name));
      items.push({ name: entry.name, size: stat.size });
    }
  }
  return items;
}

/** 构造默认环境（生产）。 */
export function defaultVscodeHealthEnv(): VscodeHealthEnv {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return {
    platform: process.platform,
    homedir: os.homedir(),
    appData,
    exec: defaultExec,
    readFile: (p) => fs.readFile(p, 'utf8'),
    scanDir: defaultScanDir,
  };
}

// ── T3.1 进程数（纯解析 + 诊断）───────────────────────────────

/** 解析 Windows `tasklist /fi "imagename eq Code.exe" /fo csv /nh` 输出 → Code.exe 进程数。 */
export function parseTasklistCodeCount(output: string): number {
  return output.split('\n').filter((line) => line.trim() !== '' && /"Code\.exe"/i.test(line))
    .length;
}

/** 解析 POSIX `ps -e -o comm=` 输出 → 含 Code 的进程数（macOS/Linux；`grep -c Code` 语义）。 */
export function parsePsCodeCount(output: string): number {
  return output.split('\n').filter((line) => line.includes('Code')).length;
}

/** 诊断 Code 进程数（T3.1）：>60 ❌ / >40 ⚠️ / ≤40 ✅；命令失败 → ⚠️ 无法检测。 */
export async function diagnoseVscodeProcesses(env: VscodeHealthEnv): Promise<VscodeDiagnostic> {
  const dict = t().doctor;
  try {
    let count: number;
    if (env.platform === 'win32') {
      const r = await env.exec('tasklist', ['/fi', 'imagename eq Code.exe', '/fo', 'csv', '/nh']);
      if (r.exitCode !== 0) {
        return {
          ok: true,
          lines: [`${dict.ok} ${dict.vscodeProcessLabel}: ${dict.vscodeProcessUnavailable}`],
        };
      }
      count = parseTasklistCodeCount(r.stdout);
    } else {
      const r = await env.exec('ps', ['-e', '-o', 'comm=']);
      if (r.exitCode !== 0) {
        return {
          ok: true,
          lines: [`${dict.ok} ${dict.vscodeProcessLabel}: ${dict.vscodeProcessUnavailable}`],
        };
      }
      count = parsePsCodeCount(r.stdout);
    }
    const label = `${dict.vscodeProcessLabel}: `;
    if (count > PROCESS_CRITICAL_THRESHOLD) {
      return {
        ok: false,
        lines: [`${dict.fail} ${label}${fmt(dict.vscodeProcessFail, { count: String(count) })}`],
      };
    }
    if (count > PROCESS_WARN_THRESHOLD) {
      return {
        ok: true,
        lines: [`${dict.ok} ${label}${fmt(dict.vscodeProcessWarn, { count: String(count) })}`],
      };
    }
    return {
      ok: true,
      lines: [`${dict.ok} ${label}${fmt(dict.vscodeProcessOk, { count: String(count) })}`],
    };
  } catch {
    return {
      ok: true,
      lines: [`${dict.ok} ${dict.vscodeProcessLabel}: ${dict.vscodeProcessUnavailable}`],
    };
  }
}

// ── T3.2 崩溃转储（纯解析 + 诊断）─────────────────────────────

/** 解析 Crashpad 目录 → *.dmp 数量 + 总体积。 */
export function collectDumps(entries: DirEntry[]): { count: number; bytes: number } {
  const dumps = entries.filter((e) => e.name.endsWith('.dmp'));
  return { count: dumps.length, bytes: dumps.reduce((sum, e) => sum + e.size, 0) };
}

/** 人类可读体积（B/KB/MB）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 诊断崩溃转储（T3.2）：>5 个或 >100MB ❌ / 1~5 个 ⚠️ / 0 ✅；目录不存在 → ✅ 正常。 */
export async function detectCrashDumps(env: VscodeHealthEnv): Promise<VscodeDiagnostic> {
  const dict = t().doctor;
  const dir = crashpadDirFor(env);
  let entries: DirEntry[];
  try {
    entries = await env.scanDir(dir);
  } catch {
    return { ok: true, lines: [`${dict.ok} ${dict.vscodeDumpLabel}: ${dict.vscodeDumpOk}`] };
  }
  const { count, bytes } = collectDumps(entries);
  const label = `${dict.vscodeDumpLabel}: `;
  if (count === 0) {
    return { ok: true, lines: [`${dict.ok} ${label}${dict.vscodeDumpOk}`] };
  }
  const sizeText = formatBytes(bytes);
  if (count > DUMP_COUNT_WARN || bytes > DUMP_BYTES_WARN) {
    return {
      ok: false,
      lines: [
        `${dict.fail} ${label}${fmt(dict.vscodeDumpFail, { count: String(count), size: sizeText })}`,
        `${dict.fail}   ${fmt(dict.vscodeDumpCleanCmd, { command: dumpCleanCommandFor(env) })}`,
      ],
    };
  }
  return {
    ok: true,
    lines: [
      `${dict.ok} ${label}${fmt(dict.vscodeDumpWarn, { count: String(count), size: sizeText })}`,
      `${dict.ok}   ${fmt(dict.vscodeDumpCleanCmd, { command: dumpCleanCommandFor(env) })}`,
    ],
  };
}

/** 清理命令（平台适配；只读诊断输出建议，不代删）。 */
export function dumpCleanCommandFor(env: VscodeHealthEnv): string {
  const dir = crashpadDirFor(env);
  if (env.platform === 'win32') {
    return `del /q "${dir}\\*.dmp"`;
  }
  return `rm -f "${dir}"/*.dmp`;
}

// ── T3.3 扩展清单解析 ─────────────────────────────────────────

/** 解析 `code --list-extensions` 输出（`<id>@<version>` 行）→ 扩展 ID 列表。 */
export function parseExtensions(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    // `publisher.name@version` → 取 @ 前部分；容忍无版本号行
    const at = trimmed.indexOf('@');
    const id = at === -1 ? trimmed : trimmed.slice(0, at);
    if (id !== '') {
      ids.push(id);
    }
  }
  return ids;
}

// ── T3.3 argv.json（JSONC 解析 + 字段名/值格式/ID 引号校验）───

/** 剥离 JSONC 注释（行注释与块注释；跳过字符串内的注释标记）。 */
export function stripJsonComments(jsonc: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < jsonc.length) {
    const c = jsonc[i];
    const next = jsonc[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < jsonc.length && jsonc[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < jsonc.length && !(jsonc[i] === '*' && jsonc[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** argv.json 核对结果（结构化，供诊断组装文案）。 */
export interface ArgvJsonCheck {
  /** 是否全部通过（字段名 / 值格式 / ID 引号）。 */
  ok: boolean;
  /** 禁用扩展 ID 列表（单数 disable-extension 数组元素）。 */
  disabledIds: string[];
  /** 复数 disable-extensions: true = 禁用全部扩展（合法但激进，提示改用单数精确禁用）。 */
  pluralAllDisabled: boolean;
  /** 复数 disable-extensions + 数组 = 无效用法（VS Code 类型不匹配静默忽略，§七根因）。 */
  pluralArrayInvalid: boolean;
  /** 字段值非法（单数 + 非数组 / 复数 + 非布尔 / 其他）。 */
  valueInvalid: boolean;
  /** 是否存在未加引号的扩展 ID（JSONC 解析失败或引号残缺）。 */
  idQuoteInvalid: boolean;
}

/**
 * 核对 argv.json 原始文本（JSONC）：
 * - 正确字段名 = **单数** `disable-extension`（值 = 字符串数组，禁用指定扩展，踩坑记录 §七）；
 * - 复数 `disable-extensions` 只接受布尔值：true = 禁用全部扩展（合法但激进 → pluralAllDisabled）；
 *   数组 = 无效（VS Code 类型不匹配静默忽略 → pluralArrayInvalid，2026-08-13 崩溃复发根因）；
 * - 单数 + 非数组 → valueInvalid；
 * - 扩展 ID 必须是带双引号的 JSON 字符串（解析失败且含字段 → idQuoteInvalid）。
 */
export function checkArgvJson(raw: string): ArgvJsonCheck {
  // 用完整 JSON 键匹配（兼容单/双引号键，VS Code jsonc 方言允许单引号），避免 includes
  // 把复数键 `disable-extensions` 误判为单数子串（踩坑记录 §六教训：字段名必须逐字符核对，
  // 检测也要精确到键边界——`["']disable-extension["']` 不会匹配 `"disable-extensions"`）。
  const keyRe = (name: string): RegExp => new RegExp(`["']${name}["']\\s*:`);
  const hasSingular = keyRe(DISABLE_EXTENSIONS_FIELD).test(raw);
  const hasPlural = keyRe(DISABLE_EXTENSIONS_PLURAL).test(raw);
  const base: ArgvJsonCheck = {
    ok: true,
    disabledIds: [],
    pluralAllDisabled: false,
    pluralArrayInvalid: false,
    valueInvalid: false,
    idQuoteInvalid: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as unknown;
  } catch {
    // 解析失败：文本含任一字段 → 值格式/引号可能有问题
    return {
      ...base,
      ok: !hasSingular && !hasPlural,
      valueInvalid: hasSingular || hasPlural,
      idQuoteInvalid: hasSingular || hasPlural,
    };
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj === null || typeof obj !== 'object') {
    return { ...base, ok: false, valueInvalid: true };
  }
  const singular = obj[DISABLE_EXTENSIONS_FIELD];
  const plural = obj[DISABLE_EXTENSIONS_PLURAL];

  // 复数字段优先检查（数组 = 根因无效用法；true = 禁用全部合法但激进）
  if (plural !== undefined) {
    if (plural === true) {
      return { ...base, pluralAllDisabled: true };
    }
    if (Array.isArray(plural)) {
      return { ...base, ok: false, pluralArrayInvalid: true };
    }
    return { ...base, ok: false, valueInvalid: true };
  }

  // 单数字段：值必须为字符串数组
  if (singular !== undefined) {
    if (Array.isArray(singular)) {
      const allStrings = singular.every((v) => typeof v === 'string');
      return {
        ...base,
        ok: allStrings,
        disabledIds: allStrings ? (singular as string[]) : [],
        valueInvalid: !allStrings,
        idQuoteInvalid: !allStrings,
      };
    }
    return { ...base, ok: false, valueInvalid: true };
  }

  // 两个字段均未配置 → 视为「未配置」但字段名本身无误（不报字段错误，仅无禁用项）
  return base;
}

/** 诊断 argv.json（T3.3）：字段名 / 值格式 / ID 引号 + 无效位置检测。 */
export async function verifyArgvJson(env: VscodeHealthEnv): Promise<VscodeDiagnostic> {
  const dict = t().doctor;
  const realPath = argvJsonPathFor(env);
  const lines: string[] = [];
  let failed = false;

  // 1. 无效位置检测（Windows %APPDATA%\Code\argv.json）
  const ineffective = ineffectiveArgvJsonPathFor(env);
  if (ineffective !== '') {
    try {
      await env.readFile(ineffective);
      lines.push(`${dict.fail} ${dict.vscodeArgvIneffective}`);
      failed = true;
    } catch {
      // 不存在 → 无此问题
    }
  }

  // 2. 实际读取位置的核对
  let raw: string;
  try {
    raw = await env.readFile(realPath);
  } catch {
    lines.push(
      `${dict.ok} ${dict.vscodeArgvLabel}: ${fmt(dict.vscodeArgvMissing, { path: realPath })}`,
    );
    return { ok: !failed, lines };
  }

  const check = checkArgvJson(raw);
  const label = `${dict.vscodeArgvLabel}: `;
  if (check.pluralArrayInvalid) {
    // 复数 disable-extensions + 数组 → VS Code 类型不匹配静默忽略（§七根因）
    lines.push(`${dict.fail} ${label}${dict.vscodeArgvInvalidField}`);
    failed = true;
  }
  if (check.valueInvalid) {
    lines.push(`${dict.fail} ${label}${dict.vscodeArgvInvalidValue}`);
    failed = true;
  }
  if (check.idQuoteInvalid) {
    lines.push(`${dict.fail} ${label}${dict.vscodeArgvInvalidId}`);
    failed = true;
  }
  if (check.pluralAllDisabled) {
    // 复数 disable-extensions: true = 禁用全部扩展（合法但激进）→ ⚠️ 提示不 fail
    lines.push(`${dict.ok} ${label}${dict.vscodeArgvPluralAll}`);
  }
  if (check.ok && !check.pluralAllDisabled) {
    const detail =
      check.disabledIds.length > 0
        ? fmt(dict.vscodeArgvOk, { path: realPath, count: String(check.disabledIds.length) })
        : fmt(dict.vscodeArgvWarn, { path: realPath });
    lines.push(`${dict.ok} ${label}${detail}`);
  }
  return { ok: !failed, lines };
}

/** 诊断 AI 扩展（T3.3）：数量 >3 告警 + 已装未禁用核对；code CLI 缺失 → ⚠️ 无法检测。 */
export async function detectAiExtensions(env: VscodeHealthEnv): Promise<VscodeDiagnostic> {
  const dict = t().doctor;
  let r: ExecResult;
  try {
    r = await env.exec('code', ['--list-extensions']);
  } catch {
    return {
      ok: true,
      lines: [`${dict.ok} ${dict.vscodeAiExtLabel}: ${dict.vscodeAiExtUnavailable}`],
    };
  }
  if (r.exitCode !== 0) {
    return {
      ok: true,
      lines: [`${dict.ok} ${dict.vscodeAiExtLabel}: ${dict.vscodeAiExtUnavailable}`],
    };
  }
  const installed = parseExtensions(r.stdout);
  const aiInstalled = installed.filter((id) => AI_EXTENSION_IDS.includes(id));

  // 读取实际 argv.json，计算「已装未禁用」。
  // 单数 disable-extension 数组 → 精确禁用列表；复数 disable-extensions: true → 全部禁用
  // （AI 扩展也在内，不应误报「已装未禁用」）；其余（复数数组无效/未配置）→ 视为未禁用。
  let disabledIds: string[] = [];
  let allDisabled = false;
  try {
    const raw = await env.readFile(argvJsonPathFor(env));
    const check = checkArgvJson(raw);
    disabledIds = check.disabledIds;
    allDisabled = check.pluralAllDisabled;
  } catch {
    disabledIds = [];
  }
  const notDisabled = allDisabled ? [] : aiInstalled.filter((id) => !disabledIds.includes(id));

  const label = `${dict.vscodeAiExtLabel}: `;
  const lines: string[] = [];
  let failed = false;
  if (aiInstalled.length > 3) {
    lines.push(
      `${dict.fail} ${label}${fmt(dict.vscodeAiExtWarn, { count: String(aiInstalled.length) })}`,
    );
    failed = true;
  } else {
    lines.push(
      `${dict.ok} ${label}${fmt(dict.vscodeAiExtOk, { count: String(aiInstalled.length) })}`,
    );
  }
  if (notDisabled.length > 0) {
    lines.push(
      `${dict.fail}   ${fmt(dict.vscodeAiExtNotDisabled, { ids: notDisabled.join(', ') })}`,
    );
    lines.push(
      `${dict.fail}   ${fmt(dict.vscodeAiExtSuggest, {
        command: `code --disable-extension ${notDisabled[0]}`,
      })}`,
    );
    failed = true;
  }
  return { ok: !failed, lines };
}
