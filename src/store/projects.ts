/**
 * 项目注册表（v3.1 M2 / T2.1）：~/.concertoai/projects.json
 *
 * 多项目管理基础：`name → { path, addedAt, whitelist?, mcpServers? }`。
 * - 会话 / 审批白名单 / MCP 服务按项目隔离（T2.3 / T2.4 消费）；
 * - 路径规范化：Windows 反斜杠统一转正斜杠（`C:\foo\bar` → `C:/foo/bar`）；
 * - 嵌套注册拒绝：新项目路径是已注册项目子目录时抛 `PROJECT_NESTED`（默认策略）；
 * - 重名拒绝：抛 `PROJECT_ALREADY_EXISTS`；
 * - 损坏 JSON 时返回空注册表并记录警告（宽松读取，对齐 D9 会话风格）。
 *
 * 注册表操作不触碰项目目录内容（add/remove 无副作用）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { projectsPath } from './paths';

/** 项目注册表 schema 版本。 */
export const PROJECTS_SCHEMA_VERSION = 1;
/** 默认注册表路径：~/.concertoai/projects.json。 */
export const DEFAULT_PROJECTS_PATH = projectsPath();

/** 单个项目条目。 */
export interface ProjectEntry {
  /** 项目根目录（绝对路径，规范化：正斜杠分隔）。 */
  path: string;
  /** 注册时间（ISO 字符串）。 */
  addedAt: string;
  /** 项目级审批白名单（T2.4：与全局白名单合并生效）。 */
  whitelist?: string[];
  /** 项目级 MCP 服务声明（T2.4：按项目启动；缺省用全局 config.json）。 */
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>;
}

/** 注册表磁盘结构。 */
export interface ProjectRegistryData {
  schemaVersion: number;
  /** name → 条目（name 为项目唯一标识，不含路径分隔符）。 */
  projects: Record<string, ProjectEntry>;
}

/** 项目注册表错误码。 */
export type ProjectRegistryErrorCode = 'PROJECT_ALREADY_EXISTS' | 'PROJECT_NESTED';

/** 项目注册表错误（携带机器可读 code，供 CLI/测试断言）。 */
export class ProjectRegistryError extends Error {
  constructor(
    public readonly code: ProjectRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectRegistryError';
  }
}

/** 空注册表数据。 */
export function emptyRegistry(): ProjectRegistryData {
  return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: {} };
}

/**
 * 路径规范化：`C:\foo\bar` → `C:/foo/bar`（Windows 反斜杠转正斜杠）。
 * - Windows 盘符绝对路径（`^[a-zA-Z]:[\\/]`）：跨平台统一转为 `C:/...`（不依赖当前平台
 *   path.resolve 的盘符语义——POSIX 下 `C:\foo` 会被误当相对路径）；
 * - 其余路径：path.resolve 转绝对 + 归一化 `..`，再统一分隔符为正斜杠。
 * 纯字符串转换不依赖真实文件系统（POSIX 下同样处理反斜杠，保证跨平台一致性）。
 */
