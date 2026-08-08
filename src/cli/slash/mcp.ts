/**
 * MCP 管理斜杠命令处理器：/mcp。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 */

import type { ChatMessage } from '../../loop/types';
import type { McpManager } from '../../mcp/manager';

// ── 命令解析 ──

export type SlashMcpCommand =
  | { type: 'status' }
  | { type: 'connect'; name: string }
  | { type: 'disconnect'; name: string }
  | { type: 'unknown'; message: string };

/** 解析 /mcp 命令。 */
export function parseMcpCommand(input: string): SlashMcpCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/mcp' || trimmed === '/mcp status') {
    return { type: 'status' };
  }

  if (trimmed.startsWith('/mcp connect ')) {
    const name = trimmed.slice('/mcp connect '.length).trim();
    if (name === '') {
      return { type: 'unknown', message: '用法: /mcp connect <服务名>' };
    }
    return { type: 'connect', name };
  }

  if (trimmed.startsWith('/mcp disconnect ')) {
    const name = trimmed.slice('/mcp disconnect '.length).trim();
    if (name === '') {
      return { type: 'unknown', message: '用法: /mcp disconnect <服务名>' };
    }
    return { type: 'disconnect', name };
  }

  if (trimmed.startsWith('/mcp ')) {
    return {
      type: 'unknown',
      message: '可用命令: /mcp status | /mcp connect <name> | /mcp disconnect <name>',
    };
  }

  return null;
}

// ── 命令执行 ──

export interface McpCommandResult {
  /** 已处理（true = 不调模型）。 */
  handled: boolean;
  /** UI 展示消息。 */
  message?: ChatMessage;
}

/** 执行 /mcp 命令。 */
export async function executeMcpCommand(
  cmd: SlashMcpCommand,
  manager: McpManager,
): Promise<McpCommandResult> {
  if (cmd.type === 'status') {
    const all = manager.statusAll();
    if (all.length === 0) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content:
            '📡 未配置 MCP 服务。\n\n在 `~/.lumen/config.json` 的 `mcpServers` 中添加服务即可。',
        },
      };
    }
    const lines = all.map((s) => {
      const icon = s.connected ? '✅' : '❌';
      const extra = s.connected ? `${s.toolCount} 个工具` : (s.error ?? '未连接');
      return `${icon} **${s.name}** — \`${s.command}\` — ${extra}`;
    });
    const connected = all.filter((s) => s.connected).length;
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `📡 MCP 服务状态（${connected}/${all.length} 已连接）：\n\n${lines.join('\n')}`,
      },
    };
  }

  if (cmd.type === 'connect') {
    const status = await manager.connect(cmd.name);
    if (status.connected) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `✅ MCP 服务已连接: **${status.name}**（${status.toolCount} 个工具）\n\`${status.command}\``,
        },
      };
    }
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `❌ MCP 服务连接失败: **${status.name}**\n${status.error ?? '未知错误'}`,
      },
    };
  }

  if (cmd.type === 'disconnect') {
    const status = manager.disconnectServer(cmd.name);
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `🔌 MCP 服务已断开: **${status.name}**`,
      },
    };
  }

  return {
    handled: true,
    message: { role: 'assistant', content: cmd.message },
  };
}
