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
import { DeepSeekClient } from '../model/client';
import { getModel } from '../model/models';
import { preloadTokenizer } from '../model/tokenizer';
import { loadConfig, resolveConfig } from '../store/config';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import type { ToolContext } from '../tools/registry';
import { createSpawnSubagentTool } from '../tools/spawn';
import { buildOsHint, buildRegistry, DEFAULT_ALLOWLIST, resolveModel } from './chat';

export interface RunTaskOptions {
  cwd: string;
  apiKey: string;
  task: string;
  model?: string;
  resume?: string;
  autoApprove?: boolean;
  /** CLI --lang（覆盖环境变量与配置）。 */
  lang?: string;
}

export async function runTask(options: RunTaskOptions): Promise<void> {
  // 配置：CLI > 环境变量 > 配置文件 > 默认值
  const config = await loadConfig();
  const resolved = resolveConfig(config, options.model, options.lang);
  setLocale(resolveLocale(resolved.locale));
  const model = resolveModel(resolved.model);
  const client = new DeepSeekClient({ apiKey: options.apiKey });

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

  const { messages, interrupted } = await runLoop(
    {
      model,
      client,
      registry,
      ctx,
      systemPrompt:
        [buildOsHint(), rules.text !== '' ? rules.text : undefined].filter(Boolean).join('\n\n') ||
        undefined,
      contextWindow: getModel(model)?.contextWindow,
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
    process.stderr.write(`\n${t().errors.loopMaxTurns}\n`);
  }

  const added = messages.slice(history.length);
  await store.appendAll(sessionId, added);
  process.stdout.write(`\n\n${fmt(t().session.saved, { id: sessionId })}\n`);
}
