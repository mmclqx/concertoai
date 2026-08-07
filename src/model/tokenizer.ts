/**
 * 简易 token 估算（v0.2 计划替换为 BPE 精确分词，见 docs/dev/TASKS.md）。
 *
 * 规则：
 * - CJK 字符（中日韩统一表意文字、假名、谚文等）按 1 字符 ≈ 1 token；
 * - 其余字符按 4 字符 ≈ 1 token（向上取整）。
 *
 * 相比「纯字符/4」近似，对中文优先的产品更接近真实计数，避免成本条严重低估。
 */

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/gu;

export function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4) + cjk;
}

/** 每条消息的固定 token 开销（角色名、结构标记等）。 */
const MESSAGE_OVERHEAD = 4;

/**
 * 估算一组消息的总 token 数：每条 = 固定开销 + 内容估算。
 * 入参用最小结构类型，避免依赖 client.ts 的消息类型。
 */
export function estimateMessageListTokens(
  messages: ReadonlyArray<{ role: string; content: string | null }>,
): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD + estimateTokens(message.content ?? '');
  }
  return total;
}
