/**
 * RA 知识库加载器（v2.1 M5）。
 *
 * 按优先级加载审查知识库文档：
 *   项目级（<cwd>/.concertoai/reviewer/knowledge/）
 *   > 全局级（~/.concertoai/reviewer/knowledge/）
 *   > 内置默认（skills/reviewer/knowledge/）
 *
 * 总 token 数超过 8000 时截断。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { reviewerKnowledgeDir } from '../store/paths';

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

/**
 * 内置知识库根目录（项目根下的 skills/reviewer/knowledge/）。
 *
 * v3.1.1 修复：ESM 模块（"type": "module"）没有 CommonJS 的全局 `__dirname`，
 * 此前直接引用导致 `ReferenceError: __dirname is not defined`（team / /orchestrate / /review 崩溃）。
 * 改为基于 cwd 定位——team/review 命令在项目根运行，内置知识库随仓库分发；
 * 目录不存在时由 loadKnowledgeBase 的 try/catch 静默降级到项目级/全局级知识库。
 */
function builtinKbDir(cwd: string): string {
  return path.resolve(cwd, 'skills', 'reviewer', 'knowledge');
}

/** 加载知识库，返回文档名 → 内容的映射。 */
export function loadKnowledgeBase(cwd: string): Map<string, string> {
  const docs = new Map<string, string>();
  const searchPaths = [
    path.join(cwd, '.concertoai', 'reviewer', 'knowledge'),
    reviewerKnowledgeDir(),
    builtinKbDir(cwd),
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
