/**
 * 插件 CLI 命令（v4.0 M4 / T4.1 + T4.1a）。
 *
 * 命令族：
 * - plugin install <name>     安装（注册表匹配 → 下载 → sha256 → 权限清单 → 确认）；
 * - plugin search <keyword>   模糊搜索注册表；
 * - plugin list               列出已安装插件；
 * - plugin remove <name>      卸载；
 * - plugin browse [category]  分类浏览（下载量 + 评分）；
 * - plugin recommend          基于项目特征推荐（Express / TODO / package.json / git）；
 * - plugin popular            社区热门 Top 10。
 *
 * 复用：PluginInstaller（installer.ts，sha256 校验 + 权限确认）、
 * market/registry.ts findPluginItem/searchPluginItems（注册表匹配）、
 * i18n plugin.* 键组。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { fmt, t } from '../i18n';
import { fetchMarketRegistry, searchPluginItems } from '../market/registry';
import type { MarketRegistry, PluginRegistryItem } from '../market/types';
import { PluginInstaller } from '../plugin/installer';
import { formatPermissionList } from '../plugin/permissions';
import type { PluginPermission } from '../plugin/types';

// ── 交互工具 ──────────────────────────────────────────────────

/** 读一行输入（TTY 交互；非 TTY 返回 undefined 由调用方降级）。 */
async function promptLine(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** 权限确认回调：展示彩色权限清单 → 读 y/N。非 TTY 且未 --yes → 拒绝（fail-closed）。 */
export function makePermissionConfirm(
  yes: boolean,
): (permissions: PluginPermission[]) => Promise<boolean> {
  return async (permissions: PluginPermission[]): Promise<boolean> => {
    const d = t().plugin;
    console.log('');
    console.log(d.permissionTitle);
    console.log(formatPermissionList(permissions));
    if (yes) {
      return true;
    }
    const answer = await promptLine(d.permissionConfirm);
    return answer?.toLowerCase() === 'y' || answer?.toLowerCase() === 'yes';
  };
}

/** 注册表获取（默认网络；测试/离线可注入）。 */
export type FetchRegistry = (url?: string) => Promise<MarketRegistry | null>;

/** 插件 CLI 选项（测试可注入依赖）。 */
export interface PluginCliOptions {
  /** 工作目录（recommend 项目特征检测用）。 */
  cwd: string;
  /** 权限确认（缺省：交互提示 y/N；--yes 自动通过）。 */
  confirm?: (permissions: PluginPermission[]) => Promise<boolean> | boolean;
  /** 注册表获取（缺省网络 fetchMarketRegistry）。 */
  fetchRegistry?: FetchRegistry;
  /** 安装目录（缺省 ~/.concertoai/plugins/）。 */
  installDir?: string;
}

/** 从选项构造 PluginInstaller（注入 confirm/fetchRegistry/installDir）。 */
function makeInstaller(opts: PluginCliOptions): PluginInstaller {
  return new PluginInstaller({
    confirm: opts.confirm,
    fetchRegistry: opts.fetchRegistry,
    installDir: opts.installDir,
  });
}

/** 获取注册表（网络；失败返回 null）。 */
async function getRegistry(opts: PluginCliOptions): Promise<MarketRegistry | null> {
  if (opts.fetchRegistry !== undefined) {
    return opts.fetchRegistry();
  }
  return fetchMarketRegistry();
}

// ── 命令实现 ──────────────────────────────────────────────────

/** 插件条目展示行（名称/版本/描述/下载量/评分/已安装标记）。 */
export function formatPluginLine(item: PluginRegistryItem, installedVersion?: string): string {
  const d = t().plugin;
  const line = fmt(d.browseLine, {
    name: item.name,
    version: item.version,
    description: item.description,
    downloads: String(item.downloads),
    rating: item.rating.toFixed(1),
  });
  return installedVersion === undefined
    ? line
    : `${line}${fmt(d.searchInstalled, { version: installedVersion })}`;
}

/** plugin install <name>：注册表匹配 → 下载 → sha256 → 权限确认 → 安装。 */
export async function runPluginInstall(
  name: string | undefined,
  opts: PluginCliOptions,
): Promise<number> {
  const d = t().plugin;
  if (name === undefined || name === '') {
    console.log(d.installMissing);
    return 1;
  }
  console.log(fmt(d.installSearching, { name }));
  const installer = makeInstaller(opts);
  const registry = await getRegistry(opts);
  if (registry === null) {
    console.log('❌ 无法访问插件注册表，请检查网络连接。');
    return 1;
  }
  const result = await installer.install(name, registry);
  if (!result.ok) {
    if (result.code === 'CANCELED') {
      console.log(`❌ ${result.message}`);
    } else if (result.code === 'ALREADY_INSTALLED') {
      console.log(fmt(d.installAlready, { message: result.message }));
    } else {
      console.log(fmt(d.installFailed, { message: result.message }));
    }
    return result.code === 'ALREADY_INSTALLED' ? 0 : 1;
  }
  const template = result.action === 'update' ? d.installUpdated : d.installOk;
  console.log(
    fmt(template, {
      name: result.name,
      version: result.version,
      dir: result.dir,
    }),
  );
  return 0;
}

/** plugin search <keyword>：模糊搜索注册表（名称/描述/作者/分类）。 */
export async function runPluginSearch(
  keyword: string | undefined,
  opts: PluginCliOptions,
): Promise<number> {
  const d = t().plugin;
  if (keyword === undefined || keyword === '') {
    console.log(d.searchMissing);
    return 1;
  }
  const registry = await getRegistry(opts);
  if (registry === null) {
    console.log('❌ 无法访问插件注册表，请检查网络连接。');
    return 1;
  }
  const matched = searchPluginItems(registry, keyword);
  if (matched.length === 0) {
    console.log(fmt(d.searchEmpty, { keyword }));
    return 0;
  }
  console.log(fmt(d.searchTitle, { count: String(matched.length) }));
  const installer = makeInstaller(opts);
  for (const item of matched) {
    const installed = installer.readInstalled(item.name);
    console.log(formatPluginLine(item, installed?.version));
  }
  console.log(d.searchHint);
  return 0;
}

/** plugin list：列出已安装插件。 */
export async function runPluginList(opts: PluginCliOptions): Promise<number> {
  const d = t().plugin;
  const installer = makeInstaller(opts);
  const installed = installer.listInstalled();
  if (installed.length === 0) {
    console.log(d.listEmpty);
    console.log(`  ${d.listHint}`);
    return 0;
  }
  console.log(fmt(d.listHeader, { count: String(installed.length) }));
  for (const p of installed) {
    const perms = p.permissions.length === 0 ? '（只读）' : `[${p.permissions.length} 项权限]`;
    console.log(`- **${p.name}** ${p.version} — ${p.description} ${perms}`);
  }
  return 0;
}

/** plugin remove <name>：卸载插件（删除安装目录）。 */
export async function runPluginRemove(
  name: string | undefined,
  opts: PluginCliOptions,
): Promise<number> {
  const d = t().plugin;
  if (name === undefined || name === '') {
    console.log(d.removeMissing);
    return 1;
  }
  const installer = makeInstaller(opts);
  if (installer.remove(name)) {
    console.log(fmt(d.removeOk, { name }));
    return 0;
  }
  console.log(fmt(d.removeNotFound, { name }));
  return 1;
}

// ── 发现（T4.1a）─────────────────────────────────────────────

/** 插件分类 → 中文展示（browse 表头）。 */
export function categoryLabel(category: string | undefined): string {
  const d = t().plugin;
  if (category === 'tool') return d.categoryTool;
  if (category === 'workflow') return d.categoryWorkflow;
  if (category === 'agent') return d.categoryAgent;
  return d.browseAll;
}

/** plugin browse [category]：按分类浏览（下载量 + 评分）。 */
export async function runPluginBrowse(
  category: string | undefined,
  opts: PluginCliOptions,
): Promise<number> {
  const d = t().plugin;
  if (category !== undefined && !['tool', 'workflow', 'agent'].includes(category)) {
    console.log(d.browseMissing);
    return 1;
  }
  const registry = await getRegistry(opts);
  if (registry === null) {
    console.log('❌ 无法访问插件注册表，请检查网络连接。');
    return 1;
  }
  const items = searchPluginItems(registry); // 全部，按下载量降序
  const filtered = category === undefined ? items : items.filter((p) => p.category === category);
  console.log(
    fmt(d.browseHeader, { category: categoryLabel(category), count: String(filtered.length) }),
  );
  if (filtered.length === 0) {
    console.log(d.browseEmpty);
    return 0;
  }
  const installer = makeInstaller(opts);
  for (const item of filtered) {
    const installed = installer.readInstalled(item.name);
    console.log(formatPluginLine(item, installed?.version));
  }
  return 0;
}

/** 项目特征检测（recommend 启发式：Express / TODO / package.json / git）。 */
export interface ProjectTraits {
  express: boolean;
  hasTodo: boolean;
  hasPackageJson: boolean;
  isGitRepo: boolean;
}

/** 检测项目特征（package.json 依赖 + TODO/FIXME 标记 + git 仓库）。 */
export function detectProjectTraits(cwd: string): ProjectTraits {
  let express = false;
  let hasPackageJson = false;
  let hasTodo = false;
  try {
    const pkgText = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    hasPackageJson = true;
    const pkg = JSON.parse(pkgText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    express = Object.keys(deps).some((k) => k === 'express' || k.startsWith('@express'));
  } catch {
    // 无 package.json
  }
  // TODO/FIXME 扫描（限 src/ 目录，最多 2 层，避免大目录卡顿）
  try {
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 2) {
        return false;
      }
      const entries = readdirSafe(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry);
        if (entry === 'node_modules' || entry.startsWith('.')) {
          continue;
        }
        const stat = statSafe(full);
        if (stat === undefined) {
          continue;
        }
        if (stat.isDirectory()) {
          if (walk(full, depth + 1)) {
            return true;
          }
        } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
          const text = readFileSafe(full);
          if (text !== undefined && /TODO|FIXME/.test(text)) {
            return true;
          }
        }
      }
      return false;
    };
    hasTodo = walk(path.join(cwd, 'src'), 0);
  } catch {
    hasTodo = false;
  }
  let isGitRepo = false;
  try {
    isGitRepo = existsSync(path.join(cwd, '.git'));
  } catch {
    isGitRepo = false;
  }
  return { express, hasTodo, hasPackageJson, isGitRepo };
}

