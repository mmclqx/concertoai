/**
 * SEARCH/REPLACE 编辑工具：内部计算统一 diff，落盘前强制审批。
 *
 * 规则（对齐 Carbon Code 编辑语义）：
 * - search 必须在文件中唯一出现，否则拒绝（防止误替换）；
 * - search 为空 = 创建新文件（文件已存在时拒绝）；
 * - 审批回调未配置时默认拒绝（fail-closed），无 yolo 模式；
 * - 审批通过才落盘，拒绝或失败均不产生任何写入。
 */

import { promises as fs } from 'node:fs';

import { z } from 'zod';

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

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * 计算 SEARCH/REPLACE 编辑方案（纯函数，不落盘）。
 * 匹配失败/不唯一时抛错。
 */
export function planEdit(original: string, search: string, replace: string): EditPlan {
  if (search === '') {
    if (original !== '') {
      throw new Error('search 为空表示创建新文件，但文件已存在');
    }
    return { newContent: replace, diff: diffForCreation(replace) };
  }
  const first = original.indexOf(search);
  if (first === -1) {
    throw new Error('SEARCH 内容未在文件中找到');
  }
  const second = original.indexOf(search, first + 1);
  if (second !== -1) {
    throw new Error('SEARCH 内容在文件中出现多次，请提供更精确的匹配块');
  }
  const newContent = original.slice(0, first) + replace + original.slice(first + search.length);
  return { newContent, diff: buildDiff(original, search, replace, first) };
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
    const resolved = resolveSafe(ctx.cwd, args.path);

    let original: string;
    try {
      original = await fs.readFile(resolved, 'utf8');
    } catch (error) {
      if (isEnoent(error) && args.search === '') {
        original = '';
      } else if (isEnoent(error)) {
        return { ok: false, error: `文件不存在: ${args.path}` };
      } else {
        throw error;
      }
    }

    const plan = planEdit(original, args.search, args.replace);
    const approved = await requestApproval(ctx, {
      kind: 'edit',
      summary: `编辑文件 ${args.path}`,
      detail: plan.diff,
    });
    if (!approved) {
      return { ok: false, error: '编辑被拒绝，文件未修改' };
    }

    await fs.writeFile(resolved, plan.newContent, 'utf8');
    return { ok: true, data: { path: args.path, diff: plan.diff } };
  },
};
