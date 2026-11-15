/**
 * 交接单（v5.3 N4）：退出时把「做到哪 / 验收过没有 / 下一步敲什么 / 为什么退出」
 * 落成一份四栏文件，供**下次进入**直接读。
 *
 * ## 三条边界（任务书 §0.1 硬禁则 3）
 *
 * 1. **不许调模型**：`buildHandoff` 是纯函数，输入只有 messages + reason + ctx，
 *    输出是字符串。没有任何 IO、不读时钟（`now` 由调用方传入）。
 * 2. **不许编内容**：取不到就写「无记录」/「未返回结果」，**绝不**用一句
 *    「基本通过」糊过去。四栏任一为空串都是 bug（有用例钉住）。
 * 3. **落点是 `~/.concertoai/handoffs/<项目 key>/handoff.md`**（用户 2026-11-14 裁决方案 B）：
 *    不碰用户工程目录 ⇒ 也**不需要** `.git/info/exclude`。
 *
 * ## 为什么全部同步写
 *
 * 任务书原文 ①② 写「异步」、④ 写「同步」。实现上**统一同步**，理由：
 * ③ 的两个出口在 `useInput` 回调里、`exit()` 本身是同步的 —— 若写成
 * `await finalizeSession()` 再退出，就必须 `void (async () => …)()`，
 * 一旦写盘挂住，用户按了 Ctrl+C **却退不出去**，这比没有交接单更糟。
 * 写一个几 KB 的文件是毫秒级，同步的确定性远比那点开销值钱。
 * ④（crash-handler）本来就只能同步，于是四条出口共用同一条路径，格式不会漂。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isToolErrorContent } from '../loop/messages';
import type { ChatMessage } from '../loop/types';
import { handoffsDir, projectKeyFor } from '../store/paths';

/** 退出原因（四栏之 ④ 的唯一来源，类型强制不会缺失）。 */
export type ExitReason =
  | { kind: 'completed' }
  | { kind: 'max-turns'; used: number; cap: number }
  | { kind: 'interrupted' }
  | { kind: 'error'; message: string };

/** `buildHandoff` 的上下文（时间由调用方注入，便于测试）。 */
export interface HandoffContext {
  cwd: string;
  sessionId?: string;
  now: Date;
}

/** ② 栏最多列出的命令条数。 */
export const MAX_ACCEPTANCE_LINES = 20;

/** ① 栏「最后一条助手结论」的截断长度。 */
export const MAX_SUMMARY_CHARS = 80;

/** 消费端只认 24 小时内的交接单（T2.3）。 */
export const HANDOFF_FRESH_HOURS = 24;

/**
 * 交接单存放路径（方案 B：按项目绝对路径哈希分目录）。
 *
 * 目录名 = `<项目名安全化>-<路径 sha256 前 12 位>`：
 * - 带项目名是给人看的（`ls ~/.concertoai/handoffs` 能认出是哪个项目）；
 * - 带哈希是为了**同名不同路径**的两个项目不会互相覆盖（`D:\a\app` 与 `E:\b\app`）。
 *
 * Windows 上路径比较**大小写不敏感**，故参与哈希前统一小写——否则同一个项目
 * 换个大小写写法就变成两个目录，下次进来读不到自己的交接单。
 */
export function handoffPath(cwd: string): string {
  const abs = path.resolve(cwd);
  const identity = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const base = projectKeyFor(path.basename(abs));
  return path.join(handoffsDir(), `${base}-${digest}`, 'handoff.md');
}

// ── ① 的内部数据结构：工具调用与它的一次回填配对 ────────────────

interface Invocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 回填内容；`undefined` = 这次调用没有拿到结果（被中断 / 还在跑）。 */
  result?: string;
  /** 在会话里的序号（保持时间顺序，用于「失败优先 + 最近优先」的取舍）。 */
  index: number;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // 参数不是合法 JSON（模型偶发）→ 当作空对象，不抛错：交接单不能因为一条脏数据就写不出来
    return {};
  }
}

/**
 * 把 messages 摊成「调用 → 回填」配对列表（按调用顺序）。
 *
 * 配对靠 `toolCallId`：assistant 消息的 `toolCalls[]` 与 tool 消息的 `toolCallId` 是
 * 同一事实的两端。**不做位置配对**（假设「tool 消息紧跟在后面」在并行工具调用、
 * 中途中断、会话恢复三种情况下都不成立）。
 */
