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
import readline from 'node:readline/promises';
import { promisify } from 'node:util';

import { fmt, t } from '../i18n';
import type { ModelClient } from '../model/client';
import { SnapshotManager } from '../orchestrator/transaction';
import type { CommandRunner, RecoveryChoice } from '../workflow/executor';
import { runWorkflow } from '../workflow/executor';
import { generateWorkflowFromNl } from '../workflow/nl-generator';
import { inferDependencies, parseWorkflowYaml, serializeWorkflowYaml } from '../workflow/parser';
import { getWorkflowTemplate, WORKFLOW_TEMPLATE_NAMES } from '../workflow/templates';
import type { Workflow } from '../workflow/types';

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

/** 加载工作流（文件不存在 / 解析失败返回 undefined）。 */
export function loadWorkflow(cwd: string, name: string): Workflow | undefined {
  try {
    const text = readFileSync(workflowFile(cwd, name), 'utf8');
    return parseWorkflowYaml(text);
  } catch {
    return undefined;
  }
}

/** 保存工作流到项目 workflows 目录（含 name 校验）。 */
export function saveWorkflow(cwd: string, workflow: Workflow): string {
  mkdirSync(workflowsDir(cwd), { recursive: true });
  const file = workflowFile(cwd, workflow.name);
  writeFileSync(file, serializeWorkflowYaml(workflow), 'utf8');
  return file;
}

/** 真实命令执行器（exec 包装，跨平台 shell 语义）。 */
export const defaultRunCommand: CommandRunner = async (command, cwd) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? String(err) };
  }
};

// ── 交互工具 ──────────────────────────────────────────────────

/** 读一行输入（TTY 交互；非 TTY 返回 undefined 由调用方降级）。 */
async function promptLine(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** 失败恢复交互：展示选项并读取 R/S/F/A。非 TTY 或非法输入 → abort（fail-closed）。 */
async function promptRecovery(failedStep: string, error: string): Promise<RecoveryChoice> {
  console.log('');
  console.log(t().workflow.failureHeader);
  console.log(fmt(t().workflow.failureStep, { step: failedStep, error }));
  console.log(t().workflow.failureOptions);
  const answer = await promptLine(t().workflow.failurePrompt);
  const choice = answer?.toLowerCase();
  if (choice === 'r') return 'retry';
  if (choice === 's') return 'skip';
  if (choice === 'f') return 'fix-and-retry';
  return 'abort'; // 非 TTY / 非法输入 → 放弃（安全）
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
    console.log(`  - ${edge.from} → ${edge.to}（${edge.reason}）`);
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
      const workflow = loadWorkflow(cwd, name);
      if (workflow === undefined) {
        console.log(fmt(d.workflowNotFound, { name }));
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
      }
      return result.ok ? 0 : 1;
    }

    case 'export': {
      const name = param;
      if (name === undefined) {
        console.log(d.exportMissing);
        return 1;
      }
      const workflow = loadWorkflow(cwd, name);
      if (workflow === undefined) {
        console.log(fmt(d.workflowNotFound, { name }));
        return 1;
      }
      process.stdout.write(serializeWorkflowYaml(workflow));
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
