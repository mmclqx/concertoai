/**
 * Agent 安装器（v3.0 M4 / T4.2）。
 *
 * 安装流程：fetch 注册表 → 匹配条目 → fetch url → sha256 校验 → 接口合规检查
 * → 写入本地目录（~/.lumen/agents/<name>/）→ 刷新 AgentRegistry。
 *
 * 与技能市场共用底层逻辑：下载 + sha256 校验走共享 fetchVerifiedContent
 * （src/market/download.ts），注册表获取复用 T4.1 fetchMarketRegistry。
 *
 * Agent 包格式（市场分发，JSON）：
 * ```json
 * {
 *   "def": {
 *     "name": "my-agent",
 *     "version": "1.0.0",
 *     "interfaces": { "input": {}, "output": {}, "version": "1.0.0" },
 *     "permissions": [{ "tool": "read_file" }]
 *   },
 *   "entry": "…实现源码（可选）…"
 * }
 * ```
 * interfaces.input/output 为描述性结构（真实 zod schema 在 Agent 实现侧，
 * T4.4 promote 脚手架生成），安装时校验结构完整性（fail-closed）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { AgentRegistry } from '../agents';
import type { AgentDef, AgentPermission } from '../orchestrator';
import { fetchVerifiedContent } from './download';
import { fetchMarketRegistry, findAgentItem } from './registry';
import type { MarketRegistry } from './types';

// ── 路径 ─────────────────────────────────────────────────────

/** 全局 Agent 安装目录（~/.lumen/agents/）。 */
export function globalAgentsDir(): string {
  return path.join(homedir(), '.lumen', 'agents');
}

// ── 包格式 ───────────────────────────────────────────────────

/** Agent 包中声明的 def（描述性 interfaces，见文件头格式说明）。 */
export interface AgentPackageDef {
  name: string;
  version: string;
  interfaces: {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    version: string;
  };
  permissions: AgentPermission[];
}

/** 解析后的 Agent 包。 */
export interface AgentPackage {
  def: AgentPackageDef;
  /** 实现源码（可选；T4.4 promote 脚手架生成）。 */
  entry?: string;
}

/** 已安装 Agent 的本地元数据（agent.json 内容）。 */
export interface InstalledAgent {
  /** 安装时从注册表写入的名称。 */
  name: string;
  /** 注册表版本号。 */
  version: string;
  /** 包内声明的 def（接口合规检查后保留）。 */
  def: AgentPackageDef;
  /** 安装时间（epoch ms）。 */
  installedAt: number;
}

// ── zod schema（接口合规检查，T4.2 验收标准 2）───────────────

