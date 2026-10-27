/**
 * 项目扫描器（v5.0 T5）：一次分析，两份输出（AGENTS.md 给 AI + PROJECT_GUIDE.md 给人）。
 *
 * 设计原则（G7 证据优先）：
 * - **每条结论都必须带 `文件:行号` 证据**，否则渲染层写「未检测到」——不允许 LLM 幻觉式套话；
 * - **纯函数优先**：抽取类逻辑（TODO / 风险调用 / import 统计）全部是不碰 IO 的纯函数，
 *   便于单测；只有 `scanProject` 做文件读取；
 * - **有界扫描**：文件数上限 + 单文件大小上限 + 跳过构建产物目录，避免在巨型仓库卡死；
 * - **失败不中断**：单文件读取失败只计入 skipped，不影响整体结论。
 */

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

/** 扫描时跳过的目录（构建产物 / 依赖 / 版本控制）。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.concertoai',
  'vendor',
]);

/** 参与扫描的源码扩展名。 */
export const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** 默认扫描上限（文件数）。 */
export const DEFAULT_MAX_FILES = 400;

/** 单个文件读取上限（字节；超过则跳过，避免读取巨型产物文件）。 */
export const MAX_FILE_BYTES = 200_000;

/** 一条带证据的记录（文件 + 行号 + 原文）。 */
export interface Evidence {
  /** 相对路径（统一正斜杠）。 */
  file: string;
  /** 1 基行号。 */
  line: number;
  /** 命中行原文（已 trim，截断到 160 字符）。 */
  text: string;
  /** 分类标签（TODO / network / timeout / env / delete / auth …）。 */
  kind: string;
}

/** 项目画像（双输出的唯一数据源）。 */
export interface ProjectProfile {
  /** 项目根目录。 */
  cwd: string;
  /** package.json 的 name。 */
  name: string | undefined;
  /** package.json 的 description。 */
  description: string | undefined;
  /** npm scripts。 */
  scripts: Record<string, string>;
  /** 运行时依赖名。 */
  deps: string[];
  /** 开发依赖名。 */
  devDeps: string[];
  /** 探测到的入口文件（相对路径）。 */
  entryFiles: string[];
  /** 顶层目录名。 */
  topDirs: string[];
  /** 配置存在性。 */
  config: {
    hasCi: boolean;
    hasTsconfig: boolean;
    hasBiome: boolean;
    hasEslint: boolean;
    hasAgentsMd: boolean;
    hasCarbonMd: boolean;
    hasReadme: boolean;
    hasLockfile: boolean;
  };
  /** TODO / FIXME 清单（带证据）。 */
  todos: Evidence[];
  /** 风险调用清单（带证据）。 */
  riskyCalls: Evidence[];
  /** 被其他文件 import 次数最多的本地文件（降序）。 */
  mostImported: Array<{ file: string; count: number }>;
  /** 实际扫描的源码文件数。 */
  scannedFiles: number;
  /** 读取失败 / 超限跳过的文件数。 */
  skippedFiles: number;
  /** 是否因达到文件上限提前停止。 */
  truncated: boolean;
}

/** 扫描选项。 */
export interface ScanOptions {
  /** 最大扫描文件数（默认 DEFAULT_MAX_FILES）。 */
  maxFiles?: number;
}

/** 规范化路径为正斜杠形式（跨平台一致，AGENTS W3 教训）。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/').split('\\').join('/');
}

/** 截断长文本用于展示。 */
function clip(text: string, max = 160): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** 判断一行是否为纯注释行（避免把注释里的关键词当证据）。 */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#');
}

/**
 * 判断一行是否为 import / export 语句。
 *
 * 为什么单独排除：`import { SessionStore } from '../store/session'` 会命中 auth 规则，
 * 但引入模块本身**没有**鉴权逻辑风险——这类误报会让用户对提示麻木（R2 狼来了）。
 * 实测在 ConcertoAI 自身代码上，3 条 auth 误报里有 1 条就是 import 行。
 */
