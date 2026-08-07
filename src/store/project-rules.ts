/**
 * 项目规则加载：AGENTS.md → CARBON.md 优先级，截断至 ≤8000 字符注入系统提示。
 *
 * - 只读取 cwd 根目录下的规则文件（不递归子目录）；
 * - 文件不存在/不可读/内容为空 → 继续尝试下一个，全部失败返回空规则（不阻塞启动）；
 * - 超长截断并标记 truncated。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 注入系统提示的规则文本上限（字符）。 */
export const MAX_RULES_CHARS = 8_000;

/** 规则文件优先级：AGENTS.md 优先，CARBON.md 兜底。 */
export const RULE_FILENAMES = ['AGENTS.md', 'CARBON.md'] as const;

export interface ProjectRules {
  /** 注入系统提示的规则文本（已截断，含来源标题；无规则时为空串）。 */
  text: string;
  /** 实际加载的文件名；无规则时为 null。 */
  loadedFrom: string | null;
  truncated: boolean;
}

export async function loadProjectRules(cwd: string): Promise<ProjectRules> {
  for (const name of RULE_FILENAMES) {
    let raw: string;
    try {
      raw = await readFile(path.join(cwd, name), 'utf8');
    } catch {
      // 不存在或不可读 → 尝试下一个
      continue;
    }
    const body = raw.trim();
    if (body === '') {
      continue;
    }
    const truncated = body.length > MAX_RULES_CHARS;
    return {
      text: `# 项目规则（来自 ${name}）\n\n${truncated ? body.slice(0, MAX_RULES_CHARS) : body}`,
      loadedFrom: name,
      truncated,
    };
  }
  return { text: '', loadedFrom: null, truncated: false };
}
