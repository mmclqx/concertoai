/**
 * Agent 斜杠命令处理器：/agent。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 *
 * v3.0 M4 / T4.3：
 * - /agent list：列出内置 Agent（随 ConcertoAI 分发）+ 已安装外部 Agent；
 * - /agent install <name>：调用 AgentInstaller 从市场安装（下载 → sha256 校验
 *   → 接口合规检查 → 写入 ~/.concertoai/agents/<name>/ → 刷新 AgentRegistry）；
 * - /agent remove <name>：卸载已安装外部 Agent（内置 Agent 拒绝卸载）；
 * - /agent promote <skill>：将技能一键升级为 Agent（脚手架 + 接口声明，T4.4）。
 *
 * 命令形态与 /skill（src/cli/slash/skill.ts）保持一致：parse + execute 双层结构，
 * 网络/磁盘操作走异步 executeAgentMarketCommand。
 */

import type { AgentRegistry } from '../../agents';
import type { ChatMessage } from '../../loop/types';
import {
  type AgentRegistryItem,
  BUILTIN_AGENT_ITEMS,
  compareVersion,
  fetchMarketRegistry,
  type InstalledAgent,
  type InstallResult,
  type MarketRegistry,
  promoteSkill,
} from '../../market';
import type { SkillLoader } from '../../skill/loader';

// ── 命令解析 ──

export type SlashAgentCommand =
  | { type: 'list' }
  | { type: 'install'; name: string }
  | { type: 'remove'; name: string }
  | { type: 'promote'; skillName: string }
  | { type: 'update'; name?: string }
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

  if (trimmed.startsWith('/agent promote ')) {
    return { type: 'promote', skillName: trimmed.slice('/agent promote '.length).trim() };
  }

  // v3.1 M5 / T5.4：/agent update [name]（复用 installer.install 的 update 语义）
  if (trimmed.startsWith('/agent update')) {
    const name = trimmed.slice('/agent update'.length).trim();
    return { type: 'update', name: name || undefined };
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
        message: '用法: /agent promote <skill> — 将技能升级为 Agent',
      };
    }
    if (rest === 'update') {
      return {
        type: 'unknown',
        message: '用法: /agent update [name] — 检查并更新已安装 Agent',
      };
    }
    if (rest === 'list') {
      return { type: 'list' };
    }
    return {
      type: 'unknown',
      message: `未知子命令: ${rest}。可用: /agent list | install <name> | remove <name> | promote <skill> | update [name]`,
    };
  }

  return null;
}

// ── 命令执行依赖 ──

/**
 * 命令层依赖的窄接口（接口优先 §3.1，根治「测试绑定具体类」反复失败）。
 *
 * 只暴露 /agent 命令需要的方法；AgentInstaller（T4.2）结构兼容本接口
 * （install(name) 可选第二参数不影响），chat.tsx 无需改动即可注入。
 * 命令层不依赖具体类的内部注入细节（registry/fetch*），测试用 stub
 * 精确控制返回值，聚焦命令逻辑本身（T4.3 测试重写为 stub 风格）。
 */
export interface AgentManager {
  /** 安装 Agent（返回 InstallResult：ok=true 成功 / ok=false 失败码 + 中文消息）。 */
  install(name: string): Promise<InstallResult>;
  /** 卸载已安装 Agent（返回是否成功；内置 Agent 由命令层拒绝，不触达此处）。 */
  remove(name: string): boolean;
  /** 列出已安装外部 Agent（按名称字典序）。 */
  listInstalled(): InstalledAgent[];
}

export interface AgentCommandDeps {
  /** Agent 管理器（install/remove/listInstalled；AgentInstaller 结构兼容）。 */
  installer: AgentManager;
  /** Agent 注册表（install 成功后刷新 / remove 时注销，T4.4 promote 复用）。 */
  registry: AgentRegistry;
  /** 内置 Agent 市场条目（可注入；默认 BUILTIN_AGENT_ITEMS，测试可 mock）。 */
  builtinItems?: AgentRegistryItem[];
  /** 技能加载器（T4.4 promote 读取技能；App.tsx 传入共享 SkillLoader 实例）。 */
  loader?: SkillLoader;
  /** Agent 安装目录（T4.4 promote 写入；默认 ~/.concertoai/agents/，测试可注入）。 */
  installDir?: string;
  /** 注册表获取（v3.1 M5 / T5.4 /agent update 无参列出可更新；测试可注入）。 */
  fetchRegistry?: (url?: string) => Promise<MarketRegistry | null>;
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
          content: `❌ ${cmd.name} 是内置 Agent，已随 ConcertoAI 分发，不可卸载。`,
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

