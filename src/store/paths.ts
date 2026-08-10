/**
 * 全局用户数据目录（v3.1 起）：~/.concertoai/
 *
 * v3.0 及以前使用 ~/.lumen/（旧品牌目录）。v3.1 起统一迁移到 ~/.concertoai/：
 * - 配置文件：~/.concertoai/config.json
 * - 会话目录：~/.concertoai/sessions/
 * - 全局技能：~/.concertoai/skills/
 * - 知识图谱：~/.concertoai/knowledge/
 * - 审计日志：~/.concertoai/audit/
 * - Agent 安装：~/.concertoai/agents/
 * - Reviewer 全局知识库：~/.concertoai/reviewer/knowledge/
 *
 * 首次启动（CLI 入口）调用 migrateLegacyHome() 自动迁移旧目录（幂等）：
 * 1. ~/.lumen 不存在 → 无操作（新安装直接用新版目录）；
 * 2. ~/.concertoai 已存在 → 保留新版，不覆盖旧目录；
 * 3. ~/.lumen 存在且 ~/.concertoai 不存在 → 整目录改名迁移（rename，失败回退复制）。
 *
 * 单一来源：所有模块的全局路径都从这里取，避免路径定义散落。
 */

import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 新版全局目录：~/.concertoai。 */
export function globalDir(): string {
  return path.join(os.homedir(), '.concertoai');
}

/** 旧版全局目录：~/.lumen（v3.0 及以前）。 */
export function legacyGlobalDir(): string {
  return path.join(os.homedir(), '.lumen');
}

/** 配置文件路径：~/.concertoai/config.json。 */
export function configPath(): string {
  return path.join(globalDir(), 'config.json');
}

/** 会话目录：~/.concertoai/sessions/。 */
export function sessionsDir(): string {
  return path.join(globalDir(), 'sessions');
}

/**
 * 项目会话目录 key：项目名安全化（防路径穿越，目录名只允许 [A-Za-z0-9._-]）。
 * - 空格 / 中文 / 其他字符 → `_`；`.` / `..` 保留但前缀 `p_` 防隐藏目录；
 * - 空名 → `unnamed`（调用方已校验非空，此处兜底）。
 */
export function projectKeyFor(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === '') {
    return 'unnamed';
  }
  if (safe === '.' || safe === '..') {
    return `p_${safe}`;
  }
  return safe;
}

/** 项目级会话目录：~/.concertoai/sessions/<projectKey>/（T2.4 隔离矩阵）。 */
export function projectSessionsDir(projectKey: string): string {
  return path.join(sessionsDir(), projectKey);
}

/** 项目注册表文件：~/.concertoai/projects.json（v3.1 M2）。 */
export function projectsPath(): string {
  return path.join(globalDir(), 'projects.json');
}

/** 全局技能目录：~/.concertoai/skills/。 */
export function globalSkillsDir(): string {
  return path.join(globalDir(), 'skills');
}

/** 知识图谱存储目录：~/.concertoai/knowledge/。 */
export function knowledgeDir(): string {
  return path.join(globalDir(), 'knowledge');
}

/** 审计日志目录：~/.concertoai/audit/。 */
export function auditDir(): string {
  return path.join(globalDir(), 'audit');
}

/** 全局 Agent 安装目录：~/.concertoai/agents/。 */
export function globalAgentsDir(): string {
  return path.join(globalDir(), 'agents');
}

/** 崩溃日志文件：~/.concertoai/crash.log（v3.1 M3 诊断用）。 */
export function crashLogPath(): string {
  return path.join(globalDir(), 'crash.log');
}

/** Reviewer 全局知识库目录：~/.concertoai/reviewer/knowledge/。 */
export function reviewerKnowledgeDir(): string {
  return path.join(globalDir(), 'reviewer', 'knowledge');
}

/**
 * 迁移旧版配置目录（~/.lumen → ~/.concertoai）。
 *
 * 幂等，可重复调用；返回是否执行了迁移。
 * @param log 日志回调（默认不输出）
 * @param legacy 旧目录（测试可注入 tmp 路径；默认 ~/.lumen）
 * @param next 新目录（测试可注入 tmp 路径；默认 ~/.concertoai）
 */
export function migrateLegacyHome(
  log: (message: string) => void = (): void => {},
  legacy: string = legacyGlobalDir(),
  next: string = globalDir(),
): boolean {
  if (!existsSync(legacy) || existsSync(next)) {
    return false;
  }
  try {
    renameSync(legacy, next);
    log('已迁移配置目录：~/.lumen → ~/.concertoai');
    return true;
  } catch (err) {
    // rename 失败（如跨文件系统）→ 回退复制 + 删除
    log(`迁移警告：目录改名失败，尝试复制: ${err instanceof Error ? err.message : String(err)}`);
    try {
      cpSync(legacy, next, { recursive: true });
      rmSync(legacy, { recursive: true, force: true });
      log('已迁移配置目录：~/.lumen → ~/.concertoai（复制模式）');
      return true;
    } catch (copyErr) {
      log(
        `迁移失败：${copyErr instanceof Error ? copyErr.message : String(copyErr)}（继续使用 ~/.lumen）`,
      );
      return false;
    }
  }
}