/** Agent 包 schema：def 必须包含完整 AgentDef 契约字段（interfaces/permissions）。 */
const agentPackageSchema = z.object({
  def: z.object({
    name: z.string().min(1, 'def.name 不能为空'),
    version: z.string().min(1, 'def.version 不能为空'),
    interfaces: z
      .object({
        input: z.record(z.string(), z.unknown()),
        output: z.record(z.string(), z.unknown()),
        version: z.string().min(1, 'interfaces.version 不能为空'),
      })
      .strict(),
    permissions: z
      .array(
        z.object({
          tool: z.string().min(1, 'permissions[].tool 不能为空'),
          args: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1, 'permissions 不能为空（fail-closed：未声明工具一律拒绝）'),
  }),
  entry: z.string().optional(),
});

// ── 安装结果（判别联合）──────────────────────────────────────

export type InstallFailureCode =
  | 'REGISTRY_UNREACHABLE'
  | 'NOT_FOUND'
  | 'BUILTIN'
  | 'DOWNLOAD_FAILED'
  | 'INVALID_PACKAGE'
  | 'INVALID_DEF'
  | 'ALREADY_INSTALLED';

export type InstallResult =
  | { ok: true; name: string; version: string; action: 'install' | 'update'; dir: string }
  | { ok: false; code: InstallFailureCode; message: string };

// ── 安装器 ───────────────────────────────────────────────────

export interface AgentInstallerOptions {
  /** 注册表获取（可注入；默认网络 fetchMarketRegistry）。 */
  fetchRegistry?: (url?: string) => Promise<MarketRegistry | null>;
  /** 包下载 + sha256 校验（可注入；默认 fetchVerifiedContent）。 */
  fetchPackage?: (url: string, sha256: string) => Promise<string | null>;
  /** 安装目录（可注入；默认 ~/.lumen/agents/）。 */
  installDir?: string;
  /** Agent 注册表（提供时安装成功后自动刷新）。 */
  registry?: AgentRegistry;
}

/**
 * Agent 安装器。
 *
 * 设计为可注入依赖（fetchRegistry / fetchPackage / installDir / registry），
 * 便于单元测试（不触碰真实网络与用户目录）与 CLI 集成（T4.3 /agent install）。
 */
export class AgentInstaller {
  constructor(private readonly opts: AgentInstallerOptions = {}) {}

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
    return this.opts.installDir ?? globalAgentsDir();
  }

  // ── 安装 ──

  /**
   * /agent install <name>：注册表匹配 → 下载 → sha256 校验 → 接口合规检查
   * → 写入本地目录 → 刷新 AgentRegistry。
   *
   * @param name 要安装的 Agent 名称
   * @param registryRef 直接提供注册表（测试/离线场景可绕过网络获取）
   */
  async install(name: string, registryRef?: MarketRegistry | null): Promise<InstallResult> {
    // 1. 获取注册表
    const registry = registryRef ?? (await this.fetchRegistry());
    if (registry === null) {
      return {
        ok: false,
        code: 'REGISTRY_UNREACHABLE',
        message: '无法访问 Agent 注册表，请检查网络连接。',
      };
    }

    // 2. 匹配条目
    const item = findAgentItem(registry, name);
    if (item === undefined) {
      const names = registry.agents.map((a) => a.name).join(', ');
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `注册表中未找到 Agent: ${name}。\n\n可用 Agent: ${names}`,
      };
    }

    // 3. 内置 Agent 已随 Lumen 分发，无需安装
    if (item.runtime === 'builtin') {
      return {
        ok: false,
        code: 'BUILTIN',
        message: `${name} 是内置 Agent，已随 Lumen 分发，无需安装（可用 /agent list 查看）。`,
      };
    }

    // 4. 已安装且版本不落后 → 跳过（避免重复下载）
    const installed = this.readInstalled(name);
    if (installed !== undefined && compareVersion(installed.version, item.version) >= 0) {
      return {
        ok: false,
        code: 'ALREADY_INSTALLED',
        message: `Agent ${name} 已安装（版本 ${installed.version}），注册表版本 ${item.version} 未更新。`,
      };
    }

    // 5. 下载 + sha256 校验（失败统一 DOWNLOAD_FAILED，含校验不通过）
    const content = await this.fetchPackage(item.url, item.sha256);
    if (content === null) {
      return {
        ok: false,
        code: 'DOWNLOAD_FAILED',
        message: `下载 Agent ${name} 失败或 sha256 校验不通过（已拒绝安装）。`,
      };
    }

    // 6. 接口合规检查（AgentDef schema：interfaces/permissions 完整，fail-closed）
    const pkg = parseAgentPackage(content);
    if (!pkg.ok) {
      return {
        ok: false,
        code: pkg.code,
        message: `Agent ${name} 安装被拒绝：${pkg.message}`,
      };
    }
    if (pkg.pkg.def.name !== name) {
      return {
        ok: false,
        code: 'INVALID_DEF',
        message: `Agent 包 def.name（${pkg.pkg.def.name}）与注册表条目名（${name}）不一致，已拒绝安装。`,
      };
    }

    // 7. 写入本地目录
    const dir = path.join(this.installDir(), name);
    mkdirSync(dir, { recursive: true });
    const installedAt = Date.now();
    writeFileSync(
      path.join(dir, 'agent.json'),
      JSON.stringify({ name, version: item.version, def: pkg.pkg.def, installedAt }, null, 2),
      'utf8',
    );
    if (pkg.pkg.entry !== undefined) {
      writeFileSync(path.join(dir, 'index.js'), pkg.pkg.entry, 'utf8');
    }

    // 8. 刷新 AgentRegistry（更新场景先卸载旧定义）
    if (this.opts.registry !== undefined) {
      const def = agentDefFromPackage(pkg.pkg.def, item.version);
      if (this.opts.registry.has(name)) {
        this.opts.registry.unregister(name);
      }
      this.opts.registry.register(def);
    }

    const action: 'install' | 'update' = installed !== undefined ? 'update' : 'install';
    return { ok: true, name, version: item.version, action, dir };
  }

  // ── 本地已安装 Agent 查询 / 卸载（T4.3 /agent list/remove 复用）──

  /** 读取已安装 Agent 元数据（未安装返回 undefined）。 */
  readInstalled(name: string): InstalledAgent | undefined {
    const file = path.join(this.installDir(), name, 'agent.json');
    if (!existsSync(file)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as InstalledAgent;
    } catch {
      return undefined;
    }
  }

  /** 列出全部已安装 Agent（按名称字典序）。 */
  listInstalled(): InstalledAgent[] {
    const dir = this.installDir();
    if (!existsSync(dir)) {
      return [];
    }
    const names = readdirSafe(dir);
    const agents: InstalledAgent[] = [];
    for (const sub of names) {
      const inst = this.readInstalled(sub);
      if (inst !== undefined) {
        agents.push(inst);
      }
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 卸载指定 Agent（删除安装目录），返回是否成功。 */
  remove(name: string): boolean {
    const dir = path.join(this.installDir(), name);
    if (!existsSync(dir)) {
      return false;
    }
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

// ── 包解析与接口合规检查 ─────────────────────────────────────

/** 解析 Agent 包内容（JSON）并校验 AgentDef 契约（接口合规检查）。 */
export function parseAgentPackage(
  content: string,
):
  | { ok: true; pkg: AgentPackage }
  | { ok: false; code: 'INVALID_PACKAGE' | 'INVALID_DEF'; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_PACKAGE',
      message: `不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  const result = agentPackageSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, code: 'INVALID_DEF', message: `AgentDef 结构不符合协议（${issues}）` };
  }
  return { ok: true, pkg: result.data as AgentPackage };
}

/**
 * 把包内描述性 def 转为可注册的 AgentDef。
 *
 * interfaces.input/output 在包内为描述性结构（JSON 无法携带 zod 实例），
 * 注册时以宽松 zod schema 兜底；真实接口校验由 Agent 实现侧（T4.4 脚手架）负责。
 */
export function agentDefFromPackage(def: AgentPackageDef, version: string): AgentDef {
  return {
    name: def.name,
    version,
    interfaces: {
      input: z.any(),
      output: z.any(),
      version: def.interfaces.version,
    },
    permissions: def.permissions,
  };
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

/** 比较两个 semver 版本：a>b → 1、a<b → -1、相等 → 0。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) {
      return 1;
    }
    if (va < vb) {
      return -1;
    }
  }
  return 0;
}
