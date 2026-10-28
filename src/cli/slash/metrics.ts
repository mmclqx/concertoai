/**
 * 本地指标斜杠命令：`/metrics`（v5.0 T21，ADR-049）。
 *
 * ## 四个子命令
 *
 * | 命令 | 效果 | 持久化 |
 * |---|---|---|
 * | `/metrics on` | **本次会话**开始记录（审批 / 提示 / 体检 / 动词） | 否（会话级） |
 * | `/metrics off` | 立刻停止记录（已有数据不动） | 否 |
 * | `/metrics status` | 查看是否开启 + 文件在哪 + 怎么汇总 | — |
 * | `/metrics clear` | 清空本地指标文件（幂等，回执说清清掉几条） | 文件级 |
 *
 * ## 与 `/hints` 一致的两条设计
 *
 * 1. **裸命令等价 `status`**：用户敲 `/metrics` 时最可能想看状态，而不是被要求再看一遍用法；
 * 2. **会话级开关不写配置**：`/metrics off` 只静音本次会话，回执里给出**真能用**的永久命令
 *    （`concertoai config set metrics off`）——提示里的话是承诺，不是空头支票（ADR-044）。
 *
 * ## 为什么 `clear` 敢直接删
 *
 * 数据是**用户自己的本地指标**、且只用于他自己看趋势；他在自己终端里敲下 `clear` 就是明确意图。
 * 删完回执告诉他一共清掉几条，误删了也能立刻意识到（而 metrics 数据重建成本为零）。
 */

import {
  clearMetrics,
  defaultMetricsPath,
  type MetricsStoreOptions,
  readMetrics,
} from '../../core/metrics-store';
import { fmt, t } from '../../i18n';
import type { ChatMessage } from '../../loop/types';

// ── 命令解析 ──

export type SlashMetricsCommand =
  | { type: 'on' }
  | { type: 'off' }
  | { type: 'status' }
  | { type: 'clear' }
  | { type: 'unknown'; message: string };

/**
 * 解析 `/metrics` 命令；非本命令返回 `null`（交给后续 handler）。
 *
 * 裸 `/metrics` 等价 `status`（同 `/hints`）。
 */
export function parseMetricsCommand(input: string): SlashMetricsCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/metrics' || trimmed === '/metrics status') {
    return { type: 'status' };
  }
  if (trimmed === '/metrics on') {
    return { type: 'on' };
  }
  if (trimmed === '/metrics off') {
    return { type: 'off' };
  }
  if (trimmed === '/metrics clear') {
    return { type: 'clear' };
  }
  if (trimmed.startsWith('/metrics ')) {
    return {
      type: 'unknown',
      message: fmt(t().metricsCmd.unknownAction, {
        action: trimmed.slice('/metrics '.length).trim(),
      }),
    };
  }
  return null;
}

// ── 命令执行 ──

/** 执行结果（App 据此更新会话状态）。 */
export interface MetricsCommandResult {
  /** 固定 true：斜杠命令不消耗模型轮次。 */
  handled: boolean;
  /** 回执消息。 */
  message: ChatMessage;
  /** 会话内指标开关的目标值；`undefined` = 本次命令不改开关。 */
  enabled?: boolean;
}

/** 执行选项（IO 全部可注入，便于纯逻辑单测）。 */
export interface MetricsCommandOptions {
  /** 当前会话指标是否开启（App 传入）。 */
  enabled: boolean;
  /** 指标文件路径（缺省 `~/.concertoai/metrics.jsonl`）。 */
  file?: string;
  /** 清空实现（缺省 `clearMetrics`）。 */
  clearImpl?: (options?: MetricsStoreOptions) => Promise<{ ok: boolean; removed: boolean }>;
  /** 读取实现（缺省 `readMetrics`，仅用于算出「清掉了几条」）。 */
  readImpl?: (options?: MetricsStoreOptions) => Promise<{ entries: unknown[] }>;
}

/** 执行 `/metrics` 命令（`clear` 会真的删文件；不影响主流程：失败只回报错文案）。 */
export async function executeMetricsCommand(
  cmd: SlashMetricsCommand,
  options: MetricsCommandOptions,
): Promise<MetricsCommandResult> {
  const dict = t().metricsCmd;
  const file = options.file ?? defaultMetricsPath();
  const storeOptions: MetricsStoreOptions = { file };

  if (cmd.type === 'on') {
    return {
      handled: true,
      message: { role: 'assistant', content: dict.on },
      enabled: true,
    };
  }

  if (cmd.type === 'off') {
    return {
      handled: true,
      message: { role: 'assistant', content: dict.off },
      enabled: false,
    };
  }

  if (cmd.type === 'status') {
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: options.enabled
          ? fmt(dict.statusOn, { path: file })
          : fmt(dict.statusOff, { path: file }),
      },
    };
  }

  if (cmd.type === 'clear') {
    const read = options.readImpl ?? readMetrics;
    const clear = options.clearImpl ?? clearMetrics;
    let count = 0;
    try {
      const before = await read(storeOptions);
      count = before.entries.length;
    } catch {
      // 读不到就按 0 条回报——清空本身仍要继续（这是用户明确要求的动作）
    }
    const result = await clear(storeOptions);
    if (!result.ok) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: fmt(dict.clearFailed, { message: (result as { error?: string }).error ?? '' }),
        },
      };
    }
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: count === 0 ? dict.clearedEmpty : fmt(dict.cleared, { count }),
      },
    };
  }

  return { handled: true, message: { role: 'assistant', content: cmd.message } };
}
