import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';

import { fmt, t } from '../i18n';
import type { LoopEvent } from '../loop/loop';
import { runLoop } from '../loop/loop';
import { userMessage } from '../loop/messages';
import type { ChatMessage, ToolCall } from '../loop/types';
import type { ModelClient } from '../model/client';
import { costFor, getModel } from '../model/models';
import { estimateMessageListTokens, estimateTokens } from '../model/tokenizer';
import type { SessionStore } from '../store/session';
import type { ApprovalRequest, ToolContext, ToolRegistry } from '../tools/registry';
import { ApprovalModal, PlanConfirm } from './modals';
import { PromptInput } from './PromptInput';
import { Spinner } from './Spinner';
import { StatusBar } from './StatusBar';
import { StreamingView } from './StreamingView';

type Phase = 'idle' | 'streaming' | 'approval' | 'plan-approval';

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
}

/**
 * 优化 v1.1：终端显示截断上限从 1,000 提高到 8,000 字符，截断时在末尾显示完整字符数。
 * 完整内容始终保存在会话 JSONL 中，不会丢失。
 */

/** 终端单消息最大显示字符数（超过则截断显示，但完整内容已落盘）。 */
const MAX_DISPLAY_CHARS = 8_000;

/** 单条消息的渲染：角色前缀 + 内容（超长截断显示）。 */
function MessageLine({ message }: { message: ChatMessage }) {
  const prefix = message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : '工具';
  const color =
    message.role === 'user' ? 'cyan' : message.role === 'assistant' ? 'white' : 'yellow';
  const body = message.content ?? '';
  const display =
    body.length > MAX_DISPLAY_CHARS
      ? `${body.slice(0, MAX_DISPLAY_CHARS)}…（共 ${body.length} 字符，终端仅显示前 ${MAX_DISPLAY_CHARS}）`
      : body;
  return (
    <Box flexDirection="column">
      <Text bold color={color}>
        {prefix}
      </Text>
      <Text>{display}</Text>
    </Box>
  );
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
  const [realUsage, setRealUsage] = useState({ input: 0, output: 0 });
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
        const onEvent = makeOnEvent(controller);
        const result = await runLoop(
          {
            model,
            client,
            registry,
            ctx: ctxWithApproval,
            systemPrompt,
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
  const cost = costFor(model, display.input, display.output);

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 聊天历史只追加不重排，索引 key 稳定
        <MessageLine key={i} message={m} />
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
      />
    </Box>
  );
}
