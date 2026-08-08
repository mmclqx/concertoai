import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeSkillCommand, parseSkillCommand } from '../../src/cli/slash/skill';
import { SkillLoader } from '../../src/skill/loader';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-slash-skill-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(cwd: string, name: string, body: string): void {
  const dir = path.join(cwd, '.lumen', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---
name: ${name}
description: ${name} 描述
version: 1.0.0
---

${body}`,
  );
}

function createLoader(cwd: string): SkillLoader {
  const loader = new SkillLoader();
  loader.loadAll(cwd);
  return loader;
}

describe('parseSkillCommand', () => {
  it('/skill → list', () => {
    expect(parseSkillCommand('/skill')).toEqual({ type: 'list' });
  });

  it('/skill list → list', () => {
    expect(parseSkillCommand('/skill list')).toEqual({ type: 'list' });
  });

  it('/skill code-review → call', () => {
    expect(parseSkillCommand('/skill code-review')).toEqual({
      type: 'call',
      name: 'code-review',
      args: '',
    });
  });

  it('/skill code-review src/tools/ → call with args', () => {
    expect(parseSkillCommand('/skill code-review src/tools/')).toEqual({
      type: 'call',
      name: 'code-review',
      args: 'src/tools/',
    });
  });

  it('非 /skill 命令 → null', () => {
    expect(parseSkillCommand('hello')).toBeNull();
    expect(parseSkillCommand('/plan task')).toBeNull();
  });

  it('/skill 带多余空格 → 正确解析', () => {
    expect(parseSkillCommand('/skill   explain   src/foo.ts')).toEqual({
      type: 'call',
      name: 'explain',
      args: 'src/foo.ts',
    });
  });
});

describe('executeSkillCommand', () => {
  it('/skill list — 列出所有可用技能', () => {
    writeSkill(tmp, 'code-review', '## 技能描述\n审查代码');
    const loader = createLoader(tmp);
    const result = executeSkillCommand({ type: 'list' }, loader, tmp);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('📋');
    expect(result.message?.content).toContain('code-review');
    expect(result.message?.content).toContain('1.0.0');
  });

  it('/skill list — 有内置技能时列出所有', () => {
    const loader = createLoader(tmp);
    const result = executeSkillCommand({ type: 'list' }, loader, tmp);
    expect(result.handled).toBe(true);
    // 内置技能至少包含 code-review
    expect(result.message?.content).toContain('📋');
    expect(result.message?.content).toContain('code-review');
  });

  it('/skill <name> — 已知技能返回 body', () => {
    writeSkill(tmp, 'code-review', '## 技能描述\n审查代码');
    const loader = createLoader(tmp);
    const result = executeSkillCommand(
      { type: 'call', name: 'code-review', args: '' },
      loader,
      tmp,
    );
    expect(result.handled).toBe(false);
    expect(result.skillBody).toContain('## 技能描述');
    expect(result.skillName).toBe('code-review');
  });

  it('/skill <name> — 未知技能返回错误提示', () => {
    const loader = createLoader(tmp);
    const result = executeSkillCommand({ type: 'call', name: 'no-such', args: '' }, loader, tmp);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未知技能');
    expect(result.message?.content).toContain('no-such');
  });

  it('/skill <name> <args> — 参数正确传递', () => {
    writeSkill(tmp, 'refactor', '## 技能描述\n重构代码');
    const loader = createLoader(tmp);
    const result = executeSkillCommand(
      { type: 'call', name: 'refactor', args: 'src/tools/' },
      loader,
      tmp,
    );
    expect(result.handled).toBe(false);
    expect(result.skillName).toBe('refactor');
  });
});
