/**
 * 技能斜杠命令处理器：/skill。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 *
 * v2.1 M3：新增 /skill install / search / update 命令（技能市场）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../../loop/types';
import { fetchVerifiedContent } from '../../market/download';
import type { SkillLoader } from '../../skill/loader';
import type { AgentRef } from '../../skill/types';

// ── 命令解析 ──

export type SlashSkillCommand =
  | { type: 'list' }
  | { type: 'call'; name: string; args: string }
  | { type: 'install'; name: string }
  | { type: 'search'; keyword?: string }
  | { type: 'update'; name?: string }
  | { type: 'unknown'; message: string };

/** 解析用户输入，识别技能命令。 */
export function parseSkillCommand(input: string): SlashSkillCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/skill' || trimmed === '/skill list') {
    return { type: 'list' };
  }

  if (trimmed.startsWith('/skill install ')) {
    return { type: 'install', name: trimmed.slice('/skill install '.length).trim() };
  }

  if (trimmed.startsWith('/skill search')) {
    const keyword = trimmed.slice('/skill search'.length).trim();
    return { type: 'search', keyword: keyword || undefined };
  }

  if (trimmed.startsWith('/skill update')) {
    const name = trimmed.slice('/skill update'.length).trim();
    return { type: 'update', name: name || undefined };
  }

  if (trimmed.startsWith('/skill ')) {
    const rest = trimmed.slice('/skill '.length).trim();
    if (rest === '' || rest === 'list') {
      return { type: 'list' };
    }
    // 解析技能名和可选参数
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      // 避免 install/search/update 被误解析为 call
      if (rest === 'install') {
        return { type: 'unknown', message: '用法: /skill install <name> — 从注册表安装技能' };
      }
      if (rest === 'search') {
        return { type: 'search', keyword: undefined };
      }
      if (rest === 'update') {
        return { type: 'update', name: undefined };
      }
      return { type: 'call', name: rest, args: '' };
    }
    const name = rest.slice(0, spaceIdx).trim();
    const args = rest.slice(spaceIdx + 1).trim();
    return { type: 'call', name, args };
  }

  return null;
}

// ── 命令执行结果 ──

export interface SkillCommandResult {
  /** 是否已处理（true = 命令已被处理，不应再调模型）。 */
  handled: boolean;
  /** UI 展示消息（null = 不显示额外消息）。 */
  message?: ChatMessage;
  /** 技能正文（call 类型时填充，供 App.tsx 注入 system prompt）。 */
  skillBody?: string;
  /** 技能名（call 类型时填充）。 */
  skillName?: string;
  /** 技能允许的工具白名单（undefined = 不限制，使用完整 ToolRegistry）。 */
  skillTools?: string[];
  /** 运行模式：'subagent' 时由 App.tsx 走隔离子代理执行。 */
  runAs?: 'inline' | 'subagent';
  /** v2.1 M2：技能内 @agent 引用列表（App.tsx 负责异步 spawn）。 */
  agentRefs?: AgentRef[];
}

/**
 * 执行技能命令。
 * @param cmd 解析后的命令
 * @param loader 技能加载器
 * @param cwd 项目根（用于 loader.loadAll）
 */
export function executeSkillCommand(
  cmd: SlashSkillCommand,
  loader: SkillLoader,
  cwd: string,
): SkillCommandResult {
  // 确保技能已加载（每次调用时刷新，支持运行时新增技能文件）
  loader.loadAll(cwd);

  if (cmd.type === 'list') {
    const skills = loader.list();
    if (skills.length === 0) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content:
            '📋 暂无可用技能。\n\n将 SKILL.md 放入 `.lumen/skills/<name>/` 目录即可注册新技能。',
        },
      };
    }
    const lines = skills.map(
      (s) =>
        `- **${s.name}** ${s.version} — ${s.description}${s.tools ? ` [工具: ${s.tools.join(', ')}]` : ''}`,
    );
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `📋 可用技能（${skills.length} 个）：\n\n${lines.join('\n')}`,
      },
    };
  }

  if (cmd.type === 'call') {
    const skill = loader.get(cmd.name);
    if (skill === undefined) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `未知技能: ${cmd.name}。使用 /skill list 查看可用技能。`,
        },
      };
    }
    return {
      handled: false, // 不阻断正常流程，交由 App.tsx 注入后调模型
      skillBody: skill.body,
      skillName: skill.name,
      skillTools: skill.tools,
      runAs: skill.runAs,
      agentRefs: skill.agentRefs,
    };
  }

  // install / search / update 由 executeSkillMarketCommand 处理
  return {
    handled: true,
    message: {
      role: 'assistant',
      content: cmd.type === 'unknown' ? cmd.message : `未知命令: ${cmd.type}`,
    },
  };
}

// ════════════════════════════════════════════════════════════════
// v2.1 M3：技能市场命令（install / search / update）
// ════════════════════════════════════════════════════════════════

/** 注册表条目 schema（与 skills/registry.json 一致）。 */
interface RegistryEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  url: string;
  sha256: string;
}

interface Registry {
  registry: string;
  skills: RegistryEntry[];
}

/** 全局技能安装目录。 */
function globalSkillsDir(): string {
  return path.join(homedir(), '.lumen', 'skills');
}

