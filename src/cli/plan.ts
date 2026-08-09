/**
 * plan 命令：先生成执行计划，批准后自动执行。
 *
 * 优化 v1.1：适配 runLoop 新返回结构 RunLoopResult；计划阶段 interrupted 时提前退出，
 * 执行阶段 interrupted 时输出警告但仍存档已累积结果。
 *
 * 流程：
 * 1. 计划阶段：注入「输出分步计划」提示词，模型只输出计划文本（不执行工具）；
 * 2. 展示计划，等待用户批准（y/n，需交互式终端；--auto-approve 跳过）；
 * 3. 执行阶段：把已批准计划注入上下文，按原始任务继续 runLoop（工具审批照旧）。
 */

import { createInterface } from 'node:readline';

import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { runLoop } from '../loop/loop';
import { userMessage } from '../loop/messages';
import type { ChatMessage } from '../loop/types';
import { DeepSeekClient } from '../model/client';
import { getModel } from '../model/models';
import { preloadTokenizer } from '../model/tokenizer';
import { loadConfig, resolveConfig } from '../store/config';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import type { ToolContext } from '../tools/registry';
import { buildRegistry, DEFAULT_ALLOWLIST, resolveModel } from './chat';

export interface RunPlanOptions {
  cwd: string;
  apiKey: string;
  task: string;
  model?: string;
  resume?: string;
  autoApprove?: boolean;
  /** CLI --lang（覆盖环境变量与配置）。 */
  lang?: string;
}

/** 终端确认：批准计划 (y/n)。 */
function confirmPlan(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('批准计划并开始执行 (y/n): ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function runPlan(options: RunPlanOptions): Promise<void> {
  if (options.autoApprove !== true && process.stdin.isTTY !== true) {
    console.error(t().errors.planNeedsTty);
    process.exit(1);
  }

  // 配置：CLI > 环境变量 > 配置文件 > 默认值
  const config = await loadConfig();
  const resolved = resolveConfig(config, options.model, options.lang);
  setLocale(resolveLocale(resolved.locale));
  const model = resolveModel(resolved.model);
  const client = new DeepSeekClient({ apiKey: options.apiKey });
  const registry = buildRegistry();
  const rules = await loadProjectRules(options.cwd);
  const store = new SessionStore(resolved.sessionDir);

  // 性能优化：后台预加载 tokenizer（WASM ~100ms），降低首轮计数延迟；
  // IO 边界后 setImmediate 执行，不阻塞当前流程。
  preloadTokenizer();

  const ctx: ToolContext = {
    cwd: options.cwd,
    allowlistedPrefixes: resolved.allowlist ?? DEFAULT_ALLOWLIST,
    requestApproval: options.autoApprove === true ? async () => true : undefined,
  };

  let sessionId: string;
  let history: ChatMessage[] = [];
  if (options.resume !== undefined) {
    const { messages } = await store.read(options.resume);
    history = messages;
    sessionId = options.resume;
  } else {
    sessionId = await store.create([]);
  }

  const baseLoopOptions = {
    model,
    client,
    registry,
    ctx,
    systemPrompt: rules.text === '' ? undefined : rules.text,
    contextWindow: getModel(model)?.contextWindow,
  };

  // 阶段 1：计划
  const baseHistory = history;
  const planPrompt = `请为任务「${options.task}」输出分步执行计划。\n格式：markdown 列表，每一步一行，说明要执行的操作（读取文件 / 编辑文件 / 运行命令）。\n只输出计划本身，不要调用任何工具。`;
  const planResult = await runLoop({ ...baseLoopOptions }, baseHistory, planPrompt);
  const plan = planResult.messages.at(-1)?.content ?? '';
  if (planResult.interrupted) {
    process.stderr.write(`\n${t().errors.loopMaxTurns}\n`);
    return;
  }
  history = planResult.messages;
  await store.appendAll(sessionId, planResult.messages.slice(baseHistory.length));

  // 展示计划
  process.stdout.write(`\n${plan}\n\n`);

  // 阶段 2：批准
  const approved = options.autoApprove === true ? true : await confirmPlan();
  if (!approved) {
    process.stdout.write(`${t().plan.rejected}\n`);
    return;
  }
  process.stdout.write(`${t().plan.approved}\n`);

  // 阶段 3：执行（计划注入上下文）
  const execHistory = [...history, userMessage(`已批准的计划（请严格按计划逐步执行）：\n${plan}`)];
  const { messages: execMessages, interrupted: execInterrupted } = await runLoop(
    { ...baseLoopOptions },
    execHistory,
    options.task,
  );
  if (execInterrupted) {
    process.stderr.write(`\n${t().errors.loopMaxTurns}\n`);
  }
  const added = execMessages.slice(history.length);
  await store.appendAll(sessionId, added);
  process.stdout.write(`\n\n${fmt(t().session.saved, { id: sessionId })}\n`);
}
