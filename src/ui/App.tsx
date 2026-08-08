import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { SubagentSpawner } from '../agent/spawner';
import { executeMcpCommand, parseMcpCommand } from '../cli/slash/mcp';
import { executeMemoryCommand, parseMemoryCommand } from '../cli/slash/memory';
import { executeSkillCommand, parseSkillCommand } from '../cli/slash/skill';
import { fmt, t } from '../i18n';
import { retrieveLocalMemories } from '../loop/local-memory';
import type { LoopEvent } from '../loop/loop';
import { runLoop } from '../loop/loop';
import type { MemoryInjector } from '../loop/memory-injector';
import { userMessage } from '../loop/messages';
import type { ChatMessage, ToolCall } from '../loop/types';
import type { McpManager } from '../mcp/manager';
import type { ModelClient } from '../model/client';
import { cacheHitCostFor, costFor, getModel } from '../model/models';
import { estimateMessageListTokens, estimateTokens } from '../model/tokenizer';
import type { SkillLoader } from '../skill/loader';
import type { MemoryStore } from '../store/memory-store';
import type { SessionStore } from '../store/session';
import type { ApprovalRequest, ToolContext } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { renderMarkdownToAnsi } from './markdown';
import { ApprovalModal, PlanConfirm } from './modals';
import { PromptInput } from './PromptInput';
import { Spinner } from './Spinner';
import { StatusBar } from './StatusBar';
import { StreamingView } from './StreamingView';

type Phase = 'idle' | 'streaming' | 'approval' | 'plan-approval';

/**
 * 从完整 ToolRegistry 中提取指定工具名组成受限注册表。
 * 技能 SKILL.md 的 `tools` 字段白名单通过此函数生效。
 */
function buildRestrictedRegistry(full: ToolRegistry, whitelist: string[]): ToolRegistry {
  const restricted = new ToolRegistry();
  for (const name of whitelist) {
    const spec = full.get(name);
    if (spec !== undefined) {
      restricted.register(spec);
    }
  }
  return restricted;
}

export interface AppProps {
  client: ModelClient;
  registry: ToolRegistry;
  /** 调用方提供的工具上下文；requestApproval 由本组件接管（弹审批框）。 */
  ctx: ToolContext;
  model: string;
  systemPrompt?: string;
  store?: SessionStore;
  sessionId?: string;
  initialHistory?: ChatMessage[];
  /** 审批策略：ask = 弹框逐个审批（默认）；allowlist-only = 只放行白名单，其余一律拒绝（不弹框）。 */
  approvalStrategy?: 'ask' | 'allowlist-only';
  /** MCP memory 注入器（v1.1）：每轮对话前检索相关记忆注入上下文。 */
  memoryInjector?: MemoryInjector;
  /** 本地项目记忆存储（v1.1）：与 MCP memory 互补。 */
  memoryStore?: MemoryStore;
  /** 技能加载器（v2.0）：处理 /skill 命令。 */
  skillLoader?: SkillLoader;
  /** MCP 管理器（v2.0）：处理 /mcp 命令。 */
  mcpManager?: McpManager;
  /** 子代理 spawner（v2.0）：subagent 模式技能走隔离执行，工具调用不暴露到 TUI。 */
  spawner?: SubagentSpawner;
}

/**
 * 优化 v1.1：终端显示截断上限从 1,000 提高到 8,000 字符，截断时在末尾显示完整字符数。
 * 完整内容始终保存在会话 JSONL 中，不会丢失。
 */

/** 终端单消息最大显示字符数（超过则截断显示，但完整内容已落盘）。 */
const MAX_DISPLAY_CHARS = 8_000;

