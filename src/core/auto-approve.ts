/**
 * 低风险自动放行判定（v5.1 T1.1，ADR-052）。
 *
 * ## 这个模块存在的唯一理由：把「安全命门」变成一处可测的纯函数
 *
 * `--auto-low` 只放行**一种**情况：风险分析**成功完成**且**一条规则都没命中**的**编辑**。
 * 判定过程零 IO、零模型、零时间依赖，所以它可以被变异探针逐条打穿（T1.3 的 M1-M5）。
 *
 * ## ⚠️ 安全命门（删掉任何一个条件都等于 yolo，**不许简化**）
 *
 * ```ts
 * insight.degraded === false && insight.level === 'low'
 * ```
 *
 * `analyzeApproval` 在**降级**时 `hits = []`，而 `levelOf([]) === 'low'`（`approval-insight.ts`）。
 * 也就是说：**降级路径的 level 恰好就是 low**。实测（同一段含 `rm -rf` 的 diff）：
 *
 * | 场景 | level | degraded | degradeReason |
 * |---|---|---|---|
 * | 非 TTY | low | true | non-tty |
 * | CI | low | true | ci |
 * | config approvalInsight: 'plain' | low | true | config-off |
 * | 超大 diff（>500 行） | low | true | huge-diff |
 * | TTY 正常（对照） | high | false | — |
 *
 * 只判 `level === 'low'` ⇒ 上述四种情况下**任何**操作都会自动放行（含 `rm -rf`），
 * 事实等于 yolo，直接打穿「安全优先、无 yolo 模式」的产品定位。所以 `degraded` 必须一起判。
 *
 * ## 判定顺序即安全语义
 *
 * 顺序是「先排除，后放行」，并且**先把 high/medium 显式挡住**再判 low：
 * 将来 `RiskLevel` 若扩值（如 `critical`），`level === 'low'` 不成立 ⇒ 落到 `ask`，
 * 而不是因为没人更新这个文件就悄悄放行一个新等级（末尾的 `unknown-level` 分支就是为此留的）。
 *
 * ## 另外三条硬底线（在调用方与本模块共同保证）
 *
 * 1. **shell 永远问**（`kind !== 'edit'` 直接 ask）：实测 21 条危险命令里 18 条零命中
 *    （`npm publish` / `git push --force` / `git reset --hard` / `curl … | sh` / `chmod -R 777 /` / `del /q *.*`），
 *    规则表是为「源码行」设计的，对命令行语义覆盖严重不足。shell 想免审批走 `config.allowlist`。
 * 2. **分析没结果就问**（`insight === null` ⇒ ask）：宁可多问一次，不许漏问一次。
 * 3. **high / medium 永远问**：medium 含 concurrency / silent-catch / test-assertion-change。
 */

import type { RiskLevel } from './risk-rules';

/**
 * 审批类别。
 *
 * **刻意不 `import` `ApprovalRequest['kind']`**：那会让 `src/core` 反向依赖 `src/tools`（当前依赖方向是
 * tools ← …，core 不依赖 tools）。取值与 `ApprovalRequest['kind']`（`tools/registry.ts`）、
 * `ApprovalKind`（`ui/approval-text.ts`）逐字一致；漂移由 `tests/core/auto-approve.test.ts` 的
 * 类型断言在 `npm run typecheck` 阶段挡住（新增 kind 而不更新这里 ⇒ 类型断言红）。
 */
export type AutoLowApprovalKind = 'edit' | 'shell' | 'model';

/**
 * 判定结论的原因（**放行与拒绝都要说清为什么**）。
 *
 * 留痕文案与排障都靠它：`low-clean` 才会放行，其余一律弹框。
 */
export type AutoLowReason =
  | 'low-clean' // ✅ 放行：分析成功 + 零命中 + 编辑
  | 'disabled' // 没开 --auto-low（默认路径）
  | 'not-edit' // shell / model 永不自动放行
  | 'no-insight' // 分析未完成 / 抛错 / 还没算出来 ⇒ fail-closed
  | 'degraded' // 走了降级路径（4 种原因）⇒ fail-closed，**这是命门**
  | 'high' // 命中 high 级规则
  | 'medium' // 命中 medium 级规则（5.1 刻意不放）
  | 'unknown-level'; // 未来新增等级：不认识就不放（默认拒绝）

/** 判定结论。 */
export interface AutoLowDecision {
  action: 'allow' | 'ask';
  reason: AutoLowReason;
}

/**
 * 判定只需要 insight 的两个字段（结构类型，便于单测构造与解耦）。
 *
 * `ApprovalInsight` 天然满足这个形状，调用方不需要转换。
 */
export interface AutoLowInsightLike {
  degraded: boolean;
  level: RiskLevel;
}

/** 判定入参。 */
export interface AutoLowInput {
  /** 是否显式开启了 `--auto-low`（默认 false ⇒ 与今天行为一致）。 */
  enabled: boolean;
  /** 审批类别。 */
  kind: AutoLowApprovalKind;
  /** 风险分析结果；`null` = 还没算出来 / 分析失败 / 未执行。 */
  insight: AutoLowInsightLike | null;
}

/**
 * 决定「这一次审批要不要自动放行」。
 *
 * 纯函数：同输入必得同输出，无 IO、无时间、无随机。放行判据见文件头「安全命门」。
 */
export function decideAutoLow(input: AutoLowInput): AutoLowDecision {
  // ① 没开开关：与今天完全一致（默认行为不变）
  if (!input.enabled) {
    return { action: 'ask', reason: 'disabled' };
  }
  // ② 只放行编辑：shell / model 一律问（见文件头硬底线 1）
  if (input.kind !== 'edit') {
    return { action: 'ask', reason: 'not-edit' };
  }
  // ③ 没有分析结果 ⇒ 问（fail-closed，宁可多问一次）
  if (input.insight === null) {
    return { action: 'ask', reason: 'no-insight' };
  }
  // ④ 【安全命门】降级路径的 level 也是 low，必须靠 degraded 把它挡在放行之外
  if (input.insight.degraded !== false) {
    return { action: 'ask', reason: 'degraded' };
  }
  // ⑤ 先显式挡住 high / medium，再判 low（顺序即安全语义，见文件头）
  switch (input.insight.level) {
    case 'high':
      return { action: 'ask', reason: 'high' };
    case 'medium':
      return { action: 'ask', reason: 'medium' };
    case 'low':
      // 走到这里 ⇒ 分析成功（degraded === false）且零命中 ⇒ 唯一允许放行的情形
      return { action: 'allow', reason: 'low-clean' };
    default:
      // 未来新增等级：不认识就不放
      return { action: 'ask', reason: 'unknown-level' };
  }
}
