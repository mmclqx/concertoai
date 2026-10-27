/**
 * 审批卡的**纯字符串渲染**（v5.0 T9.3b 架构铁律）。
 *
 * ## 三层架构（顺序不可颠倒）
 *
 * ```
 * risk-hits / impact ──▶ ① renderApprovalLines(opts): ApprovalLine[]   ← 本文件，零 Ink/React
 *                             ├──▶ ② TTY：Ink 只做着色 + 边框 + 布局，文本全部来自 ①
 *                             └──▶ ③ 非 TTY / plain：renderApprovalText(opts) 直接 print
 * ```
 *
 * ## 为什么必须这么分层（专家加固意见的落地）
 *
 * 1. **文案不可能不一致**：降级路径与正常路径共用同一套字符串产出（单一来源），
 *    不存在「plain 说一套、rich 说另一套」的漂移；
 * 2. **能测**：全部文案分支用纯函数单测覆盖，不需要 `ink-testing-library` 也能跑；
 * 3. **不阻塞迭代**：Ink 渲染出问题（边框、换行、重渲染）时可以单独排查，不影响文案。
 *
 * ## 硬约束
 *
 * - **禁止 import `ink` / `react`**（有护栏测试扫描本文件源码）；
 * - Ink 组件里**不得出现任何面向用户的文案字面量**——全部来自本文件的产出；
 * - 纯函数：无 IO、无副作用、无全局状态（`parseDiff` 也是纯函数）。
 *
 * ## 三条措辞/降级红线（T8 已知局限的落地）
 *
 * | # | 红线 | 落地方式 |
 * |---|---|---|
 * | ① | medium（如 `test-assertion-change`）**绝不出现「危险」** | 标题用「中风险审批」、命中区用「建议重点关注（中风险提示，非阻断）」；有护栏测试断言全文无「危险」 |
 * | ② | `impact.status !== 'ok'` 时**绝不显示「无影响」/「0 个引用」** | 四态各有一条独立文案，未分析就如实说「影响面未分析（超时/项目过大）」 |
 * | ③ | 不吃掉 T8 的性能优势 | 默认 diff 折叠 ≤ 12 行（含 ⚠️ 行的 hunk + 上下文），完整 diff 由 `[v]` 显式切换并截断 500 行 |
 */

import type { ApprovalInsight, ParsedDiffLine } from '../core/approval-insight';
import { parseDiff } from '../core/approval-insight';
import type { ImpactSummary } from '../core/impact-scan';
import { IMPACT_LIMITS } from '../core/impact-scan';
import type { RiskHit } from '../core/risk-rules';
import { RISK_RULES } from '../core/risk-rules';
import { fmt, t } from '../i18n';
import { displayWidth, truncateToWidth, wrapToWidth } from '../utils/text-width';

/** 审批动作类别（与 `ApprovalRequest.kind` 一致）。 */
export type ApprovalKind = 'edit' | 'shell' | 'model';

/** 工具侧可提供的编辑意图（决定「操作意图」一行）。 */
export type ApprovalIntent = 'create' | 'modify';

/**
 * 一行的**语义角色**：Ink 侧只按角色上色，**不解析文本**。
 *
 * 这样文案改了颜色不会错、颜色改了文案不会错，两边解耦。
 */
export type ApprovalLineRole =
  | 'title'
  | 'intent'
  | 'nature'
  | 'impact'
  | 'risk'
  | 'attention'
  | 'focus'
  | 'notice'
  | 'diff-add'
  | 'diff-del'
  | 'diff-hunk'
  | 'diff-context'
  | 'detail'
  | 'fold'
  | 'buttons'
  | 'help';

/** 渲染出的一行（文本 + 角色）。 */
export interface ApprovalLine {
  role: ApprovalLineRole;
  text: string;
}

/** 渲染选项。 */
export interface ApprovalTextOptions {
  /** 动作类别。 */
  kind: ApprovalKind;
  /** 一句话摘要（工具侧给，如「编辑文件 src/a.ts」）。 */
  summary: string;
  /** 详细内容：edit=统一 diff；shell=命令文本；model=成本对比。 */
  detail: string;
  /** 风险洞察；null/undefined = 无洞察（走 plain）。 */
  insight?: ApprovalInsight | null;
  /** 编辑意图（edit 才有意义）。 */
  intent?: ApprovalIntent;
  /** true = `[v]` 展开后的完整 diff；false = 默认折叠视图。 */
  fullDiff?: boolean;
  /** true = `[?]` 内联说明展开。 */
  showHelp?: boolean;
  /**
   * 影响面是否适用于本次操作（默认 true）。
   *
   * shell / model 没有「文件引用面」，传 false 后显示「不适用」——
   * 而不是让 `impact.status='skipped'` 冒充「项目过大」（那会是假话）。
   */
  impactApplies?: boolean;
  /** 本次参与匹配的规则条数（「已检查 N 类」用；缺省取内置规则表规模）。 */
  ruleCount?: number;
  /** 卡片可用显示宽度（格）。缺省 76；Ink 侧按终端宽度换算后传入。 */
  width?: number;
  /** false = 强制 plain（v4.1.1 原貌）；缺省按 insight 的降级原因自动判定。 */
  rich?: boolean;
}

