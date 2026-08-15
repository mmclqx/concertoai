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
  // v4.1.1 P0-C：tsc 无 tsconfig.json 时不检查文件、打印 help（`tsc: The TypeScript Compiler -
  // Version …` + `COMMON COMMANDS`/`tsc --init`），没有 error TS 行 → 兜底会拿到最无用的
  // npm 包装首行（`> xxx@1.0.0 typecheck`）。识别 help 特征 → 给出可操作提示。
  const tscHelp =
    lines.some((l) => /tsc: The TypeScript Compiler - Version/i.test(l)) &&
    (lines.some((l) => /COMMON COMMANDS/i.test(l)) || lines.some((l) => /\btsc --init\b/.test(l)));
  if (tscHelp) {
    return {
      line: '缺少 tsconfig.json（tsc 打印了帮助而非检查文件），请运行 npx tsc --init 生成后重试',
      tool: 'tsc',
    };
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
    // v4.1.1 P1-3：format/lint 文件级标题（`<file> format ━━━`）→ 提取文件名 +
    // 人性化措辞 + 修复建议（去掉 ━ 分隔线噪音；v4.1 初版残留整行标题过长）
    const fileMatch = /^(\S+?)\s+(format|lint)\s+━+/.exec(biome);
    if (fileMatch !== null) {
      const file = (fileMatch[1] ?? biome).slice(0, 100);
      const kind = fileMatch[2] === 'format' ? '需要格式化' : '存在 lint 问题';
      return {
        line: `${file} ${kind} → 建议运行 biome check --write . 自动修复`,
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
