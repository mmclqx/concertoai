/**
 * 工具链错误摘要提取（v4.1 T1.1 体验打磨轮，专家建议 3）。
 *
 * 客户评价问题 5：lint 失败时终端刷 6 个文件完整 diff，最后才看到选择提示。
 * 本工具从 stderr 提取「最有用的一行」——tsc/biome/npm/vitest 各自的
 * 关键错误行优先，兜底首行——让用户失败瞬间看到可操作的错误信息。
 */

import { stripAnsi } from './truncate';

/** 摘要提取结果：命中行 + 是否命中已知工具链（用于 UI 强调）。 */
export interface ErrorSummary {
  /** 摘要文本（单行，已去 ANSI）。 */
  line: string;
  /** 命中的工具链类型（unknown 表示兜底首行）。 */
  tool: 'tsc' | 'biome' | 'npm' | 'vitest' | 'unknown';
}

/** 提取摘要。空输入 → 空行 + unknown。 */
export function extractErrorSummary(stderr: string): ErrorSummary {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) {
    return { line: '', tool: 'unknown' };
  }

  // tsc: `error TSxxxx: message`（可能前缀路径/行号）
  const tsc = lines.find((l) => /\berror TS\d+\s*:/i.test(l));
  if (tsc !== undefined) {
    return { line: tsc.slice(0, 200), tool: 'tsc' };
  }

  // biome: `×` 开头（格式错误列表）或 `Found N errors` 汇总或 `error[xxx]`
  // v4.1 P1-3：biome format 错误的标题行 `<file> format ━━━`（文件级）比
  // `× Formatter would have printed the following content:`（diff 头）更有操作性——
  // 用户看到「哪个文件 + 建议 biome check --write .」才知道怎么办。
  const biome = lines.find(
    (l) =>
      /^×/.test(l) ||
      /Found \d+ error/i.test(l) ||
      /^error\[/i.test(l) ||
      /^[^\s].* format ━+/.test(l) ||
      /^[^\s].* lint ━+/.test(l),
  );
  if (biome !== undefined) {
    // v4.1 P1-3：format/lint 文件级标题（含 ━ 分隔线）→ 附带修复建议命令
    if (/ format ━+/.test(biome) || / lint ━+/.test(biome)) {
      return {
        line: `${biome.slice(0, 120)} → 建议运行 biome check --write . 自动修复`,
        tool: 'biome',
      };
    }
    return { line: biome.slice(0, 200), tool: 'biome' };
  }

  // npm: `npm error ...`
  const npm = lines.find((l) => /^npm error/i.test(l));
  if (npm !== undefined) {
    return { line: npm.slice(0, 200), tool: 'npm' };
  }

  // vitest: `FAIL 文件路径` 或 `✗ 失败用例`
  const vitest = lines.find((l) => /^FAIL\b/.test(l) || /^✗/.test(l));
  if (vitest !== undefined) {
    return { line: vitest.slice(0, 200), tool: 'vitest' };
  }

  return { line: (lines[0] ?? '').slice(0, 200), tool: 'unknown' };
}