/** 内置推荐映射：插件名 → 检测特征 → 展示原因（键组键名）。 */
const RECOMMEND_PLUGIN_REASON: Array<{
  plugin: string;
  trait: keyof ProjectTraits;
  reasonKey: string;
}> = [
  { plugin: 'api-docs', trait: 'express', reasonKey: 'recommendReasonExpress' },
  { plugin: 'todo-tracker', trait: 'hasTodo', reasonKey: 'recommendReasonTodo' },
  { plugin: 'release-helper', trait: 'hasPackageJson', reasonKey: 'recommendReasonRelease' },
  { plugin: 'git-status', trait: 'isGitRepo', reasonKey: 'recommendReasonGit' },
];

/** 基于项目特征推荐插件（返回推荐条目 + 理由文案）。 */
export function recommendPlugins(
  registry: MarketRegistry,
  traits: ProjectTraits,
): Array<{ item: PluginRegistryItem; reason: string }> {
  const d = t().plugin;
  const recommendations: Array<{ item: PluginRegistryItem; reason: string }> = [];
  for (const r of RECOMMEND_PLUGIN_REASON) {
    if (!traits[r.trait]) {
      continue;
    }
    const item = registry.plugins.find((p) => p.name === r.plugin);
    if (item !== undefined) {
      recommendations.push({ item, reason: d[r.reasonKey as keyof typeof d] as string });
    }
  }
  return recommendations;
}

