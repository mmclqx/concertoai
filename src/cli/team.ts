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
  type CoderFileWriter,
  DiskFileWriter,
  decomposeRequirement,
  OrchestratorDecomposeError,
  type OrchestratorTask,
  QaAgent,
  TeamReviewerAgent,
} from '../agents';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
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
import {
  detectParallelIntent,
  MAX_LOOP_ATTEMPTS,
  type ParallelRunResult,
  runParallelTeams,
  runTeamLoop,
  SnapshotManager,
} from '../orchestrator';
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
  /** 并行模式（v4.0 M5）：显式 --parallel，或由拆解前自然语言意图自动触发。 */
  parallel?: boolean;
  /**
   * 静默模式（v4.0 M5 收尾，P5）：作为库被 /orchestrate（chat 内）调用时置 true，
   * 抑制所有 process.stdout/stderr 直写（拆解清单/结果/回滚告警），避免污染 TUI；
   * 进度与汇总改由 onProgress 回调 + 返回值承载。CLI 入口保持 false（缺省）。
   */
  silent?: boolean;
  /** CLI --lang。 */
  lang?: string;
  /** 模型客户端（测试注入；缺省 DeepSeekClient）。 */
  client?: ModelClient;
  /** 终端确认回调（测试注入；缺省 readline y/n）。 */
  confirm?: (prompt: string) => Promise<boolean>;
  /** 团队 Agent 注入（测试；缺省装配真实 4 角色；coder 缺省装配真实 CoderAgent + 事务 writer）。 */
  agents?: { coder?: CoderLike; reviewer?: ReviewerLike; qa?: QaLike };
  /** 可观测性调用链（可选；拆解/闭环阶段记录 spans）。 */
  traceStore?: TraceStore;
  /** 进度回调（v3.2 M4 / T4.1：拆解完成 / 每轮闭环 / 结束，供 CLI stdout 与聊天消息流）。 */
  onProgress?: (progress: TeamProgress) => void;
}

/** team 执行进度（v3.2 M4 / T4.1：长任务中间消息推送，避免黑盒等待）。 */
export type TeamProgress =
  | { kind: 'decomposed'; taskCount: number }
  | {
      kind: 'loop-attempt';
      attempt: number;
      total: number;
      phase: 'implement' | 'review' | 'qa';
      /** 并行模式（v4.0 M5）：所属任务 id（串行模式缺省）。 */
      taskId?: string;
    }
  | { kind: 'parallel-task'; taskId: string; ok: boolean }
  | { kind: 'done'; ok: boolean };

/** 进度中文文案（CLI stdout 与 /orchestrate 聊天消息流共用）。 */
export function formatTeamProgress(p: TeamProgress): string {
  switch (p.kind) {
    case 'decomposed':
      return `📋 已拆解 ${p.taskCount} 个任务`;
    case 'loop-attempt': {
      const phaseLabel = p.phase === 'implement' ? '实现' : p.phase === 'review' ? '审查' : '验证';
      const taskPrefix =
        p.taskId !== undefined ? fmt(t().team.parallel.taskPrefix, { taskId: p.taskId }) : '';
      return `🔁 ${taskPrefix}第 ${p.attempt}/${p.total} 轮（${phaseLabel}）`;
    }
    case 'parallel-task':
      return fmt(p.ok ? t().team.parallel.taskDone : t().team.parallel.taskFailed, {
        taskId: p.taskId,
      });
    case 'done':
      return p.ok ? '✅ 团队执行完成' : '❌ 团队执行未成功';
  }
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
  /** 并行执行结果（v4.0 M5；并行模式时存在）。 */
  parallel?: ParallelRunResult;
  /** 拆解失败诊断（v3.2 M3 / T3.3；仅 ok=false 且失败发生在拆解阶段时存在）。 */
  diagnostics?: TeamCommandDiagnostics;
}

