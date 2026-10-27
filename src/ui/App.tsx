import { execSync } from 'node:child_process';

import { Box, Text, useApp, useInput } from 'ink';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { SubagentSpawner } from '../agent/spawner';
import type { AgentRegistry } from '../agents';
import {
  executeAgentCommand,
  executeAgentMarketCommand,
  parseAgentCommand,
} from '../cli/slash/agent';
import { executeMcpCommand, parseMcpCommand } from '../cli/slash/mcp';
import { executeMemoryCommand, parseMemoryCommand } from '../cli/slash/memory';
import { executeOrchestrateCommand, parseOrchestrateCommand } from '../cli/slash/orchestrate';
import { parsePluginCommand, runPluginSlash } from '../cli/slash/plugin';
import { executeReviewCommand, parseReviewCommand } from '../cli/slash/review';
import {
  executeSelfHealCommand,
  parseSelfHealCommand,
  selfHealPhaseLabel,
} from '../cli/slash/self-heal';
import {
  executeSkillCommand,
  executeSkillMarketCommand,
  parseSkillCommand,
} from '../cli/slash/skill';
import { parseWorkflowCommand, runWorkflowSlash } from '../cli/slash/workflow';
import { formatTeamProgress, runTeamCommand } from '../cli/team';
import { fmt, t } from '../i18n';
import { retrieveLocalMemories } from '../loop/local-memory';
import type { LoopEvent } from '../loop/loop';
import { runLoop } from '../loop/loop';
import type { MemoryInjector } from '../loop/memory-injector';
import { userMessage } from '../loop/messages';
import type { ChatMessage, ToolCall } from '../loop/types';
import type { AgentInstaller } from '../market';
import type { McpManager } from '../mcp/manager';
import type { ModelClient } from '../model/client';
import { costForProvider } from '../model/cost';
import { cacheHitCostFor, costFor, getModel, priceTierFor } from '../model/models';
import { estimateMessageListTokens, estimateTokens } from '../model/tokenizer';
import type { AuditLogger, TraceStore } from '../observable';
import { SnapshotManager } from '../orchestrator/transaction';
import { ReviewerEngine } from '../reviewer/engine';
import type { SkillLoader } from '../skill/loader';
import type { MemoryStore } from '../store/memory-store';
import type { SessionStore } from '../store/session';
import type { ApprovalRequest, ToolContext } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { renderMarkdownToAnsi } from './markdown';
import { ApprovalModal, PlanConfirm } from './modals';
import { ObservabilityPanel } from './ObservabilityPanel';
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
  /** Agent 注册表（v3.0 M4）：/agent 命令的 install/promote 落地注册表。 */
  agentRegistry?: AgentRegistry;
  /** Agent 安装器（v3.0 M4）：/agent install/remove/list 的磁盘操作。 */
  agentInstaller?: AgentInstaller;
  /** 调用链追踪（v3.0 M5）：/agent 与 /review 操作记录 span，'o' 键切换面板。 */
  traceStore?: TraceStore;
  /** 审计日志（v3.0 M5）：Agent 交互追加写入，可导出 JSON。 */
  auditLogger?: AuditLogger;
  /** 当前 Provider 名（v4.0 M3 T3.1；缺省 deepseek）。 */
  providerName?: string;
  /** fallback 提示（v4.0 M3 T3.4）：主 Provider 故障已切备选时传入，状态条黄色警示。 */
  fallbackNote?: string;
}

/**
 * 优化 v1.1：终端显示截断上限从 1,000 提高到 8,000 字符，截断时在末尾显示完整字符数。
 * 完整内容始终保存在会话 JSONL 中，不会丢失。
 */

/** 终端单消息最大显示字符数（超过则截断显示，但完整内容已落盘）。 */
const MAX_DISPLAY_CHARS = 8_000;

/** 流式文本合并刷新间隔（毫秒）：窗口内多个 chunk 只触发一次 Ink 重渲染。 */
const STREAM_FLUSH_MS = 30;

