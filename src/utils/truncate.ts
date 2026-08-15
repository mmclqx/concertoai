/**
 * 文本截断工具（v4.1 T1.1 体验打磨轮）。
 *
 * truncateMiddle：超长文本保留头尾、中间省略，并标注原长度——
 * 用于工作流失败输出等场景，让用户先看到「关键信息」（头）+「结尾上下文」（尾），
 * 而不是被完整 diff 淹没（客户评价问题 5：biome 格式报错输出淹没失败提示）。
 */

/** 截断标注占位：`…（已截断，共 N 字符）`。 */
function truncateMarker(total: number): string {
  return `…（已截断，共 ${total} 字符）`;
}

/**
 * 中间截断：保留 head 比例 + tail 比例，中间用标注连接。
 * 总输出长度 ≤ maxChars（标注计入长度）；短文本原样返回。
 *
 * @param text 原文
 * @param maxChars 最大输出字符数（含标注）
 * @param headRatio 头部保留比例（默认 0.7，偏重开头摘要）
 */
export function truncateMiddle(text: string, maxChars: number, headRatio = 0.7): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = truncateMarker(text.length);
  const keep = Math.max(1, maxChars - marker.length);
  const headLen = Math.floor(keep * headRatio);
  const tailLen = keep - headLen;
  return `${text.slice(0, headLen)}${marker}${text.slice(text.length - tailLen)}`;
}

/** 剥离 ANSI 转义码（工具链非 TTY 输出通常无颜色，但防御处理）。 */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离 ANSI 必须匹配 ESC 控制字符
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}
