/**
 * 插件安装器（v4.0 M4 / T4.1）。
 *
 * 安装流程：注册表匹配 → 下载 → sha256 校验 → 权限清单（确认回调）→ 写入本地目录
 * （~/.concertoai/plugins/<name>/：plugin.json + ESM 入口）。内置插件（sha256='builtin'）
 * 直接从 src/plugin/builtin.ts 取内容直装（不下载）。
 *
 * 复用：market/download.ts fetchVerifiedContent（sha256 校验）、market/installer.ts compareVersion
 * （版本比较）、market/registry.ts findPluginItem（注册表匹配）。
 *
 * 市场分发包格式（JSON）：
 * ```json
 * {
 *   "plugin": { "name": "api-docs", "version": "1.0.0", "description": "...",
 *               "author": "...", "category": "tool", "permissions": [{ "type": "read" }] },
 *   "entry": "export const create = () => ({ ... });"
 * }
 * ```
 * 权限确认：confirm 回调（CLI 展示彩色清单 → 用户 y/n；测试注入 stub）。确认拒绝 → 不落盘。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { fetchVerifiedContent } from '../market/download';
import { compareVersion } from '../market/installer';
import { fetchMarketRegistry, findPluginItem } from '../market/registry';
import type { MarketRegistry } from '../market/types';
import { globalPluginsDir } from '../store/paths';
import { getBuiltinPluginContent } from './builtin';
import type { Plugin, PluginPermission } from './types';
import { parsePluginJson } from './types';

// ── 路径 ─────────────────────────────────────────────────────

/** 全局插件安装目录（~/.concertoai/plugins/）。 */
export function pluginsInstallDir(): string {
  return globalPluginsDir();
}

// ── 包格式 ───────────────────────────────────────────────────

/** 市场分发包：plugin.json 字段 + entry 源码。 */
export interface PluginPackage {
  plugin: Plugin;
  /** ESM 入口源码。 */
  entry: string;
}

/** 已安装插件的本地元数据（plugin.json 内容）。 */
export interface InstalledPlugin extends Plugin {
  /** 安装时间（epoch ms）。 */
  installedAt: number;
}

/** 包 schema：plugin（复用 pluginJsonSchema 核心字段，entry 覆盖为源码字段）。 */
const pluginPackageSchema = z.object({
  plugin: z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
      description: z.string().default(''),
      author: z.string().default(''),
      category: z.enum(['tool', 'workflow', 'agent']).default('tool'),
      permissions: z
        .array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('read'), paths: z.array(z.string()).optional() }),
            z.object({ type: z.literal('write'), paths: z.array(z.string()).optional() }),
            z.object({
              type: z.literal('network'),
              allowedDomains: z.array(z.string()).optional(),
            }),
            z.object({ type: z.literal('shell'), allowlist: z.array(z.string()).optional() }),
            z.object({ type: z.literal('knowledge') }),
            z.object({ type: z.literal('mcp'), servers: z.array(z.string()).optional() }),
          ]),
        )
        .default([]),
      i18n: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  entry: z.string().min(1, 'entry 不能为空'),
});

// ── 安装结果（判别联合）──────────────────────────────────────

export type PluginInstallFailureCode =
  | 'REGISTRY_UNREACHABLE'
  | 'NOT_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'INVALID_PACKAGE'
  | 'ALREADY_INSTALLED'
  | 'CANCELED'
  | 'WRITE_FAILED';

export type PluginInstallResult =
  | { ok: true; name: string; version: string; action: 'install' | 'update'; dir: string }
  | { ok: false; code: PluginInstallFailureCode; message: string };

// ── 安装器 ───────────────────────────────────────────────────

export interface PluginInstallerOptions {
  /** 注册表获取（可注入；默认网络 fetchMarketRegistry）。 */
  fetchRegistry?: (url?: string) => Promise<MarketRegistry | null>;
  /** 包下载 + sha256 校验（可注入；默认 fetchVerifiedContent）。 */
  fetchPackage?: (url: string, sha256: string) => Promise<string | null>;
  /** 安装目录（可注入；默认 ~/.concertoai/plugins/）。 */
  installDir?: string;
  /** 权限确认回调（CLI 展示权限清单 → 用户确认；默认自动通过）。 */
  confirm?: (permissions: PluginPermission[]) => Promise<boolean> | boolean;
}

/** 插件安装器（依赖注入便于单元测试与 CLI 集成）。 */
export class PluginInstaller {
  constructor(private readonly opts: PluginInstallerOptions = {}) {}

  private fetchRegistry(url?: string): Promise<MarketRegistry | null> {
    if (this.opts.fetchRegistry !== undefined) {
      return this.opts.fetchRegistry(url);
    }
    return fetchMarketRegistry(url);
  }

  private fetchPackage(url: string, sha256: string): Promise<string | null> {
    if (this.opts.fetchPackage !== undefined) {
      return this.opts.fetchPackage(url, sha256);
    }
    return fetchVerifiedContent(url, sha256);
  }

  private installDir(): string {
    return this.opts.installDir ?? pluginsInstallDir();
  }

  private async confirm(permissions: PluginPermission[]): Promise<boolean> {
    if (this.opts.confirm === undefined) {
      return true;
    }
    return this.opts.confirm(permissions);
  }

