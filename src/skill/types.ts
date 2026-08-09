/**
 * 技能类型定义（v2.0）。
 */

/** 技能 frontmatter 元数据（从 SKILL.md 的 YAML frontmatter 解析）。 */
export interface SkillFrontmatter {
  /** 技能标识名。 */
  name: string;
  /** 一句话用途说明。 */
  description: string;
  /** 语义版本号。 */
  version: string;
  /** 允许的工具白名单（逗号分隔字符串），可选。 */
  tools?: string;
  /** 建议使用的模型 ID，可选。 */
  model?: string;
  /** 运行模式：inline（默认，工具调用可见）| subagent（隔离执行，只回传结论）。 */
  run_as?: string;
}

/** 已加载的技能定义。 */
export interface SkillDef {
  name: string;
  description: string;
  version: string;
  /** 允许的工具名列表（解析后的字符串数组），undefined = 不限制。 */
  tools?: string[];
  /** 建议模型，可选。 */
  model?: string;
  /** 运行模式：'inline'（默认）| 'subagent'（隔离执行）。 */
  runAs?: 'inline' | 'subagent';
  /** 技能正文 markdown（frontmatter 之后的部分，含已展开的 @skill 引用）。 */
  body: string;
  /** 加载来源路径（文件绝对路径）。 */
  sourcePath: string;
  /** v2.1 M2：技能内 @agent 引用列表（运行时触发子代理）。 */
  agentRefs?: AgentRef[];
}

/** v2.1 M2：技能内 @skill 引用（加载时展开）。 */
export interface SkillRef {
  /** 被引用技能名。 */
  name: string;
}

/** v2.1 M2：技能内 @agent 引用（运行时触发子代理）。 */
export interface AgentRef {
  /** 子代理名。 */
  agentName: string;
  /** 传给子代理的 prompt。 */
  prompt: string;
}
