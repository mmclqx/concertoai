/**
 * 工作流斜杠命令处理器：/workflow（v4.0 M2 T2.6，chat 内可用）。
 *
 * - /workflow                 列出已安装工作流
 * - /workflow run <name>      执行工作流（进度推送消息）
 * - /workflow init [template] 生成模板到 .concertoai/workflows/
 * - /workflow export <name>   输出 YAML（展示在聊天）
 * - /workflow import <file>   校验并注册工作流文件
 */

import { fmt, t } from '../../i18n';
import type { ChatMessage } from '../../loop/types';
import type { SnapshotManager } from '../../orchestrator/transaction';
import type { CommandRunner, RecoveryChoice } from '../../workflow/executor';
import { runWorkflow } from '../../workflow/executor';
import { parseWorkflowYaml, serializeWorkflowYaml } from '../../workflow/parser';
import { getWorkflowTemplate, WORKFLOW_TEMPLATE_NAMES } from '../../workflow/templates';
import type { WorkflowProgress } from '../../workflow/types';
import { loadWorkflow, saveWorkflow } from '../workflow';

// ── 命令解析 ──────────────────────────────────────────────────

export type SlashWorkflowCommand =
  | { type: 'list' }
  | { type: 'run'; name: string }
  | { type: 'init'; template?: string }
  | { type: 'export'; name: string }
  | { type: 'import'; file: string }
  | { type: 'unknown'; message: string };

/** 解析 /workflow 命令；非 /workflow 返回 null。 */
export function parseWorkflowCommand(input: string): SlashWorkflowCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/workflow' || trimmed === '/workflow list') {
    return { type: 'list' };
  }
  if (trimmed.startsWith('/workflow run ')) {
    return { type: 'run', name: trimmed.slice('/workflow run '.length).trim() };
  }
  if (trimmed.startsWith('/workflow init')) {
    const template = trimmed.slice('/workflow init'.length).trim();
    return { type: 'init', template: template || undefined };
  }
  if (trimmed.startsWith('/workflow export ')) {
    return { type: 'export', name: trimmed.slice('/workflow export '.length).trim() };
  }
  if (trimmed.startsWith('/workflow import ')) {
    return { type: 'import', file: trimmed.slice('/workflow import '.length).trim() };
  }
  if (trimmed.startsWith('/workflow')) {
    return {
      type: 'unknown',
      message:
        '用法: /workflow list | run <name> | init [template] | export <name> | import <file>',
    };
  }
  return null;
}

// ── 执行 ──────────────────────────────────────────────────────

export interface WorkflowSlashOptions {
  /** 工作目录。 */
  cwd: string;
  /** 命令执行器（缺省：CLI 默认 exec 包装）。 */
  runCommand?: CommandRunner;
  /** 审批回调（require: approval 步骤；缺省拒绝 fail-closed）。 */
  requestApproval?: (step: WorkflowStepLike, index: number) => Promise<boolean> | boolean;
  /** 进度回调（聊天内渐进推送消息）。 */
  onProgress?: (progress: WorkflowProgress) => void;
  /** 失败恢复选择（缺省 abort + 提示）。 */
  onFailure?: (info: {
    failedStep: string;
    error: string;
  }) => Promise<RecoveryChoice> | RecoveryChoice;
  /** 快照管理器（缺省不启用事务回滚）。 */
  snapshots?: SnapshotManager;
}

/** 与 WorkflowStep 结构兼容的最小类型（避免跨模块循环导入）。 */
export interface WorkflowStepLike {
  name: string;
  run: string;
  require?: 'none' | 'approval';
}

