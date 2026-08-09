/**
 * RA 知识库加载器（v2.1 M5）。
 *
 * 按优先级加载审查知识库文档：
 *   项目级（<cwd>/.lumen/reviewer/knowledge/）
 *   > 全局级（~/.lumen/reviewer/knowledge/）
 *   > 内置默认（skills/reviewer/knowledge/）
 *
 * 总 token 数超过 8000 时截断。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 10 份内置知识库文档名。 */
export const KB_FILES = [
  'KB-01-project-conventions.md',
  'KB-02-architecture-patterns.md',
  'KB-03-type-safety-rules.md',
  'KB-04-error-handling-guide.md',
  'KB-05-security-checklist.md',
  'KB-06-performance-patterns.md',
  'KB-07-testing-standards.md',
  'KB-08-common-anti-patterns.md',
  'KB-09-review-output-template.md',
  'KB-10-auto-fix-rules.md',
];

/** 知识库内容截断阈值（字符数近似 token 数 × 2）。 */
const MAX_KB_CHARS = 16_000;

/** 内置知识库根目录（相对于项目根）。 */
function builtinKbDir(): string {
  // src/reviewer/knowledge.ts → ../.. → 项目根 → skills/reviewer/knowledge/
  return path.resolve(__dirname ?? process.cwd(), '..', '..', 'skills', 'reviewer', 'knowledge');
}

/** 加载知识库，返回文档名 → 内容的映射。 */
export function loadKnowledgeBase(cwd: string): Map<string, string> {
  const docs = new Map<string, string>();
  const searchPaths = [
    path.join(cwd, '.lumen', 'reviewer', 'knowledge'),
    path.join(homedir(), '.lumen', 'reviewer', 'knowledge'),
    builtinKbDir(),
  ];

  for (const filename of KB_FILES) {
    for (const dir of searchPaths) {
      try {
        const content = readFileSync(path.join(dir, filename), 'utf8');
        if (content.trim() !== '') {
          docs.set(filename, content);
          break; // 找到即停止（项目级优先）
        }
      } catch {
        // 文件不存在 → 继续下一优先级
      }
    }
  }

  // 总大小超限时截断
  let total = 0;
  const limited = new Map<string, string>();
  for (const [name, content] of docs) {
    const slice =
      total + content.length > MAX_KB_CHARS
        ? `${content.slice(0, MAX_KB_CHARS - total)}\n\n（知识库内容已截断，总字符数超过限制）`
        : content;
    limited.set(name, slice);
    total += slice.length;
    if (total >= MAX_KB_CHARS) {
      break;
    }
  }

  return limited;
}

/** 将知识库合并为一段审查上下文文本。 */
export function formatKnowledgeContext(kb: Map<string, string>): string {
  if (kb.size === 0) return '';
  const sections: string[] = [];
  for (const [name, content] of kb) {
    sections.push(`## ${name.replace(/\.md$/, '')}\n${content}`);
  }
  return `# 审查知识库\n\n${sections.join('\n\n')}`;
}