function collectInvocations(messages: readonly ChatMessage[]): Invocation[] {
  const byId = new Map<string, Invocation>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (!byId.has(call.id)) {
          byId.set(call.id, {
            id: call.id,
            name: call.name,
            args: parseArgs(call.arguments),
            index: byId.size,
          });
        }
      }
      continue;
    }
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      const invocation = byId.get(message.toolCallId);
      if (invocation !== undefined) {
        // 同名 id 多次回填时保留**第一条**：那才是这次调用的真实结果
        invocation.result ??= message.content ?? '';
      }
    }
  }
  return [...byId.values()];
}

const firstLineOf = (text: string): string => text.trim().split(/\r?\n/)[0]?.trim() ?? '';

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** ① 做到哪一步。 */
function buildWhereSection(messages: readonly ChatMessage[], invocations: Invocation[]): string {
  const edits = invocations.filter(
    (item) =>
      (item.name === 'edit_file' || item.name === 'write_file') &&
      item.result !== undefined &&
      !isToolErrorContent(item.result) &&
      typeof item.args.path === 'string' &&
      item.args.path !== '',
  );
  const lastEdit = edits.at(-1);

  const lastAssistantText = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.trim() !== '',
    );

  const lines: string[] = [];
  if (lastEdit === undefined) {
    lines.push('无记录（本会话没有文件改动）');
  } else {
    lines.push(`最后改动的文件：\`${String(lastEdit.args.path)}\``);
  }
  if (lastAssistantText === undefined) {
    lines.push('无记录（本会话没有助手文本）');
  } else {
    lines.push(
      `最后一条助手结论：${truncate(firstLineOf(String(lastAssistantText.content)), MAX_SUMMARY_CHARS)}`,
    );
  }
  return lines.join('\n');
}

interface CommandOutcome {
  invocation: Invocation;
  command: string;
  failed: boolean;
  /** 失败时的首行原因（已剥掉工具名与标记）。 */
  reason?: string;
}

function commandOutcomes(invocations: Invocation[]): CommandOutcome[] {
  const outcomes: CommandOutcome[] = [];
  for (const invocation of invocations) {
    if (invocation.name !== 'run_command') {
      continue;
    }
    const rawCommand = invocation.args.command;
    const command =
      typeof rawCommand === 'string' && rawCommand.trim() !== ''
        ? rawCommand.trim()
        : '（未记录命令内容）';
    if (invocation.result === undefined) {
      outcomes.push({ invocation, command, failed: false });
      continue;
    }
    const failed = isToolErrorContent(invocation.result);
    outcomes.push({
      invocation,
      command,
      failed,
      ...(failed ? { reason: failureReason(invocation.result) } : {}),
    });
  }
  return outcomes;
}

/**
 * 从失败回填里取出「失败原因首行」。
 *
 * 形态固定为 `工具 <name> 执行失败: <error>`（见 `formatToolFailure`），
 * 故按标记切一次即可，**不做正则猜**。
 */
function failureReason(content: string): string {
  const at = content.indexOf(' 执行失败: ');
  const detail = at === -1 ? content : content.slice(at + ' 执行失败: '.length);
  return truncate(firstLineOf(detail), MAX_SUMMARY_CHARS);
}

/**
 * ② 栏取样：**失败优先，其次最近**。
 *
 * 为什么不简单地「取最后 20 条」：③ 栏靠「第一条失败的命令」给出下一步，
 * 若那条失败正好被 20 条上限截掉，用户会看到「继续上次任务」而真相是「有命令没过」。
 * 这是**静默的谎**。故超过上限时先保失败项（最多 20），剩余名额按时间倒序补成功项。
 */
function sampleOutcomes(outcomes: CommandOutcome[]): { shown: CommandOutcome[]; hidden: number } {
  if (outcomes.length <= MAX_ACCEPTANCE_LINES) {
    return { shown: outcomes, hidden: 0 };
  }
  const keep = new Set<number>();
  for (const outcome of outcomes.filter((item) => item.failed).slice(-MAX_ACCEPTANCE_LINES)) {
    keep.add(outcome.invocation.index);
  }
  for (let i = outcomes.length - 1; i >= 0 && keep.size < MAX_ACCEPTANCE_LINES; i -= 1) {
    const outcome = outcomes[i];
    if (outcome !== undefined) {
      keep.add(outcome.invocation.index);
    }
  }
  const shown = outcomes.filter((outcome) => keep.has(outcome.invocation.index));
  return { shown, hidden: outcomes.length - shown.length };
}

