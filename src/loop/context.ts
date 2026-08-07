/**
 * 上下文窗口管理：消息 token 数超过模型预算时裁剪上下文。
 *
 * - 预算 = contextWindow × 80%（CONTEXT_BUDGET_RATIO），给回复预留余量；
 * - 保留：system 消息 + 最近的 N 轮对话（按 user 消息分组，整轮保留，
 *   避免截断 assistant 的 tool_calls 与对应 tool 结果链）；
 * - 丢弃：中间的旧消息；
 * - 至少保留最新一组（含最新 user 消息），保证请求合法；
 * - 裁剪前记录日志（默认 console.warn，可注入覆盖），便于排查对话质量问题。
 */

import { estimateMessageListTokens } from '../model/tokenizer';
import type { ChatMessage } from './types';

/** 上下文预算占 contextWindow 的比例。 */
export const CONTEXT_BUDGET_RATIO = 0.8;

export interface TrimResult {
  /** 裁剪后的消息（仅发送视角；持久化应保留完整历史）。 */
  messages: ChatMessage[];
  /** 丢弃的消息条数。 */
  trimmed: number;
  /** 裁剪前 token 数。 */
  beforeTokens: number;
  /** 裁剪后 token 数。 */
  afterTokens: number;
}

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
  const beforeTokens = estimateMessageListTokens(messages);
  if (beforeTokens <= budget) {
    return { messages, trimmed: 0, beforeTokens, afterTokens: beforeTokens };
  }

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  // 从后往前按「逻辑轮」收集：一条 user 消息及其后的 assistant/tool 链为一组
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
      const groupTokens = estimateMessageListTokens(group);
      // 至少保留最新一组（forceKeep），其余组在预算内才保留
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
  const afterTokens = estimateMessageListTokens(result);
  log(
    `裁剪上下文：丢弃 ${messages.length - result.length} 条旧消息（${beforeTokens} → ${afterTokens} token，预算 ${budget}）`,
  );
  return { messages: result, trimmed: messages.length - result.length, beforeTokens, afterTokens };
}
