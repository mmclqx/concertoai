/**
 * 场景提示行外壳（v5.0 T13）。
 *
 * **本组件只干一件事：把 `hint-text.ts` 算好的一行字符串染成灰色。**
 * 不做排版、不拼文案、不加边框、不换行（架构铁律①：纯字符串优先，Ink 只上色）。
 *
 * ## 为什么 `line === null` 时返回 `null` 而不是空 `<Text>`
 *
 * Ink 里一个空的 `<Text></Text>` 仍会占**一行**高度。提示不该出现时（流式输出中、
 * 无命中、已被忽略）如果留下一个空行，输入框就被无端下推一格——这正是用户点名
 * 禁止的「挤压输入框」。所以「不渲染」必须是**不渲染**，不是「渲染个空白」。
 */

import { Text } from 'ink';
import { memo } from 'react';
import type { Suggestion } from '../core/suggestion';
import { type HintPhase, normalizeColumns, resolveHintLine } from './hint-text';

export interface HintBarProps {
  /** 引擎判定结果（`null` = 本时刻没有提示）。 */
  suggestion: Suggestion | null;
  /** 当前会话阶段（只有 `idle` 会显示）。 */
  phase: HintPhase;
  /**
   * 终端列数（测试注入；缺省读 `process.stdout.columns`，非 TTY 回落 80）。
   *
   * 与 `ApprovalModal` 的 `width` 同口径：生产不传，测试显式传以固定快照。
   */
  columns?: number;
}

/**
 * 输入框上方的一行灰字提示。
 *
 * `memo` 包裹：聊天气泡逐个追加时，提示行不变就不重算（与 T9 的节流口径一致）。
 */
export const HintBar = memo(function HintBar({ suggestion, phase, columns }: HintBarProps) {
  const resolvedColumns =
    columns ?? (typeof process.stdout.columns === 'number' ? process.stdout.columns : undefined);
  const line = resolveHintLine({
    phase,
    suggestion,
    columns: normalizeColumns(resolvedColumns),
  });
  // 不渲染 ≠ 渲染空白：必须返回 null，否则空 <Text> 会白占一行，把输入框往下推
  if (line === null) {
    return null;
  }
  return <Text dimColor>{line}</Text>;
});
