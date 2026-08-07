import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';

import { fmt, zh } from '../i18n/zh';
import type { LoopEvent } from '../loop/loop';
import { runLoop } from '../loop/loop';
import type { ChatMessage, ToolCall } from '../loop/types';
import type { ModelClient } from '../model/client';
import { costFor } from '../model/models';
import { estimateMessageListTokens, estimateTokens } from '../model/tokenizer';
import type { SessionStore } from '../store/session';
import type { ApprovalRequest, ToolContext, ToolRegistry } from '../tools/registry';
import { ApprovalModal } from './modals';
import { PromptInput } from './PromptInput';
import { StatusBar } from './StatusBar';
import { StreamingView } from './StreamingView';

type Phase = 'idle' | 'streaming' | 'approval';

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
}

/** 单条消息的渲染：角色前缀 + 内容（超长截断显示）。 */
function MessageLine({ message }: { message: ChatMessage }) {
  const prefix = message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : '工具';
  const color =
    message.role === 'user' ? 'cyan' : message.role === 'assistant' ? 'white' : 'yellow';
  const body = message.content ?? '';
  const display = body.length > 1_000 ? `${body.slice(0, 1_000)}…（显示截断）` : body;
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

  /** 审批回调：挂起当前流程，等待 y/n 按键决议。 */
  const requestApproval = useCallback(async (request: ApprovalRequest): Promise<boolean> => {
    setPending(request);
    setPhase('approval');
    return new Promise<boolean>((resolve) => {
      approvalResolver.current = resolve;
    });
  }, []);

  const ctxWithApproval = useMemo<ToolContext>(
    () => ({ ...ctx, requestApproval }),
    [ctx, requestApproval],
  );

  const send = useCallback(
    async (text: string) => {
      if (busy.current || text.trim() === '') {
        return;
      }
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
        const onEvent = (event: LoopEvent): void => {
          if (event.type === 'chunk') {
            setStreamed((s) => s + event.text);
          } else if (event.type === 'tool_call') {
            setActiveTool(event.toolCall);
          } else if (event.type === 'usage') {
            setRealUsage((u) => ({
              input: u.input + event.usage.prompt_tokens,
              output: u.output + event.usage.completion_tokens,
            }));
          } else {
            setActiveTool(null);
          }
        };
        const result = await runLoop(
          {
            model,
            client,
            registry,
            ctx: ctxWithApproval,
            systemPrompt,
            onEvent,
          },
          history,
          text,
        );
        const added = result.slice(history.length);
        setMessages(result);
        setTokens((t) => ({ ...t, output: t.output + estimateMessageListTokens(added) }));
        if (store !== undefined && sessionId !== undefined) {
          await store.appendAll(sessionId, added);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPhase('idle');
        busy.current = false;
      }
    },
    [client, ctxWithApproval, messages, model, registry, store, sessionId, systemPrompt],
  );

  useInput((input, key) => {
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
      {activeTool !== null && (
        <Text dimColor>{fmt(zh.ui.toolRunning, { name: activeTool.name })}</Text>
      )}
      {pending !== null && phase === 'approval' && (
        <ApprovalModal kind={pending.kind} summary={pending.summary} detail={pending.detail} />
      )}
      {error !== null && <Text color="red">{error}</Text>}
      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={(t) => {
          void send(t);
        }}
        placeholder={zh.prompt.placeholder}
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
