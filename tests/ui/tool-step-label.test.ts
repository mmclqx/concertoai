/**
 * `toolStepLabel` 纯函数测试（v5.1 T2.2）。
 *
 * ## 为什么这条必须单测，而不是只靠整树渲染
 *
 * 第一版把文案内联在 `App.tsx` 的 JSX 里，我配了三个探针，实测 **两个无牙**：
 *
 * | 探针 | 改法 | 结果 |
 * |---|---|---|
 * | P1 | 删掉 `setActiveStep(event.stepIndex)` | 有牙（4 红） |
 * | P2 | 入口 `setActiveStep(0)` → `99` | **无牙**（loop 侧也发 1，UI 重置被覆盖，见下） |
 * | P3 | `activeStep > 0` → `activeStep >= 0` | **无牙**（用例造的是纯文本回复，`activeTool` 全程 null，状态行不渲染 ⇒ 断言空转） |
 *
 * P3 无牙正是「断言守的取值落不进被测范围」的典型（AGENTS 注入/扰动类验证条）。
 * 判定搬进纯函数后，`step = 0` 能直接喂进来，「该红必红」才成立 —— P3' 见本文件。
 *
 * P2 无牙则说明一件事，如实记：**UI 侧的 `setActiveStep(0)` 在当前架构下不可观测**
 * （`send` 里同时 `setActiveTool(null)`，状态行不渲染；下一个 `tool_call` 又会用 loop
 * 发来的 `1` 覆盖）。它留着是防御（万一将来 loop 改成跨 `runLoop` 累计，UI 不会残留旧步号），
 * 但**它不构成「新一轮从 1 开始」的保证**——那条保证在
 * `tests/loop/loop-step-index.test.ts`（每次 `runLoop` 都从 1 开始）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../src/i18n';
import { toolStepLabel } from '../../src/ui/tool-step-label';

beforeEach(() => {
  setLocale('zh');
});

afterEach(() => {
  // locale 是模块级全局状态（AGENTS 进程级全局状态隔离条）：显式复位，不指望执行顺序
  setLocale('zh');
});

describe('有步号 ⇒ 「第 N 步 · 执行工具: x」', () => {
  it('step = 1', () => {
    expect(toolStepLabel({ step: 1, toolName: 'edit_file' })).toBe('第 1 步 · 执行工具: edit_file');
  });

  it('阶梯自证：1 / 3 / 12 三段都对（防止把步号写死成 1）', () => {
    expect(toolStepLabel({ step: 1, toolName: 'x' })).toBe('第 1 步 · 执行工具: x');
    expect(toolStepLabel({ step: 3, toolName: 'x' })).toBe('第 3 步 · 执行工具: x');
    expect(toolStepLabel({ step: 12, toolName: 'x' })).toBe('第 12 步 · 执行工具: x');
  });
});

describe('没有步号 ⇒ 退回旧文案（**不许出现「第 0 步」**）', () => {
  it('step = 0 ⇒ 只有「执行工具: x」（配 P3′ 探针：> 改 >= 必红）', () => {
    const label = toolStepLabel({ step: 0, toolName: 'self-heal' });
    expect(label).toBe('执行工具: self-heal');
    expect(label).not.toContain('第');
    expect(label).not.toContain('步');
  });

  it('否定面：负数（不该发生，但也不许渲染成「第 -1 步」）', () => {
    expect(toolStepLabel({ step: -1, toolName: 'x' })).toBe('执行工具: x');
  });

  it('**反例对照**：若实现写成「恒显示步号」，0 会得到「第 0 步」—— 断言实际不是它', () => {
    expect(toolStepLabel({ step: 0, toolName: 'x' })).not.toBe('第 0 步 · 执行工具: x');
  });
});

describe('契约：**不许有分母**', () => {
  it('任何步号下文案都不含「/数字」（配 P4 探针：拼上 `/total` 必红）', () => {
    // 正例自证：先确认确实取到了带步号的文案，否则下面的「不含」是空转
    const label = toolStepLabel({ step: 3, toolName: 'edit_file' });
    expect(label).toContain('第 3 步');
    expect(label).not.toMatch(/\/\s*\d/);
    // 双向：同一条判据对「加回分母」的形态必须报警（过滤没放宽到失明）
    expect(/\/\s*\d/.test('第 3/10 步 · 执行工具: x')).toBe(true);
  });
});

describe('i18n：en 也有步号且不含 CJK（同构）', () => {
  it('setLocale(en) ⇒ Step 3 · Running tool: x', () => {
    setLocale('en');
    const label = toolStepLabel({ step: 3, toolName: 'edit_file' });
    expect(label).toBe('Step 3 · Running tool: edit_file');
    // en 版不许混入中文（en.test.ts 同口径，但这条在渲染路径上单独上锁）
    expect(label).not.toMatch(/[\u4e00-\u9fa5]/);
  });

  it('setLocale(en) + step = 0 ⇒ 只有 Running tool，不含 Step', () => {
    setLocale('en');
    const label = toolStepLabel({ step: 0, toolName: 'x' });
    expect(label).toBe('Running tool: x');
    expect(label).not.toContain('Step');
  });
});
