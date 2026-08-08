/**
 * 技能斜杠命令处理器：/skill。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 */

import type { ChatMessage } from '../../loop/types';
import type { SkillLoader } from '../../skill/loader';

// ── 命令解析 ──

export type SlashSkillCommand =
  | { type: 'list' }
  | { type: 'call'; name: string; args: string }
  | { type: 'unknown'; message: string };

/** 解析用户输入，识别技能命令。 */
export function parseSkillCommand(input: string): SlashSkillCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/skill' || trimmed === '/skill list') {
    return { type: 'list' };
  }

  if (trimmed.startsWith('/skill ')) {
    const rest = trimmed.slice('/skill '.length).trim();
    if (rest === '' || rest === 'list') {
      return { type: 'list' };
    }
    // 解析技能名和可选参数
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
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
    };
  }

  return {
    handled: true,
    message: {
      role: 'assistant',
      content: cmd.message,
    },
  };
}