/** plugin recommend：项目特征启发式推荐。 */
export async function runPluginRecommend(opts: PluginCliOptions): Promise<number> {
  const d = t().plugin;
  const registry = await getRegistry(opts);
  if (registry === null) {
    console.log('❌ 无法访问插件注册表，请检查网络连接。');
    return 1;
  }
  const traits = detectProjectTraits(opts.cwd);
  const recommendations = recommendPlugins(registry, traits);
  if (recommendations.length === 0) {
    console.log(d.recommendEmpty);
    return 0;
  }
  console.log(d.recommendHeader);
  const installer = makeInstaller(opts);
  for (const { item, reason } of recommendations) {
    const installed = installer.readInstalled(item.name);
    const status =
      installed === undefined ? '' : fmt(d.searchInstalled, { version: installed.version });
    console.log(`- ${formatPluginLine(item)}${status}`);
    console.log(`  💡 ${reason}`);
  }
  return 0;
}

/** plugin popular：社区热门 Top 10（按下载量降序）。 */
export async function runPluginPopular(opts: PluginCliOptions): Promise<number> {
  const d = t().plugin;
  const registry = await getRegistry(opts);
  if (registry === null) {
    console.log('❌ 无法访问插件注册表，请检查网络连接。');
    return 1;
  }
  const top = [...registry.plugins].sort((a, b) => b.downloads - a.downloads).slice(0, 10);
  console.log(fmt(d.popularHeader, { count: String(top.length) }));
  const installer = makeInstaller(opts);
  top.forEach((item, i) => {
    const installed = installer.readInstalled(item.name);
    console.log(`  ${i + 1}. ${formatPluginLine(item, installed?.version)}`);
  });
  return 0;
}

// ── 命令族入口 ────────────────────────────────────────────────

/** 执行 plugin 命令族（返回 0 成功 / 1 失败，供 cli/index.ts 退出码）。 */
export async function runPluginCli(
  options: PluginCliOptions & { action: string; param?: string },
): Promise<number> {
  const { action, param, ...opts } = options;
  switch (action) {
    case 'install':
      return runPluginInstall(param, opts);
    case 'search':
      return runPluginSearch(param, opts);
    case 'list':
      return runPluginList(opts);
    case 'remove':
      return runPluginRemove(param, opts);
    case 'browse':
      return runPluginBrowse(param, opts);
    case 'recommend':
      return runPluginRecommend(opts);
    case 'popular':
      return runPluginPopular(opts);
    default:
      console.log(t().plugin.usage);
      return 1;
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

/** 安全读取目录条目（不存在返回空数组）。 */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 安全 stat（不存在/不可读返回 undefined）。 */
function statSafe(p: string): { isDirectory(): boolean } | undefined {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

/** 安全读取文件（不存在/不可读返回 undefined）。 */
function readFileSafe(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}
