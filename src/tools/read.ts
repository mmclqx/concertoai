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
      for (const entry of entries) {
        if (hits.length >= MAX_SEARCH_RESULTS) {
          return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          // 跳过 .env 类敏感文件
          if (entry.isFile() && isDotEnv(entry.name)) {
            continue;
          }
          await walk(full);
        } else if (entry.isFile()) {
          let size: number;
          try {
            size = (await fs.stat(full)).size;
          } catch {
            continue;
          }
          if (size > MAX_SEARCH_FILE_BYTES) {
            continue;
          }
          try {
            const text = stripBom(await fs.readFile(full, 'utf8'));
            if (text.includes('\0')) {
              skippedBinary += 1;
              continue;
            }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i += 1) {
              const line = lines[i];
              if (line === undefined) {
                continue;
              }
              const hay = args.caseSensitive === true ? line : line.toLowerCase();
              if (hay.includes(needle)) {
                hits.push({ file: path.relative(ctx.cwd, full), line: i + 1, text: line.trim() });
                if (hits.length >= MAX_SEARCH_RESULTS) {
                  return;
                }
              }
            }
          } catch {}
        }
      }
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
