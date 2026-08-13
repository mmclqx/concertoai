/**
 * 插件斜杠命令处理器：/plugin（v4.0 M4 T4.5，chat 内可用）。
 *
 * - /plugin                     列出已安装插件（等价 /plugin list）
 * - /plugin list                列出已安装插件
 * - /plugin install <name>      安装（复用 PluginInstaller：注册表 → 下载 → sha256 → 权限清单 → 写入）
 * - /plugin search [keyword]    模糊搜索市场
 * - /plugin remove <name>       卸载
 * - /plugin browse [category]   分类浏览（下载量 + 评分）
 * - /plugin recommend           基于项目特征推荐
 * - /plugin popular             热门 Top 10
 *
 * chat 内 /plugin install 视为用户显式授权（等同 CLI --yes），权限清单在结果中展示；
 * 敏感权限运行时仍由 PermissionEnforcer fail-closed 拦截 + 审计（T4.2）。
 */

import { fmt, t } from '../../i18n';
import type { ChatMessage } from '../../loop/types';
import { fetchMarketRegistry, searchPluginItems } from '../../market/registry';
import { PluginInstaller } from '../../plugin/installer';
import { formatPermissionList } from '../../plugin/permissions';
import { formatPluginLine, type PluginCliOptions } from '../plugin';

// ── 命令解析 ──────────────────────────────────────────────────

export type SlashPluginCommand =
  | { type: 'list' }
  | { type: 'install'; name: string }
  | { type: 'search'; keyword?: string }
  | { type: 'remove'; name: string }
  | { type: 'browse'; category?: string }
  | { type: 'recommend' }
  | { type: 'popular' }
  | { type: 'unknown'; message: string };

/** 解析 /plugin 命令；非 /plugin 返回 null。 */
export function parsePluginCommand(input: string): SlashPluginCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/plugin' || trimmed === '/plugin list') {
    return { type: 'list' };
  }
  if (trimmed.startsWith('/plugin install ')) {
    return { type: 'install', name: trimmed.slice('/plugin install '.length).trim() };
  }
  if (trimmed.startsWith('/plugin search')) {
    const keyword = trimmed.slice('/plugin search'.length).trim();
    return { type: 'search', keyword: keyword || undefined };
  }
  if (trimmed.startsWith('/plugin remove ')) {
    return { type: 'remove', name: trimmed.slice('/plugin remove '.length).trim() };
  }
  if (trimmed.startsWith('/plugin browse')) {
    const category = trimmed.slice('/plugin browse'.length).trim();
    return { type: 'browse', category: category || undefined };
  }
  if (trimmed === '/plugin recommend') {
    return { type: 'recommend' };
  }
  if (trimmed === '/plugin popular') {
    return { type: 'popular' };
  }
  if (trimmed.startsWith('/plugin')) {
    return {
      type: 'unknown',
      message:
        '用法: /plugin list | install <name> | search [keyword] | remove <name> | browse [category] | recommend | popular',
    };
  }
  return null;
}

// ── 执行 ──────────────────────────────────────────────────────

export interface PluginSlashOptions extends PluginCliOptions {
  /** 安装目录（缺省 ~/.concertoai/plugins/，测试可注入）。 */
  installDir?: string;
}

