/**
 * 工具错误码（v3.1 M4 结构化错误增强）。
 *
 * 统一错误结构：`ToolResult.error` 附带机器可读 `code` + 中文 `suggestion`，
 * 与 M1 分类器（VerifyError 的 stage/code）风格一致，供 UI / 日志 / 修复管线复用。
 *
 * - code：机器可读错误分类（如 PATH_OUTSIDE_SANDBOX / SEARCH_NOT_FOUND）；
 * - suggestion：中文修复建议（模型可直接采纳，降低反复试错成本）；
 * - 向后兼容：code/suggestion 均为可选字段，旧错误结构照常渲染。
 */

import type { ToolResult } from './registry';

/** 工具错误码常量。 */
export const ToolErrorCode = {
  // read
  PATH_OUTSIDE_SANDBOX: 'PATH_OUTSIDE_SANDBOX',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  DIR_NOT_FOUND: 'DIR_NOT_FOUND',
  SENSITIVE_FILE: 'SENSITIVE_FILE',
  // edit
  SEARCH_NOT_FOUND: 'SEARCH_NOT_FOUND',
  SEARCH_NOT_UNIQUE: 'SEARCH_NOT_UNIQUE',
  FILE_ALREADY_EXISTS: 'FILE_ALREADY_EXISTS',
  WRITE_FAILED: 'WRITE_FAILED',
  EDIT_REJECTED: 'EDIT_REJECTED',
  // shell
  SHELL_REJECTED: 'SHELL_REJECTED',
  TIMEOUT: 'TIMEOUT',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  EXIT_CODE: 'EXIT_CODE',
  // knowledge
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
} as const;

/** 工具错误码类型。 */
export type ToolErrorCodeValue = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

/** 各错误码的中文修复建议。 */
export const TOOL_ERROR_SUGGESTIONS: Record<ToolErrorCodeValue, string> = {
  PATH_OUTSIDE_SANDBOX:
    '路径越界：请使用项目目录内的相对路径（如 src/foo.ts），不要使用 ../ 或绝对路径',
  FILE_NOT_FOUND: '文件不存在：请先用 list_directory 确认路径与文件名拼写',
  DIR_NOT_FOUND:
    '路径不是文件而是目录（或目录不存在）：请指定具体文件路径，或先用 list_directory 查看目录内容',
  SENSITIVE_FILE: '敏感文件（.env 等）包含凭据，拒绝读取：请改用非敏感文件，或提示用户手动处理',
  SEARCH_NOT_FOUND: 'SEARCH 内容未找到：请用 read_file 查看文件实际内容后，复制准确的文本块',
  SEARCH_NOT_UNIQUE: 'SEARCH 内容出现多次：请包含更多上下文行使匹配块唯一',
  FILE_ALREADY_EXISTS: '文件已存在：创建新文件需 search 为空；如要修改请改用 SEARCH/REPLACE 编辑',
  WRITE_FAILED: '写入失败：请检查文件权限、磁盘空间，或改用其他路径',
  EDIT_REJECTED: '编辑被拒绝：审批未通过，文件未修改；如确需编辑请重新请求并等待批准',
  SHELL_REJECTED: '命令执行被拒绝：审批未通过；如确需执行请重新请求并等待批准',
  TIMEOUT: '命令执行超时：请增大 timeoutMs，或将命令拆分为多步执行',
  COMMAND_NOT_FOUND: '命令不存在：请检查命令名；Windows 下可用 dir/type/node 替代',
  EXIT_CODE: '命令退出码非 0：请结合 stderr 定位错误，或简化命令重试',
  ENTITY_NOT_FOUND: '实体不存在：请先用 knowledge_search 搜索确认实体名拼写',
  STORE_UNAVAILABLE: '知识图谱存储不可用：请检查 ~/.concertoai 目录权限与磁盘空间',
};

/** 构建带 code/suggestion 的错误结果（向后兼容：error 必填，code/suggestion 可选）。 */
export function toolError(
  code: ToolErrorCodeValue,
  message: string,
  extra: { repairable?: boolean; data?: unknown } = {},
): ToolResult {
  return { ok: false, error: message, code, suggestion: TOOL_ERROR_SUGGESTIONS[code], ...extra };
}

/** 路径越界错误（resolveSafe 抛；registry.run 兜底按 instanceof 识别）。 */
export class SandboxError extends Error {
  readonly code: typeof ToolErrorCode.PATH_OUTSIDE_SANDBOX = ToolErrorCode.PATH_OUTSIDE_SANDBOX;

  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** 从任意错误推断错误码（registry.run 兜底 + 工具 catch 复用；无法识别返回 undefined）。 */
export function inferErrorCode(error: unknown): ToolErrorCodeValue | undefined {
  if (error instanceof SandboxError) {
    return ToolErrorCode.PATH_OUTSIDE_SANDBOX;
  }
  const err = error as { code?: unknown; message?: unknown };
  if (err?.code === 'ENOENT') {
    return ToolErrorCode.FILE_NOT_FOUND;
  }
  if (typeof err?.message === 'string') {
    if (err.message.includes('越界')) {
      return ToolErrorCode.PATH_OUTSIDE_SANDBOX;
    }
    if (err.message.includes('命令不存在') || err.message.includes('无法启动')) {
      return ToolErrorCode.COMMAND_NOT_FOUND;
    }
  }
  return undefined;
}
