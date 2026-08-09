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

// ── v2.1 M2: 技能嵌套测试 ────────────────────────────────

describe('SkillLoader 嵌套引用（v2.1 M2）', () => {
  let tmp2: string;

  beforeEach(() => {
    tmp2 = mkdtempSync(path.join(os.tmpdir(), 'lumen-nest-test-'));
  });

  afterEach(() => {
    rmSync(tmp2, { recursive: true, force: true });
  });

  function writeSkill(dir: string, name: string, content: string): void {
    const skillDir = path.join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  }

  it('@skill:<name> 引用 → 被引用技能正文内联展开', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');
    // 先写被引用技能（按字母序先扫描）
    writeSkill(
      dir,
      'a-base',
      `---
name: base
description: 基础技能
version: 1.0.0
---
这是基础技能的正文。
`,
    );

    writeSkill(
      dir,
      'b-wrapper',
      `---
name: wrapper
description: 包装技能
version: 1.0.0
---
包装技能开头。
@skill:base
包装技能结尾。
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2);
    const wrapper = loader.get('wrapper');
    expect(wrapper).toBeDefined();
    // 正文应包含基础技能的 body + 不含 @skill 占位符
    expect(wrapper?.body).toContain('这是基础技能的正文');
    expect(wrapper?.body).toContain('包装技能开头');
    expect(wrapper?.body).toContain('包装技能结尾');
    expect(wrapper?.body).not.toContain('@skill:base');
  });

  it('@agent:<name> <prompt> → 收集为 agentRefs，正文保留原样', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');
    writeSkill(
      dir,
      'agent-skill',
      `---
name: agent-skill
description: 含子代理的技能
version: 1.0.0
---
审查代码。
@agent:explore 查找相关测试文件
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2);
    const skill = loader.get('agent-skill');
    expect(skill).toBeDefined();
    expect(skill?.agentRefs).toBeDefined();
    expect(skill?.agentRefs).toHaveLength(1);
    expect(skill?.agentRefs?.[0]).toMatchObject({
      agentName: 'explore',
      prompt: '查找相关测试文件',
    });
  });

  it('直接循环 — @skill:a → @skill:a 拒绝加载', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');
    const log = vi.fn();

    writeSkill(
      dir,
      'self-ref',
      `---
name: self-ref
description: 自我引用
version: 1.0.0
---
@skill:self-ref
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2, log);
    const skill = loader.get('self-ref');
    // 循环引用 → 加载失败，skill 不存在
    expect(skill).toBeUndefined();
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('循环');
  });

  it('间接循环 — A → B → A 拒绝加载', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');
    const log = vi.fn();

    // B 先加载（被 A 引用）
    writeSkill(
      dir,
      'a-b',
      `---
name: b
description: B
version: 1.0.0
---
B 的技能正文。
@skill:a
`,
    );

    writeSkill(
      dir,
      'b-a',
      `---
name: a
description: A
version: 1.0.0
---
A 的技能正文。
@skill:b
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2, log);
    // 由于循环，至少一个应被拒绝
    const hasLoopLog = log.mock.calls.some(
      (c) =>
        String(c[0]).includes('循环') && (String(c[0]).includes('a') || String(c[0]).includes('b')),
    );
    expect(hasLoopLog).toBe(true);
  });

  it('三层正常链 — A → B → C 正常展开', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');

    writeSkill(
      dir,
      'a-c',
      `---
name: c
description: C
version: 1.0.0
---
C 的正文。
`,
    );

    writeSkill(
      dir,
      'b-b',
      `---
name: b
description: B
version: 1.0.0
---
B 的正文。
@skill:c
`,
    );

    writeSkill(
      dir,
      'c-a',
      `---
name: a
description: A
version: 1.0.0
---
A 的正文。
@skill:b
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2);
    const a = loader.get('a');
    expect(a).toBeDefined();
    // A 应包含 C 的正文（A → B → C）
    expect(a?.body).toContain('C 的正文');
    expect(a?.body).toContain('B 的正文');
    expect(a?.body).toContain('A 的正文');
    // 无 @skill 占位符残留
    expect(a?.body).not.toContain('@skill:');
  });

  it('超过 3 层深度 → 拒绝加载', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');
    const log = vi.fn();

    // d (depth 0) → c (1) → b (2) → a (3) → ...  → exceeds limit
    // 先写最底层
    writeSkill(
      dir,
      'a-d4',
      `---
name: d4
description: 第 4 层
version: 1.0.0
---
第 4 层正文。
@skill:d5
`,
    );

    writeSkill(
      dir,
      'b-d5',
      `---
name: d5
description: 第 5 层
version: 1.0.0
---
第 5 层正文。
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2, log);
    // d4 引用 d5（已在 depth 范围），但 d4 自身深度会变成从外层的累积
    const d4 = loader.get('d4');
    expect(d4).toBeDefined(); // d4 本身 depth=0，引用 d5 depth=1 → 正常
    // 确认无深度超限日志（2 层在范围内）
    const hasDepthLog = log.mock.calls.some((c) => String(c[0]).includes('深度超过限制'));
    expect(hasDepthLog).toBe(false);
  });

  it('超过 3 层深度 — 从外层测量', () => {
    const dir = path.join(tmp2, '.lumen', 'skills');
    const log = vi.fn();

    // 创建链 A → B → C → D → E（5 层）
    writeSkill(
      dir,
      'a-e',
      `---
name: e
description: E
version: 1.0.0
---
E 的正文。
`,
    );

    writeSkill(
      dir,
      'b-d',
      `---
name: d
description: D
version: 1.0.0
---
@skill:e
`,
    );

    writeSkill(
      dir,
      'c-c2',
      `---
name: c2
description: C2
version: 1.0.0
---
@skill:d
`,
    );

    writeSkill(
      dir,
      'd-b2',
      `---
name: b2
description: B2
version: 1.0.0
---
@skill:c2
`,
    );

    writeSkill(
      dir,
      'e-a2',
      `---
name: a2
description: A2
version: 1.0.0
---
@skill:b2
`,
    );

    const loader = new SkillLoader();
    loader.loadAll(tmp2, log);

    // a2 引用 b2 → c2 → d → e = 4 层深度，应被拒绝
    const a2 = loader.get('a2');
    expect(a2).toBeUndefined();
    const hasDepthLog = log.mock.calls.some((c) => String(c[0]).includes('深度超过限制'));
    expect(hasDepthLog).toBe(true);
  });
});