export function normalizeProjectPath(p: string): string {
  const winAbs = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (winAbs !== null) {
    const drive = (winAbs[1] ?? 'A').toUpperCase();
    const rest = (winAbs[2] ?? '').replace(/\\/g, '/');
    return `${drive}:/${path.posix.normalize(rest)}`;
  }
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * 判定 newPath 是否与 existingPaths 任一存在嵌套关系（一方是另一方的子目录）。
 * 默认策略：拒绝「新项目是已注册项目子目录」（PROJECT_NESTED）。
 * 使用规范化路径 + 分隔符边界比较，避免 `/foo/bar2` 误判为 `/foo/bar` 的子目录。
 */
export function isNested(newPath: string, existingPaths: readonly string[]): boolean {
  const a = normalizeProjectPath(newPath);
  for (const raw of existingPaths) {
    const b = normalizeProjectPath(raw);
    const sep = '/';
    if (a === b) {
      continue;
    }
    // Windows 盘符大小写不敏感：统一小写比较前缀（仅当都像盘符路径）
    const ka = /^[a-zA-Z]:/.test(a) ? a.toLowerCase() : a;
    const kb = /^[a-zA-Z]:/.test(b) ? b.toLowerCase() : b;
    if (ka.startsWith(`${kb}${sep}`) || kb.startsWith(`${ka}${sep}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 项目注册表：load/save/add/remove/get/list/has。
 *
 * 用法：
 * ```ts
 * const reg = await ProjectRegistry.load();   // 宽松读取（不存在/损坏 → 空）
 * reg.add('demo', '/path/to/demo');
 * await reg.save();                            // 原子写回
 * ```
 */
export class ProjectRegistry {
  private constructor(
    private readonly file: string,
    private data: ProjectRegistryData,
    /** 宽松读取时的警告（损坏 JSON 等），由调用方决定如何展示。 */
    private readonly warnings: string[] = [],
  ) {}

  /** 读取注册表；文件不存在 / JSON 损坏 → 返回空注册表并记录警告（不抛错）。 */
  static async load(file: string = DEFAULT_PROJECTS_PATH): Promise<ProjectRegistry> {
    const warnings: string[] = [];
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProjectRegistryData>;
      if (parsed.schemaVersion !== PROJECTS_SCHEMA_VERSION) {
        warnings.push(`项目注册表 schema 版本不匹配（期望 ${PROJECTS_SCHEMA_VERSION}），已重置为空注册表`);
        return new ProjectRegistry(file, emptyRegistry(), warnings);
      }
      const projects = parsed.projects ?? {};
      const data: ProjectRegistryData = { schemaVersion: PROJECTS_SCHEMA_VERSION, projects };
      return new ProjectRegistry(file, data, warnings);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        warnings.push(`项目注册表读取失败，已重置为空注册表: ${err instanceof Error ? err.message : String(err)}`);
      }
      return new ProjectRegistry(file, emptyRegistry(), warnings);
    }
  }

  /** 宽松读取产生的警告（损坏 JSON / 版本不匹配）。 */
  warningsList(): readonly string[] {
    return this.warnings;
  }

  /** 当前注册表数据（深拷贝，防止外部修改内部状态）。 */
  dataSnapshot(): ProjectRegistryData {
    return JSON.parse(JSON.stringify(this.data)) as ProjectRegistryData;
  }

  /** 写入注册表（原子：临时文件 + rename；自动创建目录）。 */
  async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  /** 注册项目；重名抛 PROJECT_ALREADY_EXISTS；嵌套（子目录）抛 PROJECT_NESTED。 */
  add(name: string, p: string): void {
    if (name === '' || name.includes('/') || name.includes('\\')) {
      throw new Error('项目名不能为空或包含路径分隔符');
    }
    if (this.data.projects[name] !== undefined) {
      throw new ProjectRegistryError('PROJECT_ALREADY_EXISTS', `项目 ${name} 已注册`);
    }
    const normalized = normalizeProjectPath(p);
    const existing = Object.values(this.data.projects).map((e) => e.path);
    if (isNested(normalized, existing)) {
      throw new ProjectRegistryError(
        'PROJECT_NESTED',
        `项目路径 ${normalized} 是已注册项目的子目录（多项目嵌套注册被拒绝，请使用独立目录）`,
      );
    }
    this.data.projects[name] = { path: normalized, addedAt: new Date().toISOString() };
  }

  /** 卸载项目（不删除项目目录）；不存在返回 false。 */
  remove(name: string): boolean {
    if (this.data.projects[name] === undefined) {
      return false;
    }
    delete this.data.projects[name];
    return true;
  }

  /** 按名查询项目条目；不存在返回 undefined。 */
  get(name: string): ProjectEntry | undefined {
    const entry = this.data.projects[name];
    return entry === undefined ? undefined : { ...entry };
  }

  /** 列出全部项目（按注册名排序）。 */
  list(): Array<{ name: string; entry: ProjectEntry }> {
    return Object.keys(this.data.projects)
      .sort()
      .map((name) => ({ name, entry: { ...(this.data.projects[name] as ProjectEntry) } }));
  }

  /** 是否已注册。 */
  has(name: string): boolean {
    return this.data.projects[name] !== undefined;
  }

  /** 按路径精确匹配已注册项目（cwd 自动探测，T2.3）；未匹配返回 undefined。 */
  findByPath(p: string): { name: string; entry: ProjectEntry } | undefined {
    const normalized = normalizeProjectPath(p);
    for (const [name, entry] of Object.entries(this.data.projects)) {
      if (normalizeProjectPath(entry.path) === normalized) {
        return { name, entry: { ...entry } };
      }
    }
    return undefined;
  }
}
