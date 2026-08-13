/**
 * Agent 市场类型定义（v3.0 M4 / T4.1）。
 *
 * 复用技能市场 registry.json schema（name/version/description/author/url/sha256），
 * 通过 `type: 'skill' | 'agent'` 区分，Agent 条目扩展 AgentDef 字段
 * （interfaces / permissions / runtime）与接口版本号。
 *
 * 与 v2.1 技能市场的关系（§4.3 渐进式升级，非替代）：
 * - 技能注册表保持 `skills[]`；Agent 注册表新增 `agents[]`；
 * - 共用底层字段（下载 → sha256 校验 → 写入，T4.2 抽取共享函数）；
 * - 内置注册表初始含 4 个 Agent 条目（architect/coder/reviewer/qa）。
 */

import type { AgentDef } from '../orchestrator';
import type { PluginCategory, PluginPermission } from '../plugin/types';

/** 注册表条目类型：技能（v2.1）、Agent（v3.0）或插件（v4.0 M4）。 */
export type RegistryItemType = 'skill' | 'agent' | 'plugin';

/** 注册表条目公共字段（与技能市场一致）。 */
export interface RegistryItemBase {
  /** 条目唯一名称。 */
  name: string;
  /** 版本号（semver）。 */
  version: string;
  /** 描述。 */
  description: string;
  /** 作者。 */
  author: string;
  /** 下载地址（skill 为 SKILL.md / agent 为实现包）。 */
  url: string;
  /** 内容 sha256 校验值。 */
  sha256: string;
}

/** Agent 条目：复用 AgentDef 的接口/权限字段 + 运行时类型。 */
export interface AgentRegistryItem extends RegistryItemBase {
  /** 类型：'agent'（与技能条目区分）。 */
  type: 'agent';
  /** 输入/输出 Schema 契约（对齐 AgentDef.interfaces，含接口版本号）。 */
  interfaces: AgentDef['interfaces'];
  /** 工具权限声明（对齐 AgentDef.permissions，fail-closed）。 */
  permissions: AgentDef['permissions'];
  /** 运行时类型（'builtin' 内置 / 'external' 第三方，市场分发）。 */
  runtime: 'builtin' | 'external';
}

/** 技能条目（v2.1 技能市场，类型标记 'skill'）。 */
export interface SkillRegistryItem extends RegistryItemBase {
  type: 'skill';
}

/** 插件条目（v4.0 M4，类型标记 'plugin'；含分类/下载量/评分/权限声明）。 */
export interface PluginRegistryItem extends RegistryItemBase {
  type: 'plugin';
  /** 插件分类（🔧工具 / 📋工作流 / 🤖Agent，browse 按此分类）。 */
  category: PluginCategory;
  /** 下载量（市场展示排序用）。 */
  downloads: number;
  /** 评分（0~5，一位小数）。 */
  rating: number;
  /** 权限声明（六类权限，安装时展示 + 运行时 enforce，fail-closed）。 */
  permissions: PluginPermission[];
}

/** 注册表条目判别联合（按 type 收窄）。 */
export type RegistryItem = AgentRegistryItem | SkillRegistryItem | PluginRegistryItem;

/** 完整市场注册表（registry URL + 技能/Agent/插件条目）。 */
export interface MarketRegistry {
  /** 注册表自身 URL（刷新/更新用）。 */
  registry: string;
  /** 技能条目（v2.1 兼容）。 */
  skills: SkillRegistryItem[];
  /** Agent 条目（v3.0 新增）。 */
  agents: AgentRegistryItem[];
  /** 插件条目（v4.0 M4 新增）。 */
  plugins: PluginRegistryItem[];
}

