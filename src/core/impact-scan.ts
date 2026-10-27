/**
 * 影响面扫描（v5.0 T8）：回答一个朴素问题——**「谁 import 了这个文件」**。
 *
 * ## 为什么不用 AST / 全库语义分析
 *
 * 这是**同步阻塞审批流程里的唯一 IO 环节**（用户按下 y 之前必须出现在屏幕上）。
 * AST 解析 + 全库语义分析在这个预算内不可能完成，而「有多少文件引用它」这个
 * 粗略信号已足够改变用户的判断（0 引用 = 随便改；12 引用 = 得看仔细）。
 *
 * ## 硬约束（专家复核重点，勿放宽）
 *
 * | 约束 | 值 | 原因 |
 * |---|---|---|
 * | 硬超时 | **300ms** | 宁可显示「影响面未分析」，也不让审批卡住 |
 * | 文件数上限 | **2000** | 超限返回 `skipped`，不硬扫大项目 |
 * | 并发读取上限 | **32** | 裸 `Promise.all(2000 文件)` 在 Windows 必触发 EMFILE（句柄耗尽），整个审批体验直接毁掉 |
 * | TTL 缓存 | **5s** | 连续编辑同一文件不该重复扫；也会让「第二次审批更快」 |
 * | 单文件失败 | 计入 `skippedCount` 继续 | `EACCES`/`EPERM`（Windows 文件锁）/`ENOENT` 绝不能中断整体 |
 *
 * ## 红线
 *
 * - **W3/W4/W5**：路径一律 `normalizePath` 成正斜杠、比较用小写，**禁止用 `:` 切路径**（盘符会切错）；
 * - **W10**：路径比较用 `includes`/`===`，**不用路径构造正则**（含 `(`、`[`、`.` 会炸）；
 * - 不做列偏移（W6）：只看整行。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 扫描约束（可注入，便于测试构造边界）。 */
export interface ImpactScanLimits {
  /** 硬超时（毫秒）。 */
  timeoutMs?: number;
  /** 参与扫描的文件数上限。 */
  maxFiles?: number;
  /** 并发读取上限。 */
  concurrency?: number;
  /** 缓存 TTL（毫秒）；0 = 禁用缓存。 */
  cacheTtlMs?: number;
}

/** 默认约束（与 v5.0 任务书 T8.4 一致，改前先读文件头）。 */
export const IMPACT_LIMITS: Required<ImpactScanLimits> = {
  timeoutMs: 300,
  maxFiles: 2000,
  concurrency: 32,
  cacheTtlMs: 5000,
};

/** 影响面分析结果。 */
export interface ImpactSummary {
  /** ok=正常完成 / timeout=超时（含部分结果）/ skipped=超限或未执行 / error=异常。 */
  status: 'ok' | 'timeout' | 'skipped' | 'error';
  /** 引用本文件的文件数。 */
  referenceCount: number;
  /** 前 3 个引用者（相对路径，正斜杠）。 */
  topPaths: string[];
  /** 本文件的导出符号（决定影响面怎么算）。 */
  exportedSymbols: string[];
  /** 实际扫描文件数。 */
  scannedCount: number;
  /** 读取失败/被跳过文件数（EMFILE/EACCES/EPERM/ENOENT）。 */
  skippedCount: number;
  /** 耗时（毫秒）。 */
  elapsedMs: number;
}

/** 扫描选项。 */
export interface ImpactScanOptions extends ImpactScanLimits {
  /** 被编辑文件（绝对路径）。 */
  file: string;
  /** 项目根（相对路径基准）。 */
  cwd: string;
  /** 时钟注入（测试用）。 */
  now?: () => number;
  /** 单文件读取实现（测试注入）。 */
  readFileImpl?: (file: string) => Promise<string>;
  /** 目录列举实现（测试注入）。 */
  readdirImpl?: (dir: string) => Promise<{ name: string; isDirectory: boolean }[]>;
  /** stat 实现（测试注入，缓存键用）。 */
  statImpl?: (file: string) => Promise<{ mtimeMs: number }>;
}

/** 跳过的目录名（构建产物/依赖/元数据，扫描它们毫无意义且极慢）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.concertoai',
]);

/** 参与扫描的源文件扩展名白名单。 */
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * 路径归一化为正斜杠小写（W3/W4/W5）。
 *
 * - 反斜杠 → 正斜杠（Windows）；
 * - **保留盘符冒号**（`C:/x`）——不用 `:` 切路径是硬红线；
 * - 转小写（Windows 大小写不敏感）。
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** 取扩展名（小写）。 */
function extOf(file: string): string {
  return path.extname(file).toLowerCase();
}

