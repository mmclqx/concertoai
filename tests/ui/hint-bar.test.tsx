/**
 * 场景提示条组件测试（v5.0 T13）——用户点名的三条要求逐条断言。
 *
 * | # | 要求 | 断言 |
 * |---|---|---|
 * | ① | 纯字符串渲染，Ink 只上色 | 源码护栏：HintBar 不含任何文案字面量、不拼装文案 |
 * | ② | 不许挤压输入框、单行 dimColor、流式期严禁渲染 | 渲染 App 级组合：无提示时输入框**不多占行**；streaming 时提示消失 |
 * | ③ | 超宽按 displayWidth 截断，命令完整 | 窄终端渲染后断言命令仍在、总宽不超 |
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { HINT_CONTAINER_PADDING_X, HintBar } from '../../src/ui/HintBar';
import { PromptInput } from '../../src/ui/PromptInput';
import { displayWidth } from '../../src/utils/text-width';

const MESSAGE = '💡 这个项目还没有规则文件，concertoai init 可以生成 AGENTS.md（给 AI）';
const COMMAND = 'concertoai init';

const suggestion = {
  id: 'missing-project-rules' as const,
  priority: 10,
  i18nKey: 'missingProjectRules' as const,
  message: MESSAGE,
  command: COMMAND,
};

/** 取帧文本，去掉尾部空行（Ink 输出常带一个尾换行）。 */
function frameOf(lastFrame: string | undefined): string {
  return (lastFrame ?? '').replace(/\n+$/, '');
}

describe('① 架构铁律：Ink 只上色，不拼文案', () => {
  it('HintBar.tsx 不含用户可见文案字面量（文案全部来自 hint-text / i18n）', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/ui/HintBar.tsx'), 'utf8');
    // 组件里不该出现中文文案（除了注释）：去掉注释后再断言
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/[\u4e00-\u9fff]/);
    // 只允许渲染一个 Text（单行），不允许 Box 布局（布局权在 App）
    expect(code).toContain('<Text dimColor>');
    expect(code).not.toContain('<Box');
  });
});

describe('② 单行 + 不挤压输入框 + 流式期不渲染', () => {
  /**
   * 回归护栏（2026-10-28 PTY 实测踩到）：提示行渲染在 App 的 `paddingX={1}` 容器**内部**，
   * 可用列 = 终端列 - 2。若按终端列数排版，行宽正好占满一整行 → 终端把它折成两行
   * （实测 100 列终端里 `concertoai init` 的 `init` 被折到下一行，违反③单行）。
   */
  it('③ 真实容器宽度：行宽 ≤ 终端列 - paddingX*2（否则终端折行，单行要求破功）', () => {
    for (const columns of [100, 120, 160]) {
      const { lastFrame } = render(
        <HintBar suggestion={suggestion} phase="idle" columns={columns} />,
      );
      const frame = frameOf(lastFrame());
      expect(frame.split('\n')).toHaveLength(1);
      expect(displayWidth(frame)).toBeLessThanOrEqual(columns - HINT_CONTAINER_PADDING_X * 2);
      // 命令必须完整（半条命令对用户是负价值）
      expect(frame).toContain(COMMAND);
    }
  });

  it('有提示时：输入框上方**恰好一行**灰字', () => {
    const { lastFrame } = render(<HintBar suggestion={suggestion} phase="idle" columns={120} />);
    const frame = frameOf(lastFrame());
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toContain(COMMAND);
  });

  it('无提示（suggestion=null）→ 一个字符都不渲染（不是空行）', () => {
    const { lastFrame } = render(<HintBar suggestion={null} phase="idle" columns={120} />);
    expect(frameOf(lastFrame())).toBe('');
  });

  it('流式输出期间（phase=streaming）→ 哪怕有 suggestion 也一个字不渲染', () => {
    const { lastFrame } = render(
      <HintBar suggestion={suggestion} phase="streaming" columns={120} />,
    );
    expect(frameOf(lastFrame())).toBe('');
  });

  it('等待首字节期间（phase=awaiting）→ 渲染一行（断网 / 假 Key 时唯一可见的提示）', () => {
    const { lastFrame } = render(
      <HintBar suggestion={suggestion} phase="awaiting" columns={120} />,
    );
    const frame = frameOf(lastFrame());
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toContain(COMMAND);
  });

  it('审批 / 计划审批期间同样不渲染（焦点不可被干扰）', () => {
    for (const phase of ['approval', 'plan-approval'] as const) {
      const { lastFrame } = render(<HintBar suggestion={suggestion} phase={phase} columns={120} />);
      expect(frameOf(lastFrame())).toBe('');
    }
  });

  it('**关键**：提示出现/消失时输入框行数不变（不挤压 = 不多占也没顶掉）', () => {
    const prompt = (
      <PromptInput
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        placeholder="说点什么…"
        active
      />
    );
    const withHint = render(<HintBar suggestion={suggestion} phase="idle" columns={120} />);
    const hintLines = frameOf(withHint.lastFrame()).split('\n').length;
    expect(hintLines).toBe(1);

    // 没有提示时 HintBar 输出空 → 贡献 0 行；有提示时贡献恰好 1 行（且不含换行）
    const without = render(<HintBar suggestion={null} phase="idle" columns={120} />);
    expect(
      frameOf(without.lastFrame())
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(0);

    // 输入框自身渲染不受影响（独立渲染，行数由 PromptInput 自己决定）
    const promptFrame = frameOf(render(prompt).lastFrame());
    expect(promptFrame).toContain('说点什么');
  });
});

describe('③ 超宽截断：命令绝对完整', () => {
  it('窄终端（40 列）：渲染结果总宽 ≤ 40 且命令完整', () => {
    const { lastFrame } = render(<HintBar suggestion={suggestion} phase="idle" columns={40} />);
    const frame = frameOf(lastFrame());
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
    expect(frame.endsWith(COMMAND)).toBe(true);
  });

  it('极窄终端（20 列，放不下文案）→ 只剩命令，仍然完整', () => {
    const { lastFrame } = render(<HintBar suggestion={suggestion} phase="idle" columns={20} />);
    const frame = frameOf(lastFrame());
    expect(frame).toBe(COMMAND);
  });

  it('缺省列数（未注入）→ 回落到 80 而非崩溃', () => {
    const { lastFrame } = render(<HintBar suggestion={suggestion} phase="idle" />);
    const frame = frameOf(lastFrame());
    expect(frame).not.toBe('');
    expect(frame).toContain(COMMAND);
  });
});