/** 单条消息的渲染：角色前缀 + 内容（超长截断显示，助手消息走 Markdown 渲染，工具消息折叠）。 */
const MessageLine = memo(function MessageLine({
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
});

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
  agentRegistry,
  agentInstaller,
  traceStore,
  auditLogger,
  providerName = 'deepseek',
  fallbackNote,
}: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>(initialHistory ?? []);
  /** v3.0 M5：可观测性面板开关（'o' 键切换，默认收起不阻塞主对话流）。 */
  const [obsOpen, setObsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [streamed, setStreamedState] = useState('');
  /**
   * v2.1 性能优化：流式文本节流刷新。
   * - streamedRef：累积 chunk 文本（高频到达，不直接触发 setState）；
   * - flushTimerRef：合并刷新定时器，STREAM_FLUSH_MS 内多个 chunk 只触发一次刷新，
   *   避免每个 SSE chunk 都导致 Ink 全树重渲染（长文本 O(n²) 渲染退化）；
   * - setStreamed 包装：传入 '' 时同步清空 ref 与挂起定时器（流结束/中断时统一收敛，
   *   防止残留文本在定时器回写），其余值走 React setState。
   */
  const streamedRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setStreamed = useCallback((value: string) => {
    if (value === '') {
      streamedRef.current = '';
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    }
    setStreamedState(value);
  }, []);
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
          // 节流：累积到 ref，定时器统一刷新（避免高频 chunk 全树重渲染）
          streamedRef.current += event.text;
          if (flushTimerRef.current === null) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              setStreamed(streamedRef.current);
            }, STREAM_FLUSH_MS);
          }
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
    [setStreamed],
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
      setStreamed,
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
      setStreamed,
    ],
  );

  const send = useCallback(
    async (text: string) => {
      if (busy.current || text.trim() === '') {
        return;
      }
      const trimmed = text.trim();

      // v3.1 M5 T5.2：/orchestrate 触发 team 全链路（拆解 → 对抗性闭环 → 回滚兜底）
      const orchCmd = parseOrchestrateCommand(trimmed);
      if (orchCmd !== null) {
        setInput('');
        setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        const orchStartedAt = Date.now();
        traceStore?.record({
          id: `orchestrate:${orchStartedAt}`,
          taskId: 'orchestrate',
          agentName: 'cli',
          messageType: 'task',
          input: { command: trimmed },
          startedAt: orchStartedAt,
          durationMs: 0,
        });
        void auditLogger?.append({
          kind: 'message',
          detail: { command: trimmed, type: 'orchestrate' },
        });
        setPhase('streaming');
        busy.current = true;
        try {
          const result = await executeOrchestrateCommand(orchCmd, {
            // chat 内用户已通过输入 /orchestrate 显式授权；拆解/写盘确认自动放行，
            // 闭环 spans 经 traceStore 在 `o` 键面板可见
            runTeam: (task) =>
              runTeamCommand({
                cwd: ctx.cwd,
                apiKey: '',
                client,
                model,
                task,
                confirm: async () => true,
                // P5 收尾：chat 内 /orchestrate 置 silent——抑制 stdout/stderr 直写，
                // 进度经 onProgress 推送聊天消息、汇总经返回值转聊天消息，不污染 TUI
                silent: true,
                traceStore,
                // T4.1：拆解/轮次/收尾进度 → 渐进推送聊天消息（长任务可感知，不黑盒等待）
                onProgress: (p) => {
                  setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', content: formatTeamProgress(p) },
                  ]);
                },
              }),
          });
          if (result.message !== undefined) {
            setMessages((prev) => [...prev, result.message as ChatMessage]);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          busy.current = false;
          setPhase('idle');
          setStreamed('');
        }
        return;
      }

      // v2.1 M5：审查命令（/review）→ 启动 Reviewer Agent
      const reviewCmd = parseReviewCommand(trimmed);
      if (reviewCmd !== null && spawner !== undefined) {
        // v3.0 M5：审查操作记录调用链 + 审计日志
        const startedAt = Date.now();
        traceStore?.record({
          id: `review:${startedAt}`,
          taskId: 'review',
          agentName: 'reviewer',
          messageType: 'task',
          input: { command: trimmed, scope: reviewCmd.type },
          startedAt,
          durationMs: 0,
        });
        void auditLogger?.append({
          kind: 'message',
          detail: { command: trimmed, type: 'review' },
        });
        setInput('');
        setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        const execResult = executeReviewCommand(reviewCmd);
        if (execResult.message !== undefined) {
          const msg = execResult.message;
          setMessages((prev) => [...prev, msg]);
        }
        // v3.1 M5 / T5.4：非法 severity 已回显错误 → 不启动审查
        if (execResult.handled) {
          return;
        }
        // 异步运行审查引擎
        setPhase('streaming');
        busy.current = true;
        try {
          const engine = new ReviewerEngine(spawner, ctx.cwd);
          const report = await engine.review({
            scope:
              reviewCmd.type === 'files'
                ? { type: 'files', paths: reviewCmd.paths }
                : reviewCmd.type === 'pr'
                  ? { type: 'pr', diff: '' }
                  : { type: 'auto' },
            // v3.1 M5 / T5.4：审查阈值透传（strict/normal/lenient）
            severity: reviewCmd.type === 'unknown' ? undefined : reviewCmd.severity,
          });
          // v4.0 M1：/review --fix → 审查完成后自动修复 A 类建议（≤2 次交互）
          // 注意：unknown 已由 executeReviewCommand 短路（handled=true return），此处仅剩 auto/files/pr
          let finalReport = report;
          if (reviewCmd.type !== 'unknown' && reviewCmd.fix === true) {
            const fixResult = await engine.autoFix(report, {
              cwd: ctx.cwd,
              client,
              model,
              requestApproval,
              snapshots: new SnapshotManager(ctx.cwd),
              // T1.1 修复进度可视化：「正在修复第 x/y 个问题…」渐进推送聊天消息（长任务可感知）
              onProgress: (fixed, total) => {
                setMessages((prev) => [
                  ...prev,
                  {
                    role: 'assistant',
                    content: fmt(t().reviewer.autofixProgress, { fixed, total }),
                  },
                ]);
              },
              // T1.3 增量 verify：只 rerun 受影响段（lint + type 段），跳过 build/test（快）。
              // 全量 verify 由发布门/CI 兜底；修复引入 test/build 回归概率低，且 fail-closed
              // 回滚已保证修不坏代码（runVerify 注入式设计，后续可无缝替换为单文件增量）。
              runVerify: async () => {
                try {
                  execSync('npm run lint', { cwd: ctx.cwd, timeout: 60_000, stdio: 'pipe' });
                  execSync('npm run typecheck', { cwd: ctx.cwd, timeout: 60_000, stdio: 'pipe' });
                  return { passed: true };
                } catch {
                  return { passed: false };
                }
              },
            });
            finalReport = fixResult.report;
          }
          const reportText = ReviewerEngine.formatReport(finalReport);
          setMessages((prev) => [...prev, { role: 'assistant', content: reportText }]);
          setTokens((t) => ({ ...t, output: t.output + estimateTokens(reportText) }));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          busy.current = false;
          setPhase('idle');
          setStreamed('');
        }
        return;
      }

      // v4.0 M2 T2.6：工作流命令（/workflow）→ chat 内执行（run 走 DAG 引擎 + 进度推送）
      const workflowCmd = parseWorkflowCommand(trimmed);
      if (workflowCmd !== null) {
        setInput('');
        setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        setPhase('streaming');
        busy.current = true;
        try {
          const result = await runWorkflowSlash(workflowCmd, {
            cwd: ctx.cwd,
            // 审批节点走统一审批弹窗（require: approval 步骤）；普通步骤由 /workflow 显式授权执行
            requestApproval: async (step) =>
              requestApproval({
                kind: 'shell',
                summary: fmt(t().workflow.approveStep, { command: step.run }),
                detail: step.run,
              }),
            // T2.3 进度推送：聊天内渐进显示「正在执行 step x/y: name…」
            onProgress: (p) => {
              if (p.stepName === '') {
                return;
              }
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: `▎ ${fmt(t().workflow.runProgress, {
                    current: p.done + 1,
                    total: p.total,
                    step: p.stepName,
                  })}`,
                },
              ]);
            },
            // 快照事务回滚（任一步失败且放弃 → 整体回滚）
            snapshots: new SnapshotManager(ctx.cwd),
          });
          setMessages((prev) => [...prev, result.message as ChatMessage]);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          busy.current = false;
          setPhase('idle');
          setStreamed('');
        }
        return;
      }

      // v4.0 M4 T4.5：插件命令（/plugin）→ chat 内可用（install/search/list/remove/browse/recommend/popular）
      const pluginCmd = parsePluginCommand(trimmed);
      if (pluginCmd !== null) {
        setInput('');
        setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        setPhase('streaming');
        busy.current = true;
        try {
          const result = await runPluginSlash(pluginCmd, {
            cwd: ctx.cwd,
          });
          setMessages((prev) => [...prev, result.message as ChatMessage]);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          busy.current = false;
          setPhase('idle');
          setStreamed('');
        }
        return;
      }

      // v3.0 M4 T4.3：Agent 管理命令（/agent）→ 市场操作走异步，list 同步展示
      if (agentInstaller !== undefined && agentRegistry !== undefined) {
        const agentCmd = parseAgentCommand(trimmed);
        if (agentCmd !== null) {
          // v3.0 M5：Agent 操作记录调用链 + 审计日志
          const opName =
            agentCmd.type === 'list'
              ? 'list'
              : agentCmd.type === 'install'
                ? `install:${agentCmd.name}`
                : agentCmd.type === 'remove'
                  ? `remove:${agentCmd.name}`
                  : agentCmd.type === 'promote'
                    ? `promote:${agentCmd.skillName}`
                    : agentCmd.type === 'update'
                      ? `update:${agentCmd.name ?? 'all'}`
                      : 'list';
          const startedAt = Date.now();
          traceStore?.record({
            id: `agent:${opName}:${startedAt}`,
            taskId: `agent:${opName}`,
            agentName: 'cli',
            messageType: 'task',
            input: { command: trimmed },
            startedAt,
            durationMs: 0,
          });
          void auditLogger?.append({
            kind: 'message',
            detail: { command: trimmed, type: agentCmd.type },
          });
          if (
            agentCmd.type === 'install' ||
            agentCmd.type === 'remove' ||
            agentCmd.type === 'promote' ||
            agentCmd.type === 'update' ||
            // v3.2 M5 / T5.4：/agent list 走异步（拉注册表对比「已安装 vs 最新」，失败降级同步列表）
            agentCmd.type === 'list'
          ) {
            setInput('');
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
            const userMsg: ChatMessage = { role: 'user', content: text };
            setMessages((prev) => [...prev, userMsg]);
            const result = await executeAgentMarketCommand(agentCmd, {
              installer: agentInstaller,
              registry: agentRegistry,
              loader: skillLoader,
            });
            if (result.message !== undefined) {
              const msg = result.message;
              setMessages((prev) => [...prev, msg]);
            }
            return;
          }
          const result = executeAgentCommand(agentCmd, {
            installer: agentInstaller,
            registry: agentRegistry,
            loader: skillLoader,
          });
          if (result.handled && result.message !== undefined) {
            const msg = result.message;
            setMessages((prev) => [...prev, { role: 'user', content: text }, msg]);
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
          }
          if (result.handled) {
            return;
          }
        }
      }

      // 技能命令（/skill）→ 列表直接显示；调用技能注入指令后调模型
      if (skillLoader !== undefined) {
        const skillCmd = parseSkillCommand(trimmed);
        if (skillCmd !== null) {
          // v2.1 M3：技能市场命令（install / search / update）→ 异步网络操作
          if (
            skillCmd.type === 'install' ||
            skillCmd.type === 'search' ||
            skillCmd.type === 'update'
          ) {
            setInput('');
            setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
            const userMsg: ChatMessage = { role: 'user', content: text };
            setMessages((prev) => [...prev, userMsg]);
            const result = await executeSkillMarketCommand(skillCmd, skillLoader, ctx.cwd);
            if (result.message !== undefined) {
              const msg = result.message;
              setMessages((prev) => [...prev, msg]);
            }
            return;
          }

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

              // v2.1 M2：处理 @agent 引用 → 异步 spawn 子代理，结果替换占位符
              let effectiveBody = result.skillBody;
              const agentRefs = result.agentRefs;
              if (agentRefs !== undefined && agentRefs.length > 0 && spawner !== undefined) {
                for (const ref of agentRefs) {
                  const placeholder = `@agent:${ref.agentName}${ref.prompt ? ` ${ref.prompt}` : ''}`;
                  try {
                    const subResult = await spawner.spawn({
                      agentName: ref.agentName,
                      prompt: ref.prompt || `执行 ${result.skillName ?? '技能'} 的子任务`,
                    });
                    const quoted = subResult.summary
                      .split('\n')
                      .map((l) => `> ${l}`)
                      .join('\n');
                    effectiveBody = effectiveBody.replace(
                      placeholder,
                      `> **子代理 ${ref.agentName} 结论**：\n${quoted}`,
                    );
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    effectiveBody = effectiveBody.replace(
                      placeholder,
                      `（子代理 ${ref.agentName} 执行失败: ${msg}）`,
                    );
                  }
                }
              }

              const effectivePrompt = [effectiveBody, systemPrompt].filter(Boolean).join('\n\n');
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

      // v3.1 M1 T1.4：/self-heal 命令 → 执行 npm run verify → 失败自动走 M1 闭环
      // （分类 → 修复 → 验证 → 回滚）。修复期间置 streaming 阶段，状态条可见，不阻塞主对话流。
      if (parseSelfHealCommand(trimmed)) {
        setInput('');
        setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        busy.current = true;
        setError(null);
        setStreamed('');
        setPhase('streaming');
        setActiveTool({ id: 'self-heal', name: 'self-heal', arguments: '{}' });
        try {
          const result = await executeSelfHealCommand(ctxWithApproval, {
            client,
            model,
            requestApproval,
            // T4.2：阶段进度 → 状态条 activeTool 名称随阶段更新（分类/lint 修复/模型修复/验证/回滚）
            onPhase: (phase) => {
              setActiveTool({
                id: 'self-heal',
                name: `self-heal（${selfHealPhaseLabel(phase)}）`,
                arguments: '{}',
              });
            },
          });
          const msg: ChatMessage = { role: 'assistant', content: result.message };
          setMessages((prev) => [...prev, msg]);
          setTokens((t) => ({ ...t, output: t.output + estimateTokens(result.message) }));
          if (store !== undefined && sessionId !== undefined) {
            store.append(sessionId, msg).catch(() => {});
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          abortRef.current = null;
          setActiveTool(null);
          setStreamed('');
          setPhase('idle');
          busy.current = false;
        }
        return;
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
        // v2.1 性能优化：两路检索并行执行（原串行 await），缩短首字节延迟
        const [mcpBlock, localBlock] = await Promise.all([
          memoryInjector !== undefined ? memoryInjector.retrieve(text) : Promise.resolve(''),
          memoryStore !== undefined
            ? retrieveLocalMemories(memoryStore, text)
            : Promise.resolve(''),
        ]);
        const blocks = [mcpBlock, localBlock].filter((b) => b !== '');
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
      setStreamed,
      agentInstaller,
      agentRegistry,
      traceStore,
      auditLogger,
      requestApproval,
    ],
  );

  useInput((input, key) => {
    if (phase === 'plan-approval') {
      if (input === 'y' || key.return) {
        const planText = plan ?? '';
        const task = lastPlanTaskRef.current;
        setPlan(null);
        setPhase('idle');
        void executePlan(task, planText);
      } else if (input === 'n' || key.escape || (input === 'c' && key.ctrl)) {
        // v3.1 BUG 修复：计划审批阶段 Esc / Ctrl+C = 拒绝计划（fail-closed），不退出应用
        setPlan(null);
        setPhase('idle');
        setError(t().plan.rejected);
      }
      return;
    }
    if (phase === 'approval') {
      if (input === 'y' || key.return) {
        approvalResolver.current?.(true);
        approvalResolver.current = null;
        setPending(null);
        setPhase('idle');
      } else if (input === 'n' || key.escape || (input === 'c' && key.ctrl)) {
        // v3.1 BUG 修复：审批阶段 Esc / Ctrl+C = 拒绝该操作（fail-closed），不退出应用
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
    // v3.0 M5：'o' 键切换可观测性面板（仅空闲时，避免打断流式输出）
    if (input === 'o' && phase === 'idle' && traceStore !== undefined) {
      setObsOpen((v) => !v);
      return;
    }
    if (key.escape) {
      // v3.1 BUG 修复：生成/工具执行期间 Esc 与 Ctrl+C 一致 = 中断当前生成，不退出应用；
      // 仅空闲（idle）时按 Esc 才退出（与提示文案「Esc 退出」一致）。
      if (phase === 'streaming') {
        abortRef.current?.abort();
      } else {
        exit();
      }
    }
  });

  const showReal = realUsage.input + realUsage.output > 0;
  const display = phase === 'streaming' || !showReal ? tokens : realUsage;
  const displayCacheHit = showReal ? realUsage.cacheHit : 0;
  // v2.2 智能成本控制：本地模型（ollamaModel）不在 DeepSeek 模型表中，成本按 0 展示
  // v4.0 M3 T3.2a：多 Provider 成本统一走 costForProvider（deepseek 复用模型表；openai 走定价表；ollama 恒 0）
  const isLocalModel = providerName !== 'deepseek' && getModel(model) === undefined;
  // v5.0 T7：成本与价格档位标注用**同一时刻**，避免标签与数值取自不同档位（自相矛盾）
  const costAt = new Date();
  const cost = isLocalModel
    ? 0
    : providerName === 'deepseek'
      ? costFor(model, display.input, display.output, displayCacheHit, costAt)
      : costForProvider(
          providerName,
          model,
          display.input,
          display.output,
          displayCacheHit,
          costAt,
        );
  const hitCost =
    isLocalModel || providerName !== 'deepseek'
      ? 0
      : cacheHitCostFor(model, displayCacheHit, costAt);

  // v4.0 M3 T3.2a：会话结束成本对比提示（非 DeepSeek Provider 且已有真实 usage 时显示）
  // 「本次消费 ¥x（openai），如用 deepseek 约 ¥y」；本地模型显示 0 成本提示
  const costCompareNote =
    showReal && providerName !== 'deepseek' && phase !== 'streaming'
      ? providerName === 'ollama'
        ? t().provider.costCompareLocal
        : fmt(t().provider.sessionCostCompare, {
            actual: cost.toFixed(2),
            current: providerName,
            baseline: 'DeepSeek',
            estimate: costForProvider(
              'deepseek',
              'deepseek-v4-flash',
              display.input,
              display.output,
              displayCacheHit,
            ).toFixed(2),
          })
      : undefined;

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
      {traceStore !== undefined && <ObservabilityPanel spans={traceStore.all()} open={obsOpen} />}
      <StatusBar
        model={model}
        providerName={providerName}
        inputTokens={display.input}
        outputTokens={display.output}
        cost={cost}
        isReal={showReal && phase !== 'streaming'}
        cacheHitTokens={displayCacheHit}
        cacheHitCost={hitCost}
        mcpStatus={mcpSummary}
        fallbackNote={fallbackNote}
        costCompareNote={costCompareNote}
        priceTier={isLocalModel ? undefined : priceTierFor(costAt)}
      />
    </Box>
  );
}