export function isImportLine(line: string): boolean {
  const t = line.trim();
  return (
    (/^(import|export)\b/.test(t) && /\bfrom\s+['"]/.test(t)) ||
    /^import\s*\(/.test(t) ||
    // 动态 import 表达式：`const m = await import('./auth')` 同样只是引入模块，
    // 不应被当成鉴权/网络风险（要求紧跟字符串字面量，避免 `import.meta` 等误判）
    /\bimport\s*\(\s*['"]/.test(t) ||
    /^}?\s*from\s+['"]/.test(t)
  );
}

/**
 * 判断一行是否为「技术债标记」（而不是普通提到 TODO 这个词）。
 *
 * 实测误报：`* - plugin recommend 基于项目特征推荐（Express / TODO / package.json / git）`
 * 只是在文档里列举关键字，不是待办。因此要求标记后紧跟冒号/括号/空白到行尾：
 * - `// TODO: 实现 xxx`     ✅ 命中
 * - `// TODO 实现 xxx`      ✅ 命中（TODO 后是空格且位于注释中）
 * - `（Express / TODO / x）` ❌ 不命中（TODO 后面是 ` /`）
 * - `hasTodo: boolean`       ❌ 不命中（大小写不匹配，且 TODO 嵌在标识符里）
 */
export function isTodoMark(line: string): boolean {
  // 要求全大写标记（避免 hasTodo / todoList 之类标识符）
  const m = /\b(TODO|FIXME|XXX|HACK)\b/.exec(line);
  if (m === null) {
    return false;
  }
  const after = line.slice((m.index ?? 0) + m[0].length);
  // 标记后必须是：行尾 / 冒号 / 括号 / 空格+非分隔符（` / ` 这种列举形式排除）
  if (/^\s*[:：(（]/.test(after) || /^\s*$/.test(after)) {
    return true;
  }
  // `// TODO 实现` 这类：后面是空格 + 中文/字母（不是 ` / ` 或 `, `）
  return /^\s+[^\s/,、|]/.test(after);
}

/**
 * 抽取 TODO / FIXME（纯函数）。
 *
 * @param content 文件内容（任意换行风格）
 * @param file 相对路径（写入证据）
 */
export function extractTodos(content: string, file: string): Evidence[] {
  const out: Evidence[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isTodoMark(line)) {
      out.push({ file, line: i + 1, text: clip(line), kind: 'todo' });
    }
  }
  return out;
}

/**
 * 风险调用规则表：kind → 正则（字面量，热路径安全，见 AGENTS W8/W10）。
 *
 * auth 规则刻意收窄：早先用 `session` 单词导致 `SessionStore` / 会话恢复日志全被标成鉴权风险
 * （实测 3 条误报），现要求更具体的鉴权语义。
 */
const RISKY_RULES: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'network', re: /\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(/ },
  { kind: 'timeout', re: /\bsetTimeout\s*\(|\bAbortController\b|\bAbortSignal\b|\btimeout\s*[:=]/ },
  { kind: 'env', re: /\bprocess\.env\b/ },
  { kind: 'delete', re: /\bunlink\s*\(|\brmdir\s*\(|\brm\s+-rf\b|\bfs\.rm\s*\(/ },
  { kind: 'write', re: /\bwriteFile(Sync)?\s*\(|\bcreateWriteStream\s*\(/ },
  {
    // 鉴权类收窄两次（实测误报驱动）：
    // ① 早期用 `session` → SessionStore/会话日志全被标鉴权；
    // ② `canAccess` / `isAdmin` 不限调用形式 → `export const lib = { canAccess }` 这类
    //    导出聚合行被误标（实测），故要求后跟 `(` 才算真实的鉴权判定调用。
    kind: 'auth',
    re: /\bauthorization\b|\bauthenticate\w*|\bisAdmin\s*\(|\bcanAccess\s*\(|\bpermission\w*\b|\bjwt\b|\bcredentials?\b|\bbearer\b/i,
  },
];

/**
 * 抽取风险调用（纯函数）。
 *
 * 排除项（实测误报来源）：
 * - 纯注释行（关键词出现在注释里不算调用）；
 * - import / export 语句（引入模块不改逻辑）；
 * - 每类最多保留 `perKindLimit` 条（避免一个文件 100 处 process.env 刷屏）。
 */
export function extractRiskyCalls(content: string, file: string, perKindLimit = 3): Evidence[] {
  const out: Evidence[] = [];
  const counts = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isCommentLine(line) || isImportLine(line)) {
      continue;
    }
    for (const rule of RISKY_RULES) {
      if (!rule.re.test(line)) {
        continue;
      }
      const used = counts.get(rule.kind) ?? 0;
      if (used >= perKindLimit) {
        continue;
      }
      counts.set(rule.kind, used + 1);
      out.push({ file, line: i + 1, text: clip(line), kind: rule.kind });
      // 一行只归一类（避免同一行被标 6 次）
      break;
    }
  }
  return out;
}

/**
 * 抽取本地相对 import 的目标（纯函数）。
 *
 * 只识别 `from './x'` / `from '../x'` / `import('./x')` 形式；
 * 返回规范化后的路径片段（不含扩展名），用于统计「谁被最多文件依赖」。
 */
export function extractLocalImports(content: string): string[] {
  const out: string[] = [];
  // 字面量正则，避免动态构造（AGENTS W10）
  const re = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
  for (const m of content.matchAll(re)) {
    const spec = m[1];
    if (spec !== undefined) {
      out.push(spec);
    }
  }
  return out;
}

/** 把 import 说明符解析为相对项目根的路径候选（去扩展名、去 /index）。 */
export function resolveImportSpec(fromFile: string, spec: string): string {
  const dir = path.posix.dirname(toPosix(fromFile));
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  return joined.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '');
}

/** 递归收集源码文件（跳过 SKIP_DIRS，正斜杠相对路径）。 */
async function collectSourceFiles(
  root: string,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 稳定排序，保证多次扫描结果一致（测试可复现）
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await walk(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name);
      if (!SOURCE_EXTS.has(ext)) {
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(toPosix(path.relative(root, path.join(dir, entry.name))));
    }
  };

  await walk(root);
  return { files, truncated };
}

/** 读取文件（超限/失败返回 undefined）。 */
async function readCapped(
  full: string,
): Promise<{ content: string } | { error: 'too-large' | 'read-failed' }> {
  try {
    const stat = await fs.stat(full);
    if (stat.size > MAX_FILE_BYTES) {
      return { error: 'too-large' };
    }
    return { content: await fs.readFile(full, 'utf8') };
  } catch {
    return { error: 'read-failed' };
  }
}

/** 探测入口文件候选（存在性检查）。 */
function detectEntryFiles(root: string, pkg: Record<string, unknown> | undefined): string[] {
  const candidates = new Set<string>();
  const main = typeof pkg?.main === 'string' ? pkg.main : undefined;
  if (main !== undefined) {
    candidates.add(toPosix(main).replace(/^\.\//, ''));
  }
  const bin = pkg?.bin;
  if (typeof bin === 'string') {
    candidates.add(toPosix(bin).replace(/^\.\//, ''));
  } else if (bin !== null && typeof bin === 'object') {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') {
        candidates.add(toPosix(value).replace(/^\.\//, ''));
      }
    }
  }
  for (const guess of [
    'src/index.ts',
    'src/index.tsx',
    'src/main.ts',
    'src/main.tsx',
    'src/cli/index.ts',
    'index.ts',
    'index.js',
    'src/index.js',
  ]) {
    candidates.add(guess);
  }
  return [...candidates].filter((c) => existsSync(path.join(root, c)));
}

/** 顶层目录（跳过 SKIP_DIRS 与隐藏目录）。 */
async function listTopDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 扫描项目，产出画像（唯一 IO 入口）。
 *
 * 失败容错：package.json 缺失/损坏 → name/description/scripts/deps 为空，
 * 由渲染层写「未检测到」而不是崩溃（非项目目录的友好提示由 CLI 层负责）。
 */
export async function scanProject(cwd: string, options: ScanOptions = {}): Promise<ProjectProfile> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const root = path.resolve(cwd);

  // ── package.json ──
  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    pkg = undefined;
  }

  const scripts =
    pkg?.scripts !== null && typeof pkg?.scripts === 'object'
      ? (pkg.scripts as Record<string, string>)
      : {};
  const deps =
    pkg?.dependencies !== null && typeof pkg?.dependencies === 'object'
      ? Object.keys(pkg.dependencies as Record<string, string>)
      : [];
  const devDeps =
    pkg?.devDependencies !== null && typeof pkg?.devDependencies === 'object'
      ? Object.keys(pkg.devDependencies as Record<string, string>)
      : [];

  // ── 配置文件存在性 ──
  const has = (rel: string): boolean => existsSync(path.join(root, rel));
  const config = {
    hasCi: has('.github/workflows') || has('.gitlab-ci.yml'),
    hasTsconfig: has('tsconfig.json'),
    hasBiome: has('biome.json') || has('biome.jsonc'),
    hasEslint:
      has('.eslintrc') || has('.eslintrc.js') || has('.eslintrc.json') || has('eslint.config.js'),
    hasAgentsMd: has('AGENTS.md'),
    hasCarbonMd: has('CARBON.md'),
    hasReadme: has('README.md'),
    hasLockfile: has('package-lock.json') || has('pnpm-lock.yaml') || has('yarn.lock'),
  };

  // ── 源码扫描 ──
  const { files, truncated } = await collectSourceFiles(root, maxFiles);
  const todos: Evidence[] = [];
  const riskyCalls: Evidence[] = [];
  const importTargets = new Map<string, Set<string>>(); // 目标 → 引用它的文件集合
  let skippedFiles = 0;

  for (const rel of files) {
    const read = await readCapped(path.join(root, rel));
    if ('error' in read) {
      skippedFiles += 1;
      continue;
    }
    todos.push(...extractTodos(read.content, rel));
    riskyCalls.push(...extractRiskyCalls(read.content, rel));
    for (const spec of extractLocalImports(read.content)) {
      const key = resolveImportSpec(rel, spec);
      const set = importTargets.get(key) ?? new Set<string>();
      set.add(rel);
      importTargets.set(key, set);
    }
  }

  const mostImported = [...importTargets.entries()]
    .map(([file, importers]) => ({ file, count: importers.size }))
    .filter((x) => x.count > 1)
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, 10);

  return {
    cwd: root,
    name: typeof pkg?.name === 'string' ? pkg.name : undefined,
    description: typeof pkg?.description === 'string' ? pkg.description : undefined,
    scripts,
    deps,
    devDeps,
    entryFiles: detectEntryFiles(root, pkg),
    topDirs: await listTopDirs(root),
    config,
    todos,
    riskyCalls,
    mostImported,
    scannedFiles: files.length,
    skippedFiles,
    truncated,
  };
}

/**
 * 判断目录是否像项目根（有 package.json 或明显的源码入口）。
 * 用于 CLI 层「非项目目录」的友好提示。
 */
export function looksLikeProject(cwd: string): boolean {
  const root = path.resolve(cwd);
  return (
    existsSync(path.join(root, 'package.json')) ||
    existsSync(path.join(root, 'src')) ||
    existsSync(path.join(root, 'pyproject.toml')) ||
    existsSync(path.join(root, 'Cargo.toml')) ||
    existsSync(path.join(root, 'go.mod'))
  );
}