/** 卡片默认内容宽度（格）：常见 80 列终端减去边框与内边距。 */
export const DEFAULT_CARD_WIDTH = 76;

/** 默认折叠视图最多渲染的 diff 行数（性能红线，勿放宽）。 */
export const COLLAPSED_DIFF_LINES = 12;

/** `[v]` 展开后最多渲染的 diff 行数（与 T8 `huge-diff` 阈值一致的量级保护）。 */
export const MAX_FULL_DIFF_LINES = 500;

/** 折叠视图里每个 ⚠️ 行保留的上下文行数。 */
export const DIFF_CONTEXT_LINES = 2;

/** 风险点/关注行最多展示条数（一次说 8 条 = 没有重点）。 */
export const MAX_HIT_LINES = 3;

/** 这些降级原因下整卡走 plain（v4.1.1 原貌，见 T8 降级矩阵）。 */
const PLAIN_DEGRADE_REASONS = new Set(['config-off', 'error', 'non-tty', 'ci']);

/** 是否走 plain 路径（无洞察 / 强制 plain / 环境降级）。 */
export function isPlainApproval(options: ApprovalTextOptions): boolean {
  if (options.rich === false) {
    return true;
  }
  const insight = options.insight;
  if (insight === undefined || insight === null) {
    return true;
  }
  return insight.degradeReason !== undefined && PLAIN_DEGRADE_REASONS.has(insight.degradeReason);
}

/** 按显示宽度截断（不溢出边框）。 */
function clip(text: string, width: number): string {
  return truncateToWidth(text, width);
}

/** 散文折行后追加多行（同一角色）。 */
function pushWrapped(
  out: ApprovalLine[],
  role: ApprovalLineRole,
  text: string,
  width: number,
): void {
  const parts = wrapToWidth(text, width, 3);
  if (parts.length === 0) {
    return;
  }
  for (const part of parts) {
    out.push({ role, text: part });
  }
}

/** 各 kind 的 plain 标题（v4.1.1 原貌）。 */
function plainTitle(kind: ApprovalKind): string {
  const dict = t().approval;
  return kind === 'edit' ? dict.editTitle : kind === 'shell' ? dict.shellTitle : dict.modelTitle;
}

/**
 * plain 路径：**逐字节等价 v4.1.1**（标题 : 摘要 / 详情 / 按键）。
 *
 * 注意这里**不做宽度截断**——v4.1.1 就是原样渲染 diff，改它会破坏
 * 「plain = 原貌」的承诺（G1 安全不降级 / T11 的 plain 对照）。
 */
function renderPlainLines(options: ApprovalTextOptions): ApprovalLine[] {
  const dict = t().approval;
  return [
    { role: 'title', text: `${plainTitle(options.kind)}: ${options.summary}` },
    { role: 'detail', text: options.detail },
    { role: 'buttons', text: `${dict.confirm} / ${dict.reject}` },
  ];
}

/**
 * 计算 diff 每一行对应的**文件行号**（hunk 头 `@@ -a,b +c,d @@` 推算）。
 *
 * 为什么需要：`focusLines` 里存的是 **diff 行下标**，直接展示成「第 42 行」会让用户
 * 去文件第 42 行找一个根本不在那里的东西（diff 下标 ≠ 文件行号）。这里按统一 diff
 * 语义还原：新增行取新文件行号、删除行取旧文件行号、上下文行两边同增。
 *
 * 兼容两种 hunk 头形态（本项目 `edit.ts` 两种都会产出）：
 * - 标准：`@@ -12,3 +12,4 @@`
 * - 新建文件：`@@ +1,5 @@`（无 `-` 段）
 */
