/**
 * 技能加载器（v2.0）。
 *
 * 扫描指定目录下的 SKILL.md 文件，解析 YAML frontmatter + markdown 正文。
 * 支持两个加载路径：项目级（<cwd>/.lumen/skills/）和全局（~/.lumen/skills/）。
 * 同名技能：项目级覆盖全局级。
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SkillDef, SkillFrontmatter } from './types';

/** 技能文件名。 */
const SKILL_FILENAME = 'SKILL.md';

/** 项目级技能目录名（相对于 cwd）。 */
const PROJECT_SKILLS_DIR = '.lumen/skills';

/** 全局技能目录名。 */
function globalSkillsDir(): string {
  return path.join(homedir(), '.lumen', 'skills');
}

/** 内置技能目录（Lumen 仓库自带的 skills/ 目录）。 */
function builtinSkillsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // src/skill/loader.ts → ../../ → 项目根目录 → skills/
  return path.resolve(__dirname, '..', '..', 'skills');
}

export class SkillLoader {
  private readonly skills = new Map<string, SkillDef>();

  /**
   * 加载所有技能：先扫全局路径，再扫项目路径（同名覆盖）。
   * @param cwd 项目根目录
   * @param log 日志回调（默认不输出）
   */
  loadAll(cwd: string, log: (message: string) => void = () => {}): void {
    // 优先级：内置（最低） → 全局 → 项目级（最高，同名覆盖）
    this.scanDir(builtinSkillsDir(), log);
    this.scanDir(globalSkillsDir(), log);
    this.scanDir(path.join(cwd, PROJECT_SKILLS_DIR), log);
  }

  /** 获取已加载的技能列表。 */
  list(): SkillDef[] {
    return [...this.skills.values()];
  }

  /** 按名称获取技能。 */
  get(name: string): SkillDef | undefined {
    return this.skills.get(name);
  }

  // ── 内部方法 ──────────────────────────────────────────────

  /** 扫描目录下的所有 SKILL.md。 */
  private scanDir(dir: string, log: (message: string) => void): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不存在 → 跳过
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillFile = path.join(dir, entry.name, SKILL_FILENAME);
      try {
        const raw = readFileSync(skillFile, 'utf8');
        const def = this.parseSkill(raw, skillFile, log);
        if (def !== null) {
          // 同名：项目级覆盖全局级（后注册覆盖先注册）
          this.skills.set(def.name, def);
        }
      } catch {
        // 读取失败 → 跳过
      }
    }
  }

  /** 解析 SKILL.md 内容为 SkillDef。失败返回 null。 */
  private parseSkill(
    raw: string,
    sourcePath: string,
    log: (message: string) => void,
  ): SkillDef | null {
    // 解析 frontmatter（--- 分隔）
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch === null || fmMatch[1] === undefined) {
      log(`[SkillLoader] 跳过 ${sourcePath}：缺少 frontmatter（---）`);
      return null;
    }
    const fmText = fmMatch[1];
    const body = raw.slice(fmMatch[0].length).trim();

    const fm = parseFrontmatter(fmText);
    if (fm === null) {
      log(`[SkillLoader] 跳过 ${sourcePath}：frontmatter 解析失败`);
      return null;
    }

    // 校验必填字段
    if (fm.name === undefined || fm.name.trim() === '') {
      log(`[SkillLoader] 跳过 ${sourcePath}：缺少必填字段 name`);
      return null;
    }
    if (fm.description === undefined || fm.description.trim() === '') {
      log(`[SkillLoader] 跳过 ${sourcePath}：缺少必填字段 description`);
      return null;
    }
    if (fm.version === undefined || fm.version.trim() === '') {
      log(`[SkillLoader] 跳过 ${sourcePath}：缺少必填字段 version`);
      return null;
    }

    const tools = fm.tools
      ? fm.tools
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : undefined;

    const runAsRaw = fm.run_as?.trim().toLowerCase();
    const runAs = runAsRaw === 'subagent' ? 'subagent' : undefined;

    return {
      name: fm.name.trim(),
      description: fm.description.trim(),
      version: fm.version.trim(),
      tools,
      model: fm.model?.trim() || undefined,
      runAs,
      body,
      sourcePath,
    };
  }
}

/** 解析简单的 YAML frontmatter 为 SkillFrontmatter。失败返回 null。 */
function parseFrontmatter(text: string): SkillFrontmatter | null {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    result[key] = value;
  }
  if (Object.keys(result).length === 0) {
    return null;
  }
  return result as unknown as SkillFrontmatter;
}
