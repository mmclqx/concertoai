/**
 * 技能 → Agent 升级测试（v3.0 M4 / T4.4）。
 *
 * 覆盖验收标准：
 * - /agent promote <skill>：读取技能 SKILL.md → 生成 Agent 脚手架
 *   （~/.lumen/agents/<name>/agent.json + index.js）→ 注册到 AgentRegistry；
 * - 脚手架包含接口声明（interfaces）与权限声明（permissions 从技能 tools 推导，
 *   无 tools 时默认只读三件套，fail-closed）；
 * - 生成后 /agent list 可见（agent.json 与安装器 InstalledAgent 格式兼容）；
 * - 技能原样保留（升级非迁移，技能市场仍可用）；
 * - 生成失败（技能不存在 / 已存在同名 Agent）→ 明确报错。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryAgentRegistry } from '../../src/agents';
import {
  AgentInstaller,
  agentDefFromScaffold,
  buildScaffoldIndexJs,
  derivePermissions,
  promoteSkill,
} from '../../src/market';
import { SkillLoader } from '../../src/skill/loader';

let tmp: string;
let agentsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-promote-'));
  agentsDir = path.join(tmp, 'agents');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 测试辅助 ──────────────────────────────────────────────────

/** 写入一个项目级技能（SKILL.md，可指定 tools 白名单）。 */
function writeSkill(cwd: string, name: string, body: string, tools?: string): void {
  const dir = path.join(cwd, '.lumen', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const frontmatter = `---
name: ${name}
description: ${name} 描述
version: 1.0.0
${tools !== undefined ? `tools: ${tools}` : ''}
---

${body}`;
  writeFileSync(path.join(dir, 'SKILL.md'), frontmatter, 'utf8');
}

/** 创建已 loadAll 的技能加载器。 */
function makeLoader(cwd: string): SkillLoader {
  const loader = new SkillLoader();
  loader.loadAll(cwd);
  return loader;
}

// ── derivePermissions（权限推导，fail-closed）─────────────────

describe('derivePermissions', () => {
  it('有 tools → 按白名单生成权限声明', () => {
    const perms = derivePermissions(['read_file', 'edit_file']);
    expect(perms).toEqual([{ tool: 'read_file' }, { tool: 'edit_file' }]);
  });

  it('无 tools → 默认只读三件套（read_file/search_content/list_directory）', () => {
    const perms = derivePermissions(undefined);
    expect(perms.map((p) => p.tool)).toEqual(['read_file', 'search_content', 'list_directory']);
  });

  it('空 tools 数组 → 同默认只读三件套', () => {
    const perms = derivePermissions([]);
    expect(perms.map((p) => p.tool)).toEqual(['read_file', 'search_content', 'list_directory']);
  });
});

// ── buildScaffoldIndexJs（可执行骨架生成）─────────────────────

describe('buildScaffoldIndexJs', () => {
  it('生成 CJS 骨架：可被 import() 加载，含 def/execute，技能正文嵌入为字面量', async () => {
    const body = '## 技能\n审查代码并输出报告。';
    const code = buildScaffoldIndexJs('code-review', '1.0.0', body);

    expect(code).toContain('module.exports');
    expect(code).toContain('create');
    // 技能正文经 JSON.stringify 嵌入（作为字符串字面量）
    expect(code).toContain('审查代码并输出报告');
    // 权限声明占位（实际权限在 agent.json；defJson 经 JSON.stringify 无空格）
    expect(code).toContain('"permissions":[]');

    // 写盘后真实 import() 验证结构
    const dir = path.join(tmp, 'scaffold');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.js');
    writeFileSync(file, code, 'utf8');
    const mod = (await import(pathToFileURL(file).href)) as {
      create: (deps: unknown) => {
        def: { name: string; version: string };
        runtimeState: { attempts: number };
        execute: (input: unknown, context: unknown) => Promise<unknown>;
        send: () => Promise<void>;
        receive: () => Promise<undefined>;
      };
    };
    const agent = mod.create({ client: {}, model: 'm' });
    expect(agent.def.name).toBe('code-review');
    expect(agent.def.version).toBe('1.0.0');
    expect(agent.runtimeState.attempts).toBe(0);
    expect(typeof agent.execute).toBe('function');
    expect(typeof agent.send).toBe('function');
  });

  it('技能正文含反引号与模板插值时仍生成合法代码（转义安全）', () => {
    // 用拼接避免字面 ${ 触发 noTemplateCurlyInString
    const body = '使用 `code` 和 $' + '{variable} 的说明';
    const code = buildScaffoldIndexJs('tricky', '1.0.0', body);
    // 正文作为 JSON 字面量嵌入，不会破坏生成代码
    expect(code).toContain('使用 `code` 和 $' + '{variable} 的说明');
    // 生成代码本身可被解析（不抛 SyntaxError；用 Function 构造验证语法）
    expect(() => {
      new Function(code);
    }).not.toThrow();
  });
});

// ── promoteSkill 主流程 ───────────────────────────────────────

describe('promoteSkill', () => {
  it('成功：生成脚手架 + 注册 AgentRegistry + 技能保留', () => {
    writeSkill(tmp, 'code-review', '## 审查\n输出 ReviewResult。', 'read_file,search_content');
    const loader = makeLoader(tmp);
    const registry = new InMemoryAgentRegistry();

    const result = promoteSkill({
      skillName: 'code-review',
      loader,
      registry,
      installDir: agentsDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('code-review');
    expect(result.version).toBe('1.0.0');

    // agent.json 存在且格式与安装器 InstalledAgent 兼容（/agent list 可识别）
    const agentJson = path.join(agentsDir, 'code-review', 'agent.json');
    const indexJs = path.join(agentsDir, 'code-review', 'index.js');
    expect(existsSync(agentJson)).toBe(true);
    expect(existsSync(indexJs)).toBe(true);
    const meta = JSON.parse(readFileSync(agentJson, 'utf8')) as {
      name: string;
      version: string;
      def: { permissions: Array<{ tool: string }> };
    };
    expect(meta.name).toBe('code-review');
    expect(meta.version).toBe('1.0.0');
    expect(meta.def.permissions.map((p) => p.tool)).toEqual(['read_file', 'search_content']);

    // AgentInstaller.listInstalled 指向同一目录可识别（/agent list 数据源）
    const installer = new AgentInstaller({ installDir: agentsDir });
    expect(installer.listInstalled().map((a) => a.name)).toEqual(['code-review']);

    // AgentRegistry 已注册（permissions fail-closed）
    expect(registry.has('code-review')).toBe(true);
    expect(registry.permissionsOf('code-review')?.map((p) => p.tool)).toEqual([
      'read_file',
      'search_content',
    ]);

    // 技能原样保留
    expect(loader.get('code-review')).toBeDefined();
  });

  it('技能无 tools → 默认只读三件套权限', () => {
    writeSkill(tmp, 'explain', '## 解释\n解释代码。');
    const loader = makeLoader(tmp);
    const registry = new InMemoryAgentRegistry();

    const result = promoteSkill({
      skillName: 'explain',
      loader,
      registry,
      installDir: agentsDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(registry.permissionsOf('explain')?.map((p) => p.tool)).toEqual([
      'read_file',
      'search_content',
      'list_directory',
    ]);
  });

  it('技能不存在 → SKILL_NOT_FOUND', () => {
    const loader = makeLoader(tmp);
    const result = promoteSkill({
      skillName: 'no-such',
      loader,
      installDir: agentsDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SKILL_NOT_FOUND');
      expect(result.message).toContain('技能不存在');
    }
  });

  it('同名 Agent 已注册 → ALREADY_EXISTS', () => {
    writeSkill(tmp, 'code-review', '## 审查\n正文。');
    const loader = makeLoader(tmp);
    const registry = new InMemoryAgentRegistry();
    // 预注册同名 Agent
    registry.register({
      name: 'code-review',
      version: '9.9.9',
      interfaces: { input: {}, output: {}, version: '1.0.0' },
      permissions: [{ tool: 'read_file' }],
    } as never);

    const result = promoteSkill({
      skillName: 'code-review',
      loader,
      registry,
      installDir: agentsDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ALREADY_EXISTS');
      expect(result.message).toContain('已存在');
    }
  });
});

// ── agentDefFromScaffold ──────────────────────────────────────

describe('agentDefFromScaffold', () => {
  it('从脚手架 def 生成可注册 AgentDef（宽松 schema 兜底）', () => {
    const def = agentDefFromScaffold({
      name: 'my-skill',
      version: '1.0.0',
      permissions: [{ tool: 'read_file' }],
    });
    expect(def.name).toBe('my-skill');
    expect(def.version).toBe('1.0.0');
    expect(def.interfaces.version).toBe('1.0.0');
    expect(def.permissions.map((p) => p.tool)).toEqual(['read_file']);
    expect(def.interfaces.input.safeParse({ description: 'x' }).success).toBe(true);
  });
});
