/**
 * 审查斜杠命令处理器：/review（v2.1 M5 + v3.1 M5 / T5.4 --severity）。
 *
 * 支持三种模式：
 * - /review              → 审查最近修改的文件（auto 模式）
 * - /review <path>       → 审查指定文件/目录
 * - /review --pr         → PR 模式（审查当前分支 diff）
 * - /review --severity <strict|normal|lenient> → 设定审查阈值（默认 normal）
 */

import type { ChatMessage } from '../../loop/types';
import type { ReviewSeverity } from '../../reviewer';
import { REVIEW_SEVERITIES } from '../../reviewer';

// ── 命令解析 ──

export type SlashReviewCommand =
  | { type: 'auto'; severity?: ReviewSeverity }
  | { type: 'files'; paths: string[]; severity?: ReviewSeverity }
  | { type: 'pr'; severity?: ReviewSeverity }
  | { type: 'unknown'; message: string };

/** 解析 --severity <值> 选项；缺失返回 undefined；非法值返回 { error }。 */
function parseSeverityOption(rest: string): {
  severity?: ReviewSeverity;
  invalid?: string;
  rest: string;
} {
  const m = rest.match(/^--severity\s+(\S+)/);
  if (m === null) {
    return { rest };
  }
  const value = m[1] as string;
  if (!REVIEW_SEVERITIES.includes(value as ReviewSeverity)) {
    return {
      invalid: value,
      rest: rest.slice(m[0].length).trim(),
    };
  }
  return {
    severity: value as ReviewSeverity,
    rest: rest.slice(m[0].length).trim(),
  };
}

/** 解析 /review 命令。非 /review 返回 null。 */
export function parseReviewCommand(input: string): SlashReviewCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/review') {
    return { type: 'auto' };
  }

  if (trimmed.startsWith('/review ')) {
    const rest = trimmed.slice('/review '.length).trim();
    const severityOpt = parseSeverityOption(rest);
    if (severityOpt.invalid !== undefined) {
      return {
        type: 'unknown',
        message: `非法 severity 值: ${severityOpt.invalid}。合法值: ${REVIEW_SEVERITIES.join(' / ')}`,
      };
    }
    const { severity, rest: restAfter } = severityOpt;
    if (restAfter === '' || restAfter === '--pr') {
      return { type: restAfter === '--pr' ? 'pr' : 'auto', severity };
    }
    // 按空格拆分文件路径
    const paths = restAfter.split(/\s+/).filter((p) => p.length > 0);
    return { type: 'files', paths, severity };
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
  // v3.1 M5 / T5.4：非法 severity 值 → 直接回显错误（handled，不再触发审查）
  if (cmd.type === 'unknown') {
    return {
      handled: true,
      message: { role: 'assistant', content: `❌ ${cmd.message}` },
    };
  }
  const severityNote = cmd.severity !== undefined ? `\n审查阈值：${cmd.severity}` : '';
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
      content: `🔍 Reviewer Agent 启动中…\n审查范围：${scopeDesc}${severityNote}\n\n正在收集上下文并启动 5 个审查子代理，请稍候…`,
    },
  };
}