export function fileLineNumbers(lines: readonly ParsedDiffLine[]): Map<number, number> {
  const map = new Map<number, number>();
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.side === null && line.text.startsWith('@@')) {
      const match = /^@@ (?:-(\d+)(?:,\d+)? )?\+(\d+)(?:,\d+)? @@/.exec(line.text);
      if (match !== null) {
        oldNo = match[1] === undefined ? 1 : Number(match[1]);
        newNo = Number(match[2]);
        continue;
      }
    }
    if (line.side === 'added') {
      map.set(line.index, newNo);
      newNo += 1;
      continue;
    }
    if (line.side === 'removed') {
      map.set(line.index, oldNo);
      oldNo += 1;
      continue;
    }
    // 上下文行：两侧同时前进
    map.set(line.index, newNo);
    oldNo += 1;
    newNo += 1;
  }
  return map;
}

/** 折叠视图选行：优先保住 ⚠️ 行，再按 diff 顺序保留上下文。 */
function selectCollapsedIndices(total: number, focus: readonly number[], max: number): number[] {
  if (total <= max) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const wanted = new Set<number>();
  if (focus.length === 0) {
    for (let i = 0; i < max; i += 1) {
      wanted.add(i);
    }
    return [...wanted].sort((a, b) => a - b);
  }
  for (const index of [...focus].sort((a, b) => a - b)) {
    for (let i = index - DIFF_CONTEXT_LINES; i <= index + DIFF_CONTEXT_LINES; i += 1) {
      if (i >= 0 && i < total) {
        wanted.add(i);
      }
    }
    if (wanted.size >= max) {
      break;
    }
  }
  const indices = [...wanted].sort((a, b) => a - b);
  if (indices.length <= max) {
    return indices;
  }
  // 超预算：⚠️ 行必留（否则「建议重点关注」会指向一行看不见的代码）
  const focusSet = new Set(focus);
  const keep = indices.filter((i) => focusSet.has(i));
  const rest = indices.filter((i) => !focusSet.has(i)).slice(0, Math.max(0, max - keep.length));
  return [...keep, ...rest].sort((a, b) => a - b);
}

/** diff/命令行的角色映射。 */
function roleOfDiffLine(text: string): ApprovalLineRole {
  if (text.startsWith('+')) {
    return 'diff-add';
  }
  if (text.startsWith('-')) {
    return 'diff-del';
  }
  if (text.startsWith('@@')) {
    return 'diff-hunk';
  }
  return 'diff-context';
}

/** 拼一行 diff 文本：内容按宽度截断后**再挂** ⚠️（避免标记被截掉）。 */
function diffLineText(text: string, marked: boolean, width: number): string {
  const mark = marked ? t().approval.diffFocusMark : '';
  const budget = width - displayWidth(mark);
  return `${clip(text, budget)}${mark}`;
}

/**
 * 详情区（diff / 命令）渲染：默认折叠 + `[v]` 展开 + 末行提示。
 *
 * shell 的 detail 是命令文本（没有 `+`/`-` 前缀语义），按纯文本行渲染；
 * edit 的 detail 是统一 diff，按前缀上角色色。
 */
function renderDetailLines(
  options: ApprovalTextOptions,
  focus: readonly number[],
  width: number,
): ApprovalLine[] {
  const dict = t().approval;
  const isDiff = options.kind === 'edit';
  const parsed = isDiff
    ? parseDiff(options.detail)
    : options.detail
        .split('\n')
        .map((line, index): ParsedDiffLine => ({ index, side: null, text: line.trimEnd() }));
  const total = parsed.length;
  const out: ApprovalLine[] = [];

  if (options.fullDiff === true) {
    const shown = parsed.slice(0, MAX_FULL_DIFF_LINES);
    for (const line of shown) {
      out.push({
        role: isDiff ? roleOfDiffLine(line.text) : 'detail',
        text: diffLineText(line.text, focus.includes(line.index), width),
      });
    }
    if (total > MAX_FULL_DIFF_LINES) {
      out.push({
        role: 'fold',
        text: clip(fmt(dict.diffTruncated, { total, limit: MAX_FULL_DIFF_LINES }), width),
      });
    }
    return out;
  }

  const indices = selectCollapsedIndices(total, focus, COLLAPSED_DIFF_LINES);
  for (const index of indices) {
    const line = parsed[index];
    if (line === undefined) {
      continue;
    }
    out.push({
      role: isDiff ? roleOfDiffLine(line.text) : 'detail',
      text: diffLineText(line.text, focus.includes(line.index), width),
    });
  }
  if (indices.length < total) {
    out.push({
      role: 'fold',
      text: clip(fmt(dict.diffFold, { count: total - indices.length }), width),
    });
  }
  return out;
}

