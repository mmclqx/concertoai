/**
 * 展示态切换节流（v5.0 T9.3c，专家加固）。
 *
 * ## 解决什么问题
 *
 * 用户在审批框上**狂按 `v`**（或长 diff 场景下反复开合）时，每次按键都会触发一次 Ink
 * 全树重渲染：终端会闪烁、按键感觉「黏」，严重时 CPU 打满导致 `y`/`n` 也变慢。
 *
 * ## 语义（刻意选择「丢弃中间态」而不是排队）
 *
 * - 距上次应用 **≥ 80ms** → 立即应用（第一次按键零延迟，手感不打折）；
 * - 未到期 → 只记住**最后一次意图**（覆盖式写入，不排队），到期后 flush 一次；
 * - 因此连按 10 次最多产生 **2 次**渲染（首次立即 + 一次 flush），而不是 10 次。
 *
 * ## 安全红线
 *
 * 本模块**只能用于展示态**（`[v]` 展开 diff / `[?]` 说明）。`y` / `n` 审批决议**绝不**
 * 经过节流——按键必须即时响应（G1 安全不降级）。
 *
 * ## 实现约束
 *
 * - 不用 `setInterval` 轮询（持续推进的定时器会有生命周期泄漏风险），只在需要时挂一个
 *   `setTimeout`，flush / dispose 后立即清空；
 * - `dispose()` 会清掉定时器与待处理意图 → 组件卸载不残留 timer（有测试断言）。
 *
 * 纯逻辑（无 React/Ink 依赖），定时器与时钟均可注入，便于测试与复用。
 */

/** 默认最小渲染间隔（毫秒）。 */
export const RENDER_THROTTLE_MS = 80;

/** 可注入的定时器/时钟（测试用）。 */
export interface ToggleThrottleOptions {
  /** 最小间隔（毫秒），缺省 80。 */
  minIntervalMs?: number;
  /** 时钟注入（缺省 Date.now）。 */
  now?: () => number;
  /** 定时器注入（缺省 setTimeout）。 */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** 取消定时器注入（缺省 clearTimeout）。 */
  cancel?: (handle: unknown) => void;
}

/** 节流器句柄。 */
export interface ToggleThrottle<T> {
  /** 请求切换到某状态：到期立即应用，未到期只记最后一次意图。 */
  request: (value: T) => void;
  /** 立即应用待处理意图（无待处理则无操作）。 */
  flush: () => void;
  /** 丢弃待处理意图并清掉定时器（组件卸载/审批结束时调用，避免悬挂 timer）。 */
  dispose: () => void;
  /** 是否还有未应用的意图（测试断言用）。 */
  hasPending: () => boolean;
}

/**
 * 创建节流器。
 *
 * @param apply 实际应用状态的函数（React 里就是 `setState`）
 * @param options 时钟/定时器/间隔注入
 */
export function createToggleThrottle<T>(
  apply: (value: T) => void,
  options: ToggleThrottleOptions = {},
): ToggleThrottle<T> {
  const minIntervalMs = options.minIntervalMs ?? RENDER_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());
  const schedule =
    options.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel =
    options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastAppliedAt = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | undefined;
  let timer: unknown;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };

  const flush = (): void => {
    clearTimer();
    if (pending === undefined) {
      return;
    }
    const { value } = pending;
    pending = undefined;
    lastAppliedAt = now();
    apply(value);
  };

  const request = (value: T): void => {
    const elapsed = now() - lastAppliedAt;
    if (elapsed >= minIntervalMs) {
      clearTimer();
      pending = undefined;
      lastAppliedAt = now();
      apply(value);
      return;
    }
    // 覆盖式写入：连击只保留最后一次意图（丢弃中间态，不排队渲染 10 帧）
    pending = { value };
    if (timer === undefined) {
      timer = schedule(flush, minIntervalMs - elapsed);
    }
  };

  const dispose = (): void => {
    clearTimer();
    pending = undefined;
  };

  return {
    request,
    flush,
    dispose,
    hasPending: () => pending !== undefined,
  };
}
