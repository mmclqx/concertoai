import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillLoader } from '../../src/skill/loader';

let tmp: string;
let loader: SkillLoader;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-skill-test-'));
  loader = new SkillLoader();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 在指定目录下创建 SKILL.md 文件。 */
function writeSkill(dir: string, name: string, content: string): void {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), content);
}

/** 获取内置技能数量（从 Lumen 仓库 skills/ 目录加载）。 */
function builtinSkillCount(): number {
  const probe = new SkillLoader();
  probe.loadAll(tmp);
  return probe.list().length;
}

describe('SkillLoader', () => {
  it('空项目目录 → 仅有内置技能（无项目自定义技能）', () => {
    loader.loadAll(tmp);
    const count = builtinSkillCount();
    expect(loader.list()).toHaveLength(count);
    // 内置技能至少包含 code-review
    expect(loader.get('code-review')).toBeDefined();
  });

  it('从项目目录加载自定义 SKILL.md → 内置 + 自定义', () => {
    const builtin = builtinSkillCount();
    const skillsDir = path.join(tmp, '.lumen', 'skills');
    writeSkill(
      skillsDir,
      'my-skill',
      `---
name: my-skill
description: 一个测试技能
version: 1.0.0
tools: read_file, search_content
---

## 技能描述
测试技能

## 使用方式
/skill my-skill

## 执行指令
执行测试。
`,
    );

    loader.loadAll(tmp);
    const skills = loader.list();
    expect(skills).toHaveLength(builtin + 1);
    const custom = loader.get('my-skill');
    expect(custom).toMatchObject({
      name: 'my-skill',
      description: '一个测试技能',
      version: '1.0.0',
      tools: ['read_file', 'search_content'],
    });
    expect(custom?.body).toContain('## 技能描述');
  });

  it('缺少必填字段 name → 跳过并记录警告（不影响内置技能）', () => {
    const log = vi.fn();
    const skillsDir = path.join(tmp, '.lumen', 'skills');
    writeSkill(
      skillsDir,
      'bad-skill',
      `---
description: 缺少 name
version: 1.0.0
---

正文
`,
    );

    loader.loadAll(tmp, log);
    // 内置技能正常加载，bad-skill 被跳过
    expect(loader.get('bad-skill')).toBeUndefined();
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('缺少必填字段 name');
  });

  it('缺少 frontmatter → 跳过并记录警告', () => {
    const log = vi.fn();
    const skillsDir = path.join(tmp, '.lumen', 'skills');
    writeSkill(skillsDir, 'no-fm', '直接是正文，没有 frontmatter');

    loader.loadAll(tmp, log);
    expect(loader.get('no-fm')).toBeUndefined();
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('缺少 frontmatter');
  });

  it('项目级覆盖全局级同名技能（含内置）', () => {
    const projectDir = path.join(tmp, 'project');

    writeSkill(
      path.join(projectDir, '.lumen', 'skills'),
      'code-review',
      `---
name: code-review
description: 项目自定义审查
version: 2.0.0
---

自定义审查正文
`,
    );

    loader.loadAll(projectDir);
    const skill = loader.get('code-review');
    expect(skill).toBeDefined();
    // 项目级覆盖内置
    expect(skill?.description).toBe('项目自定义审查');
    expect(skill?.version).toBe('2.0.0');
  });

  it('tools 字段可选 → tools 为 undefined', () => {
    const skillsDir = path.join(tmp, '.lumen', 'skills');
    writeSkill(
      skillsDir,
      'no-tools',
      `---
name: no-tools
description: 无工具限制
version: 1.0.0
---

正文
`,
    );

    loader.loadAll(tmp);
    const skill = loader.get('no-tools');
    expect(skill?.tools).toBeUndefined();
  });

  it('model 字段可选 → model 为 undefined', () => {
    const skillsDir = path.join(tmp, '.lumen', 'skills');
    writeSkill(
      skillsDir,
      'no-model',
      `---
name: no-model
description: 无模型建议
version: 1.0.0
---

正文
`,
    );

    loader.loadAll(tmp);
    const skill = loader.get('no-model');
    expect(skill?.model).toBeUndefined();
  });

  it('目录不存在 → 不抛错，仅有内置技能', () => {
    expect(() => loader.loadAll('/no/such/dir')).not.toThrow();
    // 内置技能仍被加载
    expect(loader.list().length).toBeGreaterThan(0);
    expect(loader.get('code-review')).toBeDefined();
  });
});
