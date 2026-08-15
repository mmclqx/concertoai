/**
 * 工作流 CLI 命令（v4.0 M2 T2.5/T2.6）。
 *
 * 命令族：
 * - workflow list                       列出已安装工作流；
 * - workflow init [template]            选模板（或参数指定）生成 .concertoai/workflows/<name>.yml；
 * - workflow run <name>                 执行工作流（进度推送 + 失败恢复 R/S/F/A）；
 * - workflow export <name>              输出 YAML 到 stdout（可重定向到文件）；
 * - workflow import <file>              校验并注册到 .concertoai/workflows/。
 *
 * 存储位置：`.concertoai/workflows/<name>.yml`（项目内，可提交 Git 团队共享）。
 */

import { exec } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { fmt, t } from '../i18n';
import type { ModelClient } from '../model/client';
import { SnapshotManager } from '../orchestrator/transaction';
import { extractErrorSummary } from '../utils/error-summary';
import { truncateMiddle } from '../utils/truncate';
import type { CommandRunner, RecoveryChoice } from '../workflow/executor';
import { runWorkflow } from '../workflow/executor';
import { generateWorkflowFromNl } from '../workflow/nl-generator';
import { inferDependencies, parseWorkflowYaml, serializeWorkflowYaml } from '../workflow/parser';
import {
  type AutoInitAction,
  applyAutoInitWrites,
  checkPrerequisites,
  summarizeAutoInit,
} from '../workflow/preflight';
import { getWorkflowTemplate, WORKFLOW_TEMPLATE_NAMES } from '../workflow/templates';
import type { Workflow } from '../workflow/types';
import { promptLine } from './prompt';

const execAsync = promisify(exec);

/** 工作流存储目录（项目内 `.concertoai/workflows/`）。 */
export function workflowsDir(cwd: string): string {
  return path.join(cwd, '.concertoai', 'workflows');
}

/** 工作流文件路径。 */
function workflowFile(cwd: string, name: string): string {
  return path.join(workflowsDir(cwd), `${name}.yml`);
}

