/**
 * MCP 真实服务连接冒烟脚本。
 *
 * 读取 ~/.lumen/config.json 中的 mcpServers 配置，用 Lumen 自研 MCP 客户端
 * （McpManager / McpClient）连接真实 MCP 服务：
 *   1. 并发连接所有配置的服务；
 *   2. 发现各服务工具列表；
 *   3. 对每个服务调用一个只读探针工具验证调用链路；
 *   4. 断开连接。
 *
 * 运行：npx tsx scripts/smoke-mcp.ts
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { toMcpServerConfig } from '../src/mcp/builtin-servers';
import { McpManager } from '../src/mcp/manager';
import type { MCPServerConfig } from '../src/mcp/types';

/** 各服务的只读探针工具（避免写入污染外部数据）。 */
const PROBES: Record<string, { tool: string; args: Record<string, unknown> }> = {
  filesystem: { tool: 'list_allowed_directories', args: {} },
  memory: { tool: 'search_nodes', args: { query: 'lumen' } },
  github: { tool: 'list_repositories', args: {} },
};

async function main(): Promise<void> {
  const configPath = join(homedir(), '.lumen', 'config.json');
  let raw: { mcpServers?: unknown };
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers?: unknown };
  } catch (error) {
    console.error(
      `无法读取配置文件 ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const entries = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
  if (entries.length === 0) {
    console.error('配置文件中未声明任何 mcpServers，请先在 ~/.lumen/config.json 配置。');
    process.exit(1);
  }

  const configs: MCPServerConfig[] = entries.map(toMcpServerConfig);
  console.log(`读取到 ${configs.length} 个 MCP 服务配置：${configs.map((c) => c.name).join(', ')}\n`);

  const manager = new McpManager(configs);
  const statuses = await manager.start();
  for (const s of statuses) {
    console.log(
      `[${s.name}] connected=${s.connected} tools=${s.toolCount}` +
        (s.error !== undefined ? ` error=${s.error}` : ''),
    );
  }

  console.log('\n— 工具发现 —');
  const tools = manager.listTools();
  for (const t of tools) {
    console.log(`  ${t.name}`);
  }

  console.log('\n— 工具调用探针（只读） —');
  for (const s of statuses) {
    if (!s.connected) {
      console.log(`  [${s.name}] 未连接，跳过探针`);
      continue;
    }
    const probe = PROBES[s.name];
    if (probe === undefined) {
      console.log(`  [${s.name}] 无探针定义，仅验证连接`);
      continue;
    }
    const prefixed = `${s.name}/${probe.tool}`;
    const result = await manager.callTool(prefixed, probe.args);
    if (result.ok) {
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      console.log(`  [${s.name}/${probe.tool}] OK → ${text.slice(0, 120)}`);
    } else {
      console.log(`  [${s.name}/${probe.tool}] FAIL → ${result.error}`);
    }
  }

  console.log('\n— 断开连接 —');
  manager.disconnect();
  console.log('完成。');
}

main().catch((error: unknown) => {
  console.error('冒烟失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