/** 是否是被跳过的大目录。 */
function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase());
}

/** 是否像源文件（扩展名白名单 + 排除 .min.js）。 */
function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.min.js') || lower.endsWith('.d.ts')) {
    return false;
  }
  return SOURCE_EXTS.includes(extOf(lower));
}

/**
 * 固定并发池（**禁止裸 Promise.all 铺开全部文件**）。
 *
 * 语义：同时最多 `limit` 个任务在跑，任一完成即补位；
 * 每个任务内部异常**不冒泡**（由调用方在任务内自行 try/catch）。
 */
export async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, tasks.length));
  const workers = Array.from({ length: size }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (task !== undefined) {
        results[index] = await task();
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 从源码文本提取导出符号名（正则，不做 AST）。 */
export function extractExportedSymbols(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
    /export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) {
        found.add(name);
      }
    }
  }
  // export { a, b as c } → 取导出名（as 后面的）
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    for (const part of body.split(',')) {
      const piece = part.trim();
      if (piece === '') {
        continue;
      }
      const alias = /\bas\s+(\w+)$/.exec(piece);
      const name = alias?.[1] ?? piece.replace(/^type\s+/, '').trim();
      if (/^\w+$/.test(name)) {
        found.add(name);
      }
    }
  }
  return [...found];
}

/**
 * 判断一行是否引用了目标文件。
 *
 * 三种形态：`from '...'`（ESM/TS）、`require('...')`、`import('...')`（动态）。
 * 归一化后比较：解析相对路径，或用「目标路径后缀」兜底（import 常省略扩展名 / 用 index）。
 */
export function lineReferencesTarget(
  line: string,
  fromFileDir: string,
  targetRel: string,
): boolean {
  const specs: string[] = [];
  for (const match of line.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  for (const match of line.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  const target = normalizePath(targetRel);
  const targetNoExt = stripExt(target);
  for (const spec of specs) {
    if (!spec.startsWith('.')) {
      continue; // 只关心本地相对引用（包名不可能是本文件）
    }
    // W1/W3：spec 里的反斜杠先归一化——`path.posix.join` 不认 `\`，
    // 直接 join 会得到 `src/.\\a` 这种永不匹配的结果（Windows 风格 import 会全部漏掉）
    const normSpec = spec.replace(/\\/g, '/');
    const resolved = normalizePath(path.posix.normalize(path.posix.join(fromFileDir, normSpec)));
    // 三种命中形态都要覆盖（漏一种就会「明明引用了却报 0 引用」）：
    // ① 带扩展名精确相等；② 双方都剥扩展名后相等；③ spec 本身省略扩展名（TS 常见写法，
    // 此时 `resolved` 已经不带扩展名，**不能再剥一次**，否则 `a/b.e.ts` 会被剥成 `a/b`）
    if (resolved === target || stripExt(resolved) === targetNoExt || resolved === targetNoExt) {
      return true;
    }
    // index 文件约定：`from './x'` 可能指向 `./x/index.ts`
    if (normalizePath(path.posix.join(resolved, 'index')) === targetNoExt) {
      return true;
    }
  }
  return false;
}

/** 去扩展名（比较用）。 */
function stripExt(p: string): string {
  const ext = path.posix.extname(p);
  return ext === '' ? p : p.slice(0, -ext.length);
}

/** 模块级 TTL 缓存（key = 归一化路径 | mtimeMs）。 */
const impactCache = new Map<string, { at: number; summary: ImpactSummary }>();

/** 清空影响面缓存（测试隔离用）。 */
export function clearImpactCache(): void {
  impactCache.clear();
}

/** 递归收集候选源文件（有界：超过 maxFiles 立即停止，返回超限标记）。 */
async function collectSourceFiles(
  root: string,
  maxFiles: number,
  readdirImpl: (dir: string) => Promise<{ name: string; isDirectory: boolean }[]>,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = await readdirImpl(dir);
    } catch (error) {
      // 子目录不可读（权限/锁定）→ 跳过继续；但**根目录都读不了**说明 cwd 本身有问题，
      // 静默返回「0 引用」会让用户以为是「没人用，随便改」——必须如实上抛给调用方转 error
      if (dir === root) {
        throw error;
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (!isSkippedDir(entry.name)) {
          queue.push(path.join(dir, entry.name));
        }
        continue;
      }
      if (!isSourceFile(entry.name)) {
        continue;
      }
      files.push(path.join(dir, entry.name));
      if (files.length > maxFiles) {
        return { files: files.slice(0, maxFiles), truncated: true };
      }
    }
  }
  return { files, truncated: false };
}

