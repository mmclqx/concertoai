/**
 * /orchestrate 斜杠命令（v3.1 M5 / T5.2）：chat 内触发 team 全链路。
 *
 * - `/orchestrate <任务>`：拆解 → 展示 → 对抗性闭环 → 聚合（包装 runTeamCommand）；
 * - `/orchestrate`（无任务）→ 提示用法；
 * - 非 /orchestrate → null（不拦截）。
 *
 * 与 /review 一致：解析同步、执行异步（App.tsx 持有 client/ctx 注入 runTeam 回调）。
 * 可观测性：runTeamCommand 透传 traceStore，闭环 spans 在 `o` 键面板可见。
 */

import type { ChatMessage } from '../../loop/types';
import type { TeamCommandResult } from '../team';

// ── 命令解析 ──────────────────────────────────────────────────

export interface SlashOrchestrateCommand {
  /** 需求任务（缺省 = 用法提示）。 */
  task?: string;
}

/** 解析 /orchestrate 命令。非 /orchestrate 返回 null。 */
export function parseOrchestrateCommand(input: string): SlashOrchestrateCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/orchestrate') {
    return { task: undefined };
  }
  if (trimmed.startsWith('/orchestrate ')) {
    const task = trimmed.slice('/orchestrate '.length).trim();
    return { task: task || undefined };
  }
  return null;
}

// ── 命令执行 ──────────────────────────────────────────────────

export interface OrchestrateCommandResult {
  handled: boolean;
  message?: ChatMessage;
}

export interface ExecuteOrchestrateDeps {
  /** 执行 team 全链路（App.tsx 注入：cwd/client/model/traceStore/confirm）。 */
  runTeam: (task: string) => Promise<TeamCommandResult>;
}

/**
 * 执行 /orchestrate：调用 team 全链路，把结果转为聊天消息。
 * - 无任务 → 用法提示（handled）；
 * - 拆解失败 / 用户取消 / 闭环未收敛 → ❌ 中文错误；
 * - 成功 → ✅ 摘要。
 */
export async function executeOrchestrateCommand(
  cmd: SlashOrchestrateCommand,
  deps: ExecuteOrchestrateDeps,
): Promise<OrchestrateCommandResult> {
  if (cmd.task === undefined || cmd.task === '') {
    return {
      handled: true,
      message: {
        role: 'assistant',
        content:
          '用法: /orchestrate <任务> — 启动 Orchestrator 团队执行（拆解 → 对抗性闭环 → 回滚兜底）。\n例如: /orchestrate 实现一个 TODO 应用',
      },
    };
  }
  const result = await deps.runTeam(cmd.task);
  const icon = result.ok ? '✅' : '❌';
  // T3.3：拆解失败时附加 diagnostics（区分格式解析失败 / 网络调用失败，展示原始输出截断）
  if (!result.ok && result.diagnostics !== undefined) {
    const d = result.diagnostics;
    const kindText =
      d.kind === 'network'
        ? '网络/API 调用失败'
        : d.kind === 'parse'
          ? '模型输出格式解析失败'
          : '其他错误';
    let content = `${icon} ${result.summary}\n🔍 诊断（${kindText}）：${d.message}`;
    if (d.rawOutput !== undefined) {
      content += `\n模型原始输出（截断）:\n${d.rawOutput}`;
    }
    return { handled: true, message: { role: 'assistant', content } };
  }
  return {
    handled: true,
    message: { role: 'assistant', content: `${icon} ${result.summary}` },
  };
}