/** 取与给定 diff 下标距离最近的命中（`focusLines` 与 `hits` 不一致时的兜底）。 */
function nearestHit(hits: readonly RiskHit[], diffLineIndex: number): RiskHit | undefined {
  let best: RiskHit | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    const distance = Math.abs(hit.diffLineIndex - diffLineIndex);
    if (distance < bestDistance) {
      best = hit;
      bestDistance = distance;
    }
  }
  return best;
}

/** 影响面文案：四态各自如实描述（**未分析 ≠ 无影响**，措辞红线 ②）。 */
export function describeImpact(impact: ImpactSummary): string {
  const dict = t().approval;
  const base = (() => {
    switch (impact.status) {
      case 'ok':
        return impact.referenceCount > 0
          ? fmt(dict.impactOk, {
              count: impact.referenceCount,
              paths: impact.topPaths.map((p) => p.split('/').at(-1) ?? p).join('、'),
            })
          : fmt(dict.impactOkZero, { scanned: impact.scannedCount });
      case 'timeout':
        return fmt(dict.impactTimeout, { ms: IMPACT_LIMITS.timeoutMs });
      case 'skipped':
        return fmt(dict.impactSkipped, { maxFiles: IMPACT_LIMITS.maxFiles });
      case 'not-needed':
        // 低风险不扫（省 IO）——如实说「没扫」，不冒充「项目过大」也不冒充「无影响」
        return dict.impactNotNeeded;
      default:
        return dict.impactError;
    }
  })();
  if (impact.skippedCount > 0) {
    return `${base}${fmt(dict.impactSkippedFiles, { count: impact.skippedCount })}`;
  }
  return base;
}

/** 按键行（**不截断**：安全相关按键必须完整可读）。 */
function buttonsText(options: ApprovalTextOptions): string {
  const dict = t().approval;
  return [
    dict.keyApprove,
    dict.keyReject,
    options.fullDiff === true ? dict.keyCollapse : dict.keyExpand,
    options.showHelp === true ? dict.keyHelpClose : dict.keyHelp,
  ].join('  ');
}

/**
 * `[?]` 内联说明（不跳外链、不开编辑器）。
 *
 * **散文一律折行、不截断**：帮助文本的价值就在完整那句话（尤其 medium 的
 * 「不是结论」这类关键限定），截断等于把结论砍掉——实测踩到过。
 */
function helpLines(width: number, ruleCount: number): ApprovalLine[] {
  const dict = t().approval;
  const entries = [
    dict.helpTitle,
    dict.helpHigh,
    dict.helpMedium,
    dict.helpLow,
    fmt(dict.helpSource, { count: ruleCount }),
    dict.helpDisable,
    dict.helpKeys,
  ];
  // 每条说明最多折 6 行（76 格宽下中文约 2 行，6 行是防异常输入撑爆卡片的上界）
  return entries.flatMap((text) =>
    wrapToWidth(text, width, 6).map((part): ApprovalLine => ({ role: 'help', text: part })),
  );
}

