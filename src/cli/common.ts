/**
 * CLI 命令共享的轻量工具（v2.1 性能优化）。
 *
 * run / plan 命令只依赖这里的纯函数与常量，从本模块导入即可，
 * 无需加载 chat.tsx 的完整 TUI 依赖树（ink/react/ui/mcp/skill），
 * 显著降低 `concertoai run` / `concertoai plan` 的启动成本。
 */

import os from 'node:os';
import { getDefaultModel, getModel, listModels } from '../model/models';
import type { MCPServerEntry } from '../store/config';
import { ProjectRegistry } from '../store/projects';
import { editFileTool } from '../tools/edit';
import { listDirectoryTool, readFileTool, searchContentTool } from '../tools/read';
import type { ToolSpec } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { shellTool } from '../tools/shell';

/** 免审批直跑的安全命令白名单（用户可后续配置化）。 */
export const DEFAULT_ALLOWLIST = ['git status', 'git diff', 'npm test', 'npm run test'];

/** 构建操作系统信息提示，注入 system prompt 使模型自动适配命令。 */
export function buildOsHint(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'win32') {
    return `## 运行环境\n操作系统: Windows ${arch}\n终端: cmd.exe / PowerShell\n\n> ⚠️ 命令适配：请使用 Windows 兼容的命令。不支持 pwd/ls/cat/grep 等 UNIX 命令。替代方案：cd/dir/type/findstr。获取当前目录请用 \`node -e "console.log(process.cwd())"\`。`;
  }
  if (platform === 'darwin') {
    return `## 运行环境\n操作系统: macOS ${arch}\n终端: zsh/bash`;
  }
  return `## 运行环境\n操作系统: Linux ${arch}\n终端: bash`;
}

export function resolveModel(modelId: string | undefined): string {
  if (modelId === undefined) {
    return getDefaultModel().id;
  }
  const profile = getModel(modelId);
  if (profile === undefined) {
    console.error(
      `未知模型: ${modelId}（可用: ${listModels()
        .map((m) => m.id)
        .join(', ')}）`,
    );
    process.exit(1);
  }
  return profile.id;
}

/** 项目上下文（T2.3）：按 cwd 精确匹配已注册项目。 */
export interface ResolvedProject {
  name: string;
  path: string;
  whitelist: string[] | undefined;
  mcpServers: MCPServerEntry[] | undefined;
}

/**
 * 按 cwd 精确探测已注册项目（T2.3/T2.4 隔离矩阵基础）。
 * 未匹配返回 undefined（使用默认全局配置）。注册表损坏时宽松降级为 undefined。
 * @param cwd 当前工作目录（已含 -p chdir 后的项目路径）
 * @param registryFile 注册表文件路径（测试注入；缺省 ~/.concertoai/projects.json）
 */
export async function resolveProjectForCwd(
  cwd: string,
  registryFile?: string,
): Promise<ResolvedProject | undefined> {
  const registry = await ProjectRegistry.load(registryFile);
  const hit = registry.findByPath(cwd);
  if (hit === undefined) {
    return undefined;
  }
  return {
    name: hit.name,
    path: hit.entry.path,
    whitelist: hit.entry.whitelist,
    mcpServers: hit.entry.mcpServers,
  };
}

/**
 * 合并全局白名单与项目级白名单（T2.3）。
 * 去重合并：项目白名单追加到全局后面，保持全局前缀 + 项目追加的顺序。
 */
export function mergeAllowlist(
  globalAllowlist: string[] | undefined,
  projectWhitelist: string[] | undefined,
): string[] {
  const merged = [...(globalAllowlist ?? [])];
  if (projectWhitelist !== undefined) {
    for (const prefix of projectWhitelist) {
      if (!merged.includes(prefix)) {
        merged.push(prefix);
      }
    }
  }
  return merged;
}

export function buildRegistry(
  mcpTools?: ToolSpec[],
  spawnTool?: ToolSpec,
  knowledgeTools?: ToolSpec[],
): ToolRegistry {
  const registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(searchContentTool)
    .register(editFileTool)
    .register(shellTool);
  if (spawnTool !== undefined) {
    registry.register(spawnTool);
  }
  if (mcpTools !== undefined) {
    for (const tool of mcpTools) {
      registry.register(tool);
    }
  }
  if (knowledgeTools !== undefined) {
    for (const tool of knowledgeTools) {
      registry.register(tool);
    }
  }
  return registry;
}
