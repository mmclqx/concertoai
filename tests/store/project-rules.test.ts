import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectRules, MAX_RULES_CHARS } from '../../src/store/project-rules';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadProjectRules', () => {
  it('只有 AGENTS.md → 加载它并注入来源标题', async () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), '# 项目规则\n\n- 规则一');
    const rules = await loadProjectRules(tmp);
    expect(rules.loadedFrom).toBe('AGENTS.md');
    expect(rules.text).toContain('# 项目规则（来自 AGENTS.md）');
    expect(rules.text).toContain('- 规则一');
    expect(rules.truncated).toBe(false);
  });

  it('只有 CARBON.md → 加载它', async () => {
    writeFileSync(path.join(tmp, 'CARBON.md'), 'carbon 规则');
    const rules = await loadProjectRules(tmp);
    expect(rules.loadedFrom).toBe('CARBON.md');
    expect(rules.text).toContain('carbon 规则');
  });

  it('两者都有 → AGENTS.md 优先', async () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), 'agents 规则');
    writeFileSync(path.join(tmp, 'CARBON.md'), 'carbon 规则');
    const rules = await loadProjectRules(tmp);
    expect(rules.loadedFrom).toBe('AGENTS.md');
    expect(rules.text).toContain('agents 规则');
    expect(rules.text).not.toContain('carbon 规则');
  });

  it('都没有 → 空规则，不抛错', async () => {
    const rules = await loadProjectRules(tmp);
    expect(rules.loadedFrom).toBeNull();
    expect(rules.text).toBe('');
    expect(rules.truncated).toBe(false);
  });

  it('AGENTS.md 为空 → 跳过，加载 CARBON.md', async () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), '   \n\n');
    writeFileSync(path.join(tmp, 'CARBON.md'), 'carbon 规则');
    const rules = await loadProjectRules(tmp);
    expect(rules.loadedFrom).toBe('CARBON.md');
  });

  it('超长规则截断到 8000 字符并标记 truncated', async () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), 'x'.repeat(MAX_RULES_CHARS + 500));
    const rules = await loadProjectRules(tmp);
    expect(rules.truncated).toBe(true);
    const header = `# 项目规则（来自 AGENTS.md）\n\n`;
    expect(rules.text).toBe(`${header}${'x'.repeat(MAX_RULES_CHARS)}`);
    expect(rules.text.length).toBe(header.length + MAX_RULES_CHARS);
  });

  it('恰好 8000 字符不截断', async () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), 'x'.repeat(MAX_RULES_CHARS));
    const rules = await loadProjectRules(tmp);
    expect(rules.truncated).toBe(false);
  });

  it('中文规则内容保留无损', async () => {
    writeFileSync(path.join(tmp, 'CARBON.md'), '中文优先：所有回复使用简体中文。');
    const rules = await loadProjectRules(tmp);
    expect(rules.text).toContain('中文优先：所有回复使用简体中文。');
  });

  it('只读取 cwd 根目录，不递归子目录', async () => {
    mkdirSync(path.join(tmp, 'sub'));
    writeFileSync(path.join(tmp, 'sub', 'AGENTS.md'), '子目录规则');
    const rules = await loadProjectRules(tmp);
    expect(rules.loadedFrom).toBeNull();
  });
});
