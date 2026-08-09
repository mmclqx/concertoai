/**
 * 技能加载器（v2.0）。
 *
 * 扫描指定目录下的 SKILL.md 文件，解析 YAML frontmatter + markdown 正文。
 * 支持两个加载路径：项目级（<cwd>/.concertoai/skills/）和全局（~/.concertoai/skills/）。
 * 同名技能：项目级覆盖全局级。
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { globalSkillsDir } from '../store/paths';
import type { AgentRef, SkillDef, SkillFrontmatter } from './types';

/** 技能嵌套最大深度（ADR-010）。 */
const MAX_NEST_DEPTH = 3;
/** @skill / @agent 引用正则（每次调用 expandSkillRefs 创建新实例以避免递归状态污染）。 */
function refPattern(): RegExp {
  // [ \t] 而非 \s —— \s 匹配 \r\n 导致跨行吞噬
  return /@(skill|agent):([a-zA-Z0-9_-]+)(?:[ \t]+([^\n\r]*))?\r?$/gm;
}

/** 技能文件名。 */
const SKILL_FILENAME = 'SKILL.md';

/** 项目级技能目录名（相对于 cwd）。 */
const PROJECT_SKILLS_DIR = '.concertoai/skills';

/** 内置技能目录（ConcertoAI 仓库自带的 skills/ 目录）。 */
function builtinSkillsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // src/skill/loader.ts → ../../ → 项目根目录 → skills/
  return path.resolve(__dirname, '..', '..', 'skills');
}

export class SkillLoader {
  private readonly skills = new Map<string, SkillDef>();
  /** v2.1 M2：存储技能的原始（未展开）body，供 expandSkillRefs 递归使用。 */
  private readonly rawBodies = new Map<string, string>();

  /**
   * 加载所有技能：先扫全局路径，再扫项目路径（同名覆盖）。
   * @param cwd 项目根目录
   * @param log 日志回调（默认不输出）
   */
  loadAll(cwd: string, log: (message: string) => void = () => {}): void {
    // 第一遍：解析 + 注册（不展开引用）
    this.scanDir(builtinSkillsDir(), log, true);
    this.scanDir(globalSkillsDir(), log, true);
    this.scanDir(path.join(cwd, PROJECT_SKILLS_DIR), log, true);
    // 第二遍：展开所有技能的 @skill 引用
    this.expandAll(log);
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
  private scanDir(dir: string, log: (message: string) => void, skipExpand = false): void {
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
        const def = skipExpand
          ? this.parseSkill(raw, skillFile, log)
          : this.parseAndExpand(raw, skillFile, log);
        if (def !== null) {
          // 同名：项目级覆盖全局级（后注册覆盖先注册）
          this.skills.set(def.name, def);
          if (skipExpand) {
            this.rawBodies.set(def.name, def.body);
          }
        }
      } catch {
        // 读取失败 → 跳过
      }
    }
  }

  /** 第二遍：展开所有已注册技能的 @skill 引用。 */
  private expandAll(log: (message: string) => void): void {
    for (const [name, def] of this.skills) {
      const expanded = this.expandSkillRefs(def.body, name, [name], 0, log);
      if (expanded === null) {
        // 循环引用或超深度 → 移除该技能
        this.skills.delete(name);
        continue;
      }
      def.body = expanded.body;
      def.agentRefs = expanded.agentRefs;
    }
  }

  /** 解析 SKILL.md 并展开 @skill 引用（同时收集 @agent 引用）。 */
  private parseAndExpand(
    raw: string,
    sourcePath: string,
    log: (message: string) => void,
  ): SkillDef | null {
    const def = this.parseSkill(raw, sourcePath, log);
    if (def === null) {
      return null;
    }
    // 展开 @skill 引用 + 收集 @agent 引用
    const expanded = this.expandSkillRefs(def.body, def.name, [def.name], 0, log);
    if (expanded === null) {
      return null; // 循环引用或超深度，拒绝加载
    }
    def.body = expanded.body;
    def.agentRefs = expanded.agentRefs;
    return def;
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

  /**
   * 递归展开技能正文中的 @skill:<name> 引用。
   * 同时收集 @agent:<name> 引用为 AgentRef[]（不展开，保留占位符）。
   * @returns null = 循环引用或超深度，应拒绝加载
   */
  private expandSkillRefs(
    body: string,
    ownerName: string,
    chain: string[],
    depth: number,
    log: (message: string) => void,
  ): { body: string; agentRefs: AgentRef[] } | null {
    if (depth > MAX_NEST_DEPTH) {
      log(
        `[SkillLoader] 拒绝加载 ${ownerName}：技能引用深度超过限制（${MAX_NEST_DEPTH} 层），当前链: ${chain.join(' → ')}`,
      );
      return null;
    }

    const agentRefs: AgentRef[] = [];
    let expanded = body;
    const pattern = refPattern();

    // 逐行扫描，处理 @skill / @agent 引用
    let match = pattern.exec(body);
    while (match !== null) {
      const refType = match[1] as 'skill' | 'agent';
      const refName = match[2] ?? '';
      const rawPrompt = (match[3] ?? '').trim();

      if (refType === 'skill') {
        // @skill:<name> → 递归展开
        if (chain.includes(refName)) {
          const cyclePath = [...chain, refName].join(' → ');
          log(`[SkillLoader] 拒绝加载 ${ownerName}：技能引用循环 ${cyclePath}`);
          return null;
        }
        const refDef = this.skills.get(refName);
        if (refDef === undefined) {
          log(`[SkillLoader] 拒绝加载 ${ownerName}：引用的技能不存在: @skill:${refName}`);
          return null;
        }
        // 递归展开被引用技能（使用原始 body 避免已展开技能跳过深度检测）
        const refRawBody = this.rawBodies.get(refName) ?? refDef.body;
        const refResult = this.expandSkillRefs(
          refRawBody,
          ownerName,
          [...chain, refName],
          depth + 1,
          log,
        );
        if (refResult === null) {
          return null;
        }
        // 替换 @skill:name 行为被引用技能的 body
        expanded = expanded.replace(match[0], refResult.body);
        // 继承被引用技能的 agentRefs
        agentRefs.push(...refResult.agentRefs);
      } else {
        // @agent:<name> → 收集为 AgentRef，正文中保留占位符
        agentRefs.push({ agentName: refName, prompt: rawPrompt });
      }
      match = pattern.exec(body);
    }

    return { body: expanded, agentRefs };
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
