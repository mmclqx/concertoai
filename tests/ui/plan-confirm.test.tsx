import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { PlanConfirm } from '../../src/ui/modals';

describe('PlanConfirm', () => {
  it('展示计划文本与按键提示', () => {
    const { lastFrame, unmount } = render(
      <PlanConfirm plan={'1. 读取文件\n2. 修改配置\n3. 运行测试'} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('执行计划');
    expect(frame).toContain('1. 读取文件');
    expect(frame).toContain('3. 运行测试');
    expect(frame).toContain('批准 (y / Enter) / 拒绝 (n / Esc)');
    unmount();
  });

  it('超长计划截断显示并标记', () => {
    const longPlan = `步骤\n${'内容'.repeat(2_000)}`;
    const { lastFrame, unmount } = render(<PlanConfirm plan={longPlan} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('计划已截断显示');
    expect(frame.length).toBeLessThan(longPlan.length);
    unmount();
  });
});