/** rich 路径：风险教学卡（标题 / 意图 / 改动性质 / 影响面 / 风险点 / 关注行 / diff / 按键）。 */
function renderRichLines(
  options: ApprovalTextOptions,
  insight: ApprovalInsight,
  width: number,
): ApprovalLine[] {
  const dict = t().approval;
  // 缺省用内置规则表规模：宁可说「15 类」也不说「0 类」（后者会让「未检测到风险」失去意义）
  const ruleCount = options.ruleCount ?? RISK_RULES.length;
  const out: ApprovalLine[] = [];

  // ① 标题：{图标}{级别}审批 · {动作}{目标}
  out.push({
    role: 'title',
    text: clip(`${dict.levelTitle[insight.level]} · ${options.summary}`, width),
  });

  // ② 操作意图（edit 才有；帮用户回答「这一下是新建还是改」）
  if (options.intent !== undefined) {
    out.push({
      role: 'intent',
      text: clip(`${dict.intentLabel}${dict.intent[options.intent]}`, width),
    });
  }

  if (insight.degradeReason === 'huge-diff') {
    // 降级矩阵：超大 diff 不做逐行分析，但**如实告知**共多少行，不假装「无风险」
    out.push({
      role: 'notice',
      text: clip(fmt(dict.hugeDiff, { count: parseDiff(options.detail).length }), width),
    });
    out.push(...renderDetailLines(options, [], width));
    out.push({ role: 'buttons', text: buttonsText(options) });
    return out;
  }

  // ③ 改动性质 / 未命中提示
  // 这两块是**结论性散文**，折行不截断：截断会砍掉「N 个文件读取失败已跳过」这类
  // 如实披露盲区的尾巴（红线 ② 的精神：宁可多一行，不可少一句）。
  pushWrapped(
    out,
    'nature',
    insight.changeNatures.length > 0
      ? `${dict.natureLabel}${insight.changeNatures.join('、')}`
      : fmt(dict.noRiskPattern, { count: ruleCount }),
    width,
  );

  // ④ 影响面
  pushWrapped(
    out,
    'impact',
    `${dict.impactLabel}${
      options.impactApplies === false ? dict.impactNotApplicable : describeImpact(insight.impact)
    }`,
    width,
  );

  // ⑤ 风险点（high）／建议重点关注（medium、low）
  const topHits = insight.hits.slice(0, MAX_HIT_LINES);
  if (topHits.length > 0) {
    const isHigh = insight.level === 'high';
    const header = isHigh ? dict.riskLabel : dict.attentionLabel;
    out.push({ role: isHigh ? 'risk' : 'attention', text: clip(header, width) });
    for (const hit of topHits) {
      out.push({
        role: isHigh ? 'risk' : 'attention',
        text: clip(`  ▪ ${hit.why}`, width),
      });
    }
  }

  // ⑥ 建议重点关注行（把 diff 里的 ⚠️ 换成一句人话）
  if (insight.focusLines.length > 0) {
    const fileLines =
      options.kind === 'edit'
        ? fileLineNumbers(parseDiff(options.detail))
        : new Map<number, number>();
    for (const focusIndex of insight.focusLines.slice(0, MAX_HIT_LINES)) {
      // 数据一致性：`focusLines` 由 T8 从 hits 派生，正常必然对得上；但若上游改动导致
      // 对不上，**不能让整块「建议重点关注」静默消失**（用户会以为没有重点），
      // 故回退到距离最近的一条命中，取其建议文案。
      const hit =
        insight.hits.find((h) => h.diffLineIndex === focusIndex) ??
        nearestHit(insight.hits, focusIndex);
      if (hit === undefined) {
        continue;
      }
      out.push({
        role: 'focus',
        text: clip(
          fmt(dict.focusLabel, {
            line: fileLines.get(focusIndex) ?? focusIndex + 1,
            why: hit.suggestion,
          }),
          width,
        ),
      });
    }
  }

  // ⑦ diff 区
  out.push(...renderDetailLines(options, insight.focusLines, width));

  // ⑧ 内联说明
  if (options.showHelp === true) {
    out.push(...helpLines(width, ruleCount));
  }

  // ⑨ 按键（n 写明后果；v/? 为纯 UI 状态，不产生决议）
  out.push({ role: 'buttons', text: buttonsText(options) });
  return out;
}

/**
 * 渲染审批卡（**唯一文案来源**）。
 *
 * 纯函数：同输入必得同输出（决策只在 `analyzeApproval` 里做）。
 */
export function renderApprovalLines(options: ApprovalTextOptions): ApprovalLine[] {
  const width = Math.max(24, options.width ?? DEFAULT_CARD_WIDTH);
  if (isPlainApproval(options)) {
    return renderPlainLines(options);
  }
  return renderRichLines(options, options.insight as ApprovalInsight, width);
}

/**
 * 把审批详情转成「可参与风险规则匹配的源码文本」。
 *
 * - `edit`：detail 本身就是统一 diff（`+`/`-` 前缀已带侧别信息）→ 原样返回；
 * - `shell`：命令文本没有侧别前缀，规则一条都命中不了（`analyzeDiff` 只匹配
 *   `+`/`-` 行）→ 逐行补 `+`，按「新增源码行」参与匹配；
 * - `model`：成本文案，不参与匹配（调用方也不会传）。
 *
 * 为什么放在这里而不是 `analyzeApproval` 内部：`analyzeApproval` 的契约是「吃 diff」，
 * 把「命令文本 → 伪 diff」的适配放在 UI 层，纯分析核心不必知道 shell 的存在。
 */
export function analyzableDetail(kind: ApprovalKind, detail: string): string {
  if (kind === 'edit') {
    return detail;
  }
  return detail
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
}

/**
 * 渲染为可直接打印的整段文本（**非 TTY / 嵌入场景的唯一出口**）。
 *
 * 与 Ink 路径共用 `renderApprovalLines`，因此两者文案必然一致（一致性测试断言）。
 */
export function renderApprovalText(options: ApprovalTextOptions): string {
  return renderApprovalLines(options)
    .map((line) => line.text)
    .join('\n');
}
