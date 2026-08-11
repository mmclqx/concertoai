/**
 * Reviewer 知识库加载回归测试（v3.1.1）。
 *
 * 覆盖：`loadKnowledgeBase` 不再因 ESM 下未定义的 `__dirname` 崩溃
 * （此前 `concertoai team` / `/orchestrate` / `/review` 触发
 * `ReferenceError: __dirname is not defined`），并按优先级加载知识库。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadKnowledgeBase } from '../../src/reviewer/knowledge';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-kb-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 在 tmp 下按相对路径写入内容（自动建目录）。 */
function write(relPath: string, content: string): void {
  const abs = path.join(tmp, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('loadKnowledgeBase（v3.1.1 __dirname 回归）', () => {
  it('空项目目录 → 不抛错并返回空 Map（旧代码 ReferenceError: __dirname is not defined）', () => {
    const docs = loadKnowledgeBase(tmp);
    expect(docs).toBeInstanceOf(Map);
    expect(docs.size).toBe(0);
  });

  it('项目级知识库（cwd/.concertoai/reviewer/knowledge/）→ 加载并覆盖', () => {
    write('.concertoai/reviewer/knowledge/KB-01-project-conventions.md', '# 项目约定：禁止 any');
    const docs = loadKnowledgeBase(tmp);
    expect(docs.get('KB-01-project-conventions.md')).toContain('项目约定');
  });

  it('内置知识库（cwd/skills/reviewer/knowledge/）→ 可读取', () => {
    write('skills/reviewer/knowledge/KB-02-architecture-patterns.md', '# 架构模式');
    const docs = loadKnowledgeBase(tmp);
    expect(docs.get('KB-02-architecture-patterns.md')).toContain('架构模式');
  });

  it('总字符数超限时截断（MAX_KB_CHARS）且不抛错', () => {
    // 项目级放置超大 KB-01，触发截断路径
    write('.concertoai/reviewer/knowledge/KB-01-project-conventions.md', `${'x'.repeat(20_000)}`);
    const docs = loadKnowledgeBase(tmp);
    const kb01 = docs.get('KB-01-project-conventions.md');
    expect(kb01).toBeDefined();
    expect(kb01?.length).toBeLessThan(17_000);
    expect(kb01).toContain('知识库内容已截断');
  });
});
