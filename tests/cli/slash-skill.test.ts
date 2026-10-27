import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeSkillCommand,
  executeSkillMarketCommand,
  parseSkillCommand,
} from '../../src/cli/slash/skill';
import { SkillLoader } from '../../src/skill/loader';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-slash-skill-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(cwd: string, name: string, body: string): void {
  const dir = path.join(cwd, '.concertoai', 'skills', name);
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

// ── v2.1 M3: 技能市场命令解析 ──────────────────────────────

describe('parseSkillCommand — 技能市场', () => {
  it('/skill install <name> → install', () => {
    expect(parseSkillCommand('/skill install code-review')).toEqual({
      type: 'install',
      name: 'code-review',
    });
  });

  it('/skill search → search（无 keyword）', () => {
    expect(parseSkillCommand('/skill search')).toEqual({ type: 'search', keyword: undefined });
  });

  it('/skill search <keyword> → search', () => {
    expect(parseSkillCommand('/skill search review')).toEqual({
      type: 'search',
      keyword: 'review',
    });
  });

  it('/skill update → update（无 name）', () => {
    expect(parseSkillCommand('/skill update')).toEqual({ type: 'update', name: undefined });
  });

  it('/skill update <name> → update', () => {
    expect(parseSkillCommand('/skill update code-review')).toEqual({
      type: 'update',
      name: 'code-review',
    });
  });

  it('/skill install（无参数）→ 提示用法', () => {
    const result = parseSkillCommand('/skill install');
    expect(result).not.toBeNull();
    if (result !== null && 'message' in result) {
      expect(result.message).toContain('用法');
    }
  });
});

// ── v2.1 M3: 技能市场命令执行 ──────────────────────────────

describe('executeSkillMarketCommand', () => {
  // ═══ 隔离全局目录（v5.0 T14 收尾实测发现） ═══
  //
  // `/skill install` / `update` 会写到 **全局** 技能目录 `~/.concertoai/skills`
  // （`globalDir()` 由 `os.homedir()` 推导），原先这里只隔离了 `tmp`（cwd），
  // 于是有两个后果：
  // 1. **测试垃圾堆在开发者真实 home**，且从不清理——实测已累积 300+ 个
  //    `install-test-<时间戳>` 目录（AGENTS 第 17 条：临时资源必须清理）；
  // 2. **与 tests/skill/loader.test.ts 并行互相干扰**：那个用例先 `loadAll` 再数
  //    全局技能数量，两次之间有新技能被装进真实 home → 计数不等 → `npm run verify`
  //    偶发红（首轮全量实测复现：仅此一处失败，单独跑必绿）。
  //
  // 打桩 `os.homedir` → `globalDir()` 落到本用例的 `tmp`，外层 `afterEach` 的
  // `rmSync` 顺手清干净，两个问题一起消失。
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 构造一份注册表 JSON 字符串（含 sha256）。 */
  function makeRegistry(skills: Array<{ name: string; version: string; content: string }>): string {
    const entries = skills.map((s) => ({
      name: s.name,
      version: s.version,
      description: `${s.name} 描述`,
      author: 'ConcertoAI',
      url: `https://example.com/skills/${s.name}/SKILL.md`,
      sha256: createHash('sha256').update(s.content).digest('hex'),
    }));
    return JSON.stringify({ registry: 'https://example.com/registry.json', skills: entries });
  }

  function makeLoader(cwd: string): SkillLoader {
    const loader = new SkillLoader();
    loader.loadAll(cwd);
    return loader;
  }

  it('/skill install — 成功安装', async () => {
    const skillName = `install-test-${Date.now()}`;
    const skillContent = `---
name: ${skillName}
description: 新技能
version: 1.0.0
---
技能正文`;
    const registry = makeRegistry([{ name: skillName, version: '1.0.0', content: skillContent }]);

    // mock fetch：第一次返回注册表，第二次返回技能内容
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => {
        callCount += 1;
        return {
          ok: true,
          text: async () => (callCount === 1 ? registry : skillContent),
          json: async () => JSON.parse(registry),
        };
      }),
    );

    const loader = makeLoader(tmp);
    const result = await executeSkillMarketCommand(
      { type: 'install', name: skillName },
      loader,
      tmp,
    );

    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain(skillName);

    // 刷新后技能可用
    const skill = loader.get(skillName);
    expect(skill).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('/skill install — 已安装最新版则跳过', async () => {
    const skillName = `skip-test-${Date.now()}`;
    const skillContent = `---
name: ${skillName}
description: 审查
version: 1.0.0
---
正文`;
    const registry = makeRegistry([{ name: skillName, version: '1.0.0', content: skillContent }]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => {
        // 第一次调用：返回注册表；第二次调用：被跳过（不调用）
        return {
          ok: true,
          text: async () => skillContent,
          json: async () => JSON.parse(registry),
        };
      }),
    );

    const loader = makeLoader(tmp);
    // 先安装一次
    await executeSkillMarketCommand({ type: 'install', name: skillName }, loader, tmp);
    // 再安装 → 应提示已安装
    const loader2 = makeLoader(tmp);
    const result = await executeSkillMarketCommand(
      { type: 'install', name: skillName },
      loader2,
      tmp,
    );

    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('已安装');
    vi.unstubAllGlobals();
  });

  it('/skill install — 注册表未找到技能', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ registry: '', skills: [] }),
      })),
    );

    const loader = makeLoader(tmp);
    const result = await executeSkillMarketCommand(
      { type: 'install', name: 'no-such' },
      loader,
      tmp,
    );

    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未找到');
    vi.unstubAllGlobals();
  });

  it('/skill search — 模糊匹配', async () => {
    const registry = JSON.stringify({
      registry: '',
      skills: [
        {
          name: 'code-review',
          version: '1.0.0',
          description: '代码审查',
          author: 'ConcertoAI',
          url: '',
          sha256: '',
        },
        {
          name: 'explain',
          version: '1.0.0',
          description: '代码解释',
          author: 'ConcertoAI',
          url: '',
          sha256: '',
        },
      ],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => JSON.parse(registry),
      })),
    );

    const loader = makeLoader(tmp);
    const result = await executeSkillMarketCommand(
      { type: 'search', keyword: '审查' },
      loader,
      tmp,
    );

    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('code-review');
    expect(result.message?.content).not.toContain('explain');
    vi.unstubAllGlobals();
  });

  it('/skill search — 无 keyword 列出全部', async () => {
    const registry = JSON.stringify({
      registry: '',
      skills: [
        {
          name: 'code-review',
          version: '1.0.0',
          description: '审查',
          author: 'ConcertoAI',
          url: '',
          sha256: '',
        },
      ],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => JSON.parse(registry),
      })),
    );

    const loader = makeLoader(tmp);
    const result = await executeSkillMarketCommand({ type: 'search' }, loader, tmp);
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('code-review');
    vi.unstubAllGlobals();
  });

  it('/skill install — 网络错误友好提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network error');
      }),
    );

    const loader = makeLoader(tmp);
    const result = await executeSkillMarketCommand({ type: 'install', name: 'any' }, loader, tmp);
    expect(result.message?.content).toContain('无法访问');
    vi.unstubAllGlobals();
  });
});