/** 单条消息的渲染：角色前缀 + 内容（超长截断显示，助手消息走 Markdown 渲染，工具消息折叠）。 */
function MessageLine({
  message,
  messages,
  messageIndex,
}: {
  message: ChatMessage;
  messages: ChatMessage[];
  messageIndex: number;
}) {
  const prefix = message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : '工具';
  const color =
    message.role === 'user' ? 'cyan' : message.role === 'assistant' ? 'green' : 'yellow';
  const body = message.content ?? '';

  // 工具消息：只显示文件名/参数，不显示内容；编辑结果显示彩色 diff
  if (message.role === 'tool' && message.toolCallId !== undefined) {
    const tc = findToolCall(messages, messageIndex, message.toolCallId);
    const toolName = tc?.name;
    const isEdit = toolName === 'edit_file' || toolName === 'write_file';
    const isRead = toolName === 'read_file';
    const isSearch = toolName === 'search_content';
    const filePath = extractArg(tc, 'path');
    const pattern = extractArg(tc, 'pattern');

    // 编辑工具：彩色 diff
    if (isEdit) {
      const coloredDiff = colorizeDiff(body);
      return (
        <Box flexDirection="column">
          <Text color="red">
            {toolName} {filePath ?? ''}
          </Text>
          <Text>{coloredDiff}</Text>
        </Box>
      );
    }

    // 读取工具：只显示红色文件名
    if (isRead) {
      return (
        <Box>
          <Text color="red">
            {toolName} {filePath ?? ''}
          </Text>
        </Box>
      );
    }

    // 搜索工具：显示模式 + 命中行数
    if (isSearch) {
      const matchCount = body.split('\n').filter((l) => l.trim() !== '').length;
      const query = pattern ?? '';
      return (
        <Box>
          <Text color="red">
            {toolName} &quot;{query}&quot; → {matchCount} 条结果
          </Text>
        </Box>
      );
    }

    // 其他工具：只显示工具名
    return (
      <Box>
        <Text dimColor>{toolName ?? '工具'}</Text>
      </Box>
    );
  }

  const display =
    body.length > MAX_DISPLAY_CHARS
      ? `${body.slice(0, MAX_DISPLAY_CHARS)}…（共 ${body.length} 字符，终端仅显示前 ${MAX_DISPLAY_CHARS}）`
      : body;

  const content = message.role === 'assistant' ? renderMarkdownToAnsi(display) : display;

  return (
    <Box flexDirection="column">
      <Text bold color={color}>
        {prefix}
      </Text>
      <Text>{content}</Text>
    </Box>
  );
}

/** 在消息历史中向前查找 toolCallId 对应的工具调用。 */
function findToolCall(
  messages: ChatMessage[],
  currentIndex: number,
  toolCallId: string,
): ToolCall | undefined {
  for (let i = currentIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && msg.toolCalls !== undefined) {
      const tc = msg.toolCalls.find((c) => c.id === toolCallId);
      if (tc !== undefined) {
        return tc;
      }
    }
  }
  return undefined;
}

/** 解析工具参数 JSON，提取 path 字段（read_file / edit_file 等）。 */
function extractArg(tc: ToolCall | undefined, key: string): string | undefined {
  if (tc === undefined) return undefined;
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>;
    const val = args[key];
    return typeof val === 'string' ? val : undefined;
  } catch {
    return undefined;
  }
}

/** 给 diff 文本加上 ANSI 颜色：+ 绿色，- 红色，@@ 青色。 */
function colorizeDiff(diff: string): string {
  const lines = diff.split('\n');
  const colored = lines.map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return `\x1b[32m${line}\x1b[39m`;
    if (line.startsWith('-') && !line.startsWith('---')) return `\x1b[31m${line}\x1b[39m`;
    if (line.startsWith('@@')) return `\x1b[36m${line}\x1b[39m`;
    return `\x1b[2m${line}\x1b[22m`;
  });
  return colored.join('\n');
}

