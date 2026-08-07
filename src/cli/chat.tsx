/**
 * chat 命令装配：TUI + loop + store 组装。
 */

import { render } from 'ink';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import type { ChatMessage } from '../loop/types';
import { DeepSeekClient } from '../model/client';
import { getDefaultModel, getModel, listModels } from '../model/models';
import { loadConfig, resolveConfig } from '../store/config';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import { editFileTool } from '../tools/edit';
import { listDirectoryTool, readFileTool, searchContentTool } from '../tools/read';
import type { ToolContext } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { shellTool } from '../tools/shell';
import { App } from '../ui/App';
import { formatSessionTime, SessionPicker } from '../ui/SessionPicker';

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
  /** 会话 id 字符串 = 直接恢复；true（-r 不带参数）= 交互选择；undefined = 新会话。 */
  resume?: string | true;
  /** -l：仅列出历史会话，不进入对话。 */
  listOnly?: boolean;
  /** CLI --lang（覆盖环境变量与配置）。 */
  lang?: string;
}

export async function runChat(options: RunChatOptions): Promise<void> {
  // 配置：CLI > 环境变量 > 配置文件 > 默认值
  const config = await loadConfig();
  const resolved = resolveConfig(config, options.model, options.lang);
  setLocale(resolveLocale(resolved.locale));
  const store = new SessionStore(resolved.sessionDir);
  // -l 仅列列表：无需 TTY 与模型配置
  if (options.listOnly === true) {
    await printSessionList(store);
    return;
  }
  if (process.stdin.isTTY !== true) {
    console.error(t().errors.noTty);
    process.exit(1);
  }
  const model = resolveModel(resolved.model);
  const client = new DeepSeekClient({ apiKey: options.apiKey });
  const registry = buildRegistry();
  const rules = await loadProjectRules(options.cwd);
  const ctx: ToolContext = {
    cwd: options.cwd,
    allowlistedPrefixes: resolved.allowlist ?? DEFAULT_ALLOWLIST,
  };

  let sessionId: string;
  let history: ChatMessage[] = [];
  if (typeof options.resume === 'string') {
    const { messages } = await store.read(options.resume);
    history = messages;
    sessionId = options.resume;
    console.log(fmt(t().session.resumed, { id: options.resume, count: messages.length }));
  } else if (options.resume === true) {
    sessionId = await pickSession(store);
    const { messages } = await store.read(sessionId);
    history = messages;
    console.log(fmt(t().session.resumed, { id: sessionId, count: messages.length }));
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
      approvalStrategy={resolved.approvalPolicy}
    />,
  );
}

/** 打印历史会话列表（-l）：id、时间、消息数、首条摘要。 */
export async function printSessionList(store: SessionStore): Promise<void> {
  const sessions = await store.list();
  if (sessions.length === 0) {
    console.log(t().session.empty);
    return;
  }
  for (const s of sessions) {
    console.log(
      `${s.id}  ${formatSessionTime(s.createdAt)}  ${s.messageCount} 条  ${
        s.firstUserMessage ?? t().session.noUserMessage
      }`,
    );
  }
}

/** 交互选择历史会话：渲染 SessionPicker，Enter 选定 / Esc 取消。 */
async function pickSession(store: SessionStore): Promise<string> {
  const sessions = await store.list();
  if (sessions.length === 0) {
    console.error(t().session.empty);
    process.exit(1);
  }
  return new Promise<string>((resolve, reject) => {
    const { unmount } = render(
      <SessionPicker
        sessions={sessions}
        onSelect={(id) => {
          unmount();
          resolve(id);
        }}
        onCancel={() => {
          unmount();
          reject(new Error('已取消会话选择'));
        }}
      />,
    );
  });
}
