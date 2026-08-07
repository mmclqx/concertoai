/**
 * Markdown → ANSI 渲染（纯字符串，无 DOM）。
 *
 * 支持：标题（# 1-6 级加粗）、列表（- * + 与编号列表）、加粗（**文本**）、
 * 行内代码（`code`）、代码块（```lang ... ```，cli-highlight 语法高亮）。
 *
 * 设计要点：
 * - 输出纯 ANSI 字符串：ink Text 原样保留转义序列，流式增量重渲染只做字符串拼接；
 * - 代码块状态机逐行解析，未闭合围栏容错（按代码块输出）；
 * - 输入中的控制字符（含 \x1b）被剥离，防终端注入。
 */

import chalk from 'chalk';
import { highlight } from 'cli-highlight';

/** ANSI 样式码。 */
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
} as const;

/** 剥离 C0 控制字符（防终端注入；保留 \n \t \r）。 */
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (isC0 || code === 0x7f) {
      continue;
    }
    out += ch;
  }
  return out;
}

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^\s*([-*+]|\d+\.)\s+(.*)$/;
const FENCE_RE = /^```([\w-]*)\s*$/;

/** 行内解析：**加粗** 与 `行内代码`。 */
function renderInline(text: string): string {
  let out = '';
  let rest = text;
  while (rest !== '') {
    const m = rest.match(INLINE_RE);
    if (m === null || m.index === undefined) {
      out += sanitize(rest);
      break;
    }
    out += sanitize(rest.slice(0, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      out += `${ANSI.bold}${sanitize(token.slice(2, -2))}${ANSI.reset}`;
    } else {
      out += `${ANSI.cyan}${sanitize(token.slice(1, -1))}${ANSI.reset}`;
    }
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

/** 代码块语法高亮（cli-highlight）；未知语言/解析失败回退原文。 */
function highlightCode(code: string, lang: string): string {
  // cli-highlight 依赖 chalk，非 TTY 环境（测试/管道）默认不输出颜色；临时提升 level 保证 ANSI 输出
  const prevLevel = chalk.level;
  chalk.level = Math.max(prevLevel, 1) as typeof chalk.level;
  try {
    return highlight(code, { language: lang === '' ? undefined : lang, ignoreIllegals: true });
  } catch {
    return sanitize(code);
  } finally {
    chalk.level = prevLevel;
  }
}

/** 把 markdown 文本渲染为 ANSI 字符串。 */
export function renderMarkdownToAnsi(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];

  const flushCode = (): void => {
    if (codeLines.length > 0) {
      out.push(highlightCode(codeLines.join('\n'), codeLang));
    }
    codeLines = [];
    codeLang = '';
  };

  for (const line of lines) {
    if (inCode) {
      if (FENCE_RE.test(line)) {
        flushCode();
        inCode = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }
    const fence = line.match(FENCE_RE);
    if (fence !== null) {
      inCode = true;
      codeLang = fence[1] ?? '';
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading !== null) {
      out.push(`${ANSI.bold}${sanitize(heading[2] ?? '')}${ANSI.reset}`);
      continue;
    }
    const list = line.match(LIST_RE);
    if (list !== null) {
      const marker = list[1] ?? '';
      const bullet = /^\d+\.$/.test(marker) ? `${marker} ` : '• ';
      out.push(`${bullet}${renderInline(list[2] ?? '')}`);
      continue;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    out.push(renderInline(line));
  }
  if (inCode) {
    // 未闭合代码块容错：按代码块输出
    flushCode();
  }
  return out.join('\n');
}
