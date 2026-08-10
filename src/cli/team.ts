/**
 * `concertoai team "<任务>"`（v3.1 M5 / T5.1）：Orchestrator CLI 入口。
 *
 * 流程：需求拆解（模型 → Task[] 清单）→ 展示 + 确认（--dry-run 仅输出清单）→
 * 装配 4 角色团队（Architect/Coder/Reviewer/QA）→ 对抗性闭环（runTeamLoop，
 * coder 实现 → reviewer 审查 → qa 验证，MAX_LOOP_ATTEMPTS=5）→
 * 超限/失败 SnapshotManager 事务回滚兜底 → 聚合输出（spec/code/review-result/test-report 工件 + 中文 summary）。
 *
 * 安全：代码写盘走审批（CoderAgent.onApproval，fail-closed）；审批拒绝不写盘；
 * 闭环超限触发回滚；回滚失败保留快照供人工检查。
 *
 * 可注入（测试）：client / confirm / agents（coder/reviewer/qa），避免真实模型与磁盘副作用。
 */

import { createInterface } from 'node:readline';
import { SubagentSpawner } from '../agent/spawner';
import type { ArchitectSpec } from '../agents';
import {
  ChildProcessQaRunner,
  CoderAgent,
  DiskFileWriter,
  decomposeRequirement,
  type OrchestratorTask,
  QaAgent,
  TeamReviewerAgent,
} from '../agents';
import { resolveLocale, setLocale } from '../i18n';
import type { ModelClient } from '../model/client';
import { DeepSeekClient } from '../model/client';
import type { TraceStore } from '../observable';
import type {
  AgentContext,
  Artifact,
  CoderLike,
  QaLike,
  ReviewerLike,
  TeamLoopResult,
} from '../orchestrator';
import { runTeamLoop, SnapshotManager } from '../orchestrator';
import { ReviewerEngine } from '../reviewer/engine';
import { loadConfig, resolveConfig } from '../store/config';
import { resolveModel } from './common';

// ── 选项 ──────────────────────────────────────────────────────

export interface RunTeamCommandOptions {
  /** 项目根目录。 */
  cwd: string;
  /** DeepSeek API Key。 */
  apiKey: string;
  /** 需求描述（自然语言）。 */
  task: string;
  /** 模型 ID（缺省用配置/默认）。 */
  model?: string;
  /** 自动批准拆解方案与代码写盘（谨慎使用；默认全部审批）。 */
  autoApprove?: boolean;
  /** 仅输出拆解清单，不执行任何 Agent。 */
  dryRun?: boolean;
  /** CLI --lang。 */
  lang?: string;
  /** 模型客户端（测试注入；缺省 DeepSeekClient）。 */
  client?: ModelClient;
  /** 终端确认回调（测试注入；缺省 readline y/n）。 */
  confirm?: (prompt: string) => Promise<boolean>;
  /** 团队 Agent 注入（测试；缺省装配真实 4 角色）。 */
  agents?: { coder: CoderLike; reviewer: ReviewerLike; qa: QaLike };
  /** 可观测性调用链（可选；拆解/闭环阶段记录 spans）。 */
  traceStore?: TraceStore;
}

// ── 结果 ──────────────────────────────────────────────────────

export interface TeamCommandResult {
  /** 是否成功（闭环收敛且无失败）。 */
  ok: boolean;
  /** 中文摘要。 */
  summary: string;
  /** 拆解出的任务清单。 */
  tasks: OrchestratorTask[];
  /** 全部工件引用（spec/code/review-result/test-report）。 */
  artifacts: Artifact[];
  /** 对抗性闭环结果（未进入闭环时缺省）。 */
  loop?: TeamLoopResult;
}

// ── 主流程 ────────────────────────────────────────────────────

/** 终端 y/n 确认（默认实现；readline 单次询问）。 */
function defaultConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/** 打印拆解清单（任务名/负责人/描述/依赖/files）。 */
export function formatTaskList(tasks: OrchestratorTask[]): string {
  if (tasks.length === 0) {
    return '（需求拆解结果为空）';
  }
  const lines = tasks.map((t) => {
    const deps = t.dependencies.length > 0 ? t.dependencies.join(', ') : '无';
    const files = t.files !== undefined && t.files.length > 0 ? t.files.join(', ') : '—';
    return `- **${t.id}** [${t.agent}] ${t.description}\n  依赖: ${deps} ｜ 文件: ${files}`;
  });
  return lines.join('\n');
}

/** 构造最小 ArchitectSpec（无 architect 任务时的兜底）。 */
function minimalSpec(requirement: string): ArchitectSpec {
  return {
    requirement,
    interfaces: [],
    files: [],
    constraints: ['按需求实现，保持现有代码风格'],
  };
}

/**
 * 执行 team 命令：拆解 → 确认 → 对抗性闭环 → 聚合。
 */
