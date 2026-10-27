/**
 * 审批洞察主入口（v5.0 T8，皇冠上的明珠之一）。
 *
 * 把一次编辑的 diff 变成「用户看得懂的风险教学卡」：**批什么、影响谁、重点看哪行**。
 *
 * ## 铁律 G2（本模块存在的唯一意义）
 *
 * `analyzeApproval` **永不抛错**，也**永不阻塞审批**：
 * 无论内部发生什么（规则表炸了、文件系统挂了、超时），调用方拿到的**永远是一个可渲染对象**。
 * 审批是同步阻塞交互——分析失败最多「少给点提示」，绝不能「用户按不了 y」。
 *
 * ## 降级矩阵（实现必须与此表逐行对应，测试逐行覆盖）
 *
 * | 触发条件 | degraded | degradeReason | 表现 |
 * |---|---|---|---|
 * | `!process.stdout.isTTY` | true | `non-tty` | 完全 plain（v4.1.1 原貌） |
 * | `process.env.CI` 存在 | true | `ci` | 完全 plain |
 * | diff 行数 > 500 | true | `huge-diff` | 只显示「共 N 行改动，风险分析已跳过」 |
 * | `scanImpact` 超 300ms | false | （记在 impact.timeout） | 风险点照常，影响面显示未分析 |
 * | 任意分析函数抛错 | true | `error` | 完全 plain + 不打断 UI |
 * | config `approvalInsight: 'plain'` | true | `config-off` | 完全 plain |
 * | 规则表空/全未命中 | false | — | 显示「✅ 未检测到已知风险模式（已检查 N 类）」 |
 * | 文件数 > 2000 | false | （记在 impact.skipped） | 显示「项目较大，影响面未分析」 |
 *
 * ## 零模型调用 / 零网络
 *
 * 纯本地字符串匹配 + 一次（可超时的）文件扫描。**不调模型**——审批前调模型等于
 * 让用户等待 + 花钱去买一个「可能更不准」的判断。
 */

import type { ImpactScanOptions, ImpactSummary } from './impact-scan';
import { IMPACT_LIMITS, scanImpact } from './impact-scan';
import type { RiskHit, RiskLevel, RiskRule } from './risk-rules';
import { activeRiskRules, isCommentLine, normalizeDiffLine, RISK_LEVEL_WEIGHT } from './risk-rules';

export type { RiskHit, RiskLevel } from './risk-rules';

/** 降级原因（唯一来源见文件头降级矩阵）。 */
export type DegradeReason = 'non-tty' | 'ci' | 'huge-diff' | 'timeout' | 'error' | 'config-off';

/** 分析结果（调用方渲染用；**任何情况下都可渲染**）。 */
export interface ApprovalInsight {
  /** 总风险等级 = max(hits.level)，无命中为 low。 */
  level: RiskLevel;
  /** 改动性质（从 hits 聚合的人话，去重后取前 3）。 */
  changeNatures: string[];
  /** 命中明细（按 level 降序 + diffLineIndex 升序）。 */
  hits: RiskHit[];
  /** 建议重点关注行（diff 行下标，供 UI 打 ⚠️）。 */
  focusLines: number[];
  /** 影响面。 */
  impact: ImpactSummary;
  /** 是否走了降级路径。 */
  degraded: boolean;
  /** 降级原因。 */
  degradeReason?: DegradeReason;
  /** 总耗时（毫秒，性能门用）。 */
  elapsedMs: number;
}

/** 环境探测（可注入，便于测试假 TTY / CI）。 */
export interface InsightEnvironment {
  isTTY?: boolean;
  isCI?: boolean;
  mode?: 'rich' | 'plain';
}

/** 分析选项。 */
export interface AnalyzeApprovalOptions extends InsightEnvironment {
  /** 被编辑文件（绝对路径；影响面分析用）。 */
  file?: string;
  /** 项目根。 */
  cwd?: string;
  /** 参与匹配的规则（缺省全表；config `riskRules.disabled` 消费 `activeRiskRules`）。 */
  rules?: readonly RiskRule[];
  /**
   * 影响面扫描注入（测试用）。
   *
   * `file` / `cwd` 由本函数统一提供（调用方已在顶层传过一次），因此这里放宽为可选——
   * 否则每个调用方都得重复传同一组参数，且两处不一致时会静默以 impact 里的为准。
   */
  impact?: Partial<ImpactScanOptions>;
  /** 跳过影响面分析（low 风险 / plain 模式）。 */
  skipImpact?: boolean;
  /** 时钟注入。 */
  now?: () => number;
}