/** 执行 /plugin 命令，返回聊天消息。 */
export async function runPluginSlash(
  cmd: SlashPluginCommand,
  options: PluginSlashOptions,
): Promise<{ handled: boolean; message: ChatMessage }> {
  const d = t().plugin;
  const { cwd, fetchRegistry, installDir } = options;

  if (cmd.type === 'unknown') {
    return { handled: true, message: { role: 'assistant', content: cmd.message } };
  }

  // 注册表获取（测试可注入；默认网络）
  const registry =
    fetchRegistry !== undefined ? await fetchRegistry() : await fetchMarketRegistry();
  if (
    registry === null &&
    (cmd.type === 'install' ||
      cmd.type === 'search' ||
      cmd.type === 'browse' ||
      cmd.type === 'recommend' ||
      cmd.type === 'popular')
  ) {
    return {
      handled: true,
      message: { role: 'assistant', content: '❌ 无法访问插件注册表，请检查网络连接。' },
    };
  }

  const installer = new PluginInstaller({ installDir });

  if (cmd.type === 'list') {
    const installed = installer.listInstalled();
    if (installed.length === 0) {
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `📋 ${d.listEmpty}\n  ${d.listHint}\n\n可用 \`/plugin browse\` 浏览市场。`,
        },
      };
    }
    const lines = installed.map((p) => {
      const perms = p.permissions.length === 0 ? '（只读）' : `[${p.permissions.length} 项权限]`;
      return `- **${p.name}** ${p.version} — ${p.description} ${perms}`;
    });
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `📋 ${fmt(d.listHeader, { count: String(installed.length) })}\n\n${lines.join('\n')}`,
      },
    };
  }

  if (cmd.type === 'install') {
    if (cmd.name === '') {
      return {
        handled: true,
        message: { role: 'assistant', content: `❌ ${d.installMissing}` },
      };
    }
    // chat 内显式 /plugin install = 授权安装；权限清单在结果中展示
    const result = await installer.install(cmd.name, registry);
    if (!result.ok) {
      if (result.code === 'CANCELED' || result.code === 'ALREADY_INSTALLED') {
        return { handled: true, message: { role: 'assistant', content: `📦 ${result.message}` } };
      }
      return {
        handled: true,
        message: {
          role: 'assistant',
          content: `❌ ${fmt(d.installFailed, { message: result.message })}`,
        },
      };
    }
    const installed = installer.readInstalled(result.name);
    const perms =
      installed !== undefined && installed.permissions.length > 0
        ? `\n\n🔐 权限清单：\n${formatPermissionList(installed.permissions)}`
        : '';
    const template = result.action === 'update' ? d.installUpdated : d.installOk;
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `${fmt(template, { name: result.name, version: result.version, dir: result.dir })}${perms}`,
      },
    };
  }

  if (cmd.type === 'search') {
    const kw = cmd.keyword ?? '';
    const matched = searchPluginItems(registry as NonNullable<typeof registry>, kw);
    if (matched.length === 0) {
      return {
        handled: true,
        message: { role: 'assistant', content: `🔍 ${fmt(d.searchEmpty, { keyword: kw })}` },
      };
    }
    const lines = matched.map((item) => {
      const installed = installer.readInstalled(item.name);
      return formatPluginLine(item, installed?.version);
    });
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `${fmt(d.searchTitle, { count: String(matched.length) })}\n\n${lines.join('\n')}\n\n使用 \`/plugin install <name>\` 安装。`,
      },
    };
  }

  if (cmd.type === 'remove') {
    if (cmd.name === '') {
      return {
        handled: true,
        message: { role: 'assistant', content: `❌ ${d.removeMissing}` },
      };
    }
    if (installer.remove(cmd.name)) {
      return {
        handled: true,
        message: { role: 'assistant', content: `✅ ${fmt(d.removeOk, { name: cmd.name })}` },
      };
    }
    return {
      handled: true,
      message: { role: 'assistant', content: `❌ ${fmt(d.removeNotFound, { name: cmd.name })}` },
    };
  }

  if (cmd.type === 'browse') {
    const category = cmd.category;
    if (category !== undefined && !['tool', 'workflow', 'agent'].includes(category)) {
      return {
        handled: true,
        message: { role: 'assistant', content: `❌ ${d.browseMissing}` },
      };
    }
    const all = searchPluginItems(registry as NonNullable<typeof registry>);
    const filtered = category === undefined ? all : all.filter((p) => p.category === category);
    if (filtered.length === 0) {
      return {
        handled: true,
        message: { role: 'assistant', content: `📚 ${d.browseEmpty}` },
      };
    }
    const lines = filtered.map((item) => {
      const installed = installer.readInstalled(item.name);
      return formatPluginLine(item, installed?.version);
    });
    const { categoryLabel } = await import('../plugin');
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `${fmt(d.browseHeader, { category: categoryLabel(category), count: String(filtered.length) })}\n\n${lines.join('\n')}\n\n使用 \`/plugin install <name>\` 安装。`,
      },
    };
  }

  if (cmd.type === 'recommend') {
    const { detectProjectTraits, recommendPlugins } = await import('../plugin');
    const traits = detectProjectTraits(cwd);
    const recommendations = recommendPlugins(registry as NonNullable<typeof registry>, traits);
    if (recommendations.length === 0) {
      return {
        handled: true,
        message: { role: 'assistant', content: `💡 ${d.recommendEmpty}` },
      };
    }
    const lines = recommendations.map(
      ({ item, reason }) => `- ${formatPluginLine(item)}\n  💡 ${reason}`,
    );
    return {
      handled: true,
      message: {
        role: 'assistant',
        content: `${d.recommendHeader}\n\n${lines.join('\n')}\n\n使用 \`/plugin install <name>\` 安装。`,
      },
    };
  }

  // popular
  const top = [...(registry?.plugins ?? [])].sort((a, b) => b.downloads - a.downloads).slice(0, 10);
  if (top.length === 0) {
    return {
      handled: true,
      message: { role: 'assistant', content: '🔥 插件市场暂无热门插件。' },
    };
  }
  const lines = top.map((item, i) => {
    const installed = installer.readInstalled(item.name);
    return `  ${i + 1}. ${formatPluginLine(item, installed?.version)}`;
  });
  return {
    handled: true,
    message: {
      role: 'assistant',
      content: `${fmt(d.popularHeader, { count: String(top.length) })}\n\n${lines.join('\n')}`,
    },
  };
}
