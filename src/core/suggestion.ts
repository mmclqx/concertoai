/**
 * 场景提示引擎（v5.0 T12 / M3 第一条规则表，ADR-044 · D74-D75）。
 *
 * ## 这是什么
 *
 * 用户卡住时，在其**输入框上方**给一行灰字 + 一条**可直接复制执行**的命令。
 * 它不解释原理、不做对话、不进消息流——只回答一个问题：「下一步该敲什么」。
 *
 * ## 设计取向：宁少勿多（M3 第一条红线「去噪优先」）
 *
 * v4.0 的教训是「进度刷屏 / 输出淹没」——任何**可能频繁触发**的提示最终都会变成噪音，
 * 用户一旦学会无视它，这个功能就等于不存在。所以：
 *
 * | 决策 | 做法 | 为什么 |
 * |---|---|---|
 * | 触发条件 | 只允许**确定性**事实（有没有规则文件 / 连续失败几轮 / 同一文件被拒几次） | 耗时、Token 数、消息长度、模型自评这类**间接信号**不可靠，且天然高频 |
 * | 不做权重打分 | 没有 score、没有阈值调参，规则只有「命中 / 不命中」 | 打分状态机 = 噪音工厂（见 `v5.0-dev-plan.md` 的去噪铁律） |
 * | 硬上限写进引擎 | 见下方七条硬约束 | 「靠调用方自觉」等于没有约束——调用方会有多个（TUI / run / 未来 IDE），规则只有一处 |
 *
 * ## 七条硬约束（**在引擎内实现**，不靠调用方自觉）
 *
 * | # | 约束 | 落地 |
 * |---|---|---|
 * | ① | 同时最多返回 **1 条**（priority 最高者） | `evaluateSuggestion` 内排序取首个 |
 * | ② | 同一 `id` **每会话 1 次** | `history.shownIds` |
 * | ③ | 同一 `id` **全局 10 分钟冷却**（跨进程重启仍生效） | `history.cooldowns` + `hint-state.json` |
 * | ④ | 每会话**总计最多 3 条**（跨 id） | `history.shownCount` vs `MAX_HINTS_PER_SESSION` |
 * | ⑤ | 用户按 Esc / 忽略 → **本会话立刻全静默** | `history.dismissed` + `dismissHints` |
 * | ⑥ | `hints: 'off'`（或环境变量关）→ 恒 `null` | `state.hintsEnabled` 入口判定 |
 * | ⑦ | 引擎**纯函数**：无 IO、不直接调 `Date.now()` | 时间一律注入 `now` |
 *
 * ## 为什么不打空头支票（用户新增的第 4 条红线）
 *
 * 提示里的命令是**承诺**。T10 吃过一次亏（审批卡文案承诺了当时尚未实现的
 * `config set reflections off`），所以本文件的三条命令全部当场核实过：
 *
 * | 规则 | 命令 | 核实方式 |
 * |---|---|---|
 * | `missing-project-rules` | `concertoai init` | `src/cli/index.ts` 已 `.command('init')` |
 * | `repeated-verify-failure` | `concertoai self-heal` | `src/cli/index.ts` 已 `.command('self-heal')` |
 * | `repeated-edit-rejection` | `/review <真实文件>` | `App.tsx` 斜杠分派 + `parseReviewCommand` |
 *
 * `tests/core/suggestion.test.ts` 的护栏用例会**真跑 `--help`** 断言命令存在
 * （不是断言「文案里有这个字符串」，而是断言「这个命令真的注册过」）。
 *
 * ⚠️ 历史坑位记录：任务书 T13 表格里写的是 `concertoai fix`——该命令**至今不存在**
 * （属 M4 T15-T19）。已按用户拍板改为 `concertoai self-heal`；等 M4 落地 `fix` 后
 * **下个版本**再加规则，禁止提前把未实现的命令写进提示。
 *
 * ## 分层（对齐 `core/reflection-store.ts`）
 *
 * - 上：**纯判定层**（`evaluateSuggestion` / 规则表 / `recordSuggestionShown` / `dismissHints`）
 *   ——无 IO、无全局状态，单测不需要 mock 文件系统；
 * - 下：**IO 层**（`readHintCooldowns` / `writeHintCooldowns`）负责
 *   `~/.concertoai/hint-state.json` 读写，**永不抛错**（提示是可选便利功能，
 *   磁盘满 / 目录只读都不该让用户的对话崩掉）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fmt, zh } from '../i18n/zh';
import { hintStatePath } from '../store/paths';

// ── 常量（改这里之前先读文件头「宁少勿多」） ──

/** 同一规则 id 的全局冷却窗口：10 分钟（跨进程重启仍生效，见 `hint-state.json`）。 */
export const HINT_COOLDOWN_MS = 10 * 60 * 1000;