/** diff 行数上限：超过不做逐行分析（超大 diff 逐行匹配既慢又没意义）。 */
export const MAX_ANALYZED_DIFF_LINES = 500;

/** diff 中的一行（解析后）。 */
export interface ParsedDiffLine {
  /** 行下标（含 hunk 头等非改动行，与 `detail` 的 `\n` 分割一致）。 */
  index: number;
  /** 侧别；null = 上下文行/hunk 头（不参与匹配）。 */
  side: 'added' | 'removed' | null;
  /** 剥离 `\r`/BOM 后的整行原文。 */
  text: string;
}

/**
 * 解析统一 diff（W2 剥 `\r`、W7 剥 BOM、跳过 `+++`/`---` 文件头）。
 *
 * 返回**全部行**（含上下文行），这样 `index` 与 UI 渲染的 diff 行号一一对应（打 ⚠️ 不失位）；
 * 是否参与风险匹配由 `side !== null` 决定。
 */
export function parseDiff(detail: string): ParsedDiffLine[] {
  const rawLines = detail.split('\n');
  const parsed: ParsedDiffLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const text = normalizeDiffLine(rawLines[i] ?? '', i).trimEnd();
    let side: ParsedDiffLine['side'] = null;
    if (text.startsWith('+') && !text.startsWith('+++')) {
      side = 'added';
    } else if (text.startsWith('-') && !text.startsWith('---')) {
      side = 'removed';
    }
    parsed.push({ index: i, side, text });
  }
  return parsed;
}

/** 单行是否命中某规则（含 target 面 / 注释排除 / negativePatterns / prefilter）。 */
export function lineMatchesRule(line: ParsedDiffLine, rule: RiskRule): boolean {
  if (line.side === null) {
    return false;
  }
  if (rule.target !== 'both' && rule.target !== line.side) {
    return false;
  }
  // 内容行（去掉 diff 前缀的那个字符）
  const content = line.text.slice(1);
  // 注释里的代码不算风险（W9：只认行首注释）
  if (isCommentLine(content)) {
    return false;
  }
  if (rule.prefilter !== undefined) {
    const lower = content.toLowerCase();
    if (!rule.prefilter.some((needle) => lower.includes(needle))) {
      return false;
    }
  }
  const hit = rule.patterns.some((pattern) => pattern.test(content));
  if (!hit) {
    return false;
  }
  if (rule.negativePatterns?.some((pattern) => pattern.test(content)) === true) {
    return false;
  }
  return true;
}

/** 纯函数：对 diff 文本做规则匹配（**无 IO、无异常**，性能门覆盖）。 */
export function analyzeDiff(detail: string, rules: readonly RiskRule[]): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const line of parseDiff(detail)) {
    if (line.side === null) {
      continue;
    }
    for (const rule of rules) {
      if (lineMatchesRule(line, rule)) {
        hits.push({
          ruleId: rule.id,
          category: rule.category,
          level: rule.level,
          side: line.side,
          line: line.text.trimEnd(),
          diffLineIndex: line.index,
          why: rule.why,
          suggestion: rule.suggestion,
        });
        break; // 一行只报一条（同规则命中多条特征不重复刷屏）
      }
    }
  }
  return hits;
}

/** 总等级 = max；无命中为 low。 */
export function levelOf(hits: readonly RiskHit[]): RiskLevel {
  let level: RiskLevel = 'low';
  for (const hit of hits) {
    if (RISK_LEVEL_WEIGHT[hit.level] > RISK_LEVEL_WEIGHT[level]) {
      level = hit.level;
    }
  }
  return level;
}

/** 改动性质：按命中类别映射人话，去重，取前 3。 */
export function changeNaturesFrom(hits: readonly RiskHit[], rules: readonly RiskRule[]): string[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const nature = byId.get(hit.ruleId)?.nature ?? hit.category;
    if (seen.has(nature)) {
      continue;
    }
    seen.add(nature);
    out.push(nature);
    if (out.length >= 3) {
      break;
    }
  }
  return out;
}

/**
 * 重点关注行：high 命中最多 3 条；无 high 时取 medium 里最靠前的 1 条。
 *
 * 为什么限制数量：一次让用户「重点看 8 行」等于没重点——他只会全部跳过。
 */
export function focusLinesFrom(hits: readonly RiskHit[]): number[] {
  const highs = hits.filter((hit) => hit.level === 'high').slice(0, 3);
  if (highs.length > 0) {
    return highs.map((hit) => hit.diffLineIndex);
  }
  const medium = hits.find((hit) => hit.level === 'medium');
  return medium === undefined ? [] : [medium.diffLineIndex];
}

