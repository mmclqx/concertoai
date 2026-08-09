/**
 * 只读工具集：read_file / search_content / list_directory。
 *
 * 安全基线：
 * - 所有路径基于 ctx.cwd（项目根）解析，越界（.. 逃逸 / 绝对路径逃出）一律拒绝；
 * - read_file 超长截断并标记 truncated，防止上下文膨胀；
 * - search_content 跳过依赖/构建目录与二进制文件，命中数封顶。
 */

import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { ToolResult, ToolSpec } from './registry';

/** read_file 单次读取的最大字符数。 */
export const MAX_READ_CHARS = 50_000;

/** UTF-8 BOM（\uFEFF）。Node 的 utf8 解码会将其保留为文本首字符。 */
const UTF8_BOM = '\uFEFF';

/** 剥离文本开头的 UTF-8 BOM。 */
function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
}

/** search_content 命中数上限。 */
export const MAX_SEARCH_RESULTS = 100;
/** search_content 扫描的单个文件大小上限（字节）。 */
export const MAX_SEARCH_FILE_BYTES = 512 * 1024;
/** search_content 同目录文件并发读取的上限（防文件描述符耗尽）。 */
export const SEARCH_CONCURRENCY = 32;

/** 搜索时跳过的目录名（依赖/构建/版本库/缓存）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'out',
  'target',
  '.venv',
  '__pycache__',
  '.cache',
  '.lumen',
  '.concertoai',
  '.reasonix',
]);

/** 敏感文件名：一律跳过内容读取/search，仅在 list_directory 中显示条目（标记为 sensitive）。 */
const SENSITIVE_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  '.env.test',
]);

/** API Key 遮蔽：匹配 sk- 开头且长度 ≥ 16 的密钥字符串，替换为 ****。 */
const SECRET_PATTERN = /\bsk-[a-zA-Z0-9_-]{16,}\b/g;

/** 判断文件名是否为 .env 类敏感文件。 */
const isDotEnv = (name: string): boolean => SENSITIVE_FILES.has(name);

