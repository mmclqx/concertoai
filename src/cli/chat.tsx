/**
 * chat 命令装配：TUI + loop + store 组装。
 */

import { render } from 'ink';

import { registerBuiltinSubagents } from '../agent/builtin';
import { SubagentSpawner } from '../agent/spawner';
import { InMemoryAgentRegistry } from '../agents';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { KnowledgeStore } from '../knowledge/store';
import { MemoryInjector } from '../loop/memory-injector';
import type { ChatMessage } from '../loop/types';
import { AgentInstaller } from '../market';
import { toMcpServerConfig } from '../mcp/builtin-servers';
import { McpManager } from '../mcp/manager';
import type { MCPServerConfig } from '../mcp/types';
import { DeepSeekClient } from '../model/client';
import { preloadTokenizer } from '../model/tokenizer';
import { AuditLogger, TraceStore } from '../observable';
import { SkillLoader } from '../skill/loader';
import { loadConfig, resolveConfig } from '../store/config';
import { MemoryStore } from '../store/memory-store';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import { createKnowledgeTools } from '../tools/knowledge';
import type { ToolContext } from '../tools/registry';
import { createSpawnSubagentTool } from '../tools/spawn';
import { App } from '../ui/App';
import { formatSessionTime, SessionPicker } from '../ui/SessionPicker';
import { buildOsHint, buildRegistry, DEFAULT_ALLOWLIST, resolveModel } from './common';

// 保持 ./chat 的公共 API 不变（run/plan 现从 ./common 导入，此处 re-export 兼容旧引用）
export { buildOsHint, buildRegistry, DEFAULT_ALLOWLIST, resolveModel } from './common';

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
  // v2.1 性能优化：MCP 服务改为后台启动，不阻塞首帧渲染（冷启动 3-5s → ~1.2s）。
  // 工具就绪后动态注册进 registry，模型下一轮调用自动可见；连接状态经 /mcp status 查看。
  let mcpManager: McpManager | undefined;
  if (resolved.mcpServers.length > 0) {
    const configs: MCPServerConfig[] = resolved.mcpServers.map(toMcpServerConfig);
    mcpManager = new McpManager(configs);
  }

  // v2.0 子代理系统：创建 spawner + 注册内置子代理
  // v2.1 M1：传入 mcpManager 使子代理可按声明加载 MCP 工具
  const spawner = new SubagentSpawner(client, { cwd: options.cwd }, model, mcpManager);
  registerBuiltinSubagents(spawner);
  const spawnTool = createSpawnSubagentTool(spawner);

  // v2.1 M4：知识图谱工具
  const knowledgeStore = new KnowledgeStore(options.cwd);
  const knowledgeTools = createKnowledgeTools(knowledgeStore);

  const registry = buildRegistry(undefined, spawnTool, knowledgeTools);

  // v3.0 M4 T4.3：Agent 市场运行时（/agent 命令）
  // agentRegistry 供 install/promote 落地注册；agentInstaller 管理 ~/.lumen/agents/ 磁盘安装。
  const agentRegistry = new InMemoryAgentRegistry();
  const agentInstaller = new AgentInstaller({ registry: agentRegistry });

  // v3.0 M5：可观测性运行时（/agent 与 /review 操作记录调用链 + 审计日志）
  const traceStore = new TraceStore();
  const auditLogger = new AuditLogger();

  // MCP 后台启动：start() 内部对单服务失败 allSettled 降级（不 reject）；
  // 完成后把 MCP 工具动态注册进 registry（register 会令 apiTools 缓存失效，下一轮即可见）。
  if (mcpManager !== undefined) {
    void mcpManager
      .start()
      .then(() => {
        for (const tool of mcpManager?.listTools() ?? []) {
          registry.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            parallelSafe: false,
            execute: async (args: unknown) => {
              return mcpManager?.callTool(tool.name, args);
            },
          });
        }
      })
      .catch(() => {
        // start() 内部已 allSettled，此处仅为防御性兜底（静默降级，不阻塞主流程）
      });
  }
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
      systemPrompt={
        [buildOsHint(), rules.text !== '' ? rules.text : undefined].filter(Boolean).join('\n\n') ||
        undefined
      }
      store={store}
      sessionId={sessionId}
      initialHistory={history}
      approvalStrategy={resolved.approvalPolicy}
      memoryInjector={
        mcpManager !== undefined ? new MemoryInjector(mcpManager, {}, knowledgeStore) : undefined
      }
      memoryStore={new MemoryStore({ cwd: options.cwd })}
      skillLoader={new SkillLoader()}
      mcpManager={mcpManager}
      spawner={spawner}
      agentRegistry={agentRegistry}
      agentInstaller={agentInstaller}
      traceStore={traceStore}
      auditLogger={auditLogger}
    />,
  );

  // 性能优化：首帧渲染完成后后台预加载 tokenizer（WASM ~100ms），
  // 使首轮对话的 token 计数不再阻塞在编码器加载上。
  preloadTokenizer();
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
