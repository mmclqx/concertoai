/**
 * chat 命令装配：TUI + loop + store 组装。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
import { preloadTokenizer } from '../model/tokenizer';
import { AuditLogger, TraceStore } from '../observable';
import { PluginRuntime } from '../plugin/runtime';
import { SkillLoader } from '../skill/loader';
import { loadConfig, resolveConfig } from '../store/config';
import { MemoryStore } from '../store/memory-store';
import { globalDir, projectKeyFor, projectSessionsDir } from '../store/paths';
import { loadProjectRules } from '../store/project-rules';
import { SessionStore } from '../store/session';
import { createKnowledgeTools } from '../tools/knowledge';
import type { ToolContext } from '../tools/registry';
import { createSpawnSubagentTool } from '../tools/spawn';
import { App } from '../ui/App';
import { formatSessionTime, SessionPicker } from '../ui/SessionPicker';
import {
  buildOsHint,
  buildRegistry,
  DEFAULT_ALLOWLIST,
  mergeAllowlist,
  resolveProjectForCwd,
} from './common';
import { buildClientForProvider, resolveRuntimeProvider } from './provider-runtime';

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
  /** CLI --provider（v4.0 M3 T3.1）：临时切换 Provider（本次进程生效，不写 config）。 */
  provider?: string;
}

export async function runChat(options: RunChatOptions): Promise<void> {
  // 配置：CLI > 环境变量 > 配置文件 > 默认值
  const config = await loadConfig();
  const resolved = resolveConfig(config, options.model, options.lang);
  setLocale(resolveLocale(resolved.locale));
  // v3.1 M2 T2.3：按 cwd 精确探测已注册项目（-p 已在 index.ts preAction 中 chdir）。
  // 命中 → 项目级白名单与全局合并、项目级 MCP 优先；未命中 → 用全局配置。
  const project = await resolveProjectForCwd(options.cwd);
  const allowlistedPrefixes = mergeAllowlist(
    resolved.allowlist ?? DEFAULT_ALLOWLIST,
    project?.whitelist,
  );
  const mcpServers = project?.mcpServers ?? resolved.mcpServers;
  // v3.1 M2 T2.4：会话目录按项目隔离——项目模式写 ~/.concertoai/sessions/<projectKey>/，
  // resume/-l 天然按项目过滤；未命中项目 → 全局（配置/默认）会话目录。
  const sessionDir =
    project !== undefined ? projectSessionsDir(projectKeyFor(project.name)) : resolved.sessionDir;
  const store = new SessionStore(sessionDir);
  // -l 仅列列表：无需 TTY 与模型配置
  if (options.listOnly === true) {
    await printSessionList(store);
    return;
  }
  if (process.stdin.isTTY !== true) {
    console.error(t().errors.noTty);
    process.exit(1);
  }
  // v4.0 M3 T3.1：--provider 临时切换 / config defaultProvider 持久化 → 解析运行时 Provider。
  // 三 Provider（deepseek/openai/ollama）均为 OpenAI 兼容 /chat/completions，统一复用
  // DeepSeekClient（baseUrl 可配）；非 DeepSeek 模型跳过模型表校验（不在 DeepSeek 表中）。
  const runtime = await resolveRuntimeProvider(config, {
    provider: options.provider,
    model: options.model,
    apiKey: options.apiKey,
  });
  let providerName = runtime.provider;
  let fallbackNote: string | undefined;
  let client = buildClientForProvider(runtime);
  // v4.0 M3 T3.4：启动 fallback 探测——主 Provider 不可用自动切备选（≤1 次，D54）。
  // 探测失败不阻塞启动（保持主 Provider，后续调用原样报错）；Ollama 本地探测快，DeepSeek 余额探测有超时兜底。
  try {
    const { buildBuiltinRegistry } = await import('./provider');
    const { ProviderRouter } = await import('../model/router');
    const registry = await buildBuiltinRegistry();
    const router = new ProviderRouter(registry);
    const startup = await router.resolveStartupProvider(runtime.provider, {
      healthCheckTimeoutMs: 3_000,
    });
    if (startup.fellBack && startup.provider.name !== providerName) {
      const fallbackRuntime = await resolveRuntimeProvider(config, {
        provider: startup.provider.name,
        model: options.model,
        apiKey: options.apiKey,
      });
      fallbackNote = fmt(t().provider.fallbackNote, {
        primary: providerName,
        fallback: startup.provider.name,
        reason: startup.reason ?? '',
      });
      providerName = startup.provider.name;
      client = buildClientForProvider(fallbackRuntime);
    }
  } catch {
    // 探测异常（如 accounts 读取失败）→ 静默保持主 Provider，不阻塞启动
  }
  const model = runtime.model;

  // MCP 服务初始化（v1.1）
  // v2.1 性能优化：MCP 服务改为后台启动，不阻塞首帧渲染（冷启动 3-5s → ~1.2s）。
  // 工具就绪后动态注册进 registry，模型下一轮调用自动可见；连接状态经 /mcp status 查看。
  let mcpManager: McpManager | undefined;
  if (mcpServers.length > 0) {
    const configs: MCPServerConfig[] = mcpServers.map(toMcpServerConfig);
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
  // agentRegistry 供 install/promote 落地注册；agentInstaller 管理 ~/.concertoai/agents/ 磁盘安装。
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
    allowlistedPrefixes,
  };

  // v4.0 M4：插件运行时装配——加载全局+项目插件 → 动态 import entry → 工具注入 registry
  // （带 pluginSource/pluginPermission）→ 权限钩子 setPermissionCheck（插件工具调用前 guard）。
  // await 确保首轮对话前插件工具与权限钩子就绪（插件数量少、import 快，启动开销可接受）。
  const pluginRuntime = new PluginRuntime({ audit: auditLogger });
  const pluginMount = await pluginRuntime.mount(registry, options.cwd, ctx);
  if (pluginMount.rejected.length > 0) {
    for (const r of pluginMount.rejected) {
      console.error(`⚠ 插件 ${r.name} 未装配: ${r.reason}`);
    }
  }

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
    // v4.1 T2.2：新会话首次启动 → 欢迎引导（仅一次，标记文件控制）
    maybePrintWelcome();
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
      providerName={providerName}
      fallbackNote={fallbackNote}
    />,
  );

  // 性能优化：首帧渲染完成后后台预加载 tokenizer（WASM ~100ms），
  // 使首轮对话的 token 计数不再阻塞在编码器加载上。
  preloadTokenizer();
}

/** 欢迎标记文件名（v4.1 T2.2：仅首次运行打印欢迎引导）。 */
const WELCOME_SEEN_FILE = '.welcome-seen';

/**
 * 首次运行欢迎引导（v4.1 T2.2，用户反馈 3：新手不知流程）。
 * 首次 chat 启动打印 3 行常用命令 + 新手路径；标记文件存在后不再打印。
 * 标记文件写入失败不阻塞（静默降级，最多每次启动多打一次欢迎）。
 */
export function maybePrintWelcome(): void {
  const marker = path.join(globalDir(), WELCOME_SEEN_FILE);
  if (existsSync(marker)) {
    return;
  }
  const w = t().welcome;
  console.log('');
  console.log(w.title);
  console.log(w.line1);
  console.log(w.line2);
  console.log(w.line3);
  console.log('');
  try {
    mkdirSync(globalDir(), { recursive: true }); // 全局目录可能尚不存在（首次运行）
    writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch {
    // 静默降级：写入失败下次再显示
  }
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