/**
 * 空影响面（降级 / 未扫路径用；保证调用方永远拿到完整结构）。
 *
 * 缺省 `not-needed` 而**不是** `skipped`：`skipped` 的文案是「项目过大，文件数超过 2000」，
 * 拿它当「没扫」的默认值，会让每个低风险审批都显示「你的项目太大」（实测发现的假话）。
 */
export function emptyImpact(status: ImpactSummary['status'] = 'not-needed'): ImpactSummary {
  return {
    status,
    referenceCount: 0,
    topPaths: [],
    exportedSymbols: [],
    scannedCount: 0,
    skippedCount: 0,
    elapsedMs: 0,
  };
}

/** 降级结果构造（唯一出口，避免各处手搓不完整对象）。 */
function degradedInsight(
  reason: DegradeReason,
  elapsedMs: number,
  hits: RiskHit[] = [],
  impact: ImpactSummary = emptyImpact(),
): ApprovalInsight {
  return {
    level: levelOf(hits),
    changeNatures: [],
    hits,
    focusLines: [],
    impact,
    degraded: true,
    degradeReason: reason,
    elapsedMs,
  };
}

/**
 * 主入口：分析一次审批的 diff，产出可渲染的风险卡。
 *
 * **永不抛错**（G2）：外层整体 try/catch，任何异常 → `degraded: 'error'` 的空 insight。
 */
export async function analyzeApproval(
  detail: string,
  options: AnalyzeApprovalOptions = {},
): Promise<ApprovalInsight> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  try {
    // ① 环境降级判定（顺序即优先级：配置关闭 > CI > 非 TTY）
    const env = resolveEnvironment(options);
    if (env.degradeReason !== undefined) {
      return degradedInsight(env.degradeReason, now() - startedAt);
    }

    const rules = options.rules ?? activeRiskRules();

    // ② 超大 diff：不做逐行分析（逐行匹配 600 行 × 15 规则既慢又会糊住用户）
    const lineCount = parseDiff(detail).length;
    if (lineCount > MAX_ANALYZED_DIFF_LINES) {
      return degradedInsight('huge-diff', now() - startedAt);
    }

    // ③ 规则匹配（纯本地，无 IO）
    const hits = analyzeDiff(detail, rules).sort(
      (a, b) =>
        RISK_LEVEL_WEIGHT[b.level] - RISK_LEVEL_WEIGHT[a.level] ||
        a.diffLineIndex - b.diffLineIndex,
    );
    const level = levelOf(hits);

    // ④ 影响面：只在中高风险时扫（low 直接跳过，省掉 90% 的 IO）
    //    `emptyImpact()` 缺省为 `not-needed`——「没扫」不等于「项目太大」，也不等于「无影响」
    let impact: ImpactSummary = emptyImpact();
    if (options.skipImpact !== true && level !== 'low' && options.file !== undefined) {
      impact = await scanImpact({
        ...options.impact,
        // file/cwd 放最后：以本函数的入参为准（避免 impact 注入里传了不一致的值）
        file: options.file,
        cwd: options.cwd ?? options.impact?.cwd ?? process.cwd(),
        timeoutMs: options.impact?.timeoutMs ?? IMPACT_LIMITS.timeoutMs,
        // 时钟必须一路传下去：否则「注入时钟」只影响 elapsedMs，超时判定仍读真实时间，
        // 测试无法构造超时场景，真实环境也没法在测试里验证 300ms 降级
        now: options.impact?.now ?? options.now,
      });
    }

    return {
      level,
      changeNatures: changeNaturesFrom(hits, rules),
      hits,
      focusLines: focusLinesFrom(hits),
      impact,
      degraded: false,
      elapsedMs: now() - startedAt,
    };
  } catch {
    // G2 铁律：分析失败也必须给调用方一个可渲染对象，审批绝不中断
    return degradedInsight('error', now() - startedAt);
  }
}

/** 环境判定：返回降级原因（undefined = 可以走完整路径）。 */
function resolveEnvironment(options: InsightEnvironment): { degradeReason?: DegradeReason } {
  if (options.mode === 'plain') {
    return { degradeReason: 'config-off' };
  }
  const isCI = options.isCI ?? process.env.CI !== undefined;
  if (isCI) {
    return { degradeReason: 'ci' };
  }
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  if (!isTTY) {
    return { degradeReason: 'non-tty' };
  }
  return {};
}