export async function runTeamCommand(options: RunTeamCommandOptions): Promise<TeamCommandResult> {
  const config = await loadConfig();
  const resolved = resolveConfig(config, options.model, options.lang);
  setLocale(resolveLocale(resolved.locale));
  const model = resolveModel(resolved.model);
  const client = options.client ?? new DeepSeekClient({ apiKey: options.apiKey });

  // 1. 拆解（模型输出 Task[]；失败给中文错误，不静默产出空清单）
  let tasks: OrchestratorTask[];
  try {
    tasks = await decomposeRequirement(client, model, options.task);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `需求拆解失败: ${message}`, tasks: [], artifacts: [] };
  }
  options.traceStore?.record({
    id: `team:decompose:${Date.now()}`,
    taskId: 'team',
    agentName: 'orchestrator',
    messageType: 'task',
    input: { command: options.task },
    startedAt: Date.now(),
    durationMs: 0,
  });

  // 2. dry-run：仅输出拆解清单并退出，不执行任何 Agent
  if (options.dryRun === true) {
    process.stdout.write(`=== 任务拆解（dry-run，未执行）===\n\n${formatTaskList(tasks)}\n`);
    return { ok: true, summary: 'dry-run：仅输出拆解清单，未执行任何 Agent', tasks, artifacts: [] };
  }

  // 3. 审批：拆解清单先展示，用户确认后执行（与 plan 模式一致）
  const confirm = options.confirm ?? defaultConfirm;
  if (options.autoApprove !== true) {
    if (process.stdin.isTTY !== true) {
      process.stderr.write('❌ team 命令需要交互式终端确认拆解方案；非交互请加 --auto-approve。\n');
      process.exit(1);
    }
    process.stdout.write(`=== 任务拆解 ===\n\n${formatTaskList(tasks)}\n\n`);
    const approved = await confirm('批准该方案并开始执行 (y/n): ');
    if (!approved) {
      process.stdout.write('用户未确认拆解方案，已取消（未执行任何 Agent）。\n');
      return { ok: false, summary: '用户未确认拆解方案，已取消', tasks, artifacts: [] };
    }
  }

  // 4. 装配团队 Agent（缺省 4 角色；测试可注入 fake）
  const codeApproval: (files: Array<{ path: string; content: string }>) => Promise<boolean> =
    options.autoApprove === true
      ? async () => true
      : async () => {
          process.stdout.write('代码方案生成完毕，批准写盘 (y/n): ');
          return confirm('');
        };
  const coder =
    options.agents?.coder ??
    new CoderAgent({
      client,
      model,
      writer: new DiskFileWriter(options.cwd),
      onApproval: codeApproval,
    });
  const reviewer =
    options.agents?.reviewer ??
    new TeamReviewerAgent({
      engine: new ReviewerEngine(
        new SubagentSpawner(client, { cwd: options.cwd }, model),
        options.cwd,
      ),
    });
  const qa =
    options.agents?.qa ?? new QaAgent({ runner: new ChildProcessQaRunner({ cwd: options.cwd }) });

  // 5. 事务 + 对抗性闭环（主任务文件清单取自拆解；超限/失败回滚兜底）
  const snapshots = new SnapshotManager(options.cwd);
  const taskId = `team-${Date.now()}`;
  const mainTask = tasks.find((t) => t.agent === 'coder') ?? tasks[0];
  const files = mainTask?.files ?? [];
  await snapshots.begin(taskId, files);

  const context: AgentContext = {
    sessionId: taskId,
    taskId,
    dependencies: [],
    artifacts: [],
  };
  const loop = await runTeamLoop({
    coder,
    reviewer,
    qa,
    spec: minimalSpec(options.task),
    context,
    onAttempt: (record) => {
      options.traceStore?.record({
        id: `team:loop:${taskId}:${record.attempt}`,
        taskId,
        agentName: 'team-loop',
        messageType: 'task',
        input: { phase: record.phase, attempt: record.attempt },
        startedAt: Date.now(),
        durationMs: 0,
      });
    },
    onRollback: async (reason) => {
      const rb = await snapshots.rollback(taskId);
      process.stderr.write(
        `⚠️ 闭环超限/失败，触发事务回滚（${reason}）：${rb.ok ? '已恢复原状' : `回滚失败（${rb.failed.map((f) => f.error).join('; ')}，快照保留）`}\n`,
      );
    },
  });
  if (loop.ok) {
    await snapshots.commit(taskId);
  }

  // 6. 聚合输出：工件引用（spec/code/review-result/test-report）+ 中文 summary
  const artifacts = loop.context.artifacts;
  const artifactLines = artifacts
    .map(
      (a) =>
        `- [${a.type}] ${a.path ?? a.id}: ${a.content.slice(0, 80)}${a.content.length > 80 ? '…' : ''}`,
    )
    .join('\n');
  process.stdout.write(
    `\n=== 团队执行结果 ===\n\n${loop.summary}\n\n=== 工件 ===\n${artifactLines || '（无工件）'}\n`,
  );

  return { ok: loop.ok, summary: loop.summary, tasks, artifacts, loop };
}