  // ── v3.1 M5 / T5.4：/agent update [name] ──
  if (cmd.type === 'update') {
    // 指定名称：复用 installer.install 的 update 语义（版本落后覆盖 / 已最新 ALREADY_INSTALLED）
    if (cmd.name !== undefined) {
      const result = await deps.installer.install(cmd.name);
      if (result.ok) {
        return {
          handled: true,
          message: {
            role: 'assistant',
            content: `✅ Agent ${result.name} 已更新到 ${result.version}（${result.action}）。`,
          },
        };
      }
      if (result.code === 'ALREADY_INSTALLED') {
        return {
          handled: true,
          message: {
            role: 'assistant',
            content: `✅ Agent ${cmd.name} 已是最新版本，无需更新。`,
          },
        };
      }
      return {
        handled: true,
        message: { role: 'assistant', content: `❌ ${result.message}` },
      };
    }

    // 无参数：列出所有可更新 Agent
    const registry = await (deps.fetchRegistry ?? fetchMarketRegistry)();
    if (registry === null) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: '❌ 无法访问 Agent 注册表，请检查网络连接。',
        },
      };
    }
    const installed = deps.installer.listInstalled();
    const updatable = installed
      .map((a) => {
        const item = registry.agents.find((x) => x.name === a.name);
        return item !== undefined && compareVersion(item.version, a.version) > 0
          ? { name: a.name, from: a.version, to: item.version }
          : undefined;
      })
      .filter((x): x is { name: string; from: string; to: string } => x !== undefined);

    if (updatable.length === 0) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: '✅ 所有已安装 Agent 均是最新版本。',
        },
      };
    }
    const lines = updatable.map((u) => `- **${u.name}** ${u.from} → ${u.to}`);
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `📦 可更新 Agent（${updatable.length} 个）：\n\n${lines.join('\n')}\n\n使用 /agent update <name> 更新。`,
      },
    };
  }

  // ── /agent promote <skill> ──
  if (cmd.type === 'promote') {
    if (deps.loader === undefined) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: '❌ 技能加载器不可用，无法执行 promote（请通过对话启动 ConcertoAI）。',
        },
      };
    }
    // 每次执行前刷新技能列表，支持运行时新增技能
    deps.loader.loadAll(process.cwd());
    const result = promoteSkill({
      skillName: cmd.skillName,
      loader: deps.loader,
      registry: deps.registry,
      installDir: deps.installDir,
    });
    if (result.ok) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `✅ 技能 ${result.name} 已升级为 Agent（版本 ${result.version}）！\n\n生成位置：${result.dir}\n使用 /agent list 查看，原技能仍保留（/skill ${result.name} 可继续调用）。`,
        },
      };
    }
    return {
      handled: true,
      message: { role: 'assistant', content: `❌ ${result.message}` },
    };
  }

  return { handled: false };
}

// ── 列表格式化 ──────────────────────────────────────────────

/** 组装 /agent list 展示文本：内置 Agent（随 ConcertoAI 分发）+ 已安装外部 Agent。 */
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
    '提示：内置 Agent 随 ConcertoAI 分发；外部 Agent 经市场安装，权限 fail-closed（未声明工具一律拒绝）。',
  );
  return sections.join('\n\n');
}

/** 格式化单个已安装 Agent 条目（含权限摘要与安装时间）。 */
function formatInstalledLine(a: InstalledAgent): string {
  const perms = a.def.permissions.map((p) => p.tool).join(', ');
  const time = new Date(a.installedAt).toLocaleString('zh-CN');
  return `- **${a.name}** ${a.version} — [权限: ${perms}]（安装于 ${time}）`;
}
