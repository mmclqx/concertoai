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
import { getModel } from '../model/models';
import { preloadTokenizer } from '../model/tokenizer';
import { loadConfig, resolveConfig } from '../store/config';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import type { ToolContext } from '../tools/registry';
// v2.1 性能优化：从轻量 common 模块导入，避免加载 chat.tsx 的 TUI 依赖树
import { buildRegistry, DEFAULT_ALLOWLIST } from './common';
import { buildClientForProvider, resolveRuntimeProvider } from './provider-runtime';

export interface RunPlanOptions {
  cwd: string;
  apiKey: string;
  task: string;
  model?: string;
  resume?: string;
  autoApprove?: boolean;
  /** CLI --lang（覆盖环境变量与配置）。 */
  lang?: string;
  /** CLI --provider（v4.0 M3 T3.1）：临时切换 Provider（本次进程生效，不写 config）。 */
  provider?: string;
  /**
   * CLI `-t/--max-turns`（v5.0 架构修正）：本次生效的工具循环轮数上限。
   * 优先级：本参数 > `config.maxTurns` > `MAX_LOOP_TURNS`（50）——合并逻辑在 `resolveConfig`。
   */
  maxTurns?: number;
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
  // -t/--max-turns：CLI > config.maxTurns > 默认 50（优先级只在 resolveConfig 实现一处）
  const resolved = resolveConfig(config, options.model, options.lang, options.maxTurns);
  setLocale(resolveLocale(resolved.locale));
  // v4.0 M3 T3.1：--provider 临时切换 / config defaultProvider 持久化 → 解析运行时 Provider
  const runtime = await resolveRuntimeProvider(config, {
    provider: options.provider,
    model: options.model,
    apiKey: options.apiKey,
  });
  const model = runtime.model;
  const client = buildClientForProvider(runtime);
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
    // 计划阶段与执行阶段共用同一上限（-t / config.maxTurns / 默认 50 解析后的最终值）
    maxTurns: resolved.maxTurns,
  };

  // 阶段 1：计划
  const baseHistory = history;
  const planPrompt = `请为任务「${options.task}」输出分步执行计划。\n格式：markdown 列表，每一步一行，说明要执行的操作（读取文件 / 编辑文件 / 运行命令）。\n只输出计划本身，不要调用任何工具。`;
  const planResult = await runLoop({ ...baseLoopOptions }, baseHistory, planPrompt);
  const plan = planResult.messages.at(-1)?.content ?? '';
  if (planResult.interrupted) {
    process.stderr.write(
      `\n${fmt(t().errors.loopMaxTurnsTemplate, { turns: resolved.maxTurns })}\n`,
    );
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
    process.stderr.write(
      `\n${fmt(t().errors.loopMaxTurnsTemplate, { turns: resolved.maxTurns })}\n`,
    );
  }
  const added = execMessages.slice(history.length);
  await store.appendAll(sessionId, added);
  process.stdout.write(`\n\n${fmt(t().session.saved, { id: sessionId })}\n`);
}