/** 每会话提示**总**上限（跨 id，第 ④ 条硬约束「3 条封顶」）。 */
export const MAX_HINTS_PER_SESSION = 3;

/** 冷却记录最多保留多少条（防长期使用无限增长；超出按时间淘汰最旧的）。 */
export const MAX_COOLDOWN_ENTRIES = 50;

/** 状态文件 schema 版本（未来改格式时用于识别旧文件）。 */
export const HINT_STATE_VERSION = 1;

/** CLI 可执行名（提示命令的统一前缀，避免文案里手写拼错）。 */
const CLI = 'concertoai';

// ── 类型 ──

/** 规则 id 联合（规则表唯一 id 来源）。 */
export const SUGGESTION_IDS = [
  'missing-project-rules',
  'repeated-verify-failure',
  'repeated-edit-rejection',
] as const;
export type SuggestionId = (typeof SUGGESTION_IDS)[number];

/**
 * 文案 key（指向 i18n 字典 `hints.*`）。
 *
 * T12 只消费中文（`DEFAULT_SUGGESTION_MESSAGES`，来源 `i18n/zh.ts`）；
 * T13 传 `t().hints` 即可切英文，**不需要改本文件任何结构**
 * （这是「T12 出 i18n key，T13 直接接英文」的落地方式）。
 *
 * `repeatedEditRejectionNoFile` 是「拿不到可用文件路径」时的降级文案：
 * 不含 `{file}` 占位符，配合 `/review`（auto 模式）使用——
 * **宁可换一句不带文件名的文案，也不输出 `/review <file>` 这种半成品命令**。
 */
export type SuggestionI18nKey =
  | 'missingProjectRules'
  | 'repeatedVerifyFailure'
  | 'repeatedEditRejection'
  | 'repeatedEditRejectionNoFile';

/** 文案模板表（占位符 `{file}` 由引擎统一填充，与 i18n 的 `{key}` 格式一致）。 */
export type SuggestionMessages = Record<SuggestionI18nKey, string>;

/**
 * 中文文案默认值。**文案本体在 `i18n/zh.ts`（全项目唯一来源）**，此处只做映射——
 * Ink 组件与本文件都不许出现用户可见的文案字面量（同 T9 的护栏口径）。
 */
export const DEFAULT_SUGGESTION_MESSAGES: SuggestionMessages = {
  missingProjectRules: zh.hints.missingProjectRules,
  repeatedVerifyFailure: zh.hints.repeatedVerifyFailure,
  repeatedEditRejection: zh.hints.repeatedEditRejection,
  repeatedEditRejectionNoFile: zh.hints.repeatedEditRejectionNoFile,
};

/**
 * 触发状态（**全部是确定性事实**，由调用方从真实运行中收集）。
 *
 * 刻意不收录：耗时、Token 数、消息长度、模型自评——见文件头「设计取向」。
 */
