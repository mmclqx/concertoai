/**
 * Agent 斜杠命令处理器：/agent。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 *
 * v3.0 M4 / T4.3：
 * - /agent list：列出内置 Agent（随 Lumen 分发）+ 已安装外部 Agent；
 * - /agent install <name>：调用 AgentInstaller 从市场安装（下载 → sha256 校验
 *   → 接口合规检查 → 写入 ~/.lumen/agents/<name>/ → 刷新 AgentRegistry）；
 * - /agent remove <name>：卸载已安装外部 Agent（内置 Agent 拒绝卸载）。
 *
 * T4.4 将新增 /agent promote <skill>（技能一键升级为 Agent，见 src/market/promote.ts）。
 * 命令形态与 /skill（src/cli/slash/skill.ts）保持一致：parse + execute 双层结构，
 * 网络/磁盘操作走异步 executeAgentMarketCommand。
 */

import type { AgentRegistry } from '../../agents';
import type { ChatMessage } from '../../loop/types';
import {
  type AgentInstaller,
  type AgentRegistryItem,
  BUILTIN_AGENT_ITEMS,
  type InstalledAgent,
} from '../../market';

// ── 命令解析 ──

export type SlashAgentCommand =
  | { type: 'list' }
  | { type: 'install'; name: string }
  | { type: 'remove'; name: string }
  | { type: 'unknown'; message: string };

/** 解析用户输入，识别 Agent 管理命令。 */
export function parseAgentCommand(input: string): SlashAgentCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/agent' || trimmed === '/agent list') {
    return { type: 'list' };
  }

  if (trimmed.startsWith('/agent install ')) {
    return { type: 'install', name: trimmed.slice('/agent install '.length).trim() };
  }

  if (trimmed.startsWith('/agent remove ')) {
    return { type: 'remove', name: trimmed.slice('/agent remove '.length).trim() };
  }

  if (trimmed.startsWith('/agent ')) {
    const rest = trimmed.slice('/agent '.length).trim();
    if (rest === 'install') {
      return { type: 'unknown', message: '用法: /agent install <name> — 从市场安装 Agent' };
    }
    if (rest === 'remove') {
      return { type: 'unknown', message: '用法: /agent remove <name> — 卸载已安装 Agent' };
    }
    if (rest === 'promote') {
      return {
        type: 'unknown',
        message: '用法: /agent promote <skill> — 将技能升级为 Agent（开发中）',
      };
    }
    if (rest === 'list') {
      return { type: 'list' };
    }
    return {
      type: 'unknown',
      message: `未知子命令: ${rest}。可用: /agent list | install <name> | remove <name>`,
    };
  }

  return null;
}

// ── 命令执行依赖 ──

export interface AgentCommandDeps {
  /** Agent 安装器（install/remove/listInstalled）。 */
  installer: AgentInstaller;
  /** Agent 注册表（install 成功后刷新 / remove 时注销，T4.4 promote 复用）。 */
  registry: AgentRegistry;
  /** 内置 Agent 市场条目（可注入；默认 BUILTIN_AGENT_ITEMS，测试可 mock）。 */
  builtinItems?: AgentRegistryItem[];
}

export interface AgentCommandResult {
  /** 是否已处理（true = 命令已被处理，不应再调模型）。 */
  handled: boolean;
  /** UI 展示消息（null = 不显示额外消息）。 */
  message?: ChatMessage;
}

// ── 同步命令执行（list）─────────────────────────────────────

/**
 * 执行 Agent 命令（同步部分：list / unknown）。
 * install / remove 为异步磁盘/网络操作，走 executeAgentMarketCommand。
 */
export function executeAgentCommand(
  cmd: SlashAgentCommand,
  deps: AgentCommandDeps,
): AgentCommandResult {
  if (cmd.type === 'list') {
    return {
      handled: true,
      message: { role: 'assistant', content: formatAgentList(deps) },
    };
  }

  if (cmd.type === 'unknown') {
    return { handled: true, message: { role: 'assistant', content: cmd.message } };
  }

  return { handled: false };
}

// ── 异步命令执行（install / remove）─────────────────────────

/**
 * 执行 Agent 市场命令（异步：install / remove）。
 *
 * install 复用 AgentInstaller（T4.2）：注册表匹配 → 下载 → sha256 校验 →
 * 接口合规检查 → 写入本地 → 刷新 AgentRegistry；失败按 InstallFailureCode
 * 给出中文错误（与技能市场错误文案风格一致）。
 */
export async function executeAgentMarketCommand(
  cmd: SlashAgentCommand,
  deps: AgentCommandDeps,
): Promise<AgentCommandResult> {
  // ── /agent install <name> ──
  if (cmd.type === 'install') {
    const result = await deps.installer.install(cmd.name);
    if (result.ok) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `✅ Agent ${result.name} 安装成功（版本 ${result.version}）！\n\n使用 /agent list 查看，/agent remove ${result.name} 可卸载。`,
        },
      };
    }
    return {
      handled: true,
      message: { role: 'assistant', content: `❌ ${result.message}` },
    };
  }

  // ── /agent remove <name> ──
  if (cmd.type === 'remove') {
    const builtin = deps.builtinItems ?? BUILTIN_AGENT_ITEMS;
    if (builtin.some((b) => b.name === cmd.name)) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ ${cmd.name} 是内置 Agent，已随 Lumen 分发，不可卸载。`,
        },
      };
    }
    const removed = deps.installer.remove(cmd.name);
    if (!removed) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ Agent ${cmd.name} 未安装（使用 /agent list 查看已安装 Agent）。`,
        },
      };
    }
    if (deps.registry.has(cmd.name)) {
      deps.registry.unregister(cmd.name);
    }
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `🗑️ Agent ${cmd.name} 已卸载。`,
      },
    };
  }

  return { handled: false };
}

// ── 列表格式化 ──────────────────────────────────────────────

/** 组装 /agent list 展示文本：内置 Agent（随 Lumen 分发）+ 已安装外部 Agent。 */
export function formatAgentList(deps: AgentCommandDeps): string {
  const builtin = deps.builtinItems ?? BUILTIN_AGENT_ITEMS;
  const installed = deps.installer.listInstalled();

  const builtinLines = builtin.map((b) => {
    const perms = b.permissions.map((p) => p.tool).join(', ');
    return `- **${b.name}** ${b.version} — ${b.description} [权限: ${perms}]`;
  });

  const sections: string[] = [
    `📋 Agent 团队（内置 ${builtin.length} 个）：\n\n${builtinLines.join('\n')}`,
  ];

  if (installed.length > 0) {
    const installedLines = installed.map((a) => formatInstalledLine(a));
    sections.push(
      `📦 已安装外部 Agent（${installed.length} 个）：\n\n${installedLines.join('\n')}`,
    );
  } else {
    sections.push('📦 已安装外部 Agent：无（使用 /agent install <name> 从市场安装）');
  }

  sections.push(
    '提示：内置 Agent 随 Lumen 分发；外部 Agent 经市场安装，权限 fail-closed（未声明工具一律拒绝）。',
  );
  return sections.join('\n\n');
}

/** 格式化单个已安装 Agent 条目（含权限摘要与安装时间）。 */
function formatInstalledLine(a: InstalledAgent): string {
  const perms = a.def.permissions.map((p) => p.tool).join(', ');
  const time = new Date(a.installedAt).toLocaleString('zh-CN');
  return `- **${a.name}** ${a.version} — [权限: ${perms}]（安装于 ${time}）`;
}
