/**
 * 场景提示行纯字符串渲染测试（v5.0 T13）。
 *
 * 覆盖用户点名的三条硬要求：
 * - ② 流式输出期间严禁渲染（`resolveHintLine` 的阶段门禁，四个阶段逐个数）；
 * - ③ 超宽按 `displayWidth` 截断，**命令部分绝对完整**（窄终端 / 超长路径 / CJK 文案）；
 * - ① 纯字符串（源码护栏：本模块零 Ink / React 依赖）。
 * 边缘：终端列数缺失 / 非法 / 极窄 / 命令本身超宽。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_COLUMNS,
  HINT_MIN_MESSAGE_WIDTH,
  isHintVisiblePhase,
  normalizeColumns,
  renderHintLine,
  resolveHintLine,
} from '../../src/ui/hint-text';
import { displayWidth } from '../../src/utils/text-width';

/** 一条真实形态的提示（文案 + 命令）。 */
const MESSAGE = '💡 这个项目还没有规则文件，concertoai init 可以生成 AGENTS.md（给 AI）';
const COMMAND = 'concertoai init';

/** 去掉注释：护栏校验的是**代码**（注释里正常会写「不依赖 <Text>」「不读 process.stdout」这类说明）。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('① 纯字符串模块（源码护栏）', () => {
  it('hint-text.ts 不 import ink / react（文案与排版不许依赖渲染库）', () => {
    const source = codeOnly(readFileSync(path.join(process.cwd(), 'src/ui/hint-text.ts'), 'utf8'));
    expect(source).not.toMatch(/from ['"]ink['"]/);
    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/<Text|<Box/);
    // 护栏本身有效：确实扫到了这个模块的实现（不是切片失败导致误绿）
    expect(source).toContain('renderHintLine');
  });

  it('hint-text.ts 不接触终端环境（列数必须由调用方注入）', () => {
    const source = codeOnly(readFileSync(path.join(process.cwd(), 'src/ui/hint-text.ts'), 'utf8'));
    expect(source).not.toMatch(/process\.stdout/);
    expect(source).not.toMatch(/process\.env/);
    // 列数来自入参（normalizeColumns 的缺省兜底是常量，不是环境读取）
    expect(source).toContain('normalizeColumns');
  });
});

describe('normalizeColumns：列数兜底', () => {
  it('缺省 / 非法 / 非正数 → 80', () => {
    expect(normalizeColumns(undefined)).toBe(FALLBACK_COLUMNS);
    expect(normalizeColumns(Number.NaN)).toBe(FALLBACK_COLUMNS);
    expect(normalizeColumns(Number.POSITIVE_INFINITY)).toBe(FALLBACK_COLUMNS);
    expect(normalizeColumns(0)).toBe(FALLBACK_COLUMNS);
    expect(normalizeColumns(-10)).toBe(FALLBACK_COLUMNS);
  });

  it('合法列数原样返回（小数向下取整）', () => {
    expect(normalizeColumns(120)).toBe(120);
    expect(normalizeColumns(79.8)).toBe(79);
  });
});

describe('③ 排版：单行 + 命令绝对完整', () => {
  it('常规宽度：文案 + 两空格 + 完整命令，且总宽不超列数', () => {
    const line = renderHintLine({ message: MESSAGE, command: COMMAND, columns: 120 });
    expect(line.endsWith(COMMAND)).toBe(true);
    expect(line).toContain('  ');
    expect(displayWidth(line)).toBeLessThanOrEqual(120);
    // 单行：绝不出现换行符（Ink 里换行 = 多占一行 = 挤压输入框）
    expect(line).not.toContain('\n');
  });

  it('超宽（60 列）：文案按 displayWidth 截断并带省略号，命令仍完整', () => {
    const line = renderHintLine({ message: MESSAGE, command: COMMAND, columns: 60 });
    expect(line.endsWith(`  ${COMMAND}`)).toBe(true);
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
    expect(line).toContain('…');
    // 截断的是文案，不是命令
    expect(line).not.toContain('concertoai i…');
  });

  it('CJK 文案按显示宽度算（不是字符数）：40 列中文提示不溢出', () => {
    const line = renderHintLine({
      message: '💡 你已经连续 2 次拒绝了 AI 的改动，可以让 Reviewer Agent 扫一遍',
      command: '/review',
      columns: 40,
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(line.endsWith('/review')).toBe(true);
  });

  it('窄到文案没意义（< 最小宽度）→ 整句丢掉文案，只留完整命令', () => {
    // 命令 17 格 + 分隔 2 格 → 20 列时预算 1 格，远低于 HINT_MIN_MESSAGE_WIDTH
    const line = renderHintLine({ message: MESSAGE, command: COMMAND, columns: 20 });
    expect(line).toBe(COMMAND);
    expect(displayWidth(line)).toBe(displayWidth(COMMAND));
  });

  it('命令本身比终端还宽 → 仍返回完整命令（宁可折行也不给假命令）', () => {
    const longCommand = '/review src/very/deep/path/to/some/file.tsx';
    const line = renderHintLine({ message: MESSAGE, command: longCommand, columns: 20 });
    expect(line).toBe(longCommand);
    // 明确记录这个取舍：命令完整性优先于「单行不折行」
    expect(displayWidth(line)).toBeGreaterThan(20);
  });

  it('文案为空 → 只返回命令；命令为空 → 只返回（截断的）文案', () => {
    expect(renderHintLine({ message: '', command: COMMAND, columns: 80 })).toBe(COMMAND);
    expect(renderHintLine({ message: MESSAGE, command: '', columns: 80 }).length).toBeGreaterThan(
      0,
    );
  });

  it('去首尾空白（防止引擎/文案侧多余空格把排版算歪）', () => {
    const line = renderHintLine({
      message: `  ${MESSAGE}  `,
      command: ` ${COMMAND} `,
      columns: 120,
    });
    expect(line.endsWith(COMMAND)).toBe(true);
    expect(line.startsWith('💡')).toBe(true);
  });

  it(`最小文案宽度是 ${HINT_MIN_MESSAGE_WIDTH}（常量被测试看着，改动必须回来改用例）`, () => {
    expect(HINT_MIN_MESSAGE_WIDTH).toBe(12);
  });
});

describe('② 阶段门禁：流式输出期间严禁渲染', () => {
  const suggestion = { message: MESSAGE, command: COMMAND };

  it('idle → 渲染', () => {
    expect(resolveHintLine({ phase: 'idle', suggestion, columns: 100 })).not.toBeNull();
  });

  it('streaming → null（与流式抢行是用户点名禁止的）', () => {
    expect(resolveHintLine({ phase: 'streaming', suggestion, columns: 100 })).toBeNull();
  });

  it('awaiting → 渲染（已提交、尚无产出：断网/假 Key 时唯一能帮到用户的时刻）', () => {
    const line = resolveHintLine({ phase: 'awaiting', suggestion, columns: 100 });
    expect(line).not.toBeNull();
    expect(line).toContain(COMMAND);
  });

  it('isHintVisiblePhase：只放行 idle / awaiting（新阶段默认不放行）', () => {
    expect(isHintVisiblePhase('idle')).toBe(true);
    expect(isHintVisiblePhase('awaiting')).toBe(true);
    expect(isHintVisiblePhase('streaming')).toBe(false);
    expect(isHintVisiblePhase('approval')).toBe(false);
    expect(isHintVisiblePhase('plan-approval')).toBe(false);
  });

  it('approval / plan-approval → null（审批焦点不能被灰字干扰）', () => {
    expect(resolveHintLine({ phase: 'approval', suggestion, columns: 100 })).toBeNull();
    expect(resolveHintLine({ phase: 'plan-approval', suggestion, columns: 100 })).toBeNull();
  });

  it('无提示（引擎返回 null）→ null（不占任何行）', () => {
    expect(resolveHintLine({ phase: 'idle', suggestion: null, columns: 100 })).toBeNull();
  });
});
