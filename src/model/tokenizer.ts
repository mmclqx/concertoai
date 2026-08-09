/**
 * BPE 精确 Token 计数器（v2.0）。
 *
 * 使用 `tiktoken`（o200k_base 编码器）精确计算 token 数，替换 v1.0 的 CJK 加权估算。
 * - 编码器仅初始化一次（懒加载单例），避免重复加载 ~400KB 的编码器 WASM 文件；
 * - 若 tiktoken 加载失败（原生模块兼容问题），自动降级到旧 CJK 加权估算并标注「估算」。
 *
 * 消息级计数：每条消息的 base overhead 取 4 token（含 role 标记与结构开销），
 * 与 v1.0 的 MESSAGE_OVERHEAD 保持一致。
 */

import { get_encoding, type Tiktoken } from 'tiktoken';

// ── 旧估算逻辑（降级方案）─────────────────────────────────────

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/gu;

function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4) + cjk;
}

// ── 懒加载单例 ─────────────────────────────────────────────────

let _encoder: Tiktoken | null | undefined; // undefined=未初始化, null=加载失败
let _encoderFallback = false;

function getEncoder(): Tiktoken | null {
  if (_encoder !== undefined) {
    return _encoder;
  }
  try {
    _encoder = get_encoding('o200k_base');
    return _encoder;
  } catch {
    _encoder = null;
    _encoderFallback = true;
    return null;
  }
}

// ── 公共 API ────────────────────────────────────────────────────

/**
 * 精确计算一段文本的 token 数（BPE）。
 * 若 tiktoken 加载失败，降级到 CJK 加权估算。
 */
export function countTokens(text: string): number {
  const enc = getEncoder();
  if (enc !== null) {
    // tiktoken 的 encode 返回 Uint32Array，length 即为 token 数
    return enc.encode(text).length;
  }
  return estimateTokens(text);
}

/** 每条消息的固定 token 开销（角色名、结构标记等）。 */
const MESSAGE_OVERHEAD = 4;

/** 满足 countMessageTokens 入参的最小结构类型。 */
export interface CountableMessage {
  role: string;
  content: string | null;
}

/**
 * 精确计算单条消息的 token 数：base overhead + content token。
 */
export function countMessageTokens(msg: CountableMessage): number {
  return MESSAGE_OVERHEAD + countTokens(msg.content ?? '');
}

/**
 * 精确计算一组消息的总 token 数。
 */
export function countMessageListTokens(messages: ReadonlyArray<CountableMessage>): number {
  let total = 0;
  for (const message of messages) {
    total += countMessageTokens(message);
  }
  return total;
}

/**
 * 返回当前使用的计数模式是否为估算降级（供外部标注）。
 */
export function isTokenEstimate(): boolean {
  return _encoderFallback;
}

/**
 * 后台预加载 BPE 编码器（WASM 加载约 100ms，性能优化）。
 *
 * 供启动阶段调用：通过 setImmediate 延迟到当前帧之后执行，不阻塞首帧渲染；
 * 但能在用户首次输入前完成加载，使首轮对话的 token 计数（上下文压缩）不再产生额外延迟。
 * 若编码器已被其他调用初始化，本函数无副作用。
 */
export function preloadTokenizer(): void {
  setImmediate(() => {
    getEncoder();
  });
}

// ── 向后兼容（v1.0 API）────────────────────────────────────────
// 保留旧 estimateTokens / estimateMessageListTokens 作为别名，
// v2.1 移除。内部已指向 BPE 精确计数。

export { countMessageListTokens as estimateMessageListTokens, countTokens as estimateTokens };