/** 内置 4 个 Agent 的市场条目（architect/coder/reviewer/qa）。 */
export const BUILTIN_AGENT_ITEMS: AgentRegistryItem[] = [
  {
    type: 'agent',
    name: 'architect',
    version: '1.0.0',
    description: '架构师——接收需求输出结构化设计 spec（接口定义 + 文件结构 + 约束条件）',
    author: 'ConcertoAI',
    url: 'https://raw.githubusercontent.com/concertoai/cli/main/agents/architect.js',
    sha256: 'builtin',
    interfaces: {
      input: { _type: 'zod' } as unknown as AgentDef['interfaces']['input'],
      output: { _type: 'zod' } as unknown as AgentDef['interfaces']['output'],
      version: '1.0.0',
    },
    permissions: [{ tool: 'read_file' }, { tool: 'list_directory' }, { tool: 'search_content' }],
    runtime: 'builtin',
  },
  {
    type: 'agent',
    name: 'coder',
    version: '1.0.0',
    description: '编码 Agent——按 spec 实现代码 + 接收审查反馈修复（审批后写盘）',
    author: 'ConcertoAI',
    url: 'https://raw.githubusercontent.com/concertoai/cli/main/agents/coder.js',
    sha256: 'builtin',
    interfaces: {
      input: { _type: 'zod' } as unknown as AgentDef['interfaces']['input'],
      output: { _type: 'zod' } as unknown as AgentDef['interfaces']['output'],
      version: '1.0.0',
    },
    permissions: [{ tool: 'edit_file' }],
    runtime: 'builtin',
  },
  {
    type: 'agent',
    name: 'reviewer',
    version: '1.0.0',
    description: 'Team Reviewer——9 维审查代码，输出 ReviewResult（approve/reject 打回）',
    author: 'ConcertoAI',
    url: 'https://raw.githubusercontent.com/concertoai/cli/main/agents/reviewer.js',
    sha256: 'builtin',
    interfaces: {
      input: { _type: 'zod' } as unknown as AgentDef['interfaces']['input'],
      output: { _type: 'zod' } as unknown as AgentDef['interfaces']['output'],
      version: '1.0.0',
    },
    permissions: [{ tool: 'read_file' }, { tool: 'list_directory' }, { tool: 'search_content' }],
    runtime: 'builtin',
  },
  {
    type: 'agent',
    name: 'qa',
    version: '1.0.0',
    description: 'QA Agent——沙箱执行 npm run verify，输出结构化测试报告',
    author: 'ConcertoAI',
    url: 'https://raw.githubusercontent.com/concertoai/cli/main/agents/qa.js',
    sha256: 'builtin',
    interfaces: {
      input: { _type: 'zod' } as unknown as AgentDef['interfaces']['input'],
      output: { _type: 'zod' } as unknown as AgentDef['interfaces']['output'],
      version: '1.0.0',
    },
    permissions: [{ tool: 'run_command', args: { command: 'npm run verify' } }],
    runtime: 'builtin',
  },
];

/** 内置 4 个示例插件的市场条目（v4.0 M4 / T4.3，sha256='builtin' 表示内置内容直装）。 */
export const BUILTIN_PLUGIN_ITEMS: PluginRegistryItem[] = [
  {
    type: 'plugin',
    name: 'git-status',
    version: '1.0.0',
    description: '一键查看 git 状态摘要（分支/暂存/未跟踪）',
    author: 'ConcertoAI',
    url: 'builtin://git-status',
    sha256: 'builtin',
    category: 'tool',
    downloads: 1200,
    rating: 4.7,
    permissions: [{ type: 'read', paths: ['.git'] }],
  },
  {
    type: 'plugin',
    name: 'api-docs',
    version: '1.0.0',
    description: '自动扫描代码生成 API 文档（Express 优先）',
    author: 'ConcertoAI',
    url: 'builtin://api-docs',
    sha256: 'builtin',
    category: 'tool',
    downloads: 980,
    rating: 4.5,
    permissions: [{ type: 'read', paths: ['src'] }],
  },
  {
    type: 'plugin',
    name: 'todo-tracker',
    version: '1.0.0',
    description: '跟踪代码中 TODO/FIXME 标记并生成任务清单',
    author: 'ConcertoAI',
    url: 'builtin://todo-tracker',
    sha256: 'builtin',
    category: 'tool',
    downloads: 860,
    rating: 4.3,
    permissions: [
      { type: 'read', paths: ['src'] },
      { type: 'write', paths: ['TODO.md'] },
    ],
  },
  {
    type: 'plugin',
    name: 'release-helper',
    version: '1.0.0',
    description: '发布辅助：版本检查 → lint/test 门禁 → 发布命令',
    author: 'ConcertoAI',
    url: 'builtin://release-helper',
    sha256: 'builtin',
    category: 'workflow',
    downloads: 640,
    rating: 4.1,
    permissions: [
      { type: 'read', paths: ['package.json'] },
      { type: 'shell', allowlist: ['npm run verify'] },
    ],
  },
];

/** 内置注册表（技能 + 4 个 Agent + 4 个示例插件）。 */
export const BUILTIN_REGISTRY: MarketRegistry = {
  registry: 'https://raw.githubusercontent.com/concertoai/cli/main/skills/registry.json',
  skills: [],
  agents: BUILTIN_AGENT_ITEMS,
  plugins: BUILTIN_PLUGIN_ITEMS,
};
