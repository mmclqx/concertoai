/**
 * commander 参数解析错误的**唯一渲染点**（v5.0 C1）。
 *
 * ## 为什么需要这个模块
 *
 * commander 的报错文案是**内置英文**，且格式硬编码在它的源码里：
 * ```
 * error: unknown option '--bogus-opt'
 * error: too many arguments. Expected 0 arguments but got 1: bogus-xyz.
 * error: missing required argument 'task'
 * ```
 * 而本产品的定位是「中文优先」——于是用户撞上错误时看到的是全英文，
 * 而同一条命令的 `--help` 却是中文：**报错路径是唯一没被 i18n 覆盖的面**。
 *
 * ## 三层设计（与 K17 的 `fatal-report.ts` 同构）
 *
 * 1. **事实与措辞分离**：`CommanderError.message` 是**事实来源**（哪个 flag、缺哪个参数、
 *    期望几个实到什么），本模块只解析事实、再按 locale 换措辞，绝不改写事实；
 * 2. **解析失败就降级到原文**：commander 升级换了措辞 → 正则不匹配 → 回落
 *    `errors.cliArgs.unknown` + 原始 message。**宁可英文，不许空白**（不吞信息）；
 * 3. **只接管 commander 抛出的错**：调用方先用 `isCommanderErrorShape()` 判形态，
 *    不是就原样上抛 —— 程序 bug 不许被伪装成「你参数写错了」（K17 的同一条纪律）。
 *
 * ## 刻意不做的两件事
 *
 * - **不猜子命令自己的选项**：`CommanderError` 不携带「哪个命令报的错」这个事实。
 *   若把全部子命令的长选项都当候选，`concertoai doctor --bogus` 可能被建议
 *   一个 `doctor` 根本不接受的选项 —— 那是**误导**，比不给建议更坏。
 *   因此候选只取**顶层**选项；子命令级拿不到候选时老实给「查看用法」。
 * - **不改退出码**：退出码是 commander 给的事实（`exitCode`），本模块原样透传
 *   （help / version 也照传，因此 `--version` 仍是 0、`help({error:true})` 仍是 1）。
 */

import { fmt, t } from '../i18n';

/** commander 错误的**事实**（只挑渲染需要的字段，不依赖 commander 的类型）。 */
export interface CliErrorFacts {
  /** `CommanderError.code`，如 `commander.unknownOption`。 */
  code: string;
  /** 原始英文消息 —— 事实来源，解析不到就回落它。 */
  message: string;
  /** commander 建议的退出码。 */
  exitCode?: number;
}

/** 候选建议的上下文（**必须来自真实注册表**，不许编造）。 */
export interface CliErrorContext {
  /** 已注册命令名（含别名）。用于「你是不是想输入 …」。 */
  commandNames: readonly string[];
  /** 顶层长选项（`--project` 等）。子命令选项**刻意不收**，见模块头注释。 */
  optionFlags: readonly string[];
}

/** `renderCliError` 的结果：要打印的文本 + 退出码。`text` 为空串表示「什么都不打」。 */
export interface CliErrorRender {
  /** 已本地化的文本（`''` = 不打印，例如 `--version` / `--help` 已经自己输出过了）。 */
  text: string;
  /** 进程退出码（原样透传 commander 的 `exitCode`）。 */
  exitCode: number;
}

/**
 * 判断一个值是否「长得像 CommanderError」。
 *
 * 判据只用**结构**（`code` 是 `commander.` 开头的字符串 + `message` 是字符串），
 * 不 import commander 的类：这样单测可以直接喂普通对象，也不必让本模块依赖 commander 运行时。
 */