/** 执行 /workflow 命令，返回聊天消息。 */
export async function runWorkflowSlash(
  cmd: SlashWorkflowCommand,
  options: WorkflowSlashOptions,
): Promise<{ handled: boolean; message: ChatMessage }> {
  const d = t().workflow;
  const { cwd } = options;

  if (cmd.type === 'unknown') {
    return { handled: true, message: { role: 'assistant', content: cmd.message } };
  }

  if (cmd.type === 'list') {
    const { listWorkflows } = await import('../workflow');
    const names = listWorkflows(cwd);
    if (names.length === 0) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `📋 ${d.listEmpty}\n  ${d.listHint}\n\n可先用 \`/workflow init release\` 生成发布流程模板。`,
        },
      };
    }
    const lines = names.map((name) => {
      const wf = loadWorkflow(cwd, name);
      return `- **${name}**${wf?.description !== undefined ? ` — ${wf.description}` : ''}`;
    });
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `📋 ${fmt(d.listHeader, { count: names.length })}：\n\n${lines.join('\n')}\n\n使用 \`/workflow run <name>\` 执行。`,
      },
    };
  }

  if (cmd.type === 'init') {
    const template = cmd.template === undefined ? undefined : getWorkflowTemplate(cmd.template);
    if (template === undefined) {
      const names = WORKFLOW_TEMPLATE_NAMES.join(', ');
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ ${fmt(d.initUnknown, { name: cmd.template ?? '' })}\n\n可用模板: ${names}\n用法: /workflow init <template>`,
        },
      };
    }
    const file = saveWorkflow(cwd, template);
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `✅ ${fmt(d.initDone, { name: template.name, file })}\n\n执行 \`/workflow run ${template.name}\` 开始。`,
      },
    };
  }

  if (cmd.type === 'export') {
    const wf = loadWorkflow(cwd, cmd.name);
    if (wf === undefined) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ ${fmt(d.workflowNotFound, { name: cmd.name })}`,
        },
      };
    }
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `📄 ${fmt(d.exportTitle, { name: cmd.name })}\n\n\`\`\`yaml\n${serializeWorkflowYaml(wf).trimEnd()}\n\`\`\``,
      },
    };
  }

  if (cmd.type === 'import') {
    const { readFileSync } = await import('node:fs');
    try {
      const text = readFileSync(cmd.file, 'utf8');
      const workflow = parseWorkflowYaml(text);
      const dest = saveWorkflow(cwd, workflow);
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `✅ ${fmt(d.importDone, { name: workflow.name, file: dest })}`,
        },
      };
    } catch (err) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ ${fmt(d.importFailed, { error: err instanceof Error ? err.message : String(err) })}`,
        },
      };
    }
  }

  // ── run：异步执行工作流 ──
  const workflow = loadWorkflow(cwd, cmd.name);
  if (workflow === undefined) {
    return {
      handled: true,
      message: { role: 'assistant', content: `❌ ${fmt(d.workflowNotFound, { name: cmd.name })}` },
    };
  }
  options.onProgress?.({
    done: 0,
    total: workflow.steps.length,
    stepName: cmd.name,
    state: 'running',
  });
  const result = await runWorkflow(workflow, {
    cwd,
    runCommand: options.runCommand ?? (await import('../workflow')).defaultRunCommand,
    requestApproval: options.requestApproval,
    onProgress: options.onProgress,
    onFailure: options.onFailure,
    snapshots: options.snapshots,
  });
  if (result.ok) {
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `✅ ${fmt(d.runOk, { name: cmd.name })}\n\n${formatRunSummary(result)}`,
      },
    };
  }
  return {
    handled: true,
    message: {
      role: 'assistant',
      content: `❌ ${fmt(d.runFailed, {
        name: cmd.name,
        step: result.failedStep ?? '?',
        skipped: result.skipped.length,
      })}\n\n${formatRunSummary(result)}`,
    },
  };
}

/** 汇总执行结果（顺序 + 状态图标）。 */
function formatRunSummary(result: {
  order: string[];
  steps: Array<{ name: string; state: string }>;
}): string {
  const icons: Record<string, string> = { done: '✅', failed: '❌', skipped: '⏭', running: '▎' };
  const lines = result.order.map((name) => {
    const step = result.steps.find((s) => s.name === name);
    const state = step?.state ?? 'skipped';
    return `- ${icons[state] ?? '•'} ${name}`;
  });
  return lines.join('\n');
}