/** 列出已安装工作流名（*.yml）。 */
export function listWorkflows(cwd: string): string[] {
  try {
    return readdirSync(workflowsDir(cwd))
      .filter((f) => f.endsWith('.yml'))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

/** 加载工作流结果（v4.1 发布前修复：区分「文件不存在」与「解析失败」，消除误导）。 */
export type LoadWorkflowResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: 'not-found' | 'parse-error'; message?: string };

/**
 * 加载工作流并区分失败原因（专家建议，2026-08-15 提升到 v4.1）：
 * - 文件不存在（ENOENT）→ { ok: false, reason: 'not-found' }（用户放错位置）
 * - 文件存在但 YAML 解析失败 → { ok: false, reason: 'parse-error', message }（真实报错 + 行号）
 * 此前 catch 吞错误导致「解析失败」显示为「工作流不存在」——误导用户以为文件没放对。
 */
export function loadWorkflowResult(cwd: string, name: string): LoadWorkflowResult {
  let text: string;
  try {
    text = readFileSync(workflowFile(cwd, name), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: 'parse-error', message: `读取失败: ${String(err)}` };
  }
  try {
    return { ok: true, workflow: parseWorkflowYaml(text) };
  } catch (err) {
    return {
      ok: false,
      reason: 'parse-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 加载工作流（文件不存在 / 解析失败返回 undefined，兼容旧调用；新代码优先用 loadWorkflowResult）。 */
export function loadWorkflow(cwd: string, name: string): Workflow | undefined {
  const result = loadWorkflowResult(cwd, name);
  return result.ok ? result.workflow : undefined;
}

/** 保存工作流到项目 workflows 目录（含 name 校验）。 */
export function saveWorkflow(cwd: string, workflow: Workflow): string {
  mkdirSync(workflowsDir(cwd), { recursive: true });
  const file = workflowFile(cwd, workflow.name);
  writeFileSync(file, serializeWorkflowYaml(workflow), 'utf8');
  return file;
}

/** 工作流单步输出各自回填的最大字符数（v4.1 T1.1：防 6 文件完整 diff 淹没提示）。 */
export const MAX_WORKFLOW_OUTPUT_CHARS = 4_000;

/** 真实命令执行器（exec 包装，跨平台 shell 语义；stdout/stderr 超长截断）。 */
export const defaultRunCommand: CommandRunner = async (command, cwd) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    const truncated =
      stdout.length > MAX_WORKFLOW_OUTPUT_CHARS || stderr.length > MAX_WORKFLOW_OUTPUT_CHARS;
    return {
      ok: true,
      stdout: stdout.slice(0, MAX_WORKFLOW_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_WORKFLOW_OUTPUT_CHARS),
      truncated,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = e.stderr ?? e.message ?? String(err);
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: stderr.slice(0, MAX_WORKFLOW_OUTPUT_CHARS),
      truncated: stderr.length > MAX_WORKFLOW_OUTPUT_CHARS,
    };
  }
};

// ── 交互工具 ──────────────────────────────────────────────────

/** 失败详情截断展示上限（v4.1 T1.1：先摘要后截断详情，防完整 diff 淹没）。 */
const MAX_FAILURE_DETAIL_CHARS = 2_000;

/**
 * 失败恢复交互：展示选项并读取 R/S/F/A。非 TTY 或非法输入 → abort（fail-closed）。
 *
 * 展示顺序（v4.1 T1.1）：先一行智能摘要（tsc/biome/npm 关键行），再截断详情——
 * 消除客户评价问题 5（6 文件完整 diff 淹没提示）。
 *
 * F（fix-and-retry）语义：仅重跑失败步骤，不包含 AI 自动修复——用户需先手动
 * 修改代码再按 F。选 F 后进入等待态（v4.1 T1.2，见 promptRecoveryFix）。
 */
export async function promptRecovery(failedStep: string, error: string): Promise<RecoveryChoice> {
  console.log('');
  console.log(t().workflow.failureHeader);
  const summary = extractErrorSummary(error);
  if (summary.line !== '') {
    console.log(fmt(t().workflow.failureSummary, { summary: summary.line }));
  }
  console.log(fmt(t().workflow.failureStep, { step: failedStep }));
  if (error.trim() !== '') {
    console.log(truncateMiddle(error.trim(), MAX_FAILURE_DETAIL_CHARS));
  }
  console.log(t().workflow.failureOptions);
  const answer = await promptLine(t().workflow.failurePrompt);
  const choice = answer?.toLowerCase();
  if (choice === 'r') return 'retry';
  if (choice === 's') return 'skip';
  if (choice === 'f') {
    return promptRecoveryFix(failedStep);
  }
  return 'abort'; // 非 TTY / 非法输入 → 放弃（安全）
}

/**
 * F 选项等待态（v4.1 T1.2，专家建议 1）：用户选 F 后不立即重跑，等待手动修复。
 *
 * 交互：打印提示 → 读取输入（60s 超时）：
 * - Enter / 空 → fix-and-retry（重跑失败步骤）
 * - a → abort（整体回滚，fail-closed）
 * - 其他 → 重新提示
 * - 超时无输入 → abort（防止用户切去编辑器后忘记终端挂起等待）
 * - 非 TTY（promptLine 返回 undefined 且非超时）→ abort（fail-closed）
 */
export async function promptRecoveryFix(failedStep: string): Promise<RecoveryChoice> {
  const d = t().workflow;
  console.log(fmt(d.failureFixWait, { step: failedStep, seconds: FIX_WAIT_TIMEOUT_SECONDS }));
  for (;;) {
    const answer = await promptLine(d.failureFixPrompt, {
      timeoutMs: FIX_WAIT_TIMEOUT_SECONDS * 1000,
    });
    if (answer === undefined) {
      // Ctrl+C / 非 TTY / 超时：fail-closed 放弃（超时自动放弃防挂起，专家建议 1）
      return 'abort';
    }
    const choice = answer.toLowerCase();
    if (choice === '') {
      // Enter 直接回车 → 重试（用户已手动修复完成）
      return 'fix-and-retry';
    }
    if (choice === 'a') {
      return 'abort';
    }
    console.log(d.failureFixInvalid);
  }
}

/** F 等待态超时（秒）：超时无输入自动放弃回滚（专家建议 1）。 */
export const FIX_WAIT_TIMEOUT_SECONDS = 60;

/**
 * 运行前环境预检 + 轻量自动初始化（v4.1 T1.4，客户评价问题 1）。
 *
 * 流程：checkPrerequisites → 无缺失直接通过；有缺失展示报告 →
 * 询问是否自动初始化可修复项（y）→ 展示操作计划 → 二次确认 →
 * 执行安装命令 + 写文件/scripts；拒绝/非 TTY → fail-closed 退出。
 *
 * @returns true = 环境就绪可继续执行；false = 停止（环境未就绪且未初始化）
 */
export async function preflightAndInit(workflow: Workflow, cwd: string): Promise<boolean> {
  const d = t().workflow;
  const preflight = checkPrerequisites(workflow, cwd);
  if (preflight.ok) {
    return true;
  }

  console.log('');
  console.log(fmt(d.preflightMissing, { count: preflight.missing.length }));
  const autoActions: AutoInitAction[] = [];
  for (const m of preflight.missing) {
    if (m.fix === undefined) {
      console.log(fmt(d.preflightItemManual, { name: m.name }));
      continue;
    }
    autoActions.push(m.fix);
    if (m.kind === 'script') {
      console.log(fmt(d.preflightItemScript, { name: m.name }));
    } else if (m.kind === 'dep') {
      console.log(fmt(d.preflightItemDep, { name: m.name }));
    } else {
      console.log(fmt(d.preflightItemConfig, { name: m.name }));
    }
  }

  // 全部不可自动修复（如仅 test 缺失）→ 由用户决定是否继续
  if (autoActions.length === 0) {
    const answer = await promptLine(d.preflightContinue);
    if (answer?.toLowerCase() === 'y' || answer?.toLowerCase() === 'yes') {
      return true;
    }
    return false;
  }

  const ask = await promptLine(d.preflightAskInit);
  if (ask === undefined) {
    // 非 TTY / Ctrl+C → fail-closed：停止执行
    console.log(d.preflightNoTty);
    return false;
  }
  if (ask.toLowerCase() !== 'y' && ask.toLowerCase() !== 'yes') {
    console.log(d.preflightSkipped);
    return true; // 用户显式选择继续（可能失败）
  }

  // 展示初始化计划 + 二次确认（编辑与命令一律审批）
  const plan = summarizeAutoInit(autoActions);
  console.log(d.preflightPlanTitle);
  for (const command of plan.commands) {
    console.log(fmt(d.preflightPlanCmd, { command }));
  }
  for (const file of plan.writes) {
    console.log(fmt(d.preflightPlanWrite, { file }));
  }
  for (const a of plan.unique) {
    if (a.addScript !== undefined) {
      console.log(
        fmt(d.preflightPlanScript, { name: a.addScript.name, command: a.addScript.command }),
      );
    }
  }
  const confirm = await promptLine(d.preflightConfirm);
  if (confirm === undefined || (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes')) {
    console.log(d.preflightSkipped);
    return true;
  }

  // 执行：先安装依赖（真实命令，经上方 y/N 审批），再写文件/scripts
  for (const command of plan.commands) {
    try {
      await execAsync(command, { cwd, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      console.log(
        fmt(d.preflightInitFailed, { error: err instanceof Error ? err.message : String(err) }),
      );
      return false;
    }
  }
  const writeErr = applyAutoInitWrites(plan.unique, cwd);
  if (writeErr !== undefined) {
    console.log(fmt(d.preflightInitFailed, { error: writeErr }));
    return false;
  }
  console.log(d.preflightInitDone);
  return true;
}

/** 审批交互：显示命令 + y/n。非 TTY → 拒绝（fail-closed）。 */
async function promptApproval(command: string): Promise<boolean> {
  console.log('');
  console.log(fmt(t().workflow.approveStep, { command }));
  const answer = await promptLine(t().workflow.approvePrompt);
  return answer?.toLowerCase() === 'y' || answer?.toLowerCase() === 'yes';
}

/**
 * T2.4：推断步骤间依赖并提示用户确认（不静默写入）。
 * 有推断边 → 展示并询问是否添加 depends；无输入/拒绝 → 保持原配置。
 */
export async function confirmInferredDependencies(workflow: Workflow): Promise<Workflow> {
  const d = t().workflow;
  const inferred = inferDependencies(workflow.steps);
  if (inferred.length === 0) {
    return workflow;
  }
  console.log('');
  console.log(d.inferFound);
  for (const edge of inferred) {
    // 语义：from 依赖 to（InferredDependency 注释）。用「依赖」替代箭头，避免箭头被误读为执行顺序
    console.log(`  - ${edge.from} 依赖 ${edge.to}（${edge.reason}）`);
  }
  const answer = await promptLine(d.inferPrompt);
  if (answer?.toLowerCase() !== 'y' && answer?.toLowerCase() !== 'yes') {
    console.log(d.inferSkipped);
    return workflow;
  }
  const steps = workflow.steps.map((step) => {
    const deps = inferred.filter((e) => e.from === step.name).map((e) => e.to);
    if (deps.length === 0) {
      return step;
    }
    const existing = new Set(step.depends ?? []);
    for (const dep of deps) {
      existing.add(dep);
    }
    return { ...step, depends: [...existing] };
  });
  return { ...workflow, steps };
}

// ── 命令实现 ──────────────────────────────────────────────────

export interface WorkflowCliOptions {
  cwd: string;
  action: string;
  arg?: string;
  /** init 模板名 / run 工作流名 / import 文件路径。 */
  param?: string;
  /** NL 生成（workflow create 需要模型；未提供 → 提示手动编写）。 */
  client?: ModelClient;
  model?: string;
}

/** 执行 workflow 命令族（返回 0 成功 / 1 失败，供 cli/index.ts 退出码）。 */
export async function runWorkflowCli(options: WorkflowCliOptions): Promise<number> {
  const { cwd, action, param, client, model } = options;
  const d = t().workflow;

  switch (action) {
    case 'list': {
      const names = listWorkflows(cwd);
      if (names.length === 0) {
        console.log(d.listEmpty);
        console.log(`  ${d.listHint}`);
        return 0;
      }
      console.log(fmt(d.listHeader, { count: names.length }));
      for (const name of names) {
        const wf = loadWorkflow(cwd, name);
        const desc = wf?.description !== undefined ? ` — ${wf.description}` : '';
        console.log(`- **${name}**${desc}`);
      }
      return 0;
    }

    case 'init': {
      // 参数指定模板：`workflow init release`
      let templateName = param;
      if (templateName === undefined) {
        console.log(d.initPrompt);
        WORKFLOW_TEMPLATE_NAMES.forEach((name, i) => {
          const tpl = getWorkflowTemplate(name);
          console.log(`  ${i + 1}. ${name} — ${tpl?.description ?? ''}`);
        });
        const answer = await promptLine(d.initChoice);
        if (answer === undefined) {
          console.log(d.initAborted);
          return 1;
        }
        const idx = Number(answer) - 1;
        templateName =
          WORKFLOW_TEMPLATE_NAMES[idx] ??
          (WORKFLOW_TEMPLATE_NAMES.includes(answer) ? answer : undefined);
      }
      const template = templateName === undefined ? undefined : getWorkflowTemplate(templateName);
      if (template === undefined) {
        console.log(fmt(d.initUnknown, { name: templateName ?? '' }));
        return 1;
      }
      // T2.4：推断依赖并提示确认（模板通常已显式声明，此处主要为 create 链路复用）
      const confirmed = await confirmInferredDependencies(template);
      const file = saveWorkflow(cwd, confirmed);
      console.log(fmt(d.initDone, { name: confirmed.name, file }));
      return 0;
    }

    case 'run': {
      const name = param;
      if (name === undefined) {
        console.log(d.runMissing);
        return 1;
      }
      const loaded = loadWorkflowResult(cwd, name);
      if (!loaded.ok) {
        // v4.1 发布前修复：区分「文件不存在」与「解析失败」，解析失败展示真实错误（含行号）
        if (loaded.reason === 'parse-error') {
          console.log(fmt(d.workflowParseError, { name, message: loaded.message ?? '' }));
        } else {
          console.log(fmt(d.workflowNotFound, { name }));
        }
        return 1;
      }
      const workflow = loaded.workflow;
      // v4.1 T1.4：运行前环境预检（缺失脚本/依赖/配置 → 可自动初始化）
      const ready = await preflightAndInit(workflow, cwd);
      if (!ready) {
        return 1;
      }
      console.log(fmt(d.runStart, { name, steps: workflow.steps.length }));
      const result = await runWorkflow(workflow, {
        cwd,
        runCommand: defaultRunCommand,
        requestApproval: async (step) => promptApproval(step.run),
        onProgress: (p) => {
          if (p.stepName === '') {
            return;
          }
          const marker = p.state === 'waiting-approval' ? '⏸' : '▎';
          console.log(
            `${marker} ${fmt(d.runProgress, { current: p.done + 1, total: p.total, step: p.stepName })}`,
          );
        },
        onFailure: (info) => promptRecovery(info.failedStep, info.error),
        snapshots: new SnapshotManager(cwd),
        log: (msg) => console.log(msg),
      });
      console.log('');
      if (result.ok) {
        console.log(`✅ ${fmt(d.runOk, { name })}`);
      } else {
        console.log(
          `❌ ${fmt(d.runFailed, { name, step: result.failedStep ?? '?', skipped: result.skipped.length })}`,
        );
        // v4.1 T2.1：失败后「下一步」行动指引（用户反馈 1：出错不知道怎么办）
        console.log(fmt(d.runFailedNext, { name }));
      }
      return result.ok ? 0 : 1;
    }

    case 'export': {
      const name = param;
      if (name === undefined) {
        console.log(d.exportMissing);
        return 1;
      }
      const loaded = loadWorkflowResult(cwd, name);
      if (!loaded.ok) {
        // v4.1 发布前修复：export 同样区分失败原因（与 run 分支一致）
        if (loaded.reason === 'parse-error') {
          console.log(fmt(d.workflowParseError, { name, message: loaded.message ?? '' }));
        } else {
          console.log(fmt(d.workflowNotFound, { name }));
        }
        return 1;
      }
      process.stdout.write(serializeWorkflowYaml(loaded.workflow));
      return 0;
    }

    case 'import': {
      const file = param;
      if (file === undefined) {
        console.log(d.importMissing);
        return 1;
      }
      try {
        const text = readFileSync(file, 'utf8');
        const workflow = parseWorkflowYaml(text);
        const dest = saveWorkflow(cwd, workflow);
        console.log(fmt(d.importDone, { name: workflow.name, file: dest }));
        return 0;
      } catch (err) {
        console.log(
          fmt(d.importFailed, { error: err instanceof Error ? err.message : String(err) }),
        );
        return 1;
      }
    }

    case 'create': {
      // 自然语言 → 工作流（T2.2）：生成后展示确认，再落盘
      const description = param;
      if (description === undefined) {
        console.log(d.createMissing);
        return 1;
      }
      const result = await generateWorkflowFromNl(description, { client, model });
      if (result.workflow === undefined) {
        console.log(`❌ ${result.error ?? d.createFailed}`);
        return 1;
      }
      const wf = result.workflow;
      console.log(d.createPreview);
      process.stdout.write(serializeWorkflowYaml(wf));
      const answer = await promptLine(d.createConfirm);
      if (answer?.toLowerCase() === 'y' || answer?.toLowerCase() === 'yes') {
        // T2.4：推断依赖并提示确认（不静默写入）
        const confirmed = await confirmInferredDependencies(wf);
        const file = saveWorkflow(cwd, confirmed);
        console.log(fmt(d.createDone, { name: confirmed.name, file }));
        return 0;
      }
      console.log(d.createAborted);
      return 0;
    }

    default:
      console.log(d.usage);
      return 1;
  }
}
