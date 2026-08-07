/**
 * run 命令：一次性非交互执行任务。
 *
 * 安全基线：默认 fail-closed——编辑/命令全部被拒（审批回调未配置）；
 * 显式传 --auto-approve 才会自动批准。
 */

import { fmt, zh } from '../i18n/zh';
import { runLoop } from '../loop/loop';
import type { ChatMessage } from '../loop/types';
import { DeepSeekClient } from '../model/client';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import type { ToolContext } from '../tools/registry';
import { buildRegistry, DEFAULT_ALLOWLIST, resolveModel } from './chat';

export interface RunTaskOptions {
  cwd: string;
  apiKey: string;
  task: string;
  model?: string;
  resume?: string;
  autoApprove?: boolean;
}

export async function runTask(options: RunTaskOptions): Promise<void> {
  const model = resolveModel(options.model);
  const client = new DeepSeekClient({ apiKey: options.apiKey });
  const registry = buildRegistry();
  const rules = await loadProjectRules(options.cwd);
  const store = new SessionStore();
  const ctx: ToolContext = {
    cwd: options.cwd,
    allowlistedPrefixes: DEFAULT_ALLOWLIST,
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

  const messages = await runLoop(
    {
      model,
      client,
      registry,
      ctx,
      systemPrompt: rules.text === '' ? undefined : rules.text,
      onEvent: (event) => {
        if (event.type === 'chunk') {
          process.stdout.write(event.text);
        }
      },
    },
    history,
    options.task,
  );

  const added = messages.slice(history.length);
  await store.appendAll(sessionId, added);
  process.stdout.write(`\n\n${fmt(zh.session.saved, { id: sessionId })}\n`);
}
