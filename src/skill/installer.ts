/**
 * 技能安装器（v4.0 M4 / T4.3 installByType 分派的 skill 分支）。
 *
 * 从技能市场注册表安装 SKILL.md 到 ~/.concertoai/skills/<name>/。
 * 原逻辑内联在 src/cli/slash/skill.ts 的 /skill install 分支，v4.0 抽取为独立模块，
 * 供 slash 命令与 market/installer.ts installByType 复用（单一来源，避免重复实现）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { fetchVerifiedContent } from '../market/download';
import { globalSkillsDir } from '../store/paths';

/** 技能市场注册表条目。 */
export interface SkillRegistryEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  url: string;
  sha256: string;
}

/** 技能市场注册表。 */
export interface SkillRegistry {
  registry: string;
  skills: SkillRegistryEntry[];
}

/** 技能市场注册表默认 URL。 */
export const SKILL_REGISTRY_URL =
  'https://raw.githubusercontent.com/concertoai/cli/main/skills/registry.json';

/** 安装结果（判别联合，与 AgentInstaller/PluginInstaller 同构）。 */
export type SkillInstallResult =
  | { ok: true; name: string; version: string; action: 'install' | 'update'; dir: string }
  | {
      ok: false;
      code: 'REGISTRY_UNREACHABLE' | 'NOT_FOUND' | 'DOWNLOAD_FAILED' | 'ALREADY_INSTALLED';
      message: string;
    };

/** 技能安装器选项（测试可注入）。 */
export interface SkillInstallerOptions {
  /** 注册表获取（可注入；默认网络 fetchSkillRegistry）。 */
  fetchRegistry?: (url?: string) => Promise<SkillRegistry | null>;
  /** 下载 + sha256 校验（可注入；默认 fetchVerifiedContent）。 */
  fetchSkill?: (url: string, sha256: string) => Promise<string | null>;
  /** 安装目录（可注入；默认 ~/.concertoai/skills/）。 */
  installDir?: string;
}

/** 从注册表 URL fetch 并解析注册表 JSON。 */
export async function fetchSkillRegistry(url?: string): Promise<SkillRegistry | null> {
  try {
    const resp = await fetch(url ?? SKILL_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as SkillRegistry;
  } catch {
    return null;
  }
}

/** 从已安装的技能文件中解析版本号（简单 YAML frontmatter 解析）。 */
export function readInstalledSkillVersion(name: string, installDir?: string): string | undefined {
  const file = path.join(installDir ?? globalSkillsDir(), name, 'SKILL.md');
  try {
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/^version:\s*(.+)$/m);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** 比较两个 semver 版本，返回 1（a>b）、-1（a<b）、0（相等）。 */
export function compareSkillVersion(a: string, b: string): number {
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

/**
 * 安装技能：注册表匹配 → 版本比较 → 下载 + sha256 校验 → 写入 SKILL.md。
 * 返回结果（含权限清单在拒绝消息中）。
 */
export async function installSkillFromRegistry(
  name: string,
  options: SkillInstallerOptions = {},
): Promise<SkillInstallResult> {
  const registry =
    options.fetchRegistry !== undefined
      ? await options.fetchRegistry()
      : await fetchSkillRegistry();
  if (registry === null) {
    return {
      ok: false,
      code: 'REGISTRY_UNREACHABLE',
      message: '无法访问技能注册表，请检查网络连接。',
    };
  }
  const entry = registry.skills.find((s) => s.name === name);
  if (entry === undefined) {
    const names = registry.skills.map((s) => s.name).join(', ');
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `注册表中未找到技能: ${name}。\n\n可用技能: ${names}`,
    };
  }

  const installDir = options.installDir ?? globalSkillsDir();
  const installedVer = readInstalledSkillVersion(name, installDir);
  if (installedVer !== undefined && compareSkillVersion(installedVer, entry.version) >= 0) {
    return {
      ok: false,
      code: 'ALREADY_INSTALLED',
      message: `技能 ${name} 已安装（版本 ${installedVer}），注册表版本 ${entry.version} 未更新。`,
    };
  }

  const content =
    options.fetchSkill !== undefined
      ? await options.fetchSkill(entry.url, entry.sha256)
      : await fetchVerifiedContent(entry.url, entry.sha256);
  if (content === null) {
    return {
      ok: false,
      code: 'DOWNLOAD_FAILED',
      message: `下载技能 ${name} 失败或 sha256 校验不通过（已拒绝安装）。`,
    };
  }

  const dir = path.join(installDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  const action: 'install' | 'update' = installedVer !== undefined ? 'update' : 'install';
  return { ok: true, name, version: entry.version, action, dir };
}
