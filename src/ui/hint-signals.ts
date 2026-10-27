/**
 * 场景提示的**状态信号采集**（v5.0 T13）。
 *
 * T12 的 `SuggestionState` 要求四类确定性事实，但引擎自己不去找它们（纯函数）。
 * 本模块负责把「运行中发生的事」翻译成那几个数字，并保持**同样严格的口径**：
 * 只认能数出来的事实，不做任何推断。
 *
 * | 信号 | 来源 | 口径 |
 * |---|---|---|
 * | `hasProjectRules` | 项目根有没有 `AGENTS.md` / `CARBON.md` | 只看存在性，不看内容 |
 * | `userTurns` | 会话里的 user 消息条数 | 直接数 |
 * | `consecutiveFailures` | verify 类命令的**连续**失败次数 | 见 `isVerifyClassCommand` |
 * | `fileRejectStreak` | 同一文件被按 `n` 拒绝的**连续**次数 | 批准一次即归零 |
 *
 * ## 为什么「verify 类」要单独定义
 *
 * 「连续 2 轮失败」如果按「任意工具报错」来数，会立刻变成噪音源：模型改错一个文件、
 * 读一个不存在的路径、搜索无结果……都算失败，用户会在正常干活时被提示去跑 self-heal。
 * 所以只认**真的跑过一次质量关卡**的命令（verify / test / lint / typecheck / build /
 * self-heal）——它红了，才是「构建或测试没通过」这个事实。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { RULE_FILENAMES } from '../store/project-rules';

/**
 * verify 类命令的特征（字面量前缀匹配，**不构造动态正则**）。
 *
 * 覆盖：`npm run verify` / `npm test` / `npm run lint` / `npm run typecheck` /
 * `npm run build` / `concertoai self-heal` / `biome check` / `tsc --noEmit`。
 * 用 `includes` 而非正则：热路径、且这些字符串本身不可能有歧义。
 */
const VERIFY_CLASS_PATTERNS: readonly string[] = [
  'npm run verify',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run typecheck',
  'npm run build',
  'concertoai self-heal',
  'biome check',
  'tsc --noEmit',
  'tsc -p',
];

/**
 * 这条 shell 命令是否属于「质量关卡」（跑完能给出一致的通过/失败结论）。
 *
 * 只用于**计数**（连续失败 2 轮才提示），不做任何拦截或审批判断。
 */
export function isVerifyClassCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (normalized === '') {
    return false;
  }
  return VERIFY_CLASS_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/** 一次质量关卡的结果。 */
export type GateOutcome = 'passed' | 'failed';

/**
 * 推进「连续失败」计数（纯函数）。
 *
 * - `failed` → +1；
 * - `passed` → 归零（**必须归零**：否则「连续」二字就变成了「历史累计」，
 *   用户修好之后还会被提示，这是最典型的狼来了）。
 */
export function nextFailureStreak(previous: number, outcome: GateOutcome): number {
  const base = Number.isFinite(previous) && previous > 0 ? Math.floor(previous) : 0;
  return outcome === 'failed' ? base + 1 : 0;
}

/** 一次编辑审批的结果（用于「同一文件连续被拒」计数）。 */
export interface RejectStreakState {
  /** 文件路径（相对 cwd）；无文件上下文时为 `''`。 */
  file: string;
  /** 同一文件连续被拒次数。 */
  count: number;
}

/** 空状态（首次进入会话）。 */
export const EMPTY_REJECT_STREAK: RejectStreakState = { file: '', count: 0 };

/**
 * 推进「同一文件连续被拒」计数（纯函数）。
 *
 * 规则（与 T12 规则表的 `fileRejectStreak >= 2` 对齐）：
 * - 被拒的文件**与上次相同** → +1；
 * - 被拒的文件**换了** → 该文件从 1 开始（换文件说明用户在推进，不是死磕一处）；
 * - **批准**（`approved: true`）→ 归零（用户认可了 AI 的改动，不再是「卡住」）。
 *
 * 无文件上下文（`file === ''`）时**不计数**：数不出「同一文件」这件事，
 * 硬数就变成了「任意编辑被拒 2 次」——那是噪音。
 */
export function nextRejectStreak(
  state: RejectStreakState,
  event: { file: string | undefined; approved: boolean },
): RejectStreakState {
  if (event.approved) {
    return EMPTY_REJECT_STREAK;
  }
  const file = (event.file ?? '').trim();
  if (file === '') {
    return state;
  }
  if (state.file === file) {
    return { file, count: state.count + 1 };
  }
  return { file, count: 1 };
}

/**
 * 项目根是否已有规则文件（`AGENTS.md` / `CARBON.md` 任一）。
 *
 * 只看**存在性**：`concertoai init` 生成的内容质量不归这里管（那是 T5 的事），
 * 提示要回答的是「这个项目根本没有规则文件」这个事实。
 */
export function hasProjectRulesFile(cwd: string): boolean {
  return RULE_FILENAMES.some((name) => existsSync(path.join(cwd, name)));
}

/** 会话里已产生的用户输入轮数（`/plan` 等斜杠命令也算一轮：用户确实说过话）。 */
export function countUserTurns(messages: ReadonlyArray<{ role: string }>): number {
  return messages.filter((message) => message.role === 'user').length;
}
