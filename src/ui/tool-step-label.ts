/**
 * 状态行文案的**唯一**生成处（v5.1 T2.2）。
 *
 * ## 为什么单独一个纯函数
 *
 * 两条理由，都是踩出来的：
 *
 * 1. **可被探针打穿**。这条文案的第一版内联在 `App.tsx` 的 JSX 里，只能靠「渲染整棵
 *    Ink 树再看帧」来验。实测三个探针里有两个**无牙**：把 `step > 0` 改成 `step >= 0`
 *    （即允许显示「第 0 步」）后用例依旧全绿——因为当时那条用例造的是「纯文本回复」，
 *    `activeTool` 全程是 `null`，状态行压根不渲染，断言空转。判定搬到纯函数后，
 *    `step = 0` 可以直接喂进来，「该红必红」才成立。
 * 2. **文案不复制**。内层「执行工具: x」复用 `ui.toolRunning`，外层只包一层
 *    `ui.toolStep`。两处各写一份必然漂移（历史教训：同一句话在两个文件里各有一份，
 *    改一处漏一处）。
 *
 * ## 两条硬契约（`tests/ui/tool-step-label.test.ts` 双向上锁）
 *
 * - **不许有分母**：只有 `{n}`，没有 total。步数由模型临场决定，loop 事先不知道，
 *   写成「第 3/10 步」时那个 10 只能是猜——比不显示更糟。
 * - **`step <= 0` 退回旧文案**：`0` 表示「这个工具不是主循环发的」（`/skill`、
 *   `/self-heal`、`/review` 这类 slash 命令直接设 `activeTool`，没有步号），
 *   此时必须显示「执行工具: x」，**不能**显示「第 0 步」。
 */
import { fmt, t } from '../i18n';

export interface ToolStepLabelInput {
  /** 本次输入内的第几步（来自 `LoopEvent.stepIndex`，从 1 开始）；`<= 0` 表示无步号。 */
  step: number;
  /** 工具名（已就绪，不需要再解析参数）。 */
  toolName: string;
}

/**
 * 生成状态行文案：有步号 `第 3 步 · 执行工具: x`，无步号 `执行工具: x`。
 *
 * 纯函数：不读时钟、不读环境、不产生副作用（locale 由 `t()` 在调用时解析）。
 */
export function toolStepLabel({ step, toolName }: ToolStepLabelInput): string {
  const inner = fmt(t().ui.toolRunning, { name: toolName });
  if (step > 0) {
    return fmt(t().ui.toolStep, { n: step, text: inner });
  }
  return inner;
}
