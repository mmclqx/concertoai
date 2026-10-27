/**
 * 场景提示行的**纯字符串渲染**（v5.0 T13）。
 *
 * ## 架构铁律（沿用 T9 的做法，用户重申于 T13）
 *
 * **本文件零 Ink / React 依赖**：提示行先在这里变成普通字符串，Ink 只负责给它上色
 * （`<Text dimColor>`）。这样做的三个好处：
 *
 * 1. **可测**：截断 / 取舍 / phase 门禁全是纯函数，单测不需要渲染任何组件；
 * 2. **不漂移**：文案与命令只有这一处出口，非 TTY 路径与 TUI 路径不可能说出两种话；
 * 3. **不越权**：Ink 层拿不到「拼装」的权力，也就没机会塞进自己的换行 / 边框，
 *    提示行永远是**单行**——这正是「不许挤压输入框」的前提。
 *
 * ## 三条硬要求怎么落
 *
 * | # | 要求 | 落地 |
 * |---|---|---|
 * | ② | 流式输出期间**严禁渲染** | `resolveHintLine`：`phase !== 'idle'` → `null`（流式 / 审批 / 计划审批全不渲染） |
 * | ③ | 超宽按 `displayWidth` 截断，**命令绝对完整** | `renderHintLine`：先预留「命令 + 分隔符」宽度，再截断文案；文案窄到没意义时**整句丢掉文案，只留命令** |
 * | — | 命令里不准出现未替换占位符 | 占位符替换是 T12 引擎的职责（`repeatedEditRejectionNoFile` 降级），本文件只做排版 |
 *
 * ## 为什么「宁可折行也不截断命令」
 *
 * 提示的价值全在「能直接复制执行」。一条被截成 `concertoai self…` 的命令对用户是**负价值**
 * ——他要么放弃，要么猜。所以当终端窄到连命令都放不下时，本模块**丢掉文案、保留完整命令**
 * （终端会自行折行，视觉上多一行，好过给一条假命令）。
 */

import type { Suggestion } from '../core/suggestion';
import { displayWidth, ELLIPSIS, truncateToWidth } from '../utils/text-width';

/** 文案与命令之间的分隔（两个空格：不抢眼，又能让命令在视觉上独立成段）。 */
const SEPARATOR = '  ';

/**
 * 文案的最小可用宽度（显示格）。
 *
 * 低于这个值时文案只剩三五个字（如「💡 这…」），既说不清也占地方——
 * 此时直接只显示命令（见文件头「宁可折行也不截断命令」）。
 */
export const HINT_MIN_MESSAGE_WIDTH = 12;

/** 终端列数兜底（与 `modals.tsx` 的 `contentWidth` 同口径）。 */
export const FALLBACK_COLUMNS = 80;

/**
 * 归一化终端列数：缺省 / 非法 / 非正数 → 80（测试与管道环境常见 `undefined`）。
 */
export function normalizeColumns(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) {
    return FALLBACK_COLUMNS;
  }
  return Math.floor(columns);
}

/** `renderHintLine` 入参。 */
export interface RenderHintLineInput {
  /** 提示文案（T12 引擎产出的 `Suggestion.message`，通常以 `💡 ` 开头）。 */
  message: string;
  /** 完整可执行命令（T12 引擎产出的 `Suggestion.command`）。 */
  command: string;
  /** 终端列数；缺省 80（组件层从 `process.stdout.columns` 传入）。 */
  columns?: number;
}

/**
 * 把一条提示排成**单行**字符串（纯函数）。
 *
 * 排版规则（顺序即优先级）：
 * 1. 命令**永不截断**——先给它和分隔符留足宽度；
 * 2. 剩余宽度够（≥ `HINT_MIN_MESSAGE_WIDTH`）→ 文案按显示宽度截断（带 `…`）；
 * 3. 剩余宽度不够 → **只返回命令**（文案整句丢弃，不留半句）；
 * 4. 文案为空 → 只返回命令。
 */
