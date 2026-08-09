/**
 * 技能 → Agent 升级（v3.0 M4 / T4.4）。
 *
 * /agent promote <skill>：读取技能 SKILL.md → 生成 Agent 脚手架
 * （~/.concertoai/agents/<name>/agent.json + index.js）→ 注册到 AgentRegistry。
 *
 * 设计（§4.3 渐进式升级，非替代）：
 * - agent.json 与 T4.2 安装器共用 InstalledAgent 格式（name/version/def/installedAt），
 *   因此 promote 生成的 Agent 同样被 /agent list 的 listInstalled() 识别；
 * - permissions 从技能 SKILL.md 的 `tools` 白名单推导（fail-closed），
 *   技能无 tools 时默认只读三件套（read_file / search_content / list_directory）；
 * - index.js 生成可被 import() 加载的执行骨架（CJS，create(deps) 工厂），
 *   运行时按需实例化（外部 Agent 执行机制，决策点 C 选项①）；
 * - 技能原样保留（升级非迁移，技能市场仍可用）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AgentRegistry } from '../agents';
import type { AgentPermission } from '../orchestrator';
import type { SkillLoader } from '../skill/loader';
import { agentDefFromPackage, globalAgentsDir } from './installer';

// ── 选项 / 结果 ──────────────────────────────────────────────

export interface PromoteOptions {
  /** 要升级的技能名。 */
  skillName: string;
  /** 技能加载器（需已 loadAll，提供技能 def）。 */
  loader: SkillLoader;
  /** 安装目录（默认 ~/.concertoai/agents/，测试可注入）。 */
  installDir?: string;
  /** Agent 注册表（提供时注册成功，供 /agent list 与后续调度）。 */
  registry?: AgentRegistry;
}

export type PromoteFailureCode = 'SKILL_NOT_FOUND' | 'ALREADY_EXISTS' | 'WRITE_FAILED';

export type PromoteResult =
  | { ok: true; name: string; version: string; dir: string }
  | { ok: false; code: PromoteFailureCode; message: string };

// ── 权限推导（fail-closed）───────────────────────────────────

/** 技能无 tools 时的默认只读工具白名单。 */
const DEFAULT_TOOLS = ['read_file', 'search_content', 'list_directory'];

/** 从技能 tools 白名单推导 Agent 权限声明；无 tools → 默认只读三件套。 */
export function derivePermissions(tools: string[] | undefined): AgentPermission[] {
  const list = tools !== undefined && tools.length > 0 ? tools : DEFAULT_TOOLS;
  return list.map((tool) => ({ tool }));
}

// ── 脚手架生成 ───────────────────────────────────────────────

/**
 * 生成 index.js 执行骨架（CJS，可被 import() 加载）。
 *
 * 脚手架实现标准 Agent 契约：def（AgentDef 描述）+ runtimeState +
 * execute/send/receive。execute 以技能正文为 system prompt 调用模型，
 * 输入 description → 输出 { result }。
 *
 * 安全：生成代码用普通字符串数组拼接（非模板字符串），技能正文经
 * JSON.stringify 嵌入为双引号字符串字面量——正文含反引号 / ${} 均安全，
 * 不会破坏生成代码。
 *
 * @param name Agent 名（= 技能名）
 * @param version 版本号（继承技能版本）
 * @param body 技能正文（markdown，作为 system prompt）
 */