export interface SuggestionState {
  /** 本会话已产生的**用户输入轮数**（首轮之前为 0；用于「无规则文件」规则不抢开场白）。 */
  userTurns: number;
  /** 项目根是否有 AGENTS.md / CARBON.md 任一。 */
  hasProjectRules: boolean;
  /** **连续** verify / self-heal 类失败轮数（成功一次即归零，归零由调用方维护）。 */
  consecutiveFailures: number;
  /** 同一文件**连续**被拒绝（按 `n`）的次数（批准一次即归零）。 */
  fileRejectStreak: number;
  /** 触发 `fileRejectStreak` 的文件路径（相对 cwd；无文件上下文时 undefined）。 */
  fileRejectFile?: string;
  /** 提示总开关（`config.hints` 与环境变量**已合并**后的最终值）。 */
  hintsEnabled: boolean;
}

/** 会话内历史（内存，由调用方持有；进程结束即丢，符合「每会话」语义）。 */
export interface HintHistory {
  /** 本会话已展示过的规则 id（约束②）。 */
  shownIds: readonly SuggestionId[];
  /** 本会话已展示总条数（约束④）。 */
  shownCount: number;
  /** 用户是否已按 Esc / 忽略（约束⑤：一旦 true，本会话彻底静默）。 */
  dismissed: boolean;
  /** 全局冷却记录：id → 上次展示时间戳（约束③，来自 `hint-state.json`）。 */
  cooldowns: Readonly<Record<string, number>>;
}

/** 空历史（首次进入 chat）。 */
export const EMPTY_HINT_HISTORY: HintHistory = {
  shownIds: [],
  shownCount: 0,
  dismissed: false,
  cooldowns: {},
};

/** 判定结果（`message` / `command` 均已可直接呈现与复制执行）。 */
export interface Suggestion {
  id: SuggestionId;
  /** 数值越大越优先（同时命中多条时只返回最高的那条，约束①）。 */
  priority: number;
  /** 实际使用的文案 key（文件路径不可用时是 `repeatedEditRejectionNoFile`）。 */
  i18nKey: SuggestionI18nKey;
  /** 已填充占位符的最终文案。 */
  message: string;
  /** 完整可直接执行的命令（**永不包含未替换的 `<...>` 占位符**）。 */
  command: string;
}

/** 一条规则。 */
export interface SuggestionRule {
  id: SuggestionId;
  /** 优先级（大者优先）。同时命中时只出一条，所以这里的取值决定「谁更该被打断」。 */
  priority: number;
  /** 文案 key（拿不到可用文件路径时，引擎会自动降级到 `*NoFile` 变体）。 */
  i18nKey: SuggestionI18nKey;
  /** 无文件上下文时的降级文案 key（只有 `repeated-edit-rejection` 需要）。 */
  i18nKeyNoFile?: SuggestionI18nKey;
  /** 纯函数判定：只读 state，不做 IO、不看时间。 */
  match(state: SuggestionState): boolean;
  /** 生成**完整可直接执行**的命令（禁用未替换占位符，见文件头「空头支票」）。 */
  command(state: SuggestionState): string;
}

// ── 规则表（M3 三条；新增规则前先问：它会频繁触发吗？会 → 不做） ──

/**
 * 优先级取值（大者优先）：
 * 30 = 用户正卡在某个文件上（最急）> 20 = 构建/测试红了 > 10 = 入场引导（最缓）。
 */
export const RULE_PRIORITY = {
  repeatedEditRejection: 30,
  repeatedVerifyFailure: 20,
  missingProjectRules: 10,
} as const;

/**
 * 取可安全嵌入斜杠命令的相对路径。
 *
 * `/review` 按**空格**拆分文件参数（`parseReviewCommand`），所以含空白的路径
 * 塞进去会被拆成多个文件 → 命令语义被悄悄改坏。这种情况返回空串，
 * 由调用方降级为 `/review`（auto 模式）——**宁可不精确，也不给一条会跑错的命令**。
 */
function usableFilePath(state: SuggestionState): string {
  const file = (state.fileRejectFile ?? '').trim();
  if (file === '' || /\s/.test(file)) {
    return '';
  }
  return file;
}

/**
 * 规则表（数组顺序即「同优先级时的稳定次序」；`Array.prototype.sort` 是稳定排序）。
 *
 * 三条规则的触发条件全部是**一眼能确认的确定性事实**，没有任何推测：
 * ① 没有规则文件 ② 连续 2 轮失败 ③ 同一文件连续 2 次被拒。
 */
