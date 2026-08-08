/**
 * chat 命令装配：TUI + loop + store 组装。
 */

import { render } from 'ink';
import { registerBuiltinSubagents } from '../agent/builtin';
import { SubagentSpawner } from '../agent/spawner';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { MemoryInjector } from '../loop/memory-injector';
import type { ChatMessage } from '../loop/types';
import { toMcpServerConfig } from '../mcp/builtin-servers';
import { McpManager } from '../mcp/manager';
import type { MCPServerConfig } from '../mcp/types';
import { DeepSeekClient } from '../model/client';
import { getDefaultModel, getModel, listModels } from '../model/models';
import { SkillLoader } from '../skill/loader';
import { loadConfig, resolveConfig } from '../store/config';
import { MemoryStore } from '../store/memory-store';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import { editFileTool } from '../tools/edit';
import { listDirectoryTool, readFileTool, searchContentTool } from '../tools/read';
import type { ToolContext, ToolSpec } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { shellTool } from '../tools/shell';
import { createSpawnSubagentTool } from '../tools/spawn';
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

export function buildRegistry(mcpTools?: ToolSpec[], spawnTool?: ToolSpec): ToolRegistry {
  const registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(searchContentTool)
    .register(editFileTool)
    .register(shellTool);
  if (spawnTool !== undefined) {
    registry.register(spawnTool);
  }
  if (mcpTools !== undefined) {
    for (const tool of mcpTools) {
      registry.register(tool);
    }
  }
  return registry;
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

  // MCP 服务初始化（v1.1）
  let mcpManager: McpManager | undefined;
  if (resolved.mcpServers.length > 0) {
    const configs: MCPServerConfig[] = resolved.mcpServers.map(toMcpServerConfig);
    mcpManager = new McpManager(configs);
    // 静默启动 MCP 服务（连接状态通过 /mcp status 和状态条查看，不污染终端）
    await mcpManager.start();
  }

  // 将 MCP 工具转为 ToolSpec 并注册
  const mcpTools: ToolSpec[] | undefined = mcpManager?.listTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    parallelSafe: false,
    execute: async (args: unknown) => {
      return mcpManager?.callTool(t.name, args);
    },
  }));

  // v2.0 子代理系统：创建 spawner + 注册内置子代理
  const spawner = new SubagentSpawner(client, { cwd: options.cwd }, model);
  registerBuiltinSubagents(spawner);
  const spawnTool = createSpawnSubagentTool(spawner);

  const registry = buildRegistry(mcpTools, spawnTool);
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
      memoryInjector={mcpManager !== undefined ? new MemoryInjector(mcpManager) : undefined}
      memoryStore={new MemoryStore({ cwd: options.cwd })}
      skillLoader={new SkillLoader()}
      mcpManager={mcpManager}
      spawner={spawner}
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