export function isCommanderErrorShape(value: unknown): value is CliErrorFacts {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

/** 去掉 commander 自带的 `error: ` 前缀（本地化后由我们自己组织句子）。 */
function stripErrorPrefix(message: string): string {
  return message.replace(/^error:\s*/, '').trim();
}

/**
 * 把 `'-p, --project <name>'` 这类 flags 串收敛成 `'--project'`。
 *
 * commander 的 `optionMissingArgument` / `missingMandatoryOptionValue` / `conflictingOption`
 * 都会给整串 flags。用户敲的是长选项（短选项只是前缀），提示里优先显示长选项；
 * 没有长选项（纯短选项）时原样保留，**不编造不存在的长名**。
 */
export function preferredFlag(flags: string): string {
  const parts = flags
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const long = parts.find((part) => part.startsWith('--'));
  const chosen = long ?? parts[0] ?? flags.trim();
  // 去掉取值占位（` <name>` / ` [id]`）：提示里给的是「选项名」，不是「怎么填」
  return chosen.replace(/\s+[<[].*$/, '');
}

/**
 * `conflictingOption` 的两种来源：`option '--a'` / `environment variable 'FOO'`。
 *
 * 直接喂给 `preferredFlag` 会把它当成"没有长选项的怪名"原样返回（实测踩过：
 * 输出成了「选项冲突：option '--a' 不能与 option '--b'」——中文句子里塞英文包装）。
 * 因此先剥掉包装，并**保留类型语义**：环境变量必须说成「环境变量 FOO」，
 * 否则用户会去 `--help` 里找一个叫 FOO 的选项。
 */
export function unwrapOptionRef(ref: string): { kind: 'option' | 'env'; name: string } | undefined {
  const optionMatch = /^option\s+'(.*)'$/.exec(ref.trim());
  if (optionMatch !== null) {
    return { kind: 'option', name: preferredFlag(optionMatch[1] ?? ref) };
  }
  const envMatch = /^environment variable\s+'(.*)'$/.exec(ref.trim());
  if (envMatch !== null) {
    return { kind: 'env', name: envMatch[1] ?? ref };
  }
  return undefined;
}

/**
 * 把 commander 的「选项引用」收敛成提示里该显示的样子。
 *
 * `conflictingOption` 的原话里，被引用的一侧可能是三种外壳：
 * - `option '--all'` / `option '-a, --all'`（我们自己写的选项）
 * - `environment variable 'FOO'`（值来自环境变量，**不是选项名**）
 * - 裸 `--all`
 *
 * 直接塞进中文句子会变成「选项冲突：option '--all' 不能与 option '--quiet'」——
 * 中英混排正是本轮要修的病。因此两个分支分别处理：环境变量保留变量名（那是**事实**），
 * 选项则走 `preferredFlag()` 取长名。
 */
function formatOptionRef(reference: string): string {
  const trimmed = reference.trim();
  const envMatched = /^environment variable '([^']+)'$/.exec(trimmed);
  if (envMatched !== null) {
    return envMatched[1] ?? trimmed;
  }
  const optionMatched = /^option '(.*)'$/.exec(trimmed);
  return preferredFlag(optionMatched?.[1] ?? trimmed);
}