export function buildScaffoldIndexJs(name: string, version: string, body: string): string {
  const defJson = JSON.stringify({
    name,
    version,
    interfaces: {
      input: { description: 'string' },
      output: { result: 'string' },
      version: '1.0.0',
    },
    permissions: [], // 实际权限在 agent.json（derivePermissions），运行时由调度器授予
  });
  // 技能正文嵌入为 JSON 双引号字符串字面量（反引号 / ${} 均安全）
  const bodyLiteral = JSON.stringify(body);
  const lines = [
    '/**',
    ` * ConcertoAI Agent 脚手架（由 /agent promote ${name} 生成）。`,
    ' *',
    ' * 接口契约：AgentDef（见同目录 agent.json）',
    " * 用法：const { create } = await import('<dir>/index.js');",
    ' *       const agent = create({ client, model });',
    ' *       const output = await agent.execute({ description }, context);',
    ' */',
    'module.exports = {',
    '  create: ({ client, model }) => ({',
    `    def: ${defJson},`,
    '    runtimeState: { attempts: 0, updatedAt: Date.now() },',
    '    async execute(input, context) {',
    '      // 以技能正文为 system prompt 调用模型（与内置 Agent 生成策略一致）',
    '      const contentParts = [];',
    '      for await (const chunk of client.streamChat({',
    '        model,',
    '        messages: [',
    `          { role: 'system', content: ${bodyLiteral} },`,
    `          { role: 'user', content: \`需求：\${input?.description ?? ''}\\n\\n已有上下文：\${JSON.stringify(context ?? {})}\` },`,
    '        ],',
    '        temperature: 0.2,',
    '      })) {',
    '        for (const choice of chunk.choices ?? []) {',
    "          const text = choice.delta?.content ?? '';",
    "          if (text !== '') contentParts.push(text);",
    '        }',
    '      }',
    "      return { result: contentParts.join('') };",
    '    },',
    '    async send() {},',
    '    async receive() { return undefined; },',
    '  }),',
    '};',
    '',
  ];
  return lines.join('\n');
}

/** 从脚手架描述性 def 生成可注册的 AgentDef（复用 T4.2 宽松 schema 兜底逻辑）。 */
export function agentDefFromScaffold(def: {
  name: string;
  version: string;
  permissions: AgentPermission[];
}): import('../orchestrator').AgentDef {
  return agentDefFromPackage(
    {
      name: def.name,
      version: def.version,
      interfaces: {
        input: { description: 'string' },
        output: { result: 'string' },
        version: '1.0.0',
      },
      permissions: def.permissions,
    },
    def.version,
  );
}

// ── promote 主流程 ───────────────────────────────────────────

/**
 * 将技能升级为 Agent：校验技能存在 → 生成 agent.json + index.js →
 * 注册到 AgentRegistry。技能原样保留。
 */
export function promoteSkill(opts: PromoteOptions): PromoteResult {
  const dir = opts.installDir ?? globalAgentsDir();
  const skill = opts.loader.get(opts.skillName);

  // 1. 技能必须存在
  if (skill === undefined) {
    return {
      ok: false,
      code: 'SKILL_NOT_FOUND',
      message: `技能不存在: ${opts.skillName}（使用 /skill list 查看可用技能）。`,
    };
  }

  // 2. 同名 Agent 不得已存在（含已注册条目）
  if (opts.registry?.has(skill.name) === true) {
    return {
      ok: false,
      code: 'ALREADY_EXISTS',
      message: `Agent ${skill.name} 已存在（需先 /agent remove ${skill.name} 或使用其他技能名）。`,
    };
  }

  // 3. 生成脚手架文件
  const targetDir = path.join(dir, skill.name);
  try {
    mkdirSync(targetDir, { recursive: true });
    const permissions = derivePermissions(skill.tools);
    const def = {
      name: skill.name,
      version: skill.version,
      interfaces: {
        input: { description: 'string' },
        output: { result: 'string' },
        version: '1.0.0',
      },
      permissions,
    };
    // agent.json 与安装器 InstalledAgent 格式兼容（/agent list 可识别）
    writeFileSync(
      path.join(targetDir, 'agent.json'),
      JSON.stringify(
        { name: skill.name, version: skill.version, def, installedAt: Date.now() },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      path.join(targetDir, 'index.js'),
      buildScaffoldIndexJs(skill.name, skill.version, skill.body),
      'utf8',
    );
  } catch (err) {
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: `写入 Agent 脚手架失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. 注册到 AgentRegistry（def 仅契约；impl 由运行时按需 import 加载）
  if (opts.registry !== undefined) {
    opts.registry.register(
      agentDefFromScaffold({
        name: skill.name,
        version: skill.version,
        permissions: derivePermissions(skill.tools),
      }),
    );
  }

  return { ok: true, name: skill.name, version: skill.version, dir: targetDir };
}
