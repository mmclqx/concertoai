/**
 * `concertoai reflect list / clear` 测试（v5.0 T10）。
 *
 * 侧重点是**用户视角的边缘路径**：
 * - 第一次跑（文件不存在）→ 友好空提示而不是报错；
 * - 非交互清空 → fail-closed 要求 `--yes`（不能让脚本无声删掉历史）；
 * - 用户主动取消（Ctrl+C / 回 n）→ 文件不变；
 * - 输出超长 / 中文列宽 → 按显示宽度对齐不糊版。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REFLECT_LIMIT,
  formatReflectionTable,
  formatReflectionTime,
  levelLabel,
  padToDisplayWidth,
  parseReflectLimit,
  runReflectCommand,
} from '../../src/cli/reflect';
import { appendReflection, type ReflectionEntry } from '../../src/core/reflection-store';
import { displayWidth, truncateToWidth } from '../../src/utils/text-width';

let tmp: string;
let file: string;
let out: string[];

const log = (message: string): void => {
  out.push(message);
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-reflect-cli-'));
  file = path.join(tmp, 'reflections.jsonl');
  out = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entryOf(overrides: Partial<ReflectionEntry> = {}): ReflectionEntry {
  return {
    ts: new Date(2026, 9, 28, 1, 30).getTime(),
    project: 'demo',
    file: 'src/a.ts',
    level: 'high',
    categories: ['删除/破坏性'],
    focusLines: [3],
    intent: 'modify',
    decision: 'rejected',
    ...overrides,
  };
}

describe('parseReflectLimit：参数解析', () => {
  it('缺省 / 空 → 默认 20 条', () => {
    expect(parseReflectLimit(undefined)).toEqual({ limit: DEFAULT_REFLECT_LIMIT, invalid: false });
    expect(parseReflectLimit('  ')).toEqual({ limit: DEFAULT_REFLECT_LIMIT, invalid: false });
  });

  it('正整数生效；0 / 负数 / NaN / 小数 → 回默认并标记非法（如实提示）', () => {
    expect(parseReflectLimit('5')).toEqual({ limit: 5, invalid: false });
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const parsed = parseReflectLimit(bad);
      expect(parsed.limit).toBe(DEFAULT_REFLECT_LIMIT);
      expect(parsed.invalid).toBe(true);
    }
  });
});

describe('格式化（纯函数）', () => {
  it('时间格式 MM-DD HH:mm（本地时区）', () => {
    expect(formatReflectionTime(new Date(2026, 9, 28, 1, 5).getTime())).toBe('10-28 01:05');
    expect(formatReflectionTime(Number.NaN)).toBe('—');
  });

  it('levelLabel：unknown 显示「未分析」，不冒充低风险', () => {
    expect(levelLabel('high')).toContain('高');
    expect(levelLabel('medium')).toContain('中');
    expect(levelLabel('low')).toContain('低');
    expect(levelLabel('unknown')).toContain('未分析');
    expect(levelLabel('unknown')).not.toContain('低');
  });

  it('padToDisplayWidth：中文按 2 格补，超宽截断补省略号（不靠 .length）', () => {
    expect(displayWidth(padToDisplayWidth('中文', 10))).toBe(10);
    expect(displayWidth(padToDisplayWidth('ab', 10))).toBe(10);
    expect(padToDisplayWidth('中文', 10)).toContain('中文'); // 没被截
    const clipped = padToDisplayWidth('abcdefghijklmnop', 8);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(8);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('表格前 3 列按显示宽度对齐（中文文件名不会把表格挤歪）', () => {
    const lines = formatReflectionTable([
      entryOf({ file: 'src/中文文件名.ts' }),
      entryOf({ file: 'a.ts', level: 'unknown', categories: [] }),
      entryOf({ file: '', level: 'medium', categories: ['网络超时', '静默吞错'] }),
    ]);
    // 前 3 列固定为 12 + 1 + 10 + 1 + 28 + 1 = 53 个显示列
    const prefixWidth = (line: string): number => displayWidth(truncateToWidth(line, 53));
    expect(prefixWidth(lines[0] ?? '')).toBe(53);
    for (const line of lines.slice(1)) {
      expect(prefixWidth(line)).toBe(53);
    }
  });
});

describe('reflect list', () => {
  it('文件不存在（首次运行）→ 友好空提示，退出码 0', async () => {
    const code = await runReflectCommand({ action: 'list', file, log });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('暂无复盘记录');
  });

  it('有记录 → 标题 + 表头 + 行，最新在前', async () => {
    await appendReflection(entryOf({ ts: 1000, file: 'old.ts' }), { file });
    await appendReflection(entryOf({ ts: 2000, file: 'new.ts' }), { file });
    const code = await runReflectCommand({ action: 'list', file, log });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('2 条');
    expect(text.indexOf('new.ts')).toBeLessThan(text.indexOf('old.ts'));
    expect(text).toContain('concertoai reflect clear');
  });

  it('--limit 生效（500 条只显示 limit 条）', async () => {
    for (let i = 0; i < 30; i += 1) {
      await appendReflection(entryOf({ ts: i, file: `f${i}.ts` }), { file });
    }
    await runReflectCommand({ action: 'list', limit: 3, file, log });
    const dataLines = out.filter((line) => line.includes('.ts'));
    expect(dataLines).toHaveLength(3);
  });

  it('损坏行 → 如实统计（不静默吞掉）', async () => {
    writeFileSync(file, `${JSON.stringify(entryOf())}\nbroken line\n`, 'utf8');
    await runReflectCommand({ action: 'list', file, log });
    expect(out.join('\n')).toContain('跳过 1 条损坏行');
  });

  it('未知子命令 → 退出码 1 并给出支持列表', async () => {
    const code = await runReflectCommand({ action: 'bogus', file, log });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('list / clear');
  });
});

describe('reflect clear', () => {
  it('--yes 跳过确认并清空', async () => {
    await appendReflection(entryOf(), { file });
    const code = await runReflectCommand({ action: 'clear', yes: true, file, log });
    expect(code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(out.join('\n')).toContain('已清空');
  });

  it('用户确认 y → 清空；回 n → 取消且文件不变', async () => {
    await appendReflection(entryOf(), { file });
    const canceled = await runReflectCommand({
      action: 'clear',
      file,
      log,
      confirm: async () => false,
    });
    expect(canceled).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(out.join('\n')).toContain('已取消');

    out = [];
    const confirmed = await runReflectCommand({
      action: 'clear',
      file,
      log,
      confirm: async () => true,
    });
    expect(confirmed).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('非交互 + 无 --yes → fail-closed 拒绝（退出码 1，文件保留）', async () => {
    await appendReflection(entryOf(), { file });
    const originalIsTTY = process.stdin.isTTY;
    // vitest 下 stdin 本来就不是 TTY，这里显式固化前提，避免环境污染
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const code = await runReflectCommand({ action: 'clear', file, log });
      expect(code).toBe(1);
      expect(existsSync(file)).toBe(true);
      expect(out.join('\n')).toContain('--yes');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it('本来就是空的 → 提示无需清空且退出码 0（重复执行幂等）', async () => {
    const code = await runReflectCommand({ action: 'clear', yes: true, file, log });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('本来就是空的');
  });
});
