/**
 * 插件加载器（v4.0 M4 / T4.4）。
 *
 * 扫描全局 `~/.concertoai/plugins/` + 项目 `.concertoai/plugins/`，
 * 每个插件一个子目录（目录名 = 插件名，含 plugin.json + ESM 入口）。
 * 解析 plugin.json（zod 校验）→ ESM 强制检查 → 动态注册（工具/命令/工作流）。
 *
 * 与技能加载器同构：先扫全局再扫项目，同名项目级覆盖全局级。
 * 插件必须 ESM（.mjs 后缀，或 .js 且同目录 package.json type=module）——非 ESM 拒绝加载并明确报错。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { globalPluginsDir } from '../store/paths';
import type { Plugin } from './types';
import { parsePluginJson } from './types';

/** 项目级插件目录名（相对于 cwd）。 */
const PROJECT_PLUGINS_DIR = '.concertoai/plugins';

/** 加载结果（含被拒绝插件的错误信息，便于 CLI/日志展示）。 */
export interface PluginLoadResult {
  /** 成功注册的插件（同名覆盖后保留最后注册者）。 */
  plugins: Plugin[];
  /** 被拒绝的插件（name → 原因，ESM 强制 / 校验失败）。 */
  rejected: { name: string; reason: string }[];
}

/** 插件加载器选项（测试可注入目录）。 */
export interface PluginLoaderOptions {
  /** 全局插件目录（默认 ~/.concertoai/plugins/）。 */
  globalDir?: string;
  /** 项目插件目录（默认 <cwd>/.concertoai/plugins/）。 */
  projectDir?: string;
}

export class PluginLoader {
  private readonly plugins = new Map<string, Plugin>();
  private readonly globalDir: string;
  private readonly projectDir: string | undefined;

  constructor(options: PluginLoaderOptions = {}) {
    this.globalDir = options.globalDir ?? globalPluginsDir();
    this.projectDir = options.projectDir;
  }

  /**
   * 扫描并加载全部插件：先全局后项目（同名项目覆盖全局）。
   * @param cwd 项目根目录
   * @param log 日志回调（默认不输出；rejected 会记入日志）
   */
  loadAll(cwd: string, log: (message: string) => void = (): void => {}): PluginLoadResult {
    this.plugins.clear();
    const rejected: { name: string; reason: string }[] = [];

    const global = this.projectDir ?? path.join(cwd, PROJECT_PLUGINS_DIR);
    // 项目目录优先计算（无论是否存在，扫描时静默跳过）
    const dirs = [this.globalDir, global];

    for (const dir of dirs) {
      const entries = readdirSafe(dir);
      for (const entry of entries) {
        const pluginDir = path.join(dir, entry);
        // 只处理目录（跳过文件）
        if (!isDirectory(pluginDir)) {
          continue;
        }
        const result = this.loadOne(pluginDir, log);
        if (result.ok) {
          // 同名：项目级覆盖全局级（后注册覆盖先注册）
          this.plugins.set(result.plugin.name, result.plugin);
        } else {
          rejected.push({ name: entry, reason: result.reason });
        }
      }
    }

    return { plugins: this.list(), rejected };
  }

  /** 已加载插件列表（按名称字典序）。 */
  list(): Plugin[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称获取插件。 */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * 加载单个插件目录：读取 plugin.json → zod 校验 → ESM 强制检查 → 返回 Plugin。
   * 失败返回 { ok: false, reason }（不抛异常，调用方记录日志）。
   */
  private loadOne(
    pluginDir: string,
    log: (message: string) => void,
  ): { ok: true; plugin: Plugin } | { ok: false; reason: string } {
    const jsonPath = path.join(pluginDir, 'plugin.json');
    if (!existsSync(jsonPath)) {
      return { ok: false, reason: `缺少 plugin.json（${pluginDir}）` };
    }
    let raw: string;
    try {
      raw = readFileSync(jsonPath, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: `plugin.json 读取失败（${err instanceof Error ? err.message : String(err)}）`,
      };
    }

    // plugin.json 解析 + zod schema 校验
    const parsed = parsePluginJson(raw);
    if ('error' in parsed) {
      return { ok: false, reason: `${pluginDir}/plugin.json: ${parsed.error}` };
    }
    const plugin = parsed.plugin;

    // 目录名与 plugin.json name 一致性校验（与安装器目录布局一致）
    const dirName = path.basename(pluginDir);
    if (dirName !== plugin.name) {
      return {
        ok: false,
        reason: `插件目录名（${dirName}）与 plugin.json name（${plugin.name}）不一致`,
      };
    }

    // ESM 强制：entry 必须 .mjs，或 .js 且同目录 package.json type=module
    const entryPath = path.join(pluginDir, plugin.entry);
    const esmError = checkEsm(entryPath);
    if (esmError !== null) {
      return { ok: false, reason: `${plugin.name}: ${esmError}` };
    }
    if (!existsSync(entryPath)) {
      return { ok: false, reason: `${plugin.name}: ESM 入口不存在（${plugin.entry}）` };
    }

    plugin.sourceDir = pluginDir;
    log(`[PluginLoader] 已加载插件 ${plugin.name}@${plugin.version}（${plugin.category}）`);
    return { ok: true, plugin };
  }
}

// ── 工具函数 ─────────────────────────────────────────────────

/** 安全读取目录条目（不存在/不可读返回空数组）。 */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 判断路径是否为目录（statSync 精确判断；不存在/不可读返回 false）。 */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * ESM 强制检查（T4.4 验收标准：非 ESM 插件拒绝加载并明确报错）。
 * 规则：entry 以 .mjs 结尾 → 通过；entry 以 .js 结尾 → 需同目录 package.json 声明 type=module；
 * 其他扩展名（.cjs/.ts/无扩展）→ 拒绝。
 */
export function checkEsm(entryPath: string): string | null {
  const ext = path.extname(entryPath).toLowerCase();
  if (ext === '.mjs') {
    return null;
  }
  if (ext === '.js') {
    const pkgPath = path.join(path.dirname(entryPath), 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: string };
        if (pkg.type === 'module') {
          return null;
        }
      } catch {
        // package.json 损坏 → 视为非 ESM（fail-closed）
      }
    }
    return `非 ESM 插件被拒绝：.js 入口需同目录 package.json 声明 "type": "module"（${path.basename(entryPath)}）`;
  }
  return `非 ESM 插件被拒绝：入口必须为 .mjs 或 .js(type=module)，当前 ${ext || '无扩展名'}（${path.basename(entryPath)}）`;
}
