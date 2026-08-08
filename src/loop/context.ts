/**
 * 上下文窗口管理（v2.0）：消息 token 数超过模型预算时压缩上下文。
 *
 * v2.0 升级：优先尝试模型摘要压缩（保留信息密度），失败时回退到旧裁剪策略。
 *
 * - 预算 = contextWindow × 80%（CONTEXT_BUDGET_RATIO），给回复预留余量；
 * - 保留：system 消息 + 最近的 N 轮对话（按 user 消息分组，整轮保留，
 *   避免截断 assistant 的 tool_calls 与对应 tool 结果链）；
 * - 压缩触发条件：被裁剪消息 > 5 条时才调模型生成摘要（≤5 条时摘要成本不划算）；
 * - 摘要生成成功 → 注入 `# 对话摘要\n…` system 消息，其余消息保留最近 N 轮；
 * - 摘要生成失败（网络错误/超时/返回空）→ 自动回退到旧裁剪策略；
 * - 摘要 token 数计入上下文预算（防止摘要本身撑爆预算）；
 * - 裁剪前记录日志，便于排查对话质量问题。
 */

import type { ModelClient } from '../model/client';
import { countMessageListTokens, countTokens } from '../model/tokenizer';
import { summaryMessage, systemMessage, toApiMessages, userMessage } from './messages';
import type { ChatMessage } from './types';

/** 上下文预算占 contextWindow 的比例。 */
export const CONTEXT_BUDGET_RATIO = 0.8;

/** 触发摘要的最小被裁剪消息数（≤ 此值直接裁剪，不值得调模型）。 */
const MIN_TRIM_FOR_SUMMARY = 5;

/** 摘要生成超时（毫秒）。 */
const SUMMARY_TIMEOUT_MS = 15_000;

export interface TrimResult {
  /** 裁剪/压缩后的消息（仅发送视角；持久化应保留完整历史）。 */
  messages: ChatMessage[];
  /** 丢弃的消息条数。 */
  trimmed: number;
  /** 裁剪前 token 数。 */
  beforeTokens: number;
  /** 裁剪后 token 数。 */
  afterTokens: number;
}

export interface CompressResult extends TrimResult {
  /** 是否成功生成了摘要（false = 使用了旧裁剪策略或未触发压缩）。 */
  summarized: boolean;
  /** 摘要文本（summarized 为 true 时有值）。 */
  summary?: string;
}

export interface CompressOptions {
  client: ModelClient;
  model: string;
  contextWindow: number;
  /** 日志回调（默认 console.warn）。 */
  log?: (message: string) => void;
}

// ── 旧裁剪策略（同步，v1.0 保留为降级方案）──────────────────

/**
 * 裁剪超预算的上下文：保留 system + 最近 N 轮，丢弃中间旧消息。
 * 未超预算时原样返回（trimmed = 0，数组引用不变）。
 */
export function trimContext(
  messages: ChatMessage[],
  contextWindow: number,
  log: (message: string) => void = console.warn,
): TrimResult {
  const budget = Math.floor(contextWindow * CONTEXT_BUDGET_RATIO);
  const beforeTokens = countMessageListTokens(messages);
  if (beforeTokens <= budget) {
    return { messages, trimmed: 0, beforeTokens, afterTokens: beforeTokens };
  }

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  const keptGroups: ChatMessage[][] = [];
  let group: ChatMessage[] = [];
  let keptTokens = 0;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const m = rest[i];
    if (m === undefined) {
      continue;
    }
    group.unshift(m);
    if (m.role === 'user' || i === 0) {
      const groupTokens = countMessageListTokens(group);
      const forceKeep = keptGroups.length === 0;
      if (forceKeep || keptTokens + groupTokens <= budget) {
        keptGroups.push(group);
        keptTokens += groupTokens;
      }
      group = [];
      if (keptGroups.length > 0 && keptTokens >= budget) {
        break;
      }
    }
  }

  const kept = keptGroups.reverse().flat();
  const result = [...system, ...kept];
  const afterTokens = countMessageListTokens(result);
  log(
    `裁剪上下文：丢弃 ${messages.length - result.length} 条旧消息（${beforeTokens} → ${afterTokens} token，预算 ${budget}）`,
  );
  return { messages: result, trimmed: messages.length - result.length, beforeTokens, afterTokens };
}

// ── v2.0 智能摘要压缩（异步）─────────────────────────────────

/**
 * 压缩超预算的上下文：优先尝试模型摘要，失败回退裁剪。
 *
 * 算法：
 * 1. 检查总 token 数是否超预算 → 未超则原样返回；
 * 2. 模拟裁剪找出将被丢弃的消息；
 * 3. 丢弃 ≤ 5 条 → 直接裁剪（摘要不值）；
 * 4. 丢弃 > 5 条 → 调用模型生成摘要；
 * 5. 摘要成功 → 注入摘要 + 保留最近 N 轮；
 * 6. 摘要失败 → 回退到旧裁剪策略。
 */