export const SUGGESTION_RULES: readonly SuggestionRule[] = [
  {
    id: 'repeated-edit-rejection',
    priority: RULE_PRIORITY.repeatedEditRejection,
    i18nKey: 'repeatedEditRejection',
    i18nKeyNoFile: 'repeatedEditRejectionNoFile',
    // 同一文件「连续」2 次被拒：用户显然在反复试同一个地方（批准一次即归零，不算卡住）
    match: (state) => state.fileRejectStreak >= 2,
    // 无可用路径 → `/review`（auto 模式，真实存在），绝不输出 `/review <file>` 占位符
    command: (state) => {
      const file = usableFilePath(state);
      return file === '' ? '/review' : `/review ${file}`;
    },
  },
  {
    id: 'repeated-verify-failure',
    priority: RULE_PRIORITY.repeatedVerifyFailure,
    i18nKey: 'repeatedVerifyFailure',
    // 严格「连续 2 轮」：只红过一次不算（一次失败很可能自己下一轮就改好了）
    match: (state) => state.consecutiveFailures >= 2,
    command: () => `${CLI} self-heal`,
  },
  {
    id: 'missing-project-rules',
    priority: RULE_PRIORITY.missingProjectRules,
    i18nKey: 'missingProjectRules',
    // 要求「已产生 ≥1 轮用户输入」：否则会和开场欢迎语抢同一行（T14 复用这条，不新增第二套）
    match: (state) => !state.hasProjectRules && state.userTurns >= 1,
    command: () => `${CLI} init`,
  },
];

// ── 纯判定层 ──

/** 调用方传入的判定输入（时间必须注入，引擎内部绝不读 `Date.now()`）。 */
export interface EvaluateSuggestionInput {
  state: SuggestionState;
  history: HintHistory;
  /** 当前时间戳（毫秒）。**必填**——不给默认值，逼调用方显式注入（可测性的根）。 */
  now: number;
  /** 覆盖文案模板（T13 传英文 `t().hints`；缺省中文）。 */
  messages?: SuggestionMessages;
}

/**
 * 是否处于冷却期（约束③）。
 *
 * 边界语义：
 * - 没有记录 / 记录非法 → **不在冷却**（首次可提示）；
 * - `now - last < 10 分钟` → 冷却中；
 * - **`last` 在未来**（用户改过系统时间 / 时钟回拨）→ 视为冷却中：
 *   宁可少提示一次，也不要因为时钟回拨把同一句话连弹两遍（去噪优先）。
 */
export function isCoolingDown(last: number | undefined, now: number): boolean {
  if (last === undefined || !Number.isFinite(last)) {
    return false;
  }
  const elapsed = now - last;
  if (elapsed < 0) {
    return true; // 时钟回拨：按「还在冷却」处理（宁少勿多）
  }
  return elapsed < HINT_COOLDOWN_MS;
}

/**
 * `match` 抛错 → 当作不命中。
 *
 * 提示是**锦上添花**的功能：任何一条规则写崩了，都不该让用户的对话中断
 * （同 `reflection-store.ts` 的「写盘失败绝不阻断审批」口径）。
 */
function safeMatch(rule: SuggestionRule, state: SuggestionState): boolean {
  try {
    return rule.match(state) === true;
  } catch {
    return false;
  }
}

/**
 * 判定「现在该不该提示、提示哪条」——**纯函数**（无 IO、无全局状态、无 `Date.now()`）。
 *
 * 检查顺序（任一不满足 → `null`）：
 * ⑥ 开关 → ⑤ 已静默 → ④ 会话已满 3 条 → 时钟合法 → 逐规则过 ② 已展示 / ③ 冷却 / 命中
 * → 按 priority 取最高。
 *
 * @returns 命中则返回**唯一一条**提示；否则 `null`（约束①：永远最多 1 条）。
 */