/** ② 栏：每条 `run_command` 一行。 */
function buildAcceptanceSection(outcomes: CommandOutcome[]): string {
  if (outcomes.length === 0) {
    return '无记录（本会话没有跑过命令）';
  }
  const { shown, hidden } = sampleOutcomes(outcomes);
  const lines = shown.map((outcome) => {
    if (outcome.invocation.result === undefined) {
      // 没有回填 ≠ 成功。写 ✅ 就是编内容（硬禁则 3）
      return `⏳ ${outcome.command}（未返回结果）`;
    }
    return outcome.failed
      ? `❌ ${outcome.command}（失败：${outcome.reason ?? '未知错误'}）`
      : `✅ ${outcome.command}`;
  });
  if (hidden > 0) {
    lines.push(`……另有 ${hidden} 条未列出`);
  }
  return lines.join('\n');
}

/** ③ 栏：下一步敲什么。 */
function buildNextSection(messages: readonly ChatMessage[], shown: CommandOutcome[]): string {
  const firstFailure = shown.find((outcome) => outcome.failed);
  if (firstFailure !== undefined) {
    // 原文放进代码块：用户可直接复制重跑，不需要从一句话里摘命令
    return ['先重跑这条（它没过）：', '```bat', firstFailure.command, '```'].join('\n');
  }
  const lastAssistantText = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.trim() !== '',
    );
  if (lastAssistantText !== undefined) {
    return `继续上次任务：${truncate(firstLineOf(String(lastAssistantText.content)), MAX_SUMMARY_CHARS)}`;
  }
  return '无（上次已收尾）';
}

/**
 * ④ 栏的四句文案（**两两不同**，有用例断言 `new Set(...).size === 4`）。
 *
 * 为什么不共用一个模板只因变量不同：四句要回答的其实是四个不同问题——
 * 「做完了」「被闸门截断」「你按了键」「程序崩了」，混成模板会让用户分不清
 * 「是我自己退的，还是它出事了」。
 */
export function exitReasonText(reason: ExitReason): string {
  switch (reason.kind) {
    case 'completed':
      return '正常收尾（本会话任务已完成）';
    case 'max-turns':
      // used 与 cap 都取自调用方的真实值：撞上限时 used 必然等于 cap，
      // 这不是估算——`runLoop` 只回 `interrupted: boolean`，中途轮数没有单独计数，
      // 编一个中间值才是撒谎。轮数上限可能是 `-t` 指定的，故不写死 50。
      return `撞工具轮数上限（${reason.used}/${reason.cap}），任务未跑完`;
    case 'interrupted':
      return '用户中断（Ctrl+C / Esc）';
    case 'error':
      return `异常退出：${truncate(firstLineOf(reason.message), MAX_SUMMARY_CHARS)}`;
  }
}

/** 退出原因的**短标签**（消费端打印「上次交接：<标签>」用，与 ④ 栏正文区分）。 */
export function exitReasonLabel(reason: ExitReason): string {
  switch (reason.kind) {
    case 'completed':
      return '正常收尾';
    case 'max-turns':
      return `撞轮数上限（${reason.used}/${reason.cap}）`;
    case 'interrupted':
      return '用户中断';
    case 'error':
      return '异常退出';
  }
}

/** 会话里是否存在工具调用（`① 正常收尾` 要不要写交接单的判据：纯闲聊不写）。 */
export function sessionHasToolCalls(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'tool');
}

/**
 * 生成四栏交接单（**纯函数**：无 IO、不读时钟）。
 *
 * 输出形态（消费端按 `> ` 行解析）：
 * ```
 * # 交接单 — <cwd>
 * > 项目: <cwd>
 * > 会话: <sessionId 或 无>
 * > 写入时间: <ISO>
 * > 退出原因: <kind>
 * > 退出原因标签: <短标签>
 * ## ① 做到哪一步 …
 * ```
 */