/** 从注册表 URL fetch 并解析注册表 JSON。 */
async function fetchRegistry(): Promise<Registry | null> {
  try {
    const resp = await fetch(
      'https://raw.githubusercontent.com/lumen/cli/main/skills/registry.json',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as Registry;
  } catch {
    return null;
  }
}

/** fetch SKILL.md 内容并校验 sha256。返回内容或 null（复用共享下载函数，T4.2 抽取）。 */
async function fetchSkill(url: string, expectedSha256: string): Promise<string | null> {
  return fetchVerifiedContent(url, expectedSha256);
}

/** 从已安装的技能文件中解析版本号（简单 YAML frontmatter 解析）。 */
function readInstalledVersion(name: string): string | undefined {
  const file = path.join(globalSkillsDir(), name, 'SKILL.md');
  try {
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/^version:\s*(.+)$/m);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** 比较两个 semver 版本，返回 1（a>b）、-1（a<b）、0（相等）。 */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) {
      return 1;
    }
    if (va < vb) {
      return -1;
    }
  }
  return 0;
}

/**
 * 执行技能市场命令（异步，供 App.tsx 调用）。
 * 返回 SkillCommandResult（handled=true 时 message 为 UI 展示文本）。
 */
export async function executeSkillMarketCommand(
  cmd: SlashSkillCommand,
  loader: SkillLoader,
  cwd: string,
): Promise<SkillCommandResult> {
  // ── /skill install <name> ──
  if (cmd.type === 'install') {
    const reg = await fetchRegistry();
    if (reg === null) {
      return {
        handled: true,
        message: { role: 'assistant', content: '❌ 无法访问技能注册表，请检查网络连接。' },
      };
    }
    const entry = reg.skills.find((s) => s.name === cmd.name);
    if (entry === undefined) {
      const names = reg.skills.map((s) => s.name).join(', ');
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ 注册表中未找到技能: ${cmd.name}。\n\n可用技能: ${names}`,
        },
      };
    }

    // 检查已安装版本
    const installedVer = readInstalledVersion(cmd.name);
    if (installedVer !== undefined && compareVersion(installedVer, entry.version) >= 0) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `📦 技能 ${cmd.name} 已安装（版本 ${installedVer}），注册表版本 ${entry.version} 未更新。`,
        },
      };
    }

    // 下载 + 校验
    const content = await fetchSkill(entry.url, entry.sha256);
    if (content === null) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ 下载技能 ${cmd.name} 失败或 sha256 校验不通过。`,
        },
      };
    }

    // 写入 ~/.lumen/skills/<name>/SKILL.md
    const dir = path.join(globalSkillsDir(), cmd.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');

    // 刷新加载器
    loader.loadAll(cwd);

    const action = installedVer !== undefined ? `从 ${installedVer} 更新到` : '安装';
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `✅ 技能 ${cmd.name} ${action} ${entry.version} 成功！\n\n使用 /skill ${cmd.name} 调用。`,
      },
    };
  }

  // ── /skill search [keyword] ──
  if (cmd.type === 'search') {
    const reg = await fetchRegistry();
    if (reg === null) {
      return {
        handled: true,
        message: { role: 'assistant', content: '❌ 无法访问技能注册表，请检查网络连接。' },
      };
    }
    const kw = cmd.keyword?.toLowerCase();
    const matched = kw
      ? reg.skills.filter(
          (s) => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw),
        )
      : reg.skills;
    if (matched.length === 0) {
      return {
        handled: true,
        message: { role: 'assistant', content: `🔍 未找到匹配 "${kw ?? ''}" 的技能。` },
      };
    }
    const lines = matched.map((s) => {
      const installed = readInstalledVersion(s.name);
      const status = installed !== undefined ? ` [已安装 ${installed}]` : '';
      return `- **${s.name}** ${s.version} — ${s.description}${status}`;
    });
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `🔍 技能市场（${matched.length} 个）：\n\n${lines.join('\n')}\n\n使用 /skill install <name> 安装。`,
      },
    };
  }

  // ── /skill update [name] ──
  if (cmd.type === 'update') {
    const reg = await fetchRegistry();
    if (reg === null) {
      return {
        handled: true,
        message: { role: 'assistant', content: '❌ 无法访问技能注册表，请检查网络连接。' },
      };
    }

    // 确定更新范围
    const targets = cmd.name
      ? reg.skills.filter((s) => s.name === cmd.name)
      : reg.skills.filter((s) => {
          const iv = readInstalledVersion(s.name);
          return iv !== undefined && compareVersion(s.version, iv) > 0;
        });

    if (targets.length === 0) {
      return {
        handled: true,
        message: { role: 'assistant', content: '✅ 所有技能已是最新版本。' },
      };
    }

    const results: string[] = [];
    for (const entry of targets) {
      const content = await fetchSkill(entry.url, entry.sha256);
      if (content === null) {
        results.push(`❌ ${entry.name}: 下载失败或校验不通过`);
        continue;
      }
      const dir = path.join(globalSkillsDir(), entry.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
      results.push(`✅ ${entry.name}: 更新到 ${entry.version}`);
    }

    loader.loadAll(cwd);
    return {
      handled: true,
      message: { role: 'assistant', content: `📦 更新完成：\n\n${results.join('\n')}` },
    };
  }

  return { handled: true, message: { role: 'assistant', content: '未知技能市场命令。' } };
}
