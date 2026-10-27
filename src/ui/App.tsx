import { execSync } from 'node:child_process';
import path from 'node:path';

import { Box, Text, useApp, useInput } from 'ink';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentSpawner } from '../agent/spawner';
import type { AgentRegistry } from '../agents';
import {
  executeAgentCommand,
  executeAgentMarketCommand,
  parseAgentCommand,
} from '../cli/slash/agent';
import { executeHintsCommand, parseHintsCommand } from '../cli/slash/hints';
import { executeMcpCommand, parseMcpCommand } from '../cli/slash/mcp';
import { executeMemoryCommand, parseMemoryCommand } from '../cli/slash/memory';
import { executeModelCommand, parseModelCommand } from '../cli/slash/model';
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
import type { ApprovalInsight } from '../core/approval-insight';
import { analyzeApproval } from '../core/approval-insight';
import { appendReflection, buildReflection, isReflectionsEnabled } from '../core/reflection-store';
import { activeRiskRules } from '../core/risk-rules';
import {
  dismissHints,
  EMPTY_HINT_HISTORY,
  evaluateSuggestion,
  type HintHistory,
  isHintsEnabled,
  readHintCooldowns,
  recordSuggestionShown,
  type Suggestion,
  writeHintCooldowns,
} from '../core/suggestion';
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
import { analyzableDetail } from './approval-text';
import { HintBar } from './HintBar';
import {
  countUserTurns,
  EMPTY_REJECT_STREAK,
  hasProjectRulesFile,
  isVerifyClassCommand,
  nextFailureStreak,
  nextRejectStreak,
  type RejectStreakState,
} from './hint-signals';
import { renderMarkdownToAnsi } from './markdown';
import { ApprovalModal, PlanConfirm } from './modals';
import { ObservabilityPanel } from './ObservabilityPanel';
import { PromptInput } from './PromptInput';
import { Spinner } from './Spinner';
import { StatusBar } from './StatusBar';
import { StreamingView } from './StreamingView';
import type { ToggleThrottle } from './toggle-throttle';
import { createToggleThrottle, RENDER_THROTTLE_MS } from './toggle-throttle';

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
  /**
   * 审批洞察模式（v5.0 T9；config `approvalInsight`）：
   * `rich`（默认）= 风险教学卡；`plain` = v4.1.1 原貌（只 summary + diff）。
   */
  approvalInsightMode?: 'rich' | 'plain';
  /** 关闭的风险规则 id（config `riskRules.disabled`，v5.0 T8 配置项的消费方）。 */
  riskRulesDisabled?: readonly string[];
  /**
   * 拒绝复盘开关（v5.0 T10；由 `resolveConfig().reflections` 决定）。
   *
   * 缺省读环境变量 `CONCERTOAI_REFLECTIONS`（无则 on）。关掉后拒绝**照常工作**，
   * 只是不写记录——绝不影响审批决议。
   *
   * 为什么缺省也读环境变量：① 给嵌入式调用方（不经过 `resolveConfig`）一个开关；
   * ② 测试进程靠它兜底（`tests/setup.ts`），否则 `npm test` 会把记录写进开发者
   * 真实 home —— 实测踩到过一次（16 条测试垃圾记录）。
   */
  reflectionsEnabled?: boolean;

  /**
   * 场景提示开关（v5.0 T13；由 `resolveConfig().hints` 决定）。
   *
   * 缺省读环境变量 `CONCERTOAI_HINTS`（无则 on）。关掉后**完全不渲染**提示行，
   * chat 内 `/hints off` 亦可临时静音本次会话（会话级，不改配置）。
   *
   * 与 `reflectionsEnabled` 同口径也读环境变量：① 给嵌入式调用方一个开关；
   * ② 测试进程靠它兜底（`tests/setup.ts`），否则 `npm test` 会把冷却时间戳
   * 写进开发者真实 `~/.concertoai/hint-state.json`，导致他自己用 CLI 时提示被莫名静音。
   */
  hintsEnabled?: boolean;
  /**
   * 提示冷却状态读取/写入注入（**仅测试用**）。
   *
   * 生产不传：缺省读写 `~/.concertoai/hint-state.json`。测试必须隔离到 tmp，
   * 否则会污染开发者真实冷却状态（症状是「提示功能看起来不生效」，极难排查）。
   */
  readHintCooldownsForTest?: typeof readHintCooldowns;
  writeHintCooldownsForTest?: typeof writeHintCooldowns;

  /**
   * 复盘写入注入（**仅测试用**）。
   *
   * 生产代码不要传：缺省写 `~/.concertoai/reflections.jsonl`，测试必须隔离到 tmp 目录，
   * 否则一次 `npm test` 会污染开发者本机的真实复盘记录。
   */
  appendReflectionForTest?: typeof appendReflection;
  /**
   * 环境探测注入（测试用；缺省读 `process.stdout.isTTY` / `process.env.CI`）。
   * 生产代码不应传——降级判定必须反映真实终端环境。
   */
  insightEnv?: { isTTY?: boolean; isCI?: boolean };
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
  model: initialModel,
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
  approvalInsightMode,
  riskRulesDisabled,
  reflectionsEnabled = isReflectionsEnabled(undefined, process.env.CONCERTOAI_REFLECTIONS),
  appendReflectionForTest,
  insightEnv,
  hintsEnabled = isHintsEnabled(undefined, process.env.CONCERTOAI_HINTS),
  readHintCooldownsForTest,
  writeHintCooldownsForTest,
}: AppProps) {
  const { exit } = useApp();
  /**
   * v5.0 T6：模型可在会话内切换（`/model flash|pro|auto`）。
   * prop 只作为初值——之后由 `setModel` 接管；切换仅影响后续请求的 `model` 参数
   * （SSE 客户端按请求传模型，无需重建 client）。
   */
  const [model, setModel] = useState(initialModel);
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
  /**
   * 中性提示行（v5.0 T10）：用于「已记录到复盘」这类**不是错误**的告知。
   *
   * 为什么不复用 `error`：拒绝操作对用户是正常行为，用红字渲染会让人以为出了问题。
   */
  const [notice, setNotice] = useState<string | null>(null);
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
  /**
   * v5.0 T9：审批风险洞察（`analyzeApproval` 的结果）。
   *
   * 生命周期刻意与 `pending` **解耦**：先渲染 plain 审批框（永不等待分析），
   * 分析结果（通常 <20ms）到达后再补齐 rich 卡片。任何分析失败都只是「少给提示」。
   */
  const [pendingInsight, setPendingInsight] = useState<ApprovalInsight | null>(null);
  /** `[v]` 完整 diff / `[?]` 说明（纯展示态，不产生审批决议）。 */
  const [diffFull, setDiffFull] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * 展示态的**逻辑真值**（ref，与 state 并行维护）。
   *
   * 为什么需要 ref：连按 `v` 时同一批事件里 React 的 `diffFull` 还是旧值，
   * 用 `!diffFull` 计算意图会让 10 次连按全部算成同一个值（实测踩到：
   * 10 次连按后状态停在展开态，用户以为按键没反应）。ref 赋值是同步的，
   * 每次按键都能基于最新意图取反。
   */
  const diffFullRef = useRef(false);
  const helpOpenRef = useRef(false);
  /** 每次审批自增：用于丢弃「上一次审批」的迟到分析结果（避免串台）。 */
  const approvalSeq = useRef(0);

  // ── v5.0 T13：场景提示（M3 场景可发现）──────────────────────────────────
  /** 当前要显示的提示（`null` = 不显示；引擎已保证「同时最多 1 条」）。 */
  const [hint, setHint] = useState<Suggestion | null>(null);
  /**
   * 会话内提示开关：`hintsEnabled`（配置 / 环境变量）是**初始值**，
   * chat 内 `/hints off|on` 只改这个 state（会话级，不写配置——见 `slash/hints.ts`）。
   */
  const [hintsOn, setHintsOn] = useState(hintsEnabled);
  /** 会话历史（已展示 id / 计数 / 冷却 / 是否已被忽略），纯数据，由引擎解释。 */
  const hintHistory = useRef<HintHistory>(EMPTY_HINT_HISTORY);
  /** 全局冷却是否已从磁盘装载完成（未装载就判定会误以为「从没提示过」）。 */
  const [hintCooldownsReady, setHintCooldownsReady] = useState(false);
  /** 「同一文件连续被拒」计数（T13 采集，T12 规则表消费）。 */
  const [rejectStreak, setRejectStreak] = useState<RejectStreakState>(EMPTY_REJECT_STREAK);
  /** 「verify 类连续失败」计数（T13 采集，T12 规则表消费）。 */
  const [failureStreak, setFailureStreak] = useState(0);

  /** 生效的风险规则（config `riskRules.disabled` 消费方，T9 起真正接上）。 */
  const insightRules = useMemo(() => activeRiskRules(riskRulesDisabled), [riskRulesDisabled]);

  /** 冷却状态读写（测试可注入；缺省走 `~/.concertoai/hint-state.json`）。 */
  const readHintState = readHintCooldownsForTest ?? readHintCooldowns;
  const writeHintState = writeHintCooldownsForTest ?? writeHintCooldowns;

  /**
   * 装载全局冷却（v5.0 T13，约束③）。
   *
   * **为什么必须先装载再判定**：冷却记录决定「10 分钟内不重复」。
   * 若判定先跑，会以为「从没提示过」而立刻弹一条——用户刚启动就被提醒，
   * 正是「重启后还是被同一句话打断」的体验退化。
   */
  useEffect(() => {
    let cancelled = false;
    void readHintState()
      .then((result) => {
        if (cancelled) {
          return;
        }
        hintHistory.current = { ...hintHistory.current, cooldowns: result.cooldowns };
      })
      .catch(() => {
        // `readHintCooldowns` 自身永不抛错；这里兜住未来改动的意外（提示不该让会话崩）
      })
      .finally(() => {
        if (!cancelled) {
          setHintCooldownsReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readHintState]);

  /**
   * 判定「现在该不该提示」（v5.0 T13）。
   *
   * 触发时机刻意绑在**阶段回到 idle** 上（不随每次渲染）：提示是「这一轮结束了，
   * 你可能需要这个」，而不是「每帧都问一次模型状态」。
   *
   * 引擎（T12）负责全部硬约束；此处只交状态、收结果，并持久化冷却。
   * `phase !== 'idle'` 时清空——流式输出期间严禁渲染（用户点名要求②，`HintBar` 再挡一次）。
   */
  useEffect(() => {
    if (phase !== 'idle') {
      setHint(null);
      return;
    }
    if (!hintCooldownsReady) {
      return;
    }
    const suggestion = evaluateSuggestion({
      state: {
        userTurns: countUserTurns(messages),
        hasProjectRules: hasProjectRulesFile(ctx.cwd),
        consecutiveFailures: failureStreak,
        fileRejectStreak: rejectStreak.count,
        fileRejectFile: rejectStreak.file === '' ? undefined : rejectStreak.file,
        hintsEnabled: hintsOn,
      },
      history: hintHistory.current,
      now: Date.now(),
      // 文案走 i18n：T13 直接消费 zh/en 字典，引擎结构不变
      messages: t().hints,
    });
    if (suggestion === null) {
      setHint(null);
      return;
    }
    const now = Date.now();
    hintHistory.current = recordSuggestionShown(hintHistory.current, suggestion.id, now);
    // fire-and-forget：冷却写盘失败最多让这条提示多出现一次，不该影响会话
    void writeHintState(hintHistory.current.cooldowns, { now }).catch(() => {});
    setHint(suggestion);
  }, [
    phase,
    hintCooldownsReady,
    hintsOn,
    messages,
    failureStreak,
    rejectStreak,
    ctx.cwd,
    writeHintState,
  ]);

  /** 展示态应用（节流器的 apply）。 */
  const applyToggle = useCallback((patch: { diffFull?: boolean; helpOpen?: boolean }) => {
    if (patch.diffFull !== undefined) {
      setDiffFull(patch.diffFull);
    }
    if (patch.helpOpen !== undefined) {
      setHelpOpen(patch.helpOpen);
    }
  }, []);

  /**
   * `[v]` / `[?]` 的 80ms 节流器（T9.3c）。
   *
   * 只作用于展示态；`y` / `n` 决议**绝不**经过它（安全红线 G1）。
   */
  const toggleThrottleRef = useRef<ToggleThrottle<{
    diffFull?: boolean;
    helpOpen?: boolean;
  }> | null>(null);
  const getToggleThrottle = useCallback(() => {
    if (toggleThrottleRef.current === null) {
      toggleThrottleRef.current = createToggleThrottle(applyToggle, {
        minIntervalMs: RENDER_THROTTLE_MS,
      });
    }
    return toggleThrottleRef.current;
  }, [applyToggle]);

  // 卸载时清空待处理意图（不留悬挂 timer，T9.3c 验收）
  useEffect(
    () => () => {
      toggleThrottleRef.current?.dispose();
    },
    [],
  );

  /**
   * 拒绝时记一条本地复盘（v5.0 T10，G8 / ADR-042）。
   *
   * **顺序与容错都是刻意的**：
   * 1. 由 `finishApproval` 在 `resolve(false)` **之后**调用（决议已下发，写盘再慢也只影响提示行）；
   * 2. `void` 发出去不 await（fire-and-forget）——目录只读 / 磁盘满都不能让审批流程卡住；
   * 3. `appendReflection` 自身永不抛错，这里再兜一层 `then/catch` 只为更新提示行。
   */
  const recordRejection = useCallback(
    (request: ApprovalRequest, insight: ApprovalInsight | null) => {
      if (reflectionsEnabled === false || request.kind !== 'edit') {
        return;
      }
      /**
       * **降级 ≠ 低风险**（实测踩到，见踩坑记录 2026-10-28）。
       *
       * `analyzeApproval` 在降级时返回的空 insight 上 `level` 恒为 `'low'`
       * （因为「无命中 = low」），直接记录会让复盘表显出一片「✅ 低」——
       * 而事实是**根本没分析**。判据必须用 `degraded`，不能用 `level` 本身。
       */
      const analyzed = insight !== null && insight !== undefined && insight.degraded !== true;
      const entry = buildReflection({
        file: request.insightHint?.file,
        intent: request.insightHint?.intent,
        // 未分析（降级 / 分析未到达）→ undefined → 记为 unknown
        level: analyzed ? insight.level : undefined,
        categories: analyzed ? insight.hits.map((hit) => hit.category) : undefined,
        focusLines: analyzed ? insight.focusLines : undefined,
        cwd: ctx.cwd,
      });
      const writer = appendReflectionForTest ?? appendReflection;
      void writer(entry)
        .then((result) => {
          setNotice(result.ok ? t().reflect.recorded : t().reflect.recordFailed);
        })
        .catch(() => {
          // 防御未来改动：写盘链路上的任何异常都不该冒泡到 UI
          setNotice(t().reflect.recordFailed);
        });
    },
    [ctx.cwd, reflectionsEnabled, appendReflectionForTest],
  );

  /** 结束一次审批：清空展示态与在途分析（G1：y/n 语义与 v4.1.1 完全一致）。 */
  const finishApproval = useCallback(
    (approved: boolean, request?: ApprovalRequest | null, insight?: ApprovalInsight | null) => {
      approvalSeq.current += 1; // 让在途分析结果失效，不再回写状态
      toggleThrottleRef.current?.dispose();
      approvalResolver.current?.(approved);
      approvalResolver.current = null;
      setPending(null);
      setPendingInsight(null);
      setDiffFull(false);
      setHelpOpen(false);
      diffFullRef.current = false;
      helpOpenRef.current = false;
      setPhase('idle');
      // v5.0 T13：「同一文件连续被拒」计数（T12 规则表消费）。
      // 只统计 **edit** 审批：批准一条 shell / model 不代表用户认可了某个文件的改动，
      // 拿它去归零会让 «连续» 二字失真（`nextRejectStreak` 内部也做了 kind 无关的纯判断）。
      if (request !== undefined && request !== null && request.kind === 'edit') {
        setRejectStreak((prev) =>
          nextRejectStreak(prev, {
            file: request.insightHint?.file,
            approved,
          }),
        );
      }
      // v5.0 T10：决议已下发后才写复盘（不阻塞审批退出）
      if (!approved && request !== undefined && request !== null) {
        recordRejection(request, insight ?? null);
      }
    },
    [recordRejection],
  );

  /**
   * 审批回调：挂起当前流程，等待 y/n 按键决议。
   *
   * **G2 铁律**：审批框先出现（plain），风险洞察随后补齐——
   * 用户永远不会因为「分析慢/分析挂了」而按不了 y。
   */
  const requestApproval = useCallback(
    async (request: ApprovalRequest): Promise<boolean> => {
      approvalSeq.current += 1;
      const seq = approvalSeq.current;
      toggleThrottleRef.current?.dispose();
      setDiffFull(false);
      setHelpOpen(false);
      diffFullRef.current = false;
      helpOpenRef.current = false;
      setPendingInsight(null);
      setPending(request);
      setPhase('approval');
      // 模型切换审批是对「成本文案」的确认，没有 diff 可分析 → 不跑洞察
      if (request.kind !== 'model') {
        const hintFile = request.insightHint?.file;
        const absoluteFile = hintFile === undefined ? undefined : path.resolve(ctx.cwd, hintFile);
        void analyzeApproval(analyzableDetail(request.kind, request.detail), {
          cwd: ctx.cwd,
          file: absoluteFile,
          rules: insightRules,
          mode: approvalInsightMode,
          isTTY: insightEnv?.isTTY,
          isCI: insightEnv?.isCI,
          // 没有目标文件就没有「影响面」可言（shell 命令），别再白扫一遍全库
          skipImpact: absoluteFile === undefined,
        })
          .then((insight) => {
            if (approvalSeq.current === seq) {
              setPendingInsight(insight);
            }
          })
          .catch(() => {
            // analyzeApproval 自身永不抛错（G2）；此处仅防御未来改动
          });
      }
      return new Promise<boolean>((resolve) => {
        approvalResolver.current = resolve;
      });
    },
    [ctx.cwd, insightEnv?.isCI, insightEnv?.isTTY, insightRules, approvalInsightMode],
  );

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
          // v5.0 T13：verify 类命令的连续失败计数（T12 规则表消费）。
          // 只认「真的跑过一次质量关卡」的命令（`isVerifyClassCommand`），
          // 任意工具报错都不算——否则正常干活时会被反复提示去跑 self-heal。
          if (event.type === 'tool_result' && event.toolCall.name === 'run_command') {
            const command = extractArg(event.toolCall, 'command') ?? '';
            if (isVerifyClassCommand(command)) {
              setFailureStreak((prev) =>
                nextFailureStreak(prev, event.result.ok ? 'passed' : 'failed'),
              );
            }
          }
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

      // v5.0 T13：/hints —— 本会话静音 / 恢复 / 查看状态（约束⑤「忽略即静默」的用户入口）。
      // 放在最前面：它是纯会话内操作，不碰模型、不碰工具，先拦下来最省事。
      const hintsCmd = parseHintsCommand(trimmed);
      if (hintsCmd !== null) {
        setInput('');
        setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
        const result = executeHintsCommand(hintsCmd, { enabled: hintsOn });
        setMessages((prev) => [...prev, { role: 'user', content: text }, result.message]);
        if (result.enabled !== undefined) {
          setHintsOn(result.enabled);
        }
        if (result.dismiss === true) {
          // 立刻静默：标记 + 清掉当前正在显示的那一条（等下一帧 effect 太慢，用户会看到它闪一下）
          hintHistory.current = dismissHints(hintHistory.current);
          setHint(null);
        } else if (result.dismiss === false) {
          // /hints on：连「已忽略」一并清掉，否则「开了却再也不出提示」= 假按钮
          hintHistory.current = { ...hintHistory.current, dismissed: false };
        }
        return;
      }

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

      // v5.0 T6：/model 模型查看与切换（升级方向走审批框确认，降级直接生效；无自动切换路径）
      const modelCmd = parseModelCommand(trimmed);
      if (modelCmd !== null) {
        const modelResult = await executeModelCommand(modelCmd, {
          currentModel: model,
          providerName,
          // 确认走审批框（y/Enter 批准、n/Esc 拒绝）：与编辑/命令同一套 fail-closed 决议机制
          confirm: async (question: string) =>
            requestApproval({
              kind: 'model',
              summary: '切换模型（成本将上升）',
              detail: question,
            }),
        });
        if (modelResult.handled) {
          if (modelResult.nextModel !== undefined) {
            setModel(modelResult.nextModel);
          }
          const msg = modelResult.message ?? { role: 'assistant' as const, content: '（无输出）' };
          setMessages((prev) => [...prev, { role: 'user', content: text }, msg]);
          setTokens((t) => ({ ...t, input: t.input + estimateTokens(text) }));
          if (store !== undefined && sessionId !== undefined) {
            store.append(sessionId, msg).catch(() => {});
          }
          return;
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
          // v5.0 T13：self-heal 就是「跑一次 verify + 尝试修复」，其结果天然是
          // 「连续失败」的权威判据（`RepairVerifyResult.passed`），无需再猜命令文本。
          setFailureStreak((prev) =>
            nextFailureStreak(prev, result.result.passed ? 'passed' : 'failed'),
          );
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
      // v5.0 T6：/model 切换要判断 Provider（非 deepseek 拒绝切换），providerName 参与闭包
      providerName,
      // v5.0 T13：/hints status 的回执要反映**当前**开关状态；漏了它就是 stale closure，
      // 会永远报第一次渲染时的值（实测由 biome useExhaustiveDependencies 报红捕获）
      hintsOn,
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
        // 决议**不经节流**：安全按键必须即时响应（G1 / T9.3c 红线）
        finishApproval(true);
      } else if (input === 'n' || key.escape || (input === 'c' && key.ctrl)) {
        // v3.1 BUG 修复：审批阶段 Esc / Ctrl+C = 拒绝该操作（fail-closed），不退出应用
        // v5.0 T10：把「拒的是什么 + 当时的风险洞察」交给复盘记录
        finishApproval(false, pending, pendingInsight);
      } else if (input === 'v') {
        // 纯展示态切换，走 80ms 节流（连按只取最后一次意图，防终端闪烁）
        diffFullRef.current = !diffFullRef.current;
        getToggleThrottle().request({ diffFull: diffFullRef.current });
      } else if (input === '?') {
        helpOpenRef.current = !helpOpenRef.current;
        getToggleThrottle().request({ helpOpen: helpOpenRef.current });
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
        <ApprovalModal
          kind={pending.kind}
          summary={pending.summary}
          detail={pending.detail}
          insight={pendingInsight}
          intent={pending.insightHint?.intent}
          fullDiff={diffFull}
          showHelp={helpOpen}
          impactApplies={pending.kind === 'edit' && pending.insightHint?.file !== undefined}
          ruleCount={insightRules.length}
        />
      )}
      {plan !== null && phase === 'plan-approval' && <PlanConfirm plan={plan} />}
      {/* v5.0 T10：拒绝后的复盘提示（中性灰，不是错误——用户拒绝是正常操作） */}
      {notice !== null && <Text dimColor>{notice}</Text>}
      {/* v5.0 T13：场景提示（输入框上方单行灰字；不弹框、不进消息流、不挤压输入框） */}
      <HintBar suggestion={hint} phase={phase} />
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
