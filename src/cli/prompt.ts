/**
 * 共享行输入工具（v4.0.1 修复：Ctrl+C 崩溃链路；v4.1 T1.2 扩展：超时）。
 *
 * 背景：workflow / plugin / provider 三处此前各自用 readline/promises 的
 * question() 读输入；用户按 Ctrl+C 时 question() 抛 AbortError，若未被捕获
 * 会触发 crash-handler 的 unhandledRejection → 误写 crash.log + exit(1)
 * （用户主动中断不是崩溃）。
 *
 * 语义：AbortError（Ctrl+C）→ 返回 undefined，由调用方按「无输入」处理
 * （恢复选择走 abort = fail-closed，审批走拒绝 = fail-closed，均为既有安全路径）；
 * 非 TTY → undefined；超时（timeoutMs）→ undefined（与 Ctrl+C 同语义，调用方
 * 按放弃处理，用于 F 等待态防挂起）；其他错误原样上抛（不吞真实异常）。
 */

import readline from 'node:readline/promises';

/** 行输入选项。 */
export interface PromptLineOptions {
  /** 超时毫秒（缺省不超时；超时返回 undefined 由调用方降级）。 */
  timeoutMs?: number;
}

/**
 * 读一行输入（TTY 交互；非 TTY / Ctrl+C / 超时返回 undefined 由调用方降级）。
 * 超时实现：AbortController + 竞速——超时触发 abort 使 question() 抛 AbortError。
 */
export async function promptLine(
  prompt: string,
  options?: PromptLineOptions,
): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const timer =
    options?.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;
  try {
    const answer = await rl.question(prompt, { signal: controller.signal });
    return answer.trim();
  } catch (err) {
    // 用户 Ctrl+C 或超时：question() 抛 AbortError，是正常取消而非崩溃 → undefined
    if (err instanceof Error && err.name === 'AbortError') {
      return undefined;
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    rl.close();
  }
}
