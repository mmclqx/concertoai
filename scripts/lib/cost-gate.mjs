/**
 * 成本闸门（K15 修法 ③）：把「读花费 → 判阈值 → 决定继续/停手」抽成**纯函数**。
 *
 * ## 为什么必须抽出来
 *
 * 原来的闸门写在两个驱动脚本里，判据是「跑前余额 − 跑后余额」。它有两个问题：
 * 1. **判据失效**：余额 2 位小数 + 结算延迟 → 刚跑完差额恒为 0，
 *    实测花 ¥2.11 仍打印「差 0」，超 ¥1 停手从未触发（K15）；
 * 2. **无法测试**：脚本要真 Key、真花钱、跑 CLI 才能走到判定，于是
 *    「闸门有没有牙」这件事只能靠人相信。
 *
 * 抽成纯函数后，`npm test` 里可以用注入数值直接证明「超阈值必停」「读不到花费必停」，
 * 不花一分钱。
 *
 * ## 判据（fail-closed）
 *
 * | 输入 | 判定 |
 * |---|---|
 * | 读到成本，未超阈值 | `stop: false`，继续 |
 * | 读到成本，超阈值 | `stop: true` + 原因 |
 * | **读不到成本**（行缺失 / 解析失败 / NaN） | **`stop: true`** —— 不可度量就不许花真钱 |
 *
 * 「读不到就停」是这次的纪律核心：老脚本在「读不到」时把差额当 0，等于给未知花费
 * 发了一张免检通行证。
 */

/**
 * 成本行锚点（语义锚，不是装饰锚）。
 *
 * 口语化字符（`💰`、全角冒号、`｜`）**不参与匹配**：只锚定「本次消耗」四个字 +
 * 最近的一个 `¥金额`。CLI 文案要改措辞时，这个闸门不会因为符号变化而静默失配
 * （2026-08 的教训：正则锚在会被改的装饰符号上，改文案就静默不再命中）。
 */
export const COST_LINE_ANCHOR = '本次消耗';

/** 成本行正则（金额允许 6 位小数：一次子代理调用 ≈ ¥0.0002，2 位小数看不见）。 */
export const COST_LINE_PATTERN = /本次消耗[^\n]*?¥\s*([0-9]+(?:\.[0-9]+)?)/;

/**
 * 成本行里出现「未计价」= 有模型不在价格表里 → 金额只是**下限**。
 *
 * 这条按 fail-closed 处理（当「读不到」）：闸门要防的是「花了但看不见」，
 * 允许一个下限值通过等于给未知花费免检。`tests/scripts/cost-gate.test.ts`
 * 里有护栏断言：「`zh.usage.unpriced` 必须含『未计价』」——改文案会红，不会静默失配。
 */
const UNPRICED_MARKER = '未计价';

/**
 * PTY 折行兜底宽度。
 *
 * 真 Key 复验走 PTY（`cols: 120`），一行太长会被终端折成两行，
 * 金额可能掉到下一行 —— 只看单行会「读不到」（还恰好是最容易发生的那次）。
 * 从锚点行起最多拼接 3 行：既兜住折行，又不至于把别处的 `¥` 误当成本次花费。
 */
const WRAP_SPAN = 3;

/**
 * 解析成本行（`💰 本次消耗：… ≈ ¥0.0021`）。
 *
 * 成功返回 `{ ok: true, cost, raw }`；找不到 / 数字非法 / 含未计价模型返回
 * `{ ok: false, reason }`。**不返回 0 兜底**：0 与「没读到」在闸门里必须是两种结局。
 */
export function parseCostLine(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: '输出为空' };
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(COST_LINE_ANCHOR)) continue;
    for (let span = 1; span <= WRAP_SPAN; span += 1) {
      const candidate = lines.slice(i, i + span).join(' ');
      const match = COST_LINE_PATTERN.exec(candidate);
      if (match === null) continue;
      const raw = match[1];
      const cost = Number(raw);
      if (!Number.isFinite(cost) || cost < 0) {
        return { ok: false, reason: `金额非法：${raw}` };
      }
      // 注意查**整段候选行**而不是 `match[0]`：中文文案里「未计价」在金额**之后**
      // （`≈ ¥0.000000（x 不在价格表里，这部分未计价）`），只看匹配到的片段会漏。
      if (candidate.includes(UNPRICED_MARKER)) {
        return { ok: false, reason: '成本行含未计价模型，金额只是下限（按不可度量处理）' };
      }
      return { ok: true, cost, raw: match[0] };
    }
  }
  return { ok: false, reason: '未找到「本次消耗」行' };
}

/**
 * 单场景闸门判定。
 *
 * @param {{ measured: boolean, cost?: number } | undefined} reading 一次场景的花费读数
 * @param {number} limitCny 单场景阈值（元）
 * @param {string} [label] 场景名（进原因文案）
 * @returns {{ stop: boolean, cost: number|undefined, reason: string }}
 */
export function gateDecision(reading, limitCny, label = '本场景') {
  const unusable = `${label}读不到本次消耗，按超预算处理（不继续花钱）`;
  if (reading === null || typeof reading !== 'object') {
    return { stop: true, cost: undefined, reason: unusable };
  }
  if (reading.measured !== true || typeof reading.cost !== 'number' || !Number.isFinite(reading.cost)) {
    return { stop: true, cost: undefined, reason: unusable };
  }
  const cost = reading.cost;
  if (cost > limitCny) {
    return { stop: true, cost, reason: `${label}花费 ¥${cost} 超阈值 ¥${limitCny}` };
  }
  return { stop: false, cost, reason: `${label}花费 ¥${cost}，未超阈值 ¥${limitCny}` };
}

/**
 * 累计闸门：把多个读数相加后再判（同一场景多次运行 / 全程多场景两种口径共用）。
 *
 * 与单场景闸门分开的理由：单场景「不超标」不等于全程「不超标」——
 * 10 个场景各 ¥0.9 会一路绿灯花掉 ¥9。同理，同一场景里「审查 + `--fix`」
 * 是两次运行、两行成本，必须加总才叫「本场景花了多少」。
 */
export function totalGateDecision(readings, totalLimitCny) {
  const list = Array.isArray(readings) ? readings : [];
  let sum = 0;
  for (const reading of list) {
    if (reading === null || typeof reading !== 'object' || reading.measured !== true) {
      return { stop: true, total: undefined, reason: '存在读不到消耗的读数，按超预算处理（不继续花钱）' };
    }
    if (typeof reading.cost !== 'number' || !Number.isFinite(reading.cost)) {
      return { stop: true, total: undefined, reason: '存在非法金额的读数，按超预算处理（不继续花钱）' };
    }
    sum += reading.cost;
  }
  if (sum > totalLimitCny) {
    return { stop: true, total: sum, reason: `累计花费 ¥${sum} 超阈值 ¥${totalLimitCny}` };
  }
  return { stop: false, total: sum, reason: `累计花费 ¥${sum}，未超阈值 ¥${totalLimitCny}` };
}