export function buildHandoff(
  messages: readonly ChatMessage[],
  reason: ExitReason,
  ctx: HandoffContext,
): string {
  const invocations = collectInvocations(messages);
  const outcomes = commandOutcomes(invocations);
  const { shown } = sampleOutcomes(outcomes);
  const cwd = path.resolve(ctx.cwd);
  const header = [
    `# 交接单 — ${path.basename(cwd)}`,
    `> 项目: ${cwd}`,
    `> 会话: ${ctx.sessionId ?? '无'}`,
    `> 写入时间: ${ctx.now.toISOString()}`,
    `> 退出原因: ${reason.kind}`,
    `> 退出原因标签: ${exitReasonLabel(reason)}`,
    '',
  ];
  const sections = [
    '## ① 做到哪一步',
    buildWhereSection(messages, invocations),
    '',
    '## ② 验收',
    buildAcceptanceSection(outcomes),
    '',
    '## ③ 下一步',
    buildNextSection(messages, shown),
    '',
    '## ④ 为什么退出',
    exitReasonText(reason),
    '',
  ];
  return [...header, ...sections].join('\n');
}

/** 写盘结果：成功给路径，失败给 `undefined`（**失败静默**，不影响退出流程）。 */
export function writeHandoff(text: string, cwd: string): string | undefined {
  const file = handoffPath(cwd);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * 「已经为这次退出写过交接单」的标记（**按退出事件幂等，不按会话**）。
 *
 * ## 为什么不能按会话幂等（第一版就是这么写的，是错的）
 *
 * 按 `sessionId` 去重时，一次会话里**第一次**收尾就把记录锁死了：
 * 用户第一轮跑完（写 `completed`）→ 继续干活 → 最后 Ctrl+C 退出，
 * 而交接单还停在第 1 轮的 `completed`。下次进来读到「上次正常收尾」，
 * 真相却是「撞了轮数上限就跑了」——**过期的记录比没有记录更糟**。
 *
 * 所以幂等的对象是**这一次退出**：`exit()` 与 `SIGINT` 兜底可能都触发，
 * 那是同一个事件，只写一次；而不同时间的收尾各写各的，最后写的赢。
 *
 * **测试必须复位**（AGENTS「进程级全局状态隔离」）：用 `resetHandoffState()`。
 */
let exitWritten = false;

/** 复位幂等状态与「当前会话快照」（仅测试用）。 */
export function resetHandoffState(): void {
  exitWritten = false;
  activeSession = undefined;
}

/**
 * 四条退场出口共用的收尾函数（同步）。
 *
 * @param options.terminal 是不是**真退出**（③ Ctrl+C / Esc、④ 崩溃）：
 * - `true` ⇒ 按退出事件幂等（同一次退出只写一次），写的是最终状态；
 * - `false`/省略 ⇒ 会话中途的快照（① 正常收尾、② 撞上限），**每次都写**，不设锁。
 * @returns 写入的文件路径；已写过（同一次退出）/ 写失败时为 `undefined`
 */
export function finalizeSession(
  messages: readonly ChatMessage[],
  reason: ExitReason,
  ctx: HandoffContext,
  options: { terminal?: boolean } = {},
): string | undefined {
  if (options.terminal === true) {
    if (exitWritten) {
      return undefined;
    }
    // 先标记再写：写盘失败也不重试——退出路径上再抛一次错只会让用户退不出去
    exitWritten = true;
  }
  return writeHandoff(buildHandoff(messages, reason, ctx), ctx.cwd);
}

// ── 崩溃出口（④）需要的「当前会话快照」 ─────────────────────────
//
// `crash-handler` 是全局安装的，拿不到 React 的 messages；而崩溃时**没有时机**
// 再去做一次异步取数。所以由 App 在消息变化时把快照登记到这里，
// 崩溃处理器只读快照。`process.exit()` 前同步写完，不依赖任何 await。

interface ActiveSession {
  messages: readonly ChatMessage[];
  cwd: string;
  sessionId?: string;
}

let activeSession: ActiveSession | undefined;

/** 登记当前会话快照（App 每轮消息变化后调用）。 */
export function setActiveSession(session: ActiveSession): void {
  activeSession = session;
}

/** 清掉快照（退出后避免陈旧数据被后续代码读到）。 */
export function clearActiveSession(): void {
  activeSession = undefined;
}

/**
 * 为「当前会话」写交接单（崩溃出口用）。
 *
 * 没有快照时返回 `undefined`（例如崩溃发生在 UI 挂载之前）——
 * **不编造一份空交接单**：那会让下次进来读到「无记录」而误以为上次什么都没干。
 */
export function finalizeActiveSession(reason: ExitReason): string | undefined {
  if (activeSession === undefined) {
    return undefined;
  }
  return finalizeSession(
    activeSession.messages,
    reason,
    {
      cwd: activeSession.cwd,
      ...(activeSession.sessionId !== undefined ? { sessionId: activeSession.sessionId } : {}),
      now: new Date(),
    },
    { terminal: true },
  );
}

/**
 * 出口 ③ 的**进程级兜底**（2026-11-15 真 TTY 实测补上的第三条接线）。
 *
 * ## 为什么 `useInput` 与 `SIGINT` 两条都收不到 Ctrl+C
 *
 * Ink 7 的按键分发（`node_modules/ink/build/components/App.js:148-159`）是：
 *
 * ```js
 * if (input === '\x03' && exitOnCtrlC) {
 *   handleExit();   // → 只 unmount，不 process.exit()
 *   return;         // ← 在 emit 'input' 事件之前就返回了
 * }
 * ```
 *
 * 两个后果：① `useInput` 的处理器**永远看不到** Ctrl+C（`App.tsx` 里那段
 * `input === 'c' && key.ctrl` 是真机上的死代码）；② 终端处于 raw mode，
 * 那个 `\x03` 是一个**字节而不是信号**，`process.on('SIGINT')` 同样不触发。
 * 于是进程自然结束（退出码 0），交接单停在上一次快照——真机实测
 * `> 退出原因: completed`，而用户是 Ctrl+C 退的（门 6「四退场格式统一」判红）。
 *
 * ## 为什么选 `process.on('exit')`
 *
 * 它是上述所有路径下**唯一必然发生**的事件（Ink 自然卸载、`process.exit(130)`、
 * 崩溃处理器的 `exit(1)`），且允许**同步**写盘——与崩溃出口同步写是同一个理由。
 *
 * ## 三条「不写」（缺任一条就会造出假记录）
 *
 * 1. 没有快照（UI 从未挂载，例如 `doctor` 之类的非交互命令）⇒ 不写；
 * 2. 快照里一条消息都没有（「打开就退」）⇒ 不写（AGENTS §已知边界 B1 的降噪裁决）；
 * 3. 本次退出**已经**由 terminal 出口写过（`exit()` / 崩溃）⇒ 不覆盖，
 *    `finalizeSession(terminal: true)` 的幂等标志正是为这一步设的。
 */
export function writeHandoffAtProcessExit(): string | undefined {
  if (activeSession === undefined || activeSession.messages.length === 0) {
    return undefined;
  }
  return finalizeActiveSession({ kind: 'interrupted' });
}

let exitHookInstalled = false;

/**
 * 装一次「进程退出」兜底（幂等）。返回卸载函数供测试使用。
 *
 * 只在 CLI 入口（`chat.tsx`）调用一次：放在模块级会污染 vitest 进程
 * （UI 用例挂载真 App ⇒ 进程结束时往用例的临时 cwd 写盘）。
 */
export function installHandoffExitHook(): () => void {
  if (exitHookInstalled) {
    return () => {
      /* 已装过：不重复注册，交给第一个装的人卸载 */
    };
  }
  exitHookInstalled = true;
  const handler = (): void => {
    writeHandoffAtProcessExit();
  };
  process.on('exit', handler);
  return () => {
    process.off('exit', handler);
    exitHookInstalled = false;
  };
}

/** 读到的交接单（消费端判定的三种结论）。 */
export type HandoffReading =
  | { kind: 'none' }
  | { kind: 'fresh'; path: string; text: string; reasonLabel: string; ageHours: number }
  | { kind: 'stale'; path: string; why: 'other-project' | 'too-old'; days: number };

/**
 * 读交接单并判定新鲜度（T2.3）。
 *
 * 规则三段（必须都能命中）：
 * 1. 文件不存在 ⇒ `none`（**什么也不打印**——「未找到交接单」是噪音）；
 * 2. 同项目 且 距今 < 24h ⇒ `fresh`；
 * 3. 其他 ⇒ `stale`（异项目 / 太旧）。
 *
 * ## 异项目这一支在方案 B 下是「防御性检查」
 *
 * 落点按项目路径哈希分目录 ⇒ 读的是**本项目自己的目录**，正常不会读到别人的交接单。
 * 但仍要判：目录可能被用户手动复制、项目目录被移动后又搬回旧路径、
 * 或哈希改名等边界。**判据始终以文件头里的 `> 项目:` 为准**（那是写入时的绝对路径），
 * 不以目录名为准。
 */
export function readHandoff(cwd: string, now: Date): HandoffReading {
  const file = handoffPath(cwd);
  if (!existsSync(file)) {
    return { kind: 'none' };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // 读不动就当没有：不能因为交接单坏了就让 CLI 起不来
    return { kind: 'none' };
  }
  const projectLine = headerValue(text, '项目');
  const writtenLine = headerValue(text, '写入时间');
  const writtenAt = writtenLine === undefined ? Number.NaN : Date.parse(writtenLine);
  const ageMs = now.getTime() - writtenAt;
  const ageHours = Number.isFinite(ageMs) ? ageMs / 3_600_000 : Number.POSITIVE_INFINITY;
  const days = Math.max(1, Math.floor(ageHours / 24));

  const project = path.resolve(cwd);
  const sameProject =
    projectLine !== undefined && normalizePath(projectLine) === normalizePath(project);

  if (!sameProject) {
    return { kind: 'stale', path: file, why: 'other-project', days };
  }
  if (!(ageHours < HANDOFF_FRESH_HOURS)) {
    // 时间读不出来（NaN）也归「太旧」：宁可不注入，也不把一份不知道多旧的东西塞进上下文
    return { kind: 'stale', path: file, why: 'too-old', days };
  }
  return {
    kind: 'fresh',
    path: file,
    text,
    reasonLabel: headerValue(text, '退出原因标签') ?? '未记录',
    ageHours,
  };
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 取 `> 键: 值` 行的值（只认**文件头部区**，正文里同形文本不算）。
 *
 * ## 边界是「第一个 `## ` 小节」，不是「第一个非 `>` 行」（第一版写错了，实测踩到）
 *
 * 交接单第一行是 `# 交接单 — <项目名>`（一级标题），既不是 `> ` 开头也不是空行。
 * 按「遇到非 `> ` 就停」的写法，**第一行就把扫描停掉了**，于是 `> 项目:` 永远读不到
 * ⇒ 消费端每次都判「另有项目，已忽略」⇒ 交接单写了等于没写。
 *
 * 这个缺陷很安静：文件生成正常、四栏都对、`git status` 干净，只有「下次进来读不到」
 * 这一件事坏掉。抓到它的是 `tests/cli/handoff.test.ts` 的「同项目 + 1 小时前 ⇒ fresh」。
 */
function headerValue(text: string, key: string): string | undefined {
  const prefix = `> ${key}: `;
  const headerEnd = text.indexOf('\n## ');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  for (const line of header.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return undefined;
}

/** 注入给模型的上下文长度上限（T2.3：超出截断并注明）。 */
export const MAX_INJECT_CHARS = 4_000;

/**
 * 消费端一步到位：读交接单 → 给「提示行」与「注入内容」。
 *
 * 把「怎么判」与「怎么用」分开：`readHandoff` 只判定，这里只负责按判定结果
 * 生成两段文本，入口层（`chat.tsx` / `run.ts`）只负责打印与拼接——不各自实现一遍规则。
 */
export function consumeHandoff(cwd: string, now: Date): { notice?: string; inject?: string } {
  const reading = readHandoff(cwd, now);
  if (reading.kind === 'none') {
    return {};
  }
  if (reading.kind === 'stale') {
    const why = reading.why === 'other-project' ? '另有项目' : `${reading.days} 天前`;
    return { notice: `发现旧交接单（${why}），已忽略：${reading.path}` };
  }
  const truncated =
    reading.text.length > MAX_INJECT_CHARS
      ? `${reading.text.slice(0, MAX_INJECT_CHARS)}\n…（交接单过长已截断，完整内容：${reading.path}）`
      : reading.text;
  return {
    notice: `上次交接：${reading.reasonLabel}（${Math.max(1, Math.round(reading.ageHours))} 小时前）· ${reading.path}`,
    inject: truncated,
  };
}
