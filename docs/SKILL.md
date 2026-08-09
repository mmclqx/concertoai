# SKILL.md 规范

> ConcertoAI v2.0 技能系统 · 版本 v1.0 · 2026-08-08

## 概述

技能（Skill）是一个 markdown 文件，包含 frontmatter 元数据 + 给模型的执行指令。用户通过 `/skill <name>` 命令调用技能，加载器将技能正文注入当前对话的上下文。

## 文件格式

SKILL.md 文件由 YAML frontmatter + markdown 正文组成，用 `---` 分隔：

```markdown
---
name: skill-name
description: 一句话描述
version: 1.0.0
tools: tool1, tool2
model: deepseek-v4-pro
---

## 技能描述
…

## 使用方式
…

## 执行指令
…
```

## Frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 技能标识名（字母、数字、`-`、`_`，不含空格） |
| `description` | ✅ | 一句话用途说明（显示在 `/skill list` 列表中） |
| `version` | ✅ | 语义版本号（如 `1.0.0`） |
| `tools` | ❌ | 允许的工具白名单（逗号分隔，如 `read_file, search_content`）；省略表示不限制 |
| `model` | ❌ | 建议使用的模型 ID（如 `deepseek-v4-pro`）；省略表示使用当前模型 |

## 正文规范

正文为 markdown，建议包含以下标准段落：

### `## 技能描述`
一句话说明技能做什么。

### `## 使用方式`
触发方式与参数说明（如 `/skill code-review src/tools/`）。

### `## 执行指令`
给模型的详细指令：角色定义、操作步骤、输出格式、约束条件。

## 加载路径

技能文件存放在以下目录，加载器按优先级扫描：

1. **项目级**：`<cwd>/.concertoai/skills/` — 项目专属技能，优先加载
2. **全局**：`~/.concertoai/skills/` — 跨项目共享技能

同名技能：项目级覆盖全局级。

## 调用方式

```
/skill list              → 列出所有可用技能
/skill <name>            → 将技能正文注入为 system 消息
/skill <name> <参数>     → 注入技能指令 + 将参数作为用户消息
```

## 约束

- 技能不支持嵌套调用（v2.0 限制）
- 技能文件大小建议 ≤ 10KB（过大影响上下文预算）
- 技能正文注入为 system 消息，不计入 `/skill` 命令本身
