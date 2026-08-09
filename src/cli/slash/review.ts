/**
 * 审查斜杠命令处理器：/review（v2.1 M5）。
 *
 * 支持三种模式：
 * - /review              → 审查最近修改的文件（auto 模式）
 * - /review <path>       → 审查指定文件/目录
 * - /review --pr         → PR 模式（审查当前分支 diff）
 */

import type { ChatMessage } from '../../loop/types';

// ── 命令解析 ──

export type SlashReviewCommand =
  | { type: 'auto' }
  | { type: 'files'; paths: string[] }
  | { type: 'pr' };

/** 解析 /review 命令。非 /review 返回 null。 */
export function parseReviewCommand(input: string): SlashReviewCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/review') {
    return { type: 'auto' };
  }

  if (trimmed === '/review --pr') {
    return { type: 'pr' };
  }

  if (trimmed.startsWith('/review ')) {
    const rest = trimmed.slice('/review '.length).trim();
    if (rest === '--pr') {
      return { type: 'pr' };
    }
    // 按空格拆分文件路径
    const paths = rest.split(/\s+/).filter((p) => p.length > 0);
    return { type: 'files', paths };
  }

  return null;
}

// ── 命令执行结果 ──

export interface ReviewCommandResult {
  handled: boolean;
  /** 起始消息（审查开始提示）。 */
  message?: ChatMessage;
  /** 审查命令数据（供 App.tsx 调用 ReviewerEngine）。 */
  command?: SlashReviewCommand;
}

/** 执行审查命令（同步解析，异步审查由 App.tsx 驱动）。 */
export function executeReviewCommand(cmd: SlashReviewCommand): ReviewCommandResult {
  const scopeDesc =
    cmd.type === 'auto'
      ? '最近修改的文件'
      : cmd.type === 'pr'
        ? '当前分支 PR diff'
        : cmd.paths.join(', ');

  return {
    handled: false, // 由 App.tsx 驱动异步审查流程
    command: cmd,
    message: {
      role: 'assistant',
      content: `🔍 Reviewer Agent 启动中…\n审查范围：${scopeDesc}\n\n正在收集上下文并启动 5 个审查子代理，请稍候…`,
    },
  };
}
