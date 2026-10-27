/**
 * 展示态切换节流测试（v5.0 T9.3c）。
 *
 * 三条最重要的断言（对应专家点名 + 验收标准）：
 * 1. **连按 10 次渲染帧 ≤ 3**（不是排队渲染 10 帧）；
 * 2. **最终状态正确**（丢弃中间态不等于丢最后一次意图）；
 * 3. **dispose 后无悬挂 timer**（卸载不残留定时器）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createToggleThrottle,
  RENDER_THROTTLE_MS,
  type ToggleThrottleOptions,
} from '../../src/ui/toggle-throttle';

/** 假时钟 + 假定时器（不依赖真实时间，避免 flaky）。 */
function fakeTimers() {
  let now = 0;
  const queue: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const options: ToggleThrottleOptions = {
    now: () => now,
    schedule: (callback, ms) => {
      const task = { at: now + ms, callback, cancelled: false };
      queue.push(task);
      return task;
    },
    cancel: (handle) => {
      const task = handle as { cancelled: boolean };
      task.cancelled = true;
    },
  };
  return {
    options,
    advance: (ms: number) => {
      now += ms;
      for (const task of queue) {
        if (!task.cancelled && task.at <= now) {
          task.cancelled = true; // 只触发一次
          task.callback();
        }
      }
    },
    /** 还有多少个未取消/未触发的定时器（悬挂 timer 断言用）。 */
    pendingTimers: () => queue.filter((task) => !task.cancelled).length,
  };
}

describe('createToggleThrottle', () => {
  it('默认最小间隔为 80ms（T9.3c 规格）', () => {
    expect(RENDER_THROTTLE_MS).toBe(80);
  });

  it('第一次请求立即生效（手感不打折，不是「等 80ms 才响应」）', () => {
    const applied: boolean[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<boolean>((v) => applied.push(v), clock.options);

    throttle.request(true);
    expect(applied).toEqual([true]);
  });

  it('间隔内连按 10 次：应用次数 ≤ 3，且最终状态是最后一次意图', () => {
    const applied: boolean[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<boolean>((v) => applied.push(v), clock.options);

    // 第 1 次立即生效，其余 9 次在 80ms 窗口内连击
    for (let i = 0; i < 10; i += 1) {
      throttle.request(i % 2 === 0);
    }
    expect(applied.length).toBe(1); // 只有首次立即生效
    expect(throttle.hasPending()).toBe(true);

    clock.advance(RENDER_THROTTLE_MS);
    // 首次 + 一次 flush = 2 帧（远小于 10 帧）
    expect(applied.length).toBeLessThanOrEqual(3);
    // 最后一次意图是 i=9 → true（9 % 2 === 1 → false... 校验实际值而非硬编码）
    expect(applied.at(-1)).toBe(9 % 2 === 0);
    expect(throttle.hasPending()).toBe(false);
  });

  it('间隔够了之后的新请求立即生效（不会永久节流）', () => {
    const applied: boolean[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<boolean>((v) => applied.push(v), clock.options);

    throttle.request(true);
    clock.advance(RENDER_THROTTLE_MS);
    throttle.request(false);
    expect(applied).toEqual([true, false]);
  });

  it('覆盖式写入：窗口内的多次意图只保留最后一次（不排队）', () => {
    const applied: string[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<string>((v) => applied.push(v), clock.options);

    throttle.request('first'); // 立即
    throttle.request('a');
    throttle.request('b');
    throttle.request('c'); // 只保留 c
    clock.advance(RENDER_THROTTLE_MS);

    expect(applied).toEqual(['first', 'c']);
  });

  it('flush 立即应用待处理意图', () => {
    const applied: number[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<number>((v) => applied.push(v), clock.options);

    throttle.request(1);
    throttle.request(2);
    expect(applied).toEqual([1]);
    throttle.flush();
    expect(applied).toEqual([1, 2]);
    expect(throttle.hasPending()).toBe(false);
  });

  it('dispose 清空待处理意图并取消定时器（卸载不留悬挂 timer）', () => {
    const applied: boolean[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<boolean>((v) => applied.push(v), clock.options);

    throttle.request(true);
    throttle.request(false);
    expect(clock.pendingTimers()).toBe(1);

    throttle.dispose();
    expect(clock.pendingTimers()).toBe(0);
    expect(throttle.hasPending()).toBe(false);

    // dispose 之后即使时钟推进也不会再应用（不会对已卸载组件 setState）
    clock.advance(RENDER_THROTTLE_MS * 5);
    expect(applied).toEqual([true]);
  });

  it('dispose 后再请求仍能工作（不永久失效）', () => {
    const applied: boolean[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<boolean>((v) => applied.push(v), clock.options);

    throttle.request(true);
    throttle.dispose();
    clock.advance(RENDER_THROTTLE_MS);
    throttle.request(false);
    expect(applied).toEqual([true, false]);
  });

  it('flush 无待处理时是空操作（不重复 apply）', () => {
    const applied: boolean[] = [];
    const clock = fakeTimers();
    const throttle = createToggleThrottle<boolean>((v) => applied.push(v), clock.options);

    throttle.flush();
    expect(applied).toEqual([]);
  });

  it('用真实定时器时同样只渲染少量帧（集成口径）', async () => {
    vi.useRealTimers();
    const applied: number[] = [];
    const throttle = createToggleThrottle<number>((v) => applied.push(v));
    for (let i = 0; i < 10; i += 1) {
      throttle.request(i);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    throttle.dispose();
    expect(applied.length).toBeLessThanOrEqual(3);
    // 最后一次意图（9）必须落地
    expect(applied.at(-1)).toBe(9);
  });
});