/** 需求拆解失败诊断（v3.2 M3 / T3.3：区分「格式解析失败」vs「网络超时」，记录原始输出）。 */
export interface TeamCommandDiagnostics {
  /** 失败类型：parse（模型输出格式/结构不符） / network（模型调用失败） / other。 */
  kind: 'parse' | 'network' | 'other';
  /** 模型原始输出（截断 ≤500 字符；parse 时存在）。 */
  rawOutput?: string;
  /** 错误消息（截断 ≤500 字符）。 */
  message: string;
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
  // P5 收尾：库调用（/orchestrate）静默——stdout/stderr 直写统一走 write/stderrWrite，
  // silent=true 时全部抑制，改由 onProgress + 返回值承载（CLI 入口保持直写）
  const silent = options.silent === true;
  const write = (s: string): void => {
    if (!silent) {
      process.stdout.write(s);
    }
  };
  const stderrWrite = (s: string): void => {
    if (!silent) {
      process.stderr.write(s);
    }
  };

  // 1. 拆解（模型输出 Task[]；失败给中文错误 + diagnostics，不静默产出空清单）
  let tasks: OrchestratorTask[];
  try {
    tasks = await decomposeRequirement(client, model, options.task);
  } catch (err) {
    // T3.3：OrchestratorDecomposeError 区分 parse/network（携带原始输出截断 ≤500）；
    // 其余异常归为 other，避免丢失可定位信息
    if (err instanceof OrchestratorDecomposeError) {
      return {
        ok: false,
        summary: err.message,
        tasks: [],
        artifacts: [],
        diagnostics: { kind: err.kind, rawOutput: err.raw, message: err.message.slice(0, 500) },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: `需求拆解失败: ${message}`,
      tasks: [],
      artifacts: [],
      diagnostics: { kind: 'other', message: message.slice(0, 500) },
    };
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

  // T4.1：拆解完成 → 推送进度（CLI stdout / 聊天消息流）
  options.onProgress?.({ kind: 'decomposed', taskCount: tasks.length });

  // 2. dry-run：仅输出拆解清单并退出，不执行任何 Agent
  if (options.dryRun === true) {
    options.onProgress?.({ kind: 'done', ok: true });
    write(`=== 任务拆解（dry-run，未执行）===\n\n${formatTaskList(tasks)}\n`);
    return { ok: true, summary: 'dry-run：仅输出拆解清单，未执行任何 Agent', tasks, artifacts: [] };
  }

  // 3. 审批：拆解清单先展示，用户确认后执行（与 plan 模式一致）
  const confirm = options.confirm ?? defaultConfirm;
  if (options.autoApprove !== true) {
    if (process.stdin.isTTY !== true) {
      stderrWrite('❌ team 命令需要交互式终端确认拆解方案；非交互请加 --auto-approve。\n');
      process.exit(1);
    }
    write(`=== 任务拆解 ===\n\n${formatTaskList(tasks)}\n\n`);
    const approved = await confirm('批准该方案并开始执行 (y/n): ');
    if (!approved) {
      options.onProgress?.({ kind: 'done', ok: false });
      write('用户未确认拆解方案，已取消（未执行任何 Agent）。\n');
      return { ok: false, summary: '用户未确认拆解方案，已取消', tasks, artifacts: [] };
    }
  }

  // 4. 装配团队 Agent（缺省 4 角色；测试可注入 fake）
  const codeApproval: (files: Array<{ path: string; content: string }>) => Promise<boolean> =
    options.autoApprove === true
      ? async () => true
      : async () => {
          write('代码方案生成完毕，批准写盘 (y/n): ');
          return confirm('');
        };
  // 事务上下文先于 coder 装配创建（T6.5：写盘必须登记快照，回滚保护不依赖预登记清单）
  const snapshots = new SnapshotManager(options.cwd);
  const taskId = `team-${Date.now()}`;
  // 事务感知 writer：写盘前 registerWrite 动态登记快照（begin 只预登记拆解清单，
  // Agent 实际写盘路径可能超出清单——未登记的文件 rollback 时会被判「外部修改」拒绝覆盖）
  const baseWriter = new DiskFileWriter(options.cwd);
  const txnWriter: CoderFileWriter = {
    async write(relPath: string, content: string): Promise<void> {
      await snapshots.registerWrite(taskId, relPath, content);
      await baseWriter.write(relPath, content);
    },
  };
  const coder =
    options.agents?.coder ??
    new CoderAgent({
      client,
      model,
      writer: txnWriter,
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

  // 5. 并行模式（v4.0 M5）：显式 --parallel 或自然语言并行意图 → runParallelTeams
  const parallelMode = options.parallel === true || detectParallelIntent(options.task);
  if (parallelMode) {
    // 并行子任务 = 全部 coder 任务（无 coder 任务时兜底全部任务，与串行 mainTask 逻辑一致）
    const coderTasks = tasks.filter((t) => t.agent === 'coder');
    const parallelTasks = coderTasks.length > 0 ? coderTasks : tasks;
    // 每任务独立事务快照（预登记文件清单；实际写盘由 txnWriter 动态登记）
    for (const task of parallelTasks) {
      await snapshots.begin(task.id, task.files ?? []);
    }
    const parallelResult = await runParallelTeams({
      tasks: parallelTasks,
      coder,
      reviewer,
      qa,
      onTaskProgress: (taskId, record) => {
        options.traceStore?.record({
          id: `team:parallel:${taskId}:${record.attempt}`,
          taskId,
          agentName: 'team-parallel',
          messageType: 'task',
          input: { phase: record.phase, attempt: record.attempt },
          startedAt: Date.now(),
          durationMs: 0,
        });
        options.onProgress?.({
          kind: 'loop-attempt',
          taskId,
          attempt: record.attempt,
          total: MAX_LOOP_ATTEMPTS,
          phase: record.phase,
        });
      },
      onRollback: async (rollbackTaskId, reason) => {
        const rb = await snapshots.rollback(rollbackTaskId);
        stderrWrite(
          `⚠️ 任务 ${rollbackTaskId} 闭环超限/失败，触发事务回滚（${reason}）：${
            rb.ok
              ? '已恢复原状'
              : `回滚失败（${rb.failed.map((f) => f.error).join('; ')}，快照保留）`
          }\n`,
        );
      },
    });
    // 成功任务提交快照；失败任务已由 onRollback 回滚
    for (const [taskId, result] of parallelResult.results) {
      if (result.ok) {
        await snapshots.commit(taskId);
      }
      options.onProgress?.({ kind: 'parallel-task', taskId, ok: result.ok });
    }
    options.onProgress?.({ kind: 'done', ok: parallelResult.ok });

    // 聚合输出：全部任务工件 + 并行汇总（含冲突提示）
    const artifacts = [...parallelResult.results.values()].flatMap((r) => r.context.artifacts);
    const artifactLines = artifacts
      .map(
        (a) =>
          `- [${a.type}] ${a.path ?? a.id}: ${a.content.slice(0, 80)}${a.content.length > 80 ? '…' : ''}`,
      )
      .join('\n');
    write(
      `\n=== 并行团队执行结果 ===\n\n${parallelResult.summary}\n\n=== 工件 ===\n${artifactLines || '（无工件）'}\n`,
    );
    return {
      ok: parallelResult.ok,
      summary: parallelResult.summary,
      tasks,
      artifacts,
      parallel: parallelResult,
    };
  }

  // 6. 事务 + 对抗性闭环（主任务文件清单取自拆解；超限/失败回滚兜底）
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
      // T4.1：每轮闭环 → 推送进度（实现/审查/验证）
      options.onProgress?.({
        kind: 'loop-attempt',
        attempt: record.attempt,
        total: MAX_LOOP_ATTEMPTS,
        phase: record.phase,
      });
    },
    onRollback: async (reason) => {
      const rb = await snapshots.rollback(taskId);
      stderrWrite(
        `⚠️ 闭环超限/失败，触发事务回滚（${reason}）：${rb.ok ? '已恢复原状' : `回滚失败（${rb.failed.map((f) => f.error).join('; ')}，快照保留）`}\n`,
      );
    },
  });
  if (loop.ok) {
    await snapshots.commit(taskId);
  }

  // 6. 聚合输出：工件引用（spec/code/review-result/test-report）+ 中文 summary
  // T4.1：闭环结束 → 推送 done（聚合输出前，消息流可感知收尾）
  options.onProgress?.({ kind: 'done', ok: loop.ok });
  const artifacts = loop.context.artifacts;
  const artifactLines = artifacts
    .map(
      (a) =>
        `- [${a.type}] ${a.path ?? a.id}: ${a.content.slice(0, 80)}${a.content.length > 80 ? '…' : ''}`,
    )
    .join('\n');
  write(
    `\n=== 团队执行结果 ===\n\n${loop.summary}\n\n=== 工件 ===\n${artifactLines || '（无工件）'}\n`,
  );

  return { ok: loop.ok, summary: loop.summary, tasks, artifacts, loop };
}
