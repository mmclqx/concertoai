/**
 * 场景提示斜杠命令：`/hints`（v5.0 T13）。
 *
 * ## 三个子命令
 *
 * | 命令 | 效果 | 持久化 |
 * |---|---|---|
 * | `/hints off` | **本次会话**立刻静默（当前提示消失，后续不再出现） | 否（会话级） |
 * | `/hints on` | 恢复本次会话提示（连同「已忽略」标记一起清掉） | 否 |
 * | `/hints status` | 查看当前会话提示是否开启 | — |
 *
 * ## 为什么 `/hints off` 不改配置文件
 *
 * 「我现在烦了」和「我以后都不想看」是两件事：
 * - 前者发生在**具体某次对话**里（用户此刻在赶活），下次开新会话未必还烦；
 * - 后者应当是一句显式、永久的决定。
 *
 * 所以 `/hints off` 只作用于当前会话，并在回执里**明确告知**永久关闭的命令
 * （`concertoai config set hints off`）——那条命令 T12 已实现并有用例，
 * 这里只是把它指出来，不是空头支票。
 */

import { HINT_COOLDOWN_MS, MAX_HINTS_PER_SESSION } from '../../core/suggestion';
import { fmt, t } from '../../i18n';
import type { ChatMessage } from '../../loop/types';

// ── 命令解析 ──

export type SlashHintsCommand =
  | { type: 'on' }
  | { type: 'off' }
  | { type: 'status' }
  | { type: 'unknown'; message: string };

/**
 * 解析 `/hints` 命令；非本命令返回 `null`（交给后续 handler）。
 *
 * 接受 `/hints`（无参数）等价于 `status`——用户敲一个裸命令时最可能想看状态，
 * 而不是被要求再看一遍用法。
 */
export function parseHintsCommand(input: string): SlashHintsCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/hints' || trimmed === '/hints status') {
    return { type: 'status' };
  }
  if (trimmed === '/hints on') {
    return { type: 'on' };
  }
  if (trimmed === '/hints off') {
    return { type: 'off' };
  }
  if (trimmed.startsWith('/hints ')) {
    return {
      type: 'unknown',
      message: fmt(t().hintsCmd.unknownAction, { action: trimmed.slice('/hints '.length).trim() }),
    };
  }
  return null;
}

// ── 命令执行 ──

/** 执行结果（App 据此更新会话状态）。 */
export interface HintsCommandResult {
  /** 固定 true：斜杠命令不消耗模型轮次。 */
  handled: boolean;
  /** 回执消息。 */
  message: ChatMessage;
  /**
   * 会话内提示开关的目标值；`undefined` = 本次命令不改开关。
   */
  enabled?: boolean;
  /**
   * 是否要求「立刻静默」（约束⑤）。
   *
   * `/hints off` 置 true：当前正在显示的那一条要马上消失，且本会话不再出现。
   */
  dismiss?: boolean;
}

/** 执行选项。 */
export interface HintsCommandOptions {
  /** 当前会话提示是否开启（由 App 传入；用于 `/hints status` 回执）。 */
  enabled: boolean;
}

/** 执行 `/hints` 命令（同步、纯逻辑，不碰磁盘）。 */
export function executeHintsCommand(
  cmd: SlashHintsCommand,
  options: HintsCommandOptions,
): HintsCommandResult {
  const dict = t().hintsCmd;

  if (cmd.type === 'off') {
    return {
      handled: true,
      message: { role: 'assistant', content: dict.off },
      enabled: false,
      dismiss: true,
    };
  }

  if (cmd.type === 'on') {
    return {
      handled: true,
      message: { role: 'assistant', content: dict.on },
      enabled: true,
      // 恢复时不能只改开关：T12 引擎的「已忽略」是单向的，必须一并清掉，
      // 否则用户 `/hints off` 再 `/hints on` 会发现「开了但再也不出提示」（假按钮）。
      dismiss: false,
    };
  }

  if (cmd.type === 'status') {
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: options.enabled
          ? fmt(dict.statusOn, {
              max: MAX_HINTS_PER_SESSION,
              minutes: Math.round(HINT_COOLDOWN_MS / 60_000),
            })
          : dict.statusOff,
      },
    };
  }

  return {
    handled: true,
    message: { role: 'assistant', content: cmd.message },
  };
}
