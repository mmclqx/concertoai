/**
 * chat 命令装配：TUI + loop + store 组装。
 */

import { render } from 'ink';
import { fmt, zh } from '../i18n/zh';
import type { ChatMessage } from '../loop/types';
import { DeepSeekClient } from '../model/client';
import { getDefaultModel, getModel, listModels } from '../model/models';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import { editFileTool } from '../tools/edit';
import { listDirectoryTool, readFileTool, searchContentTool } from '../tools/read';
import type { ToolContext } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { shellTool } from '../tools/shell';
import { App } from '../ui/App';

/** 免审批直跑的安全命令白名单（用户可后续配置化）。 */
export const DEFAULT_ALLOWLIST = ['git status', 'git diff', 'npm test', 'npm run test'];

export function resolveModel(modelId: string | undefined): string {
  if (modelId === undefined) {
    return getDefaultModel().id;
  }
  const profile = getModel(modelId);
  if (profile === undefined) {
    console.error(
      `未知模型: ${modelId}（可用: ${listModels()
        .map((m) => m.id)
        .join(', ')}）`,
    );
    process.exit(1);
  }
  return profile.id;
}

export function buildRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(searchContentTool)
    .register(editFileTool)
    .register(shellTool);
}

export interface RunChatOptions {
  cwd: string;
  apiKey: string;
  model?: string;
  resume?: string;
}

export async function runChat(options: RunChatOptions): Promise<void> {
  if (process.stdin.isTTY !== true) {
    console.error(zh.errors.noTty);
    process.exit(1);
  }
  const model = resolveModel(options.model);
  const client = new DeepSeekClient({ apiKey: options.apiKey });
  const registry = buildRegistry();
  const rules = await loadProjectRules(options.cwd);
  const store = new SessionStore();
  const ctx: ToolContext = { cwd: options.cwd, allowlistedPrefixes: DEFAULT_ALLOWLIST };

  let sessionId: string;
  let history: ChatMessage[] = [];
  if (options.resume !== undefined) {
    const { messages } = await store.read(options.resume);
    history = messages;
    sessionId = options.resume;
    console.log(fmt(zh.session.resumed, { id: options.resume, count: messages.length }));
  } else {
    sessionId = await store.create([]);
  }

  render(
    <App
      client={client}
      registry={registry}
      ctx={ctx}
      model={model}
      systemPrompt={rules.text === '' ? undefined : rules.text}
      store={store}
      sessionId={sessionId}
      initialHistory={history}
    />,
  );
}