/** 路径沙箱：把相对 ctx.cwd 的路径解析为绝对路径，越界即抛错。 */
export function resolveSafe(cwd: string, p: string): string {
  if (p === '') {
    throw new Error('路径不能为空');
  }
  const resolved = path.resolve(cwd, p);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界（仅允许访问项目目录内）: ${p}`);
  }
  return resolved;
}

/** 遮蔽文本中的 API Key 模式（sk-...），返回安全文本。 */
export function maskSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, 'sk-****');
}

const readFileSchema = z.object({ path: z.string().min(1) });

interface ReadFileArgs {
  path: string;
}

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description: `读取项目内文本文件的完整内容；超过 ${MAX_READ_CHARS} 字符时截断并在结果中标记 truncated。`,
  parameters: readFileSchema,
  parallelSafe: true,
  execute: async (rawArgs, ctx): Promise<ToolResult> => {
    const { path: p } = rawArgs as ReadFileArgs;
    const basename = path.basename(p);
    if (isDotEnv(basename)) {
      return {
        ok: false,
        error: `敏感文件，拒绝读取: ${p}（API Key 等凭据不应在对话中传输）`,
        repairable: false,
      };
    }
    const resolved = resolveSafe(ctx.cwd, p);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return { ok: false, error: `不是文件而是目录: ${p}` };
    }
    const content = stripBom(await fs.readFile(resolved, 'utf8'));
    const truncated = content.length > MAX_READ_CHARS;
    return {
      ok: true,
      data: {
        path: p,
        content: truncated ? content.slice(0, MAX_READ_CHARS) : content,
        truncated,
        totalChars: content.length,
      },
    };
  },
};

const listDirectorySchema = z.object({ path: z.string().min(1) });

interface ListDirectoryArgs {
  path: string;
}

export const listDirectoryTool: ToolSpec = {
  name: 'list_directory',
  description:
    '列出项目内目录的直接条目（文件名/子目录名，文件附带字节大小），非递归，按名称排序。',
  parameters: listDirectorySchema,
  parallelSafe: true,
  execute: async (rawArgs, ctx): Promise<ToolResult> => {
    const { path: p } = rawArgs as ListDirectoryArgs;
    const resolved = resolveSafe(ctx.cwd, p);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        let size: number | undefined;
        if (entry.isFile()) {
          try {
            size = (await fs.stat(path.join(resolved, entry.name))).size;
          } catch {
            size = undefined;
          }
        }
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size,
          ...(isDotEnv(entry.name) ? { sensitive: true } : {}),
        };
      }),
    );
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, data: { path: p, entries: items } };
  },
};

const searchContentSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default('.'),
  caseSensitive: z.boolean().default(false),
});

interface SearchContentArgs {
  pattern: string;
  path?: string;
  caseSensitive?: boolean;
}

export const searchContentTool: ToolSpec = {
  name: 'search_content',
  description: `在项目内按子串（非正则）搜索文件内容，返回 文件:行号: 文本 命中列表（最多 ${MAX_SEARCH_RESULTS} 条）。跳过 node_modules/.git/dist 等目录与二进制文件。`,
  parameters: searchContentSchema,
  parallelSafe: true,
  execute: async (rawArgs, ctx): Promise<ToolResult> => {
    const args = rawArgs as SearchContentArgs;
    const root = resolveSafe(ctx.cwd, args.path ?? '.');
    const needle = args.caseSensitive === true ? args.pattern : args.pattern.toLowerCase();
    const hits: Array<{ file: string; line: number; text: string }> = [];
    let skippedBinary = 0;

    interface SearchHit {
      file: string;
      line: number;
      text: string;
    }

    /**
     * 扫描单个文件，返回该文件的命中列表（保序）。
     * v2.1 性能优化：
     * - 文件级快速排除：先用一次 includes（C++ 实现）判断整个文件是否可能包含
     *   needle，未命中直接跳过，不再对每一行做 toLowerCase + includes
     *   （旧实现每行分配小写字符串，大文件开销高）；
     * - 不区分大小写时优先用原始文本匹配（代码文件多为小写 ASCII，可直接命中，
     *   避免整文件 toLowerCase 分配大字符串），仅当原始文本未命中才降级小写检查；
     * - 逐行定位（需要行号与原始行文本）只发生在命中的少数文件上。
     */
    const scanFile = async (
      full: string,
    ): Promise<{ hits: SearchHit[]; skippedBinary: number }> => {
      let size: number;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        return { hits: [], skippedBinary: 0 };
      }
      if (size > MAX_SEARCH_FILE_BYTES) {
        return { hits: [], skippedBinary: 0 };
      }
      let text: string;
      try {
        text = stripBom(await fs.readFile(full, 'utf8'));
      } catch {
        return { hits: [], skippedBinary: 0 };
      }
      if (text.includes('\0')) {
        return { hits: [], skippedBinary: 1 };
      }

      // ── 文件级快速排除 ──
      if (args.caseSensitive === true) {
        if (!text.includes(needle)) {
          return { hits: [], skippedBinary: 0 };
        }
      } else if (!text.includes(needle)) {
        const lowerText = text.toLowerCase();
        if (!lowerText.includes(needle)) {
          return { hits: [], skippedBinary: 0 };
        }
      }

      // ── 逐行定位（仅命中文件；保留原始行文本与行号）──
      const lines = text.split('\n');
      const fileHits: SearchHit[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (hits.length + fileHits.length >= MAX_SEARCH_RESULTS) {
          break;
        }
        const line = lines[i];
        if (line === undefined) {
          continue;
        }
        const hay = args.caseSensitive === true ? line : line.toLowerCase();
        if (hay.includes(needle)) {
          fileHits.push({ file: path.relative(ctx.cwd, full), line: i + 1, text: line.trim() });
        }
      }
      return { hits: fileHits, skippedBinary: 0 };
    };

    /**
     * v2.1 性能优化：同目录文件并发读取（Promise.all 并行），
     * 完成后按 readdir 顺序保序合并，避免大目录逐个 await readFile 的串行等待。
     */
    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= MAX_SEARCH_RESULTS) {
        return;
      }
      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // 收集连续文件段，遇目录时先 flush（保持「目录深度优先、文件按序」的遍历顺序）
      let fileBatch: string[] = [];
      const flushFiles = async (): Promise<void> => {
        if (fileBatch.length === 0 || hits.length >= MAX_SEARCH_RESULTS) {
          fileBatch = [];
          return;
        }
        const batch = fileBatch;
        fileBatch = [];
        // v2.1 性能优化：并发读取同一目录下的文件（Promise.all 并行），
        // 但用 SEARCH_CONCURRENCY 分片限制并发上限，防止超大目录一次性打开
        // 数千个文件描述符（Windows 默认句柄上限较低）；分片结果按序合并，
        // 与串行遍历的命中顺序完全一致。
        const results: Array<{ hits: SearchHit[]; skippedBinary: number }> = [];
        for (let i = 0; i < batch.length; i += SEARCH_CONCURRENCY) {
          const slice = batch.slice(i, i + SEARCH_CONCURRENCY);
          const partial = await Promise.all(slice.map((full) => scanFile(full)));
          results.push(...partial);
        }
        for (const r of results) {
          if (hits.length >= MAX_SEARCH_RESULTS) {
            break;
          }
          hits.push(...r.hits);
          skippedBinary += r.skippedBinary;
        }
      };
      for (const entry of entries) {
        if (hits.length >= MAX_SEARCH_RESULTS) {
          break;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          await flushFiles();
          await walk(full);
        } else if (entry.isFile()) {
          // 敏感文件（.env 等）不参与搜索（v2.1 安全加固：旧实现中该检查位于
          // isDirectory 分支内属死代码，实际会扫描到 .env）
          if (isDotEnv(entry.name)) {
            continue;
          }
          fileBatch.push(full);
        }
      }
      await flushFiles();
    };

    await walk(root);
    return {
      ok: true,
      data: {
        hits,
        truncated: hits.length >= MAX_SEARCH_RESULTS,
        skippedBinary,
      },
    };
  },
};