/**
 * 分析影响面（带粗粒度超时与缓存）。
 *
 * **绝不抛错**：内部任何异常都收敛为 `status: 'error'` 的空结果——
 * 审批流程不能因为「分析影响面失败」而中断（G2 铁律）。
 */
export async function scanImpact(options: ImpactScanOptions): Promise<ImpactSummary> {
  const limits = { ...IMPACT_LIMITS, ...stripUndefined(options) };
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const readFileImpl = options.readFileImpl ?? ((f: string) => readFile(f, 'utf8'));
  const readdirImpl =
    options.readdirImpl ??
    (async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    });
  const statImpl = options.statImpl ?? ((f: string) => stat(f));

  const targetAbs = path.resolve(options.file);
  const targetRel = normalizePath(path.relative(options.cwd, targetAbs));

  // ① 缓存命中直接返回（连续编辑同一文件不该重复扫）
  let cacheKey: string | undefined;
  if (limits.cacheTtlMs > 0) {
    try {
      const info = await statImpl(targetAbs);
      cacheKey = `${targetRel}|${info.mtimeMs}`;
      const cached = impactCache.get(cacheKey);
      if (cached !== undefined && now() - cached.at < limits.cacheTtlMs) {
        return { ...cached.summary, elapsedMs: now() - startedAt };
      }
    } catch {
      // stat 失败（文件不存在等）→ 不缓存，继续扫描
    }
  }

  // ② 导出符号（决定「影响面怎么算」；读不到就空列表，不影响引用统计）
  let exportedSymbols: string[] = [];
  try {
    exportedSymbols = extractExportedSymbols(await readFileImpl(targetAbs));
  } catch {
    exportedSymbols = [];
  }

  // ③ 收集候选文件（有界）
  let collected: { files: string[]; truncated: boolean };
  try {
    collected = await collectSourceFiles(options.cwd, limits.maxFiles, readdirImpl);
  } catch {
    return {
      status: 'error',
      referenceCount: 0,
      topPaths: [],
      exportedSymbols,
      scannedCount: 0,
      skippedCount: 0,
      elapsedMs: now() - startedAt,
    };
  }

  if (collected.truncated) {
    const result: ImpactSummary = {
      status: 'skipped',
      referenceCount: 0,
      topPaths: [],
      exportedSymbols,
      scannedCount: 0,
      skippedCount: 0,
      elapsedMs: now() - startedAt,
    };
    return result;
  }

  // ④ 并发池读取 + 每批前检查超时（超时保留已完成部分结果）
  const deadline = startedAt + limits.timeoutMs;
  const referencing: string[] = [];
  let scannedCount = 0;
  let skippedCount = 0;
  let timedOut = false;

  const candidates = collected.files.filter((f) => normalizePath(f) !== targetRel);
  for (let i = 0; i < candidates.length; i += limits.concurrency) {
    if (now() >= deadline) {
      timedOut = true;
      break;
    }
    const batch = candidates.slice(i, i + limits.concurrency);
    const outcomes = await runWithConcurrency(
      batch.map((file) => async () => {
        try {
          const text = await readFileImpl(file);
          return { file, text, ok: true as const };
        } catch {
          return { file, text: '', ok: false as const };
        }
      }),
      limits.concurrency,
    );
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        skippedCount += 1;
        continue;
      }
      scannedCount += 1;
      const dirRel = normalizePath(path.relative(options.cwd, path.dirname(outcome.file)));
      const hit = outcome.text
        .split('\n')
        .some((line) => lineReferencesTarget(line, dirRel === '' ? '.' : dirRel, targetRel));
      if (hit) {
        referencing.push(normalizePath(path.relative(options.cwd, outcome.file)));
      }
    }
  }

  const summary: ImpactSummary = {
    status: timedOut ? 'timeout' : 'ok',
    referenceCount: referencing.length,
    topPaths: referencing.slice(0, 3),
    exportedSymbols,
    scannedCount,
    skippedCount,
    elapsedMs: now() - startedAt,
  };

  // ⑤ 只缓存完整结果（超时结果带时效性，缓存会误导下一次判断）
  if (!timedOut && cacheKey !== undefined && limits.cacheTtlMs > 0) {
    impactCache.set(cacheKey, { at: now(), summary });
  }
  return summary;
}

/** 去掉 undefined 的键（便于与默认约束合并）。 */
function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined && key !== 'file' && key !== 'cwd') {
      (out as Record<string, unknown>)[key] = val;
    }
  }
  return out;
}