export function App({
  client,
  registry,
  ctx,
  model,
  systemPrompt,
  store,
  sessionId,
  initialHistory,
  approvalStrategy = 'ask',
  memoryInjector,
  memoryStore,
  skillLoader,
  mcpManager,
  spawner,
}: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>(initialHistory ?? []);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [streamed, setStreamed] = useState('');
  const [activeTool, setActiveTool] = useState<ToolCall | null>(null);
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  /** API 返回的真实 usage 累计（usage 事件累加；流式中途仍显示估算值）。 */
  const [realUsage, setRealUsage] = useState({ input: 0, output: 0, cacheHit: 0 });
  const approvalResolver = useRef<((approved: boolean) => void) | null>(null);
  const busy = useRef(false);
  /** 当前生成任务的取消控制器（Ctrl+C 中断流式生成）。 */
  const abortRef = useRef<AbortController | null>(null);
  /** 待审批的 /plan 计划文本与对应任务。 */
  const [plan, setPlan] = useState<string | null>(null);
  const lastPlanTaskRef = useRef('');
  /** 审批回调：挂起当前流程，等待 y/n 按键决议。 */
  const requestApproval = useCallback(async (request: ApprovalRequest): Promise<boolean> => {
    setPending(request);
    setPhase('approval');
    return new Promise<boolean>((resolve) => {
      approvalResolver.current = resolve;
    });
  }, []);

  const ctxWithApproval = useMemo<ToolContext>(() => {
    if (approvalStrategy === 'allowlist-only') {
      return { ...ctx, requestApproval: async () => false };
    }
    return { ...ctx, requestApproval };
  }, [ctx, requestApproval, approvalStrategy]);

  /** 构造统一的事件回调（流式输出/工具状态/usage/错误展示）。 */
  const makeOnEvent = useCallback(
    (controller: AbortController) =>
      (event: LoopEvent): void => {
        if (event.type === 'chunk') {
          setStreamed((s) => s + event.text);
        } else if (event.type === 'tool_call') {
          setActiveTool(event.toolCall);
        } else if (event.type === 'usage') {
          setRealUsage((u) => ({
            input: u.input + event.usage.prompt_tokens,
            output: u.output + event.usage.completion_tokens,
            cacheHit: u.cacheHit + (event.usage.prompt_cache_hit_tokens ?? 0),
          }));
        } else if (event.type === 'error') {
          setError(
            controller.signal.aborted
              ? t().errors.streamAborted
              : fmt(t().errors.streamInterrupted, { message: event.error.message }),
          );
        } else {
          setActiveTool(null);
        }
      },
    [],
  );

  /** /plan 阶段一：让模型输出分步计划，进入 plan-approval 等待审批。 */
  const sendPlan = useCallback(
    async (task: string) => {
      if (busy.current || task === '') {
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      busy.current = true;
      lastPlanTaskRef.current = task;
      setError(null);
      setInput('');
      setStreamed('');
      setActiveTool(null);
      setTokens((t) => ({ ...t, input: t.input + estimateTokens(`/plan ${task}`) }));
      const history = messages;
      setMessages([...history, userMessage(`/plan ${task}`)]);
      setPhase('streaming');
      try {
        const planResult = await runLoop(
          {
            model,
            client,
            registry,
            ctx: ctxWithApproval,
            systemPrompt,
            onEvent: makeOnEvent(controller),
            signal: controller.signal,
            contextWindow: getModel(model)?.contextWindow,
          },
          history,
          `请为任务「${task}」输出分步执行计划：markdown 列表，每一步说明要执行的操作（读取/编辑/运行命令）。只输出计划本身，不要调用工具。`,
        );
        if (planResult.interrupted) {
          setError(t().errors.loopMaxTurns);
          return;
        }
        const added = planResult.messages.slice(history.length);
        setMessages(planResult.messages);
        setTokens((t) => ({ ...t, output: t.output + estimateMessageListTokens(added) }));
        if (store !== undefined && sessionId !== undefined) {
          await store.appendAll(sessionId, added);
        }
        const planText = planResult.messages.at(-1)?.content ?? '';
        if (planText === '') {
          setError('模型未输出计划，请重试');
          return;
        }
        setPlan(planText);
        setPhase('plan-approval');
      } catch (err) {
        if (controller.signal.aborted) {
          setError(t().errors.streamAborted);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        abortRef.current = null;
        setActiveTool(null);
        setStreamed('');
        busy.current = false;
      }
    },
    [
      client,
      ctxWithApproval,
      messages,
      model,
      registry,
      store,
      sessionId,
      systemPrompt,
      makeOnEvent,
    ],
  );

  /** /plan 阶段二：计划已批准，把计划注入上下文后按任务执行。 */
  const executePlan = useCallback(
    async (task: string, planText: string) => {
      if (busy.current) {
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      busy.current = true;
      setError(null);
      setStreamed('');
      setActiveTool(null);
      const history = messages;
      setPhase('streaming');
      try {
        const execHistory = [
          ...history,
          userMessage(`已批准的计划（请严格按计划逐步执行）：\n${planText}`),
        ];
        const execResult = await runLoop(
          {
            model,
            client,
            registry,
            ctx: ctxWithApproval,
            systemPrompt,
            onEvent: makeOnEvent(controller),
            signal: controller.signal,
            contextWindow: getModel(model)?.contextWindow,
          },
          execHistory,
          task,
        );
        if (execResult.interrupted) {
          setError(t().errors.loopMaxTurns);
        }
        const added = execResult.messages.slice(history.length);
        setMessages(execResult.messages);
        setTokens((t) => ({ ...t, output: t.output + estimateMessageListTokens(added) }));
        if (store !== undefined && sessionId !== undefined) {
          await store.appendAll(sessionId, added);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setError(t().errors.streamAborted);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        abortRef.current = null;
        setActiveTool(null);
        setStreamed('');
        setPhase('idle');
        busy.current = false;
      }
    },
    [
      client,
      ctxWithApproval,
      messages,
      model,
      registry,
      store,
      sessionId,
      systemPrompt,
      makeOnEvent,
    ],
  );

  const send = useCallback(
    async (text: string) => {
      if (busy.current || text.trim() === '') {
        return;
      }
      const trimmed = text.trim();

      // 技能命令（/skill）→ 列表直接显示；调用技能注入指令后调模型
      if (skillLoader !== undefined) {
        const skillCmd = parseSkillCommand(trimmed);
        if (skillCmd !== null) {
          const result = executeSkillCommand(skillCmd, skillLoader, ctx.cwd);
          if (result.handled && result.message !== undefined) {
            const msg = result.message;
            setMessages((prev) => [...prev, { role: 'user', content: text }, msg]);
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
          }
          if (result.handled) {
            return;
          }
          // subagent 模式技能：走隔离子代理执行，工具调用不暴露到 TUI
          if (
            result.runAs === 'subagent' &&
            spawner !== undefined &&
            result.skillBody !== undefined
          ) {
            setInput('');
            busy.current = true;
            setError(null);
            setStreamed('');
            setPhase('streaming');
            setActiveTool({ id: 'skill', name: result.skillName ?? 'skill', arguments: '{}' });
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
            setMessages((prev) => [...prev, { role: 'user', content: text }]);

            const agentName = `skill:${result.skillName ?? 'unknown'}`;
            const allowedTools = (
              result.skillTools && result.skillTools.length > 0
                ? result.skillTools
                : ['read_file', 'search_content', 'list_directory']
            ) as Array<'read_file' | 'search_content' | 'list_directory'>;

            // 提取用户参数（/skill <name> <args>）
            const skillArgs = text.replace(/^\/skill\s+\S+\s*/, '').trim();
            const prompt = skillArgs !== '' ? skillArgs : text;

            spawner.register({
              name: agentName,
              description: result.skillName ?? 'skill',
              allowedTools,
              maxTurns: 12,
              timeoutMs: 120_000,
              systemPrompt: result.skillBody,
              maxRepairs: 2,
            });

            try {
              const subResult = await spawner.spawn({ agentName, prompt });
              setMessages((prev) => [...prev, { role: 'assistant', content: subResult.summary }]);
              setTokens((t) => ({
                ...t,
                output: t.output + estimateTokens(subResult.summary),
              }));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              setError(msg);
            } finally {
              busy.current = false;
              setActiveTool(null);
              setStreamed('');
              setPhase('idle');
            }
            return;
          }
          // inline 模式技能：注入技能正文为 system prompt，继续正常流程
          if (result.skillBody !== undefined) {
            setInput('');
            setPhase('streaming');
            busy.current = true;
            const controller = new AbortController();
            abortRef.current = controller;
            setError(null);
            setStreamed('');
            setActiveTool(null);
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
            const history = messages;
            const skillUserMsg = result.skillName ? `[技能: ${result.skillName}]\n${text}` : text;
            setMessages([...history, { role: 'user', content: skillUserMsg }]);
            try {
              // 技能指定了工具白名单 → 创建受限 ToolRegistry
              const skillRegistry =
                result.skillTools !== undefined
                  ? buildRestrictedRegistry(registry, result.skillTools)
                  : registry;

              const effectivePrompt = [result.skillBody, systemPrompt].filter(Boolean).join('\n\n');
              const onEvent = makeOnEvent(controller);
              const loopResult = await runLoop(
                {
                  model,
                  client,
                  registry: skillRegistry,
                  ctx: ctxWithApproval,
                  systemPrompt: effectivePrompt || undefined,
                  onEvent,
                  signal: controller.signal,
                  contextWindow: getModel(model)?.contextWindow,
                  maxRepairs: 5,
                },
                history,
                skillUserMsg,
              );
              if (loopResult.interrupted) {
                setError(t().errors.loopMaxTurns);
              }
              const added = loopResult.messages.slice(history.length);
              setMessages(loopResult.messages);
              setTokens((t) => ({
                ...t,
                output: t.output + estimateMessageListTokens(added),
              }));
              if (store !== undefined && sessionId !== undefined && added.length > 0) {
                await store.appendAll(sessionId, added);
              }
            } catch (err) {
              if (controller.signal.aborted) {
                setError(t().errors.streamAborted);
              } else if (err instanceof Error) {
                setError(err.message);
              } else {
                setError(String(err));
              }
            } finally {
              abortRef.current = null;
              setActiveTool(null);
              setStreamed('');
              setPhase('idle');
              busy.current = false;
            }
            return;
          }
        }
      }

      // MCP 管理命令（/mcp status / connect / disconnect）
      if (mcpManager !== undefined) {
        const mcpCmd = parseMcpCommand(trimmed);
        if (mcpCmd !== null) {
          const mcpResult = await executeMcpCommand(mcpCmd, mcpManager);
          if (mcpResult.handled && mcpResult.message !== undefined) {
            const msg = mcpResult.message;
            setMessages((prev) => [...prev, { role: 'user', content: text }, msg]);
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
          }
          return;
        }
      }

      // 记忆管理命令（/remember /forget /memories）→ 不经过模型
      if (memoryStore !== undefined) {
        const memCmd = parseMemoryCommand(trimmed);
        if (memCmd !== null) {
          const { message, handled } = await executeMemoryCommand(memCmd, memoryStore);
          if (handled) {
            setMessages((prev) => [...prev, { role: 'user', content: text }, message]);
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
            return;
          }
        }
      }

      if (trimmed.startsWith('/plan')) {
        await sendPlan(trimmed.slice('/plan'.length).trim());
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      busy.current = true;
      setError(null);
      setInput('');
      setStreamed('');
      setActiveTool(null);
      setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
      const history = messages;
      setMessages([...history, { role: 'user', content: text }]);
      setPhase('streaming');
      try {
        // 检索 MCP + 本地记忆，合并到 system prompt
        const blocks: string[] = [];
        if (memoryInjector !== undefined) {
          const mcpBlock = await memoryInjector.retrieve(text);
          if (mcpBlock !== '') blocks.push(mcpBlock);
        }
        if (memoryStore !== undefined) {
          const localBlock = await retrieveLocalMemories(memoryStore, text);
          if (localBlock !== '') blocks.push(localBlock);
        }
        const memoryBlock = blocks.join('\n\n');
        const effectivePrompt =
          memoryBlock !== '' ? `${memoryBlock}\n\n${systemPrompt ?? ''}`.trim() : systemPrompt;

        const onEvent = makeOnEvent(controller);
        const result = await runLoop(
          {
            model,
            client,
            registry,
            ctx: ctxWithApproval,
            systemPrompt: effectivePrompt || undefined,
            onEvent,
            signal: controller.signal,
            contextWindow: getModel(model)?.contextWindow,
          },
          history,
          text,
        );
        if (result.interrupted) {
          setError(t().errors.loopMaxTurns);
        }
        const added = result.messages.slice(history.length);
        setMessages(result.messages);
        setTokens((t) => ({ ...t, output: t.output + estimateMessageListTokens(added) }));
        if (store !== undefined && sessionId !== undefined) {
          // abort 时只持久化用户消息，不保存部分 assistant 回复，避免 resume 后模型被残缺上下文误导
          const toSave = controller.signal.aborted
            ? added.filter((m) => m.role !== 'assistant')
            : added;
          if (toSave.length > 0) {
            await store.appendAll(sessionId, toSave);
          }
        }
      } catch (err) {
        // 即使 abort/失败也持久化用户消息，保证 resume 时不丢上下文
        if (store !== undefined && sessionId !== undefined) {
          store.append(sessionId, { role: 'user', content: text }).catch(() => {});
        }
        if (controller.signal.aborted) {
          setError(t().errors.streamAborted);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        abortRef.current = null;
        setActiveTool(null);
        setStreamed('');
        setPhase('idle');
        busy.current = false;
      }
    },
    [
      client,
      ctxWithApproval,
      messages,
      model,
      registry,
      store,
      sessionId,
      systemPrompt,
      sendPlan,
      makeOnEvent,
      memoryStore,
      memoryInjector,
      skillLoader,
      spawner,
      ctx.cwd,
      mcpManager,
    ],
  );

  useInput((input, key) => {
    if (phase === 'plan-approval') {
      if (input === 'y') {
        const planText = plan ?? '';
        const task = lastPlanTaskRef.current;
        setPlan(null);
        setPhase('idle');
        void executePlan(task, planText);
      } else if (input === 'n') {
        setPlan(null);
        setPhase('idle');
        setError(t().plan.rejected);
      }
      return;
    }
    if (phase === 'approval') {
      if (input === 'y') {
        approvalResolver.current?.(true);
        approvalResolver.current = null;
        setPending(null);
        setPhase('idle');
      } else if (input === 'n') {
        approvalResolver.current?.(false);
        approvalResolver.current = null;
        setPending(null);
        setPhase('idle');
      }
      return;
    }
    if (input === 'c' && key.ctrl) {
      if (phase === 'streaming') {
        abortRef.current?.abort();
      } else {
        exit();
      }
      return;
    }
    if (key.escape) {
      exit();
    }
  });

  const showReal = realUsage.input + realUsage.output > 0;
  const display = phase === 'streaming' || !showReal ? tokens : realUsage;
  const displayCacheHit = showReal ? realUsage.cacheHit : 0;
  const cost = costFor(model, display.input, display.output, displayCacheHit);
  const hitCost = cacheHitCostFor(model, displayCacheHit);

  // MCP 状态摘要
  const mcpSummary = mcpManager
    ? (() => {
        const all = mcpManager.statusAll();
        if (all.length === 0) return undefined;
        const connected = all.filter((s) => s.connected).length;
        return `${connected}/${all.length} 服务`;
      })()
    : undefined;

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 聊天历史只追加不重排，索引 key 稳定
        <MessageLine key={i} message={m} messages={messages} messageIndex={i} />
      ))}
      {phase === 'streaming' && <StreamingView text={streamed} />}
      {activeTool !== null && <Spinner text={fmt(t().ui.toolRunning, { name: activeTool.name })} />}
      {pending !== null && phase === 'approval' && (
        <ApprovalModal kind={pending.kind} summary={pending.summary} detail={pending.detail} />
      )}
      {plan !== null && phase === 'plan-approval' && <PlanConfirm plan={plan} />}
      {error !== null && <Text color="red">{error}</Text>}
      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={(t) => {
          void send(t);
        }}
        placeholder={t().prompt.placeholder}
        active={phase === 'idle'}
      />
      <StatusBar
        model={model}
        inputTokens={display.input}
        outputTokens={display.output}
        cost={cost}
        isReal={showReal && phase !== 'streaming'}
        cacheHitTokens={displayCacheHit}
        cacheHitCost={hitCost}
        mcpStatus={mcpSummary}
      />
    </Box>
  );
}
