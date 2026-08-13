/**
 * 技能斜杠命令处理器：/skill。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 *
 * v2.1 M3：新增 /skill install / search / update 命令（技能市场）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../loop/types';
import { fetchVerifiedContent } from '../../market/download';
import {
  compareSkillVersion,
  fetchSkillRegistry,
  installSkillFromRegistry,
  readInstalledSkillVersion,
} from '../../skill/installer';
import type { SkillLoader } from '../../skill/loader';
import type { AgentRef } from '../../skill/types';
import { globalSkillsDir } from '../../store/paths';

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
            '📋 暂无可用技能。\n\n将 SKILL.md 放入 `.concertoai/skills/<name>/` 目录即可注册新技能。',
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
// v4.0 M4 T4.3：安装逻辑抽取至 src/skill/installer.ts（installSkillFromRegistry），
// 供 /skill install 与 market/installer.ts installByType 复用（单一来源）。
// search/update 复用 installer 的 fetchSkillRegistry / readInstalledSkillVersion / compareSkillVersion。

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
  // v4.0 M4 T4.3：复用 skill/installer.ts（注册表匹配 → 版本比较 → 下载+sha256 → 写入）
  if (cmd.type === 'install') {
    const result = await installSkillFromRegistry(cmd.name);
    // 刷新加载器（安装/更新后立即可用）
    loader.loadAll(cwd);
    if (!result.ok) {
      const content =
        result.code === 'ALREADY_INSTALLED' ? `📦 ${result.message}` : `❌ ${result.message}`;
      return { handled: true, message: { role: 'assistant', content } };
    }
    const action = result.action === 'update' ? `更新到` : '安装';
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `✅ 技能 ${result.name} ${action} ${result.version} 成功！\n\n使用 /skill ${result.name} 调用。`,
      },
    };
  }

  // ── /skill search [keyword] ──
  if (cmd.type === 'search') {
    const reg = await fetchSkillRegistry();
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
      const installed = readInstalledSkillVersion(s.name);
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
    const reg = await fetchSkillRegistry();
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
          const iv = readInstalledSkillVersion(s.name);
          return iv !== undefined && compareSkillVersion(s.version, iv) > 0;
        });

    if (targets.length === 0) {
      return {
        handled: true,
        message: { role: 'assistant', content: '✅ 所有技能已是最新版本。' },
      };
    }

    const results: string[] = [];
    for (const entry of targets) {
      const content = await fetchVerifiedContent(entry.url, entry.sha256);
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