export function renderHintLine(input: RenderHintLineInput): string {
  const width = normalizeColumns(input.columns);
  const command = input.command.trim();
  const message = input.message.trim();

  // 没有命令就没有「可复制执行」的价值（理论上不该发生：规则表命令必填）
  if (command === '') {
    return truncateToWidth(message, width);
  }
  if (message === '') {
    return command;
  }

  const budget = width - displayWidth(command) - displayWidth(SEPARATOR);
  if (budget < HINT_MIN_MESSAGE_WIDTH) {
    // 命令优先：宁可丢掉整句文案，也不给一条会被截断/挤坏的命令
    return command;
  }
  return `${truncateToWidth(message, budget, ELLIPSIS)}${SEPARATOR}${command}`;
}

/**
 * 渲染阶段（与 `App.tsx` 的 `Phase` 同构 + 一个提示专用的 `awaiting`；本文件不 import 组件层，故自行声明）。
 *
 * 允许显示提示的只有两种「屏幕上没有别的东西在长」的时刻：
 *
 * | 阶段 | 显示 | 为什么 |
 * |---|---|---|
 * | `idle` | ✅ | 用户掌控输入框，正是「下一步该敲什么」有用的时刻 |
 * | `awaiting` | ✅ | **已提交、还没有任何产出**（等首字节 / 等模型回话）。此刻屏幕上只有 spinner，没有可被打断的输出；而用户断网 / Key 没配好时这一等就是无限长——若此时不给提示，他就**永远看不到**（v5.0 T13 实测踩到，见下方「②的边界」） |
 * | `streaming` | ❌ | 正在吐字，灰字会与输出抢同一行（用户点名禁止） |
 * | `approval` / `plan-approval` | ❌ | 审批框 / 计划确认框本身是全屏焦点，底下挂灰字会让人以为它也参与决策 |
 *
 * ## ②的边界（2026-10-28 修正）
 *
 * 原实现只认 `idle`，等于把「提示」这个**确定性事实**绑在了「这一轮对话成功跑完」上。
 * 实测后果：假 Key / 断网时 `runLoop` 一直挂起、`phase` 永远停在 `streaming`，
 * 于是「没有规则文件」这条最该早早告诉用户的提示**一次都没出现**。
 * 现在把「等首字节」从 `streaming` 里单独拆出来（`awaiting`）：②的本意是
 * 「别打断用户读流式输出」，而不是「对话没结束就别帮他」。
 */
export type HintPhase = 'idle' | 'awaiting' | 'streaming' | 'approval' | 'plan-approval';

/** `resolveHintLine` 入参。 */
export interface ResolveHintLineInput {
  /** 当前会话阶段。 */
  phase: HintPhase;
  /** 引擎判定结果（`null` = 不该提示）。 */
  suggestion: Pick<Suggestion, 'message' | 'command'> | null;
  /** 终端列数；缺省 80。 */
  columns?: number;
}

/**
 * 判定「现在该不该画这一行、画成什么」——**纯函数**，一行搞定两个门禁：
 * 阶段门禁（②，`idle` / `awaiting` 才出现，`streaming` 与审批类一律不画）与排版
 * （③，超宽截断但命令完整）。
 *
 * @returns 需要渲染的单行字符串；`null` = 不渲染（组件据此**不占任何行**，输入框不会被挤）。
 */
export function resolveHintLine(input: ResolveHintLineInput): string | null {
  if (input.suggestion === null) {
    return null;
  }
  if (!isHintVisiblePhase(input.phase)) {
    return null;
  }
  const line = renderHintLine({
    message: input.suggestion.message,
    command: input.suggestion.command,
    columns: input.columns,
  });
  return line === '' ? null : line;
}

/**
 * 该阶段是否允许出现提示（阶段门禁的**唯一**判据，组件与测试都从这里取，不各自写一份）。
 *
 * 新增阶段时**必须**在这里显式表态：默认不放行（`false`），避免「新加了个 phase
 * 就悄悄多出一行灰字」这类回归。
 */
export function isHintVisiblePhase(phase: HintPhase): boolean {
  return phase === 'idle' || phase === 'awaiting';
}
