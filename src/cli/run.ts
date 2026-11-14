/**
 * run 命令：一次性非交互执行任务。
 *
 * 优化 v1.1：适配 runLoop 新返回结构 RunLoopResult，interrupted 时输出警告到 stderr 并继续存档。
 *
 * 安全基线：默认 fail-closed——编辑/命令全部被拒（审批回调未配置）；
 * 显式传 --auto-approve 才会自动批准。
 */

import { registerBuiltinSubagents } from '../agent/builtin';
import { SubagentSpawner } from '../agent/spawner';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { runLoop } from '../loop/loop';
import type { ChatMessage } from '../loop/types';
import { getModel } from '../model/models';
import { preloadTokenizer } from '../model/tokenizer';
import { loadConfig, resolveConfig } from '../store/config';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import type { ToolContext } from '../tools/registry';
import { createSpawnSubagentTool } from '../tools/spawn';
// v2.1 性能优化：从轻量 common 模块导入，避免加载 chat.tsx 的 TUI 依赖树
import { buildOsHint, buildRegistry, DEFAULT_ALLOWLIST } from './common';
import { consumeHandoff, type ExitReason, finalizeSession, sessionHasToolCalls } from './handoff';
import { buildClientForProvider, resolveRuntimeProvider } from './provider-runtime';

export interface RunTaskOptions {
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

export async function runTask(options: RunTaskOptions): Promise<void> {
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

  // v2.0 子代理系统
  // v2.1 M1：run 模式暂不接入 MCP（子代理仅内置工具）
  const spawner = new SubagentSpawner(client, { cwd: options.cwd }, model);
  registerBuiltinSubagents(spawner);
  const spawnTool = createSpawnSubagentTool(spawner);

  const registry = buildRegistry(undefined, spawnTool);
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

  // v5.3 N4 消费端：上次退出留下交接单就先读出来（打印一行 + 注入上下文）。
  // 读取规则全在 `consumeHandoff` 一处实现，入口层不重写一遍（同 T11「优先级只在一处」）。
  const handoff = consumeHandoff(options.cwd, new Date());
  if (handoff.notice !== undefined) {
    process.stdout.write(`${handoff.notice}\n`);
  }

  const { messages, interrupted } = await runLoop(
    {
      model,
      client,
      registry,
      ctx,
      systemPrompt:
        [buildOsHint(), rules.text !== '' ? rules.text : undefined, handoff.inject]
          .filter(Boolean)
          .join('\n\n') || undefined,
      contextWindow: getModel(model)?.contextWindow,
      maxTurns: resolved.maxTurns,
      onEvent: (event) => {
        if (event.type === 'chunk') {
          process.stdout.write(event.text);
        }
      },
    },
    history,
    options.task,
  );

  if (interrupted) {
    // 提示里的轮数用**本次真实生效**的上限（可能是 -t / config.maxTurns 传入的值）
    process.stderr.write(
      `\n${fmt(t().errors.loopMaxTurnsTemplate, { turns: resolved.maxTurns })}\n`,
    );
  }

  const added = messages.slice(history.length);
  await store.appendAll(sessionId, added);

  /**
   * v5.3 N4 出口 ①/②：`run` 是一次性进程，跑完即退出 ⇒ 这里就是「真退出」，
   * 用 `terminal: true`（与 chat 的 Ctrl+C / 崩溃共用同一条写盘路径，格式不会漂）。
   *
   * 「正常收尾」仍要求**本会话有工具调用**：只问了一句就跑的 `run` 不该留交接单
   * （否则用户每次 `concertoai run "解释一下这个函数"` 都多一份）。
   */
  const reason: ExitReason = interrupted
    ? { kind: 'max-turns', used: resolved.maxTurns, cap: resolved.maxTurns }
    : { kind: 'completed' };
  if (interrupted || sessionHasToolCalls(messages)) {
    const saved = finalizeSession(
      messages,
      reason,
      { cwd: options.cwd, sessionId, now: new Date() },
      { terminal: true },
    );
    if (saved !== undefined) {
      // 落点 B（~/.concertoai/）用户不容易发现 ⇒ **必须打印完整路径**，只写不报等于没写
      process.stdout.write(`📋 交接单已写入：${saved}\n`);
    }
  }

  process.stdout.write(`\n\n${fmt(t().session.saved, { id: sessionId })}\n`);
}