export function evaluateSuggestion(input: EvaluateSuggestionInput): Suggestion | null {
  const { state, history, now } = input;

  // ⑥ 总开关（非严格 true 一律不提示）
  if (state.hintsEnabled !== true) {
    return null;
  }
  // ⑤ 用户按过 Esc / 忽略 → 本会话彻底静默
  if (history.dismissed) {
    return null;
  }
  // ④ 会话总量封顶（跨 id）
  if (history.shownCount >= MAX_HINTS_PER_SESSION) {
    return null;
  }
  // 时钟非法（NaN / Infinity）→ 无法判断冷却，宁可不提示
  if (!Number.isFinite(now)) {
    return null;
  }

  const shown = new Set<SuggestionId>(history.shownIds);
  const eligible = SUGGESTION_RULES.filter(
    (rule) =>
      // ② 同一 id 每会话仅 1 次
      !shown.has(rule.id) &&
      // ③ 全局 10 分钟冷却
      !isCoolingDown(history.cooldowns[rule.id], now) &&
      safeMatch(rule, state),
  ).sort((a, b) => b.priority - a.priority);

  const rule = eligible[0];
  if (rule === undefined) {
    return null;
  }

  const messages = input.messages ?? DEFAULT_SUGGESTION_MESSAGES;
  const file = usableFilePath(state);
  // 拿不到可用路径 → 换不含 {file} 的降级文案（不让占位符裸奔到用户眼前）
  const i18nKey: SuggestionI18nKey =
    file === '' && rule.i18nKeyNoFile !== undefined ? rule.i18nKeyNoFile : rule.i18nKey;
  const template = messages[i18nKey] ?? DEFAULT_SUGGESTION_MESSAGES[i18nKey];

  return {
    id: rule.id,
    priority: rule.priority,
    i18nKey,
    message: fmt(template, { file }),
    command: rule.command(state),
  };
}

/**
 * 记录「这条提示已展示」（纯函数：返回新的 history，不改入参）。
 *
 * 同 id 重复调用是**幂等**的（不会把 `shownCount` 多加一次，否则会话总量会被虚耗）。
 */
export function recordSuggestionShown(
  history: HintHistory,
  id: SuggestionId,
  now: number,
): HintHistory {
  if (history.shownIds.includes(id)) {
    return history;
  }
  return {
    ...history,
    shownIds: [...history.shownIds, id],
    shownCount: history.shownCount + 1,
    cooldowns: { ...history.cooldowns, [id]: now },
  };
}

/**
 * 用户按 Esc / 忽略 → 本会话全部提示静默（约束⑤，纯函数）。
 *
 * 幂等；**不清理 `cooldowns`**——全局冷却要跨会话继续生效
 * （用户关掉的是「这次对话」，不是「以后都别再提醒我」）。
 */
export function dismissHints(history: HintHistory): HintHistory {
  return history.dismissed ? history : { ...history, dismissed: true };
}

/**
 * 淘汰过期 / 超量的冷却记录（纯函数：返回新对象）。
 *
 * 只保留「未来 / 仍在 10 分钟窗口内」的记录，最多 `MAX_COOLDOWN_ENTRIES` 条。
 * 时钟回拨产生的「未来时间戳」也会被剔除（它没有参考价值，且会永久压制该规则）。
 */