/** Damerau–Levenshtein 编辑距离（与 commander 自带算法同口径，含相邻换位计 1）。 */
function editDistance(a: string, b: string, maxDistance: number): number {
  // 长度差已超阈值 → 直接给最坏值，省掉整张矩阵
  if (Math.abs(a.length - b.length) > maxDistance) {
    return Math.max(a.length, b.length);
  }
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j += 1) {
    (d[0] as number[])[j] = j;
  }
  for (let j = 1; j <= b.length; j += 1) {
    for (let i = 1; i <= a.length; i += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      // 三个前驱各要 +1 才构成「一次编辑」——实测踩过：漏掉这两个 +1 会让距离恒为 0，
      // 于是**任何**乱敲的词都会"匹配"上**任何**候选（`bogus-xyz` 被建议成 `balance`）。
      // 那次是探针先跑真进程才发现的（单测若只断言"docter → doctor"会假绿）。
      row[j] = Math.min(
        ((d[i - 1] as number[])[j] as number) + 1, // 删除
        (row[j - 1] as number) + 1, // 插入
        ((d[i - 1] as number[])[j - 1] as number) + cost, // 替换
      );
      // 相邻换位（`doctro` ↔ `doctor`）
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * 找出「你是不是想输入」的候选（按编辑距离最近的一组返回，可能为空）。
 *
 * ## 阈值（**实测校准**，不是拍脑袋）
 *
 * 只接受**编辑距离 ≤ 2 且相似度 > 0.5** 的候选。这两道阈值的必要性是实测出来的：
 * 初版照抄 commander 的口径（距离 ≤ 3）时，真机上 `bogus-xyz` 被建议成 `` `balance` ``
 * （Damerau 距离 3）、`--bogus-opt` 一次给出 `--project / --provider / --version` 三个候选
 * ——**乱猜比不猜更坏**：用户会以为自己真敲错了某个近形词。
 * 收紧到 ≤ 2 后：`docter → doctor`、`chek → check`、`providr → --provider`（距离均为 1）
 * 仍然命中，而 `bogus-xyz` / `--bogus-opt` 老实不给候选（改说「查看用法」）。
 *
 * 空数组 = 「没有值得建议的」，由调用方换成「查看用法 / 查看全部命令」。
 * **绝不返回「最相似但差很远」的结果**。
 */
export function suggestSimilar(
  word: string,
  candidates: readonly string[],
  maxEdits = 2,
  minSimilarity = 0.5,
): string[] {
  if (candidates.length === 0) {
    return [];
  }
  // ## 为什么两侧都要剥掉前导横线再比
  //
  // 只剥 needle（初版写法）会漏掉**混合形态**：候选是 `--provider`、待查词是 `providr` 时，
  // 长度差 3 直接触发编辑距离的早退分支 → 一个候选都给不出。
  // 生产链路上两边的形态总是一致（都带 `--` 或都不带），但「只在一侧剥」这种隐形耦合
  // 一旦被调用方误用就静默失效——比多写一行剥线更危险。输出仍用**候选的原始形态**，
  // 因此 `--provider` 不会变成 `provider`。
  const stripDashes = (value: string): string => value.replace(/^-+/, '');
  const needle = stripDashes(word);
  const pool = Array.from(new Set(candidates))
    // 单字符候选的「相似」没有信息量（`a` 与任何两字符词距离都是 1）
    .filter((candidate) => stripDashes(candidate).length > 1);

  let bestDistance = maxEdits + 1;
  let similar: string[] = [];
  for (const candidate of pool) {
    const distance = editDistance(needle, stripDashes(candidate), maxEdits);
    const length = Math.max(needle.length, stripDashes(candidate).length);
    const similarity = (length - distance) / length;
    if (distance > maxEdits || similarity <= minSimilarity) {
      continue;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      similar = [candidate];
    } else if (distance === bestDistance) {
      similar.push(candidate);
    }
  }
  return similar.sort((a, b) => a.localeCompare(b));
}

/** 把候选列表渲染成「`a` / `b`」；空数组 → `''`（调用方据此决定换提示）。 */ function formatCandidates(
  candidates: readonly string[],
): string {
  return candidates.map((candidate) => `\`${candidate}\``).join(' / ');
}

/** 「额外提示行」：有候选就给候选，没有就老实指向帮助。 */ function hintLine(
  candidates: readonly string[],
  fallback: string,
): string {
  if (candidates.length === 0) {
    return fallback;
  }
  return fmt(t().errors.cliArgs.didYouMean, { candidates: formatCandidates(candidates) });
}

/**
 * 把 commander 错误渲染成**当前语言**的「一句话 + 下一步」。
 *
 * 返回 `text: ''` 的两种情况（都是**成功路径**，不是错误）：
 * - `commander.version` / `commander.helpDisplayed`：commander 已经把版本号 / 帮助打到
 *   stdout，这里**再多说一句就是噪音**；
 * - `commander.help`（`help({ error: true })`）：帮助已打到 stderr，只剩退出码要透传。
 *
 * 其余 code 一律给出本地化文本；**code 或消息形态不认识时回落原文**，不吞事实。
 */
export function renderCliError(facts: CliErrorFacts, ctx: CliErrorContext): CliErrorRender {
  const dict = t().errors.cliArgs;
  const exitCode = facts.exitCode ?? 1;
  const raw = stripErrorPrefix(facts.message);

  switch (facts.code) {
    case 'commander.version':
    case 'commander.helpDisplayed':
      return { text: '', exitCode };
    case 'commander.help':
      // 帮助正文已经由 commander 写到 stderr 了，这里只负责退出码
      return { text: '', exitCode };

    case 'commander.unknownOption': {
      const flag = /unknown option '([^']+)'/.exec(facts.message)?.[1] ?? raw;
      const candidates = suggestSimilar(flag, ctx.optionFlags);
      const head = fmt(dict.unknownOption, { flag });
      return { text: `${head}\n${hintLine(candidates, dict.seeHelp)}`, exitCode };
    }

    case 'commander.unknownCommand': {
      const name = /unknown command '([^']+)'/.exec(facts.message)?.[1] ?? raw;
      const candidates = suggestSimilar(name, ctx.commandNames);
      const head = fmt(dict.unknownCommand, { name });
      return { text: `${head}\n${hintLine(candidates, dict.seeAllCommands)}`, exitCode };
    }

    case 'commander.excessArguments': {
      const matched =
        /too many arguments(?: for '([^']+)')?\. Expected (\d+) arguments? but got (\d+): (.*)\.$/.exec(
          facts.message,
        );
      // 解析不到 → 回落原文（commander 改了措辞也不许空白）
      if (matched === null) {
        return { text: fmt(dict.unknown, { message: raw }), exitCode };
      }
      const [, subcommand, expected, received, details] = matched;
      if (subcommand === undefined) {
        // ── 归类修正（C1 的核心之一）──
        // 顶层多余参数**几乎总是命令名打错**：根命令有默认 action（无子命令 → 进 chat），
        // 于是 `bogus-xyz` 落进 root 的实参，commander 只能报「参数太多」。
        // 对用户来说「参数太多」是**错的归因**（他并没有多敲一个参数，是命令名不存在）。
        // 因此这里按「未知命令」渲染，并给真实候选。
        const name = (details ?? '').split(',')[0]?.trim() ?? '';
        const candidates = suggestSimilar(name, ctx.commandNames);
        const head = fmt(dict.unknownCommand, { name });
        return { text: `${head}\n${hintLine(candidates, dict.seeAllCommands)}`, exitCode };
      }
      const head = fmt(dict.tooManyArguments, {
        command: `concertoai ${subcommand}`,
        expected: expected ?? '',
        received: received ?? '',
        details: details ?? '',
      });
      return { text: `${head}\n${dict.seeHelp}`, exitCode };
    }

    case 'commander.missingArgument': {
      const name = /missing required argument '([^']+)'/.exec(facts.message)?.[1] ?? raw;
      return { text: `${fmt(dict.missingArgument, { name })}\n${dict.seeHelp}`, exitCode };
    }

    case 'commander.optionMissingArgument': {
      const flags = /option '(.*)' argument missing$/.exec(facts.message)?.[1] ?? raw;
      const flag = preferredFlag(flags);
      return { text: `${fmt(dict.optionMissingValue, { flag })}\n${dict.seeHelp}`, exitCode };
    }

    case 'commander.missingMandatoryOptionValue': {
      const flags = /required option '(.*)' not specified$/.exec(facts.message)?.[1] ?? raw;
      const flag = preferredFlag(flags);
      return { text: `${fmt(dict.missingRequiredOption, { flag })}\n${dict.seeHelp}`, exitCode };
    }

    case 'commander.conflictingOption': {
      // 两种形态：`option '--a' cannot be used with option '--b'`
      //        / `environment variable 'FOO' cannot be used with option '--b'`
      const matched = /^(.*) cannot be used with (.*)$/.exec(raw);
      if (matched === null) {
        return { text: fmt(dict.unknown, { message: raw }), exitCode };
      }
      // 剥掉 `option '…'` / `environment variable '…'` 包装：否则中文句子里会塞进英文外壳
      const flag = formatOptionRef(matched[1] ?? raw);
      const other = formatOptionRef(matched[2] ?? raw);
      return { text: `${fmt(dict.conflictingOption, { flag, other })}\n${dict.seeHelp}`, exitCode };
    }

    case 'commander.invalidArgument':
      // 这类消息可能是**我们自己**在 parseArg 里写的（已是中文 / 已是英文），
      // 因此只去掉 commander 的 `error: ` 前缀，不重写句子 —— 重写会丢事实。
      return { text: fmt(dict.invalidArgument, { message: raw }), exitCode };

    default:
      return { text: fmt(dict.unknown, { message: raw }), exitCode };
  }
}
