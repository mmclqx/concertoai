#!/usr/bin/env node
/**
 * Mock MCP 服务 —— 可独立运行的测试用 MCP 协议实现。
 *
 * 用法（测试中由 McpClient spawn）：
 *   node tests/mcp/mock-server.ts
 *
 * 通过 stdin/stdout 提供 JSON-RPC 2.0 协议，支持：
 * - initialize
 * - tools/list
 * - tools/call（预置 echo / fail / slow 三种工具）
 */

import { createInterface } from 'node:readline';

// ── 预置工具列表 ──

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入参数',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: '要回显的消息' },
      },
      required: ['message'],
    },
  },
  {
    name: 'fail',
    description: '始终返回错误',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'slow',
    description: '延迟返回（模拟耗时操作）',
    inputSchema: {
      type: 'object' as const,
      properties: {
        delayMs: { type: 'number', description: '延迟毫秒数' },
      },
    },
  },
];

const SERVER_INFO = {
  name: 'mock-mcp-server',
  version: '1.0.0-test',
};

// ── 消息处理 ──

function sendResponse(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id: number, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handleRequest(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<void> {
  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const callParams = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = callParams?.name;
      const args = callParams?.arguments ?? {};

      if (toolName === 'echo') {
        const msg = (args as { message?: string }).message ?? '';
        sendResponse(id, {
          content: [{ type: 'text', text: `echo: ${msg}` }],
        });
      } else if (toolName === 'fail') {
        sendResponse(id, {
          content: [{ type: 'text', text: '工具执行失败' }],
          isError: true,
        });
      } else if (toolName === 'slow') {
        const delay = Math.min((args as { delayMs?: number }).delayMs ?? 100, 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        sendResponse(id, {
          content: [{ type: 'text', text: `延迟 ${delay}ms 后返回` }],
        });
      } else {
        sendError(id, -32601, `未知工具: ${toolName ?? '(空)'}`);
      }
      break;
    }

    // 模拟特殊行为：exit 方法退出进程
    case 'exit':
      sendResponse(id, { ok: true });
      process.exit(0);
      break;

    default:
      sendError(id, -32601, `未知方法: ${method}`);
  }
}

// ── 主循环 ──

const rl = createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (trimmed === '') {
    return;
  }
  try {
    const msg = JSON.parse(trimmed) as {
      jsonrpc: string;
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    // 仅处理请求（有 id）
    if (msg.id !== undefined && msg.id !== null) {
      void handleRequest(msg.id, msg.method, msg.params);
    }
    // 通知消息（无 id）忽略：initialized 等
  } catch {
    // 解析失败静默忽略（测试中不应发生）
  }
});

// 进程异常退出时输出到 stderr 供调试
process.on('uncaughtException', (err) => {
  console.error(`[mock-server] uncaught: ${err.message}`);
  process.exit(1);
});