  /**
   * plugin install <name>：注册表匹配 → 下载/内置直装 → sha256 校验 → 权限确认 →
   * 写入本地目录。返回结果（含权限清单在拒绝消息中）。
   */
  async install(name: string, registryRef?: MarketRegistry | null): Promise<PluginInstallResult> {
    // 1. 获取注册表
    const registry = registryRef ?? (await this.fetchRegistry());
    if (registry === null) {
      return {
        ok: false,
        code: 'REGISTRY_UNREACHABLE',
        message: '无法访问插件注册表，请检查网络连接。',
      };
    }

    // 2. 匹配插件条目
    const item = findPluginItem(registry, name);
    if (item === undefined) {
      const names = registry.plugins.map((p) => p.name).join(', ');
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `注册表中未找到插件: ${name}。\n\n可用插件: ${names}`,
      };
    }

    // 3. 已安装且版本不落后 → 跳过（避免重复下载）
    const installed = this.readInstalled(name);
    if (installed !== undefined && compareVersion(installed.version, item.version) >= 0) {
      return {
        ok: false,
        code: 'ALREADY_INSTALLED',
        message: `插件 ${name} 已安装（版本 ${installed.version}），注册表版本 ${item.version} 未更新。`,
      };
    }

    // 4. 获取内容：内置直装 or 下载 + sha256 校验
    let pkg: PluginPackage;
    if (item.sha256 === 'builtin') {
      const builtin = getBuiltinPluginContent(name);
      if (builtin === undefined) {
        return {
          ok: false,
          code: 'INVALID_PACKAGE',
          message: `插件 ${name} 标记为内置但内容缺失（builtin.ts 未定义）。`,
        };
      }
      pkg = { plugin: builtin.plugin, entry: builtin.entry };
    } else {
      const content = await this.fetchPackage(item.url, item.sha256);
      if (content === null) {
        return {
          ok: false,
          code: 'DOWNLOAD_FAILED',
          message: `下载插件 ${name} 失败或 sha256 校验不通过（已拒绝安装）。`,
        };
      }
      const parsed = parsePluginPackage(content);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'INVALID_PACKAGE',
          message: `插件 ${name} 安装被拒绝：${parsed.message}`,
        };
      }
      pkg = parsed.pkg;
    }

    // 5. 包内 plugin.name 与注册表条目名一致性校验
    if (pkg.plugin.name !== name) {
      return {
        ok: false,
        code: 'INVALID_PACKAGE',
        message: `插件包 name（${pkg.plugin.name}）与注册表条目名（${name}）不一致，已拒绝安装。`,
      };
    }

    // 6. 权限确认（fail-closed：拒绝 → 不落盘）
    const approved = await this.confirm(pkg.plugin.permissions);
    if (!approved) {
      return {
        ok: false,
        code: 'CANCELED',
        message: `已取消安装 ${name}（权限未获批准，未写入任何文件）。`,
      };
    }

    // 7. 写入本地目录（plugin.json + ESM 入口）
    try {
      const dir = path.join(this.installDir(), name);
      mkdirSync(dir, { recursive: true });
      const entryName = pkg.plugin.entry ?? 'index.mjs';
      // plugin.json 内容（保持 entry 相对路径）；版本以注册表条目为准（分发版本），
      // 避免包内版本与注册表不一致导致「永远判不到 ALREADY_INSTALLED」的重复更新
      const pluginJson = {
        ...pkg.plugin,
        version: item.version,
        entry: entryName,
        installedAt: Date.now(),
      };
      writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(pluginJson, null, 2), 'utf8');
      writeFileSync(path.join(dir, entryName), pkg.entry, 'utf8');
      const action: 'install' | 'update' = installed !== undefined ? 'update' : 'install';
      return { ok: true, name, version: item.version, action, dir };
    } catch (err) {
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: `写入插件 ${name} 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── 本地已安装插件查询 / 卸载 ──────────────────────────────

  /** 读取已安装插件元数据（未安装返回 undefined）。 */
  readInstalled(name: string): InstalledPlugin | undefined {
    const file = path.join(this.installDir(), name, 'plugin.json');
    if (!existsSync(file)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as InstalledPlugin;
      // 兼容：旧版无 installedAt → 补 0
      if (typeof parsed.installedAt !== 'number') {
        parsed.installedAt = 0;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** 列出全部已安装插件（按名称字典序）。 */
  listInstalled(): InstalledPlugin[] {
    const dir = this.installDir();
    if (!existsSync(dir)) {
      return [];
    }
    const names = readdirSafe(dir);
    const plugins: InstalledPlugin[] = [];
    for (const sub of names) {
      const inst = this.readInstalled(sub);
      if (inst !== undefined) {
        plugins.push(inst);
      }
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 卸载指定插件（删除安装目录），返回是否成功。 */
  remove(name: string): boolean {
    const dir = path.join(this.installDir(), name);
    if (!existsSync(dir)) {
      return false;
    }
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

// ── 包解析 ───────────────────────────────────────────────────

/** 解析插件包内容（JSON）并校验结构。 */
export function parsePluginPackage(
  content: string,
): { ok: true; pkg: PluginPackage } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (err) {
    return {
      ok: false,
      message: `不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  const result = pluginPackageSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, message: `插件包结构不符合协议（${issues}）` };
  }
  // 兼容：包内 plugin 无 entry（entry 为包顶层字段）→ 补默认 index.mjs
  const data = result.data;
  const plugin: Plugin = { ...data.plugin, entry: 'index.mjs' };
  return { ok: true, pkg: { plugin, entry: data.entry } };
}

/** 解析 plugin.json（InstalledPlugin 读取时校验；失败返回 null）。 */
export function parseInstalledPluginJson(json: string): Plugin | null {
  const parsed = parsePluginJson(json);
  return 'plugin' in parsed ? parsed.plugin : null;
}

// ── 工具函数 ─────────────────────────────────────────────────

/** 安全读取目录条目（不存在返回空数组）。 */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