export async function compressContext(
  messages: ChatMessage[],
  options: CompressOptions,
): Promise<CompressResult> {
  const log = options.log ?? (() => {});
  const budget = Math.floor(options.contextWindow * CONTEXT_BUDGET_RATIO);
  const beforeTokens = countMessageListTokens(messages);

  if (beforeTokens <= budget) {
    return { messages, trimmed: 0, beforeTokens, afterTokens: beforeTokens, summarized: false };
  }

  // 模拟裁剪找出将被丢弃的消息
  const dryRun = trimContext(messages, options.contextWindow, () => {});
  const trimmedCount = dryRun.trimmed;
  const keptMessages = dryRun.messages;

  // 丢弃 ≤ 5 条 → 直接裁剪
  if (trimmedCount <= MIN_TRIM_FOR_SUMMARY) {
    log(
      `裁剪上下文：丢弃 ${trimmedCount} 条旧消息（≤ ${MIN_TRIM_FOR_SUMMARY} 条，不触发摘要；${beforeTokens} → ${dryRun.afterTokens} token，预算 ${budget}）`,
    );
    return {
      messages: keptMessages,
      trimmed: trimmedCount,
      beforeTokens,
      afterTokens: dryRun.afterTokens,
      summarized: false,
    };
  }

  // 收集被丢弃的消息用于摘要
  const discarded = findDiscarded(messages, keptMessages);

  // 尝试生成摘要
  const summary = await generateSummary(options.client, options.model, discarded);
  if (summary !== null && summary.length > 0) {
    // 摘要成功 → 注入摘要 + 保留最近 N 轮
    const systemMsgs = keptMessages.filter((m) => m.role === 'system');
    const nonSystem = keptMessages.filter((m) => m.role !== 'system');
    const summaryMsg = summaryMessage(summary);
    const result = [...systemMsgs, summaryMsg, ...nonSystem];
    const afterTokens = countMessageListTokens(result);

    // 摘要 token 计入预算：若摘要 + 保留消息仍超预算，则裁剪保留部分
    if (afterTokens > budget) {
      const trimmedResult = trimContext(result, options.contextWindow, () => {});
      log(
        `[上下文] 已生成摘要（${discarded.length} 条消息 → ${countTokens(summary)} token 摘要），但摘要 + 保留消息仍超预算，已二次裁剪（${afterTokens} → ${trimmedResult.afterTokens} token）`,
      );
      return {
        messages: trimmedResult.messages,
        trimmed: messages.length - trimmedResult.messages.length,
        beforeTokens,
        afterTokens: trimmedResult.afterTokens,
        summarized: true,
        summary,
      };
    }

    log(
      `[上下文] 已生成摘要（${discarded.length} 条消息 → ${countTokens(summary)} token 摘要；${beforeTokens} → ${afterTokens} token，预算 ${budget}）`,
    );
    return {
      messages: result,
      trimmed: trimmedCount,
      beforeTokens,
      afterTokens,
      summarized: true,
      summary,
    };
  }

  // 摘要失败 → 回退到旧裁剪策略
  log(
    `[上下文] 摘要生成失败，回退到裁剪策略：丢弃 ${trimmedCount} 条旧消息（${beforeTokens} → ${dryRun.afterTokens} token，预算 ${budget}）`,
  );
  return {
    messages: keptMessages,
    trimmed: trimmedCount,
    beforeTokens,
    afterTokens: dryRun.afterTokens,
    summarized: false,
  };
}

// ── 辅助函数 ──────────────────────────────────────────────────

/** 找出原始消息中不在保留列表中的消息（即被丢弃的消息）。 */
function findDiscarded(all: ChatMessage[], kept: ChatMessage[]): ChatMessage[] {
  const keptSet = new Set(kept);
  return all.filter((m) => !keptSet.has(m));
}

/** 调用模型生成对话摘要。失败返回 null。 */
async function generateSummary(
  client: ModelClient,
  model: string,
  discarded: ChatMessage[],
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    // 将被丢弃的消息序列化为文本（截断每条消息防止摘要 prompt 过长）
    const lines: string[] = [];
    for (const m of discarded) {
      const prefix =
        m.role === 'user'
          ? '用户'
          : m.role === 'assistant'
            ? '助手'
            : m.role === 'tool'
              ? '工具结果'
              : '系统';
      const body = (m.content ?? '').slice(0, 500);
      lines.push(`${prefix}: ${body}`);
    }

    const prompt = [
      systemMessage(
        '你是一个对话摘要工具。请将以下对话历史压缩为一段简短摘要，保留关键决策、用户意图、重要上下文和未完成的任务。输出纯文本，不超过 500 字。',
      ),
      userMessage(`请摘要以下 ${discarded.length} 条对话消息：\n\n${lines.join('\n')}`),
    ];

    let summary = '';
    for await (const chunk of client.streamChat({
      model,
      messages: toApiMessages(prompt),
      maxTokens: 600,
      signal: controller.signal,
    })) {
      for (const choice of chunk.choices) {
        summary += choice.delta.content ?? '';
      }
    }
    const trimmed = summary.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
