/**
 * SEARCH/REPLACE 编辑工具：内部计算统一 diff，落盘前强制审批。
 *
 * 规则（对齐 Carbon Code 编辑语义）：
 * - search 必须在文件中唯一出现，否则拒绝（防止误替换）；
 * - search 为空 = 创建新文件（文件已存在时拒绝）；
 * - 审批回调未配置时默认拒绝（fail-closed），无 yolo 模式；
 * - 审批通过才落盘，拒绝或失败均不产生任何写入。
 *
 * CRLF/BOM 加固（T1.4）：
 * - SEARCH 匹配在规范化文本（\r\n → \n）上进行，CRLF 与 LF 等价；
 * - 替换结果保留原文件换行风格（按多数换行符检测）；
 * - 不剥离/添加 BOM，避免意外改变文件的编码标记。
 */

import { promises as fs } from 'node:fs';

import { z } from 'zod';

import { ToolErrorCode, toolError } from './error-codes';
import { resolveSafe } from './read';
import type { ToolResult, ToolSpec } from './registry';
import { requestApproval } from './registry';

const editFileSchema = z.object({
  path: z.string().min(1),
  search: z.string(),
  replace: z.string(),
});

interface EditFileArgs {
  path: string;
  search: string;
  replace: string;
}

interface EditPlan {
  newContent: string;
  diff: string;
}

/** 编辑计划错误：携带机器可读错误码（v3.1 M4）。 */
export class EditPlanError extends Error {
  constructor(
    public readonly code: (typeof ToolErrorCode)[
      | 'SEARCH_NOT_FOUND'
      | 'SEARCH_NOT_UNIQUE'
      | 'FILE_ALREADY_EXISTS'],
    message: string,
  ) {
    super(message);
    this.name = 'EditPlanError';
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 检测文件主换行风格：CRLF 数量 ≥ LF 且 > 0 时判为 CRLF，否则 LF。 */
function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/** 把文本中的 \r\n 规范化为 \n（匹配基准）。 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * 规范化文本偏移 → 原文本偏移。
 * \r\n 在原文本占 2 字符、规范化后占 1，每个被替换的 \r\n 使原偏移多 1。
 */
function mapOffset(original: string, normOffset: number): number {
  let crlfCount = 0;
  const re = /\r\n/g;
  while (true) {
    const m = re.exec(original);
    if (m === null) {
      break;
    }
    if (m.index - crlfCount >= normOffset) {
      break;
    }
    crlfCount += 1;
  }
  return normOffset + crlfCount;
}

/** 把文本换行统一转为目标风格（先归一化 \r\n 再替换，避免重复转换）。 */
function convertEol(text: string, eol: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/**
 * 计算 SEARCH/REPLACE 编辑方案（纯函数，不落盘）。
 * 匹配失败/不唯一时抛错。
 */
export function planEdit(original: string, search: string, replace: string): EditPlan {
  if (search === '') {
    if (original !== '') {
      throw new EditPlanError(
        ToolErrorCode.FILE_ALREADY_EXISTS,
        'search 为空表示创建新文件，但文件已存在',
      );
    }
    return { newContent: replace, diff: diffForCreation(replace) };
  }
  const eol = detectEol(original);
  // 在规范化文本（\r\n → \n）上匹配：CRLF 与 LF 等价
  const normOriginal = normalizeNewlines(original);
  const normSearch = normalizeNewlines(search);
  const first = normOriginal.indexOf(normSearch);
  if (first === -1) {
    throw new EditPlanError(ToolErrorCode.SEARCH_NOT_FOUND, 'SEARCH 内容未在文件中找到');
  }
  const second = normOriginal.indexOf(normSearch, first + 1);
  if (second !== -1) {
    throw new EditPlanError(
      ToolErrorCode.SEARCH_NOT_UNIQUE,
      'SEARCH 内容在文件中出现多次，请提供更精确的匹配块',
    );
  }
  // 规范化偏移映射回原文本偏移，切片保留原文件的换行风格；replace 转为原风格
  const origStart = mapOffset(original, first);
  const origEnd = mapOffset(original, first + normSearch.length);
  const newContent =
    original.slice(0, origStart) + convertEol(replace, eol) + original.slice(origEnd);
  const diff = buildDiff(normOriginal, normSearch, normalizeNewlines(replace), first);
  return { newContent, diff };
}

/** 新建文件的 diff（全 + 行）。 */
function diffForCreation(replace: string): string {
  const lines = replace.split('\n');
  const header = `@@ +1,${lines.length} @@`;
  return [header, ...lines.map((l) => `+${l}`)].join('\n');
}

/**
 * 生成统一行级 diff：@@ hunk 头 + 前后各 2 行上下文 + search 行标 - + replace 行标 +。
 */
function buildDiff(original: string, search: string, replace: string, offset: number): string {
  const before = original.slice(0, offset);
  const after = original.slice(offset + search.length);
  const beforeLines = before.split('\n');
  const searchLines = search.split('\n');
  const replaceLines = replace.split('\n');
  const afterLines = after.split('\n');
  const startLine = beforeLines.length;
  const header = `@@ -${startLine},${searchLines.length} +${startLine},${replaceLines.length} @@`;
  const body = [
    ...beforeLines.slice(-2).map((l) => ` ${l}`),
    ...searchLines.map((l) => `-${l}`),
    ...replaceLines.map((l) => `+${l}`),
    ...afterLines.slice(0, 2).map((l) => ` ${l}`),
  ];
  return [header, ...body].join('\n');
}

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    'SEARCH/REPLACE 编辑文件：search 必须在文件中唯一匹配（为空表示创建新文件），落盘前需要审批；返回统一 diff。',
  parameters: editFileSchema,
  parallelSafe: false,
  execute: async (rawArgs, ctx): Promise<ToolResult> => {
    const args = rawArgs as EditFileArgs;
    let resolved: string;
    try {
      resolved = resolveSafe(ctx.cwd, args.path);
    } catch (error) {
      return toolError(
        ToolErrorCode.PATH_OUTSIDE_SANDBOX,
        error instanceof Error ? error.message : String(error),
        { repairable: false },
      );
    }

    let original: string;
    try {
      original = await fs.readFile(resolved, 'utf8');
    } catch (error) {
      if (isEnoent(error) && args.search === '') {
        original = '';
      } else if (isEnoent(error)) {
        return toolError(ToolErrorCode.FILE_NOT_FOUND, `文件不存在: ${args.path}`);
      } else {
        throw error;
      }
    }

    let plan: EditPlan;
    try {
      plan = planEdit(original, args.search, args.replace);
    } catch (error) {
      if (error instanceof EditPlanError) {
        return toolError(error.code, error.message);
      }
      throw error;
    }
    const approved = await requestApproval(ctx, {
      kind: 'edit',
      summary: `编辑文件 ${args.path}`,
      detail: plan.diff,
    });
    if (!approved) {
      return toolError(ToolErrorCode.EDIT_REJECTED, '编辑被拒绝，文件未修改', {
        repairable: false,
      });
    }

    // 落盘前快照原文件（v1.1 计划回滚）
    if (ctx.snapshotStore !== undefined) {
      await ctx.snapshotStore.snapshot(args.path, ctx.cwd);
    }

    try {
      await fs.writeFile(resolved, plan.newContent, 'utf8');
    } catch (error) {
      return toolError(
        ToolErrorCode.WRITE_FAILED,
        `写入失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ok: true, data: { path: args.path, diff: plan.diff } };
  },
};
