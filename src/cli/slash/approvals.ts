/**
 * 自动放行记录斜杠命令：`/approvals`（v5.2 N2）。
 *
 * ## 它解决的问题
 *
 * v5.1 的自动放行**只在屏幕上留痕**（`setNotice` 是单行槽位，滚过去就没了）。
 * 用户 `chat -r` 恢复会话后**无法回答**：「昨天那次改动是我按的 y，还是被自动放行的？」
 * D93 写的问责口径（事后能说清谁放开的）当时只兑现了一半——只有 `.git/` 里
 * 「开关开没开」的记录，没有「哪几次真放行了」。
 *
 * ## 为什么是纯函数
 *
 * 与 `/hints`、`/metrics` 同构：不碰磁盘、不读时钟、无副作用，输入 messages 输出文本。
 * 这样它能被单测直接打穿（空数组 / 旧格式 / 配对失败 / 超长列表都是纯输入）。
 *
 * ## 为什么读 messages 而不是重新读磁盘
 *
 * 恢复会话时 `chat.tsx` 已经把 JSONL 读成 `initialHistory` 交给 App；再从磁盘读一次
 * 会产生**两条真相路径**（还要处理「读的瞬间别人又追加了一行」）。
 */

import { fmt, t } from '../../i18n';
import type { ChatMessage } from '../../loop/types';

/**
 * 报告里最多列出的条数。
 *
 * 为什么有上限：自动放行次数可能上百（一次长任务连续改文件）。列表全铺出来会把
 * 回执变成一堵墙，用户反而看不到「一共几次」这个结论。超出部分明确告知还剩多少。
 */
export const MAX_APPROVAL_LINES = 20;

/** 一条自动放行记录（供测试与将来的结构化消费）。 */
export interface ApprovalRecord {
  /** 该 tool 消息的 `toolCallId`（缺失时为 undefined）。 */
  toolCallId?: string;
  /** 工具名（从配对的 assistant toolCalls 里取；取不到时 undefined）。 */
  toolName?: string;
  /** 编辑目标文件（从 `arguments.path` 取；取不到时 undefined）。 */
  filePath?: string;
  /** 工具回填结果的首行摘要（兜底展示用）。 */
  contentPreview?: string;
}

/**
 * 从 messages 里抽出所有「被自动放行」的工具调用。
 *
 * 口径：`role === 'tool' && approval === 'auto-low'`。
 * 工具名/文件名**从配对的 assistant toolCalls 反查**——因为自动放行发生在工具内部，
 * 工具结果本身未必带文件名（不同工具 data 形状不同，不该让报告层去猜每种工具）。
 */
export function collectApprovalRecords(messages: readonly ChatMessage[]): ApprovalRecord[] {
  // 先建 toolCallId → ToolCall 的索引（一次遍历，避免 O(n²)）
  const byId = new Map<string, { name: string; args: string }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || msg.toolCalls === undefined) {
      continue;
    }
    for (const call of msg.toolCalls) {
      byId.set(call.id, { name: call.name, args: call.arguments });
    }
  }

  const records: ApprovalRecord[] = [];
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.approval !== 'auto-low') {
      continue;
    }
    const call = msg.toolCallId === undefined ? undefined : byId.get(msg.toolCallId);
    records.push({
      ...(msg.toolCallId === undefined ? {} : { toolCallId: msg.toolCallId }),
      ...(call === undefined ? {} : { toolName: call.name, filePath: extractPath(call.args) }),
      ...(typeof msg.content === 'string' && msg.content !== ''
        ? { contentPreview: firstLine(msg.content) }
        : {}),
    });
  }
  return records;
}

/**
 * 从工具参数 JSON 里取 `path`（解析失败不抛错：参数是模型生成的，可能不合法）。
 *
 * 只取 `path` 一种：目前只有 `edit_file` 会被自动放行（shell 永不），
 * 而 `edit_file` 的参数就是 `{ path, search, replace }`。将来若要覆盖别的工具，
 * 在这里按工具名分派，而不是让调用方猜。
 */
function extractPath(rawArgs: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArgs) as { path?: unknown };
    return typeof parsed.path === 'string' ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

/** 取首行并截断（工具结果可能很长，报告只做识别线索）。 */
function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * 生成 `/approvals` 的回执正文。
 *
 * **零记录时必须有话可说**：返回一段明确文案而不是空串——空回执会让用户以为
 * 「命令没生效」或「功能坏了」（本仓一贯的「假按钮」教训）。
 */
export function formatApprovalReport(messages: readonly ChatMessage[]): string {
  const dict = t().approvalsCmd;
  const records = collectApprovalRecords(messages);

  if (records.length === 0) {
    return dict.none;
  }

  const shown = records.slice(0, MAX_APPROVAL_LINES);
  const lines: string[] = [fmt(dict.header, { count: String(records.length) })];
  shown.forEach((record, index) => {
    /**
     * 逐级兜底：文件名 → 工具名 → 「未知工具」，配对失败时**附上 toolCallId** 作线索。
     *
     * 为什么不直接把 toolCallId 当标题：`c1` / `call_abc` 这类 id 对用户毫无意义，
     * 但也不能丢——它是排查「这条到底对应哪次调用」的唯一线索。所以做成附注。
     * 绝不出现空白明细行（用户看不出发生了什么 = 比没有更糟）。
     */
    const known = record.filePath ?? record.toolName;
    const target =
      known ??
      (record.toolCallId === undefined
        ? dict.unknownTool
        : `${dict.unknownTool} [${record.toolCallId}]`);
    const detail = record.contentPreview ?? '';
    lines.push(`  ${index + 1}. ${target}${detail === '' ? '' : ` — ${detail}`}`);
  });
  if (records.length > shown.length) {
    lines.push(fmt(dict.more, { count: String(records.length - shown.length) }));
  }
  lines.push(dict.footnote);
  return lines.join('\n');
}

/** `/approvals` 的执行结果（与 `/hints` 同形：App 直接塞进消息列表）。 */
export interface ApprovalsCommandResult {
  /** 固定 true：斜杠命令不消耗模型轮次。 */
  handled: boolean;
  message: ChatMessage;
}

/**
 * 解析并执行 `/approvals`；非本命令返回 `null`（交给后续 handler）。
 *
 * 无子命令、无可调参数：这是一条**只读**命令，敲了就给报告。
 * 带参数时不报错、也不忽略——明确告知用法（用户以为有 `--json` 之类时不该沉默）。
 */
export function parseApprovalsCommand(
  input: string,
  messages: readonly ChatMessage[],
): ApprovalsCommandResult | null {
  const trimmed = input.trim();
  if (trimmed === '/approvals') {
    return {
      handled: true,
      message: { role: 'assistant', content: formatApprovalReport(messages) },
    };
  }
  if (trimmed.startsWith('/approvals ')) {
    return { handled: true, message: { role: 'assistant', content: t().approvalsCmd.usage } };
  }
  return null;
}