export function pruneCooldowns(
  cooldowns: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> {
  const kept = Object.entries(cooldowns)
    .filter(([, ts]) => Number.isFinite(ts) && ts <= now && now - ts < HINT_COOLDOWN_MS)
    .sort((a, b) => b[1] - a[1]) // 新的在前
    .slice(0, MAX_COOLDOWN_ENTRIES);
  return Object.fromEntries(kept);
}

// ── IO 层（与上面纯函数严格分离；**永不抛错**） ──

/** 冷却状态文件路径（单一来源：`store/paths.ts`）。 */
export function defaultHintStatePath(): string {
  return hintStatePath();
}

/** 读取 / 写入选项（测试注入 tmp 文件）。 */
export interface HintStateOptions {
  /** 文件路径（缺省 `~/.concertoai/hint-state.json`）。 */
  file?: string;
}

/** 读取结果。 */
export interface HintStateReadResult {
  /** id → 上次展示时间戳（已剔除非法条目）。 */
  cooldowns: Record<string, number>;
  /** 文件存在但无法解析 → `true`。两种情况的处理相同（按空记录），值只用于诊断。 */
  reset: boolean;
}

/**
 * 读取全局冷却记录（**永不抛错**）。
 *
 * - 文件不存在（首次运行）→ 空记录 + `reset: false`；
 * - JSON 损坏 / 结构非法 → 空记录 + `reset: true`
 *   （**不阻塞**启动：冷却记录坏了最多多提示一次，不值得让 CLI 起不来）；
 * - 单条非法（id 非字符串 / 时间戳非有限数字）→ 剔除该条，其余照用。
 */
export async function readHintCooldowns(
  options: HintStateOptions = {},
): Promise<HintStateReadResult> {
  const file = options.file ?? defaultHintStatePath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { cooldowns: {}, reset: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { cooldowns: {}, reset: true };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { cooldowns: {}, reset: true };
  }
  const source = (parsed as { cooldowns?: unknown }).cooldowns;
  if (source === null || typeof source !== 'object') {
    return { cooldowns: {}, reset: true };
  }
  const cooldowns: Record<string, number> = {};
  for (const [id, ts] of Object.entries(source as Record<string, unknown>)) {
    if (id !== '' && typeof ts === 'number' && Number.isFinite(ts)) {
      cooldowns[id] = ts;
    }
  }
  return { cooldowns, reset: false };
}

/** 写入结果（**调用方不需要**处理失败——提示是否展示不该被磁盘状态绑架）。 */
export interface HintStateWriteResult {
  ok: boolean;
  /** 失败原因（仅诊断用，不面向普通用户）。 */
  error?: string;
}

/**
 * 写入全局冷却记录（**永不抛错**）。
 *
 * - 原子写（临时文件 + `rename`）：进程被 Ctrl+C 打断不会留下半个 JSON；
 * - 写前 `pruneCooldowns`（淘汰过期 + 控量），文件不会无限增长；
 * - 目录不存在 → 自动创建（`recursive`）。
 */
export async function writeHintCooldowns(
  cooldowns: Readonly<Record<string, number>>,
  options: HintStateOptions & { now?: number } = {},
): Promise<HintStateWriteResult> {
  const file = options.file ?? defaultHintStatePath();
  // IO 层允许读真实时钟（纯判定层禁止）；注入 now 只为测试可控
  const now = options.now ?? Date.now();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const payload = {
      version: HINT_STATE_VERSION,
      cooldowns: pruneCooldowns(cooldowns, now),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── 开关（双轨：环境变量 > config；默认 **on** 但极保守） ──

/** 关闭语义的写法（大小写不敏感）。 */
const OFF_VALUES = new Set(['off', 'false', '0', 'no']);
/** 开启语义的写法（大小写不敏感）。 */
const ON_VALUES = new Set(['on', 'true', '1', 'yes']);

/** 把取值解析为布尔；无法识别 → undefined（**不猜**）。 */
function parseSwitchValue(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return undefined;
  }
  if (OFF_VALUES.has(normalized)) {
    return false;
  }
  if (ON_VALUES.has(normalized)) {
    return true;
  }
  return undefined;
}

/**
 * 提示开关（双轨：环境变量 > config；默认 **on**）。
 *
 * 与 `isReflectionsEnabled` 同口径：**无法识别的值一律忽略、回落下一层**——
 * 把 `CONCERTOAI_HINTS=ofl` 当成 on，会静默推翻用户配置里明确写的 `off`
 * （用户以为关了，实际一直在提示）。
 */
export function isHintsEnabled(configValue?: string, envValue?: string): boolean {
  const fromEnv = parseSwitchValue(envValue);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const fromConfig = parseSwitchValue(configValue);
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  return true; // 默认开（用户拍板），但七条硬约束保证「极保守」
}
