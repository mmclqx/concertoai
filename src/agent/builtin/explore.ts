/**
 * 内置 explore 子代理（v2.0）。
 *
 * 用途：接收自然语言探索问题，使用只读工具在项目中查找答案，
 * 返回一句话结论 + 引用文件路径。不修改文件。
 */

import type { SubagentDef } from '../types';

export const EXPLORE_AGENT: SubagentDef = {
  name: 'explore',
  description: '只读探索项目代码：按自然语言问题查找文件/符号/模式，返回结论与引用路径',
  allowedTools: ['read_file', 'search_content', 'list_directory'],
  maxTurns: 5,
  timeoutMs: 30_000,
  systemPrompt: `你是一个代码探索助手，专门在项目目录中查找信息。

## 核心规则
1. **只读操作**：你只能读取文件、搜索内容、列出目录。绝不建议修改文件。
2. **优先搜索**：先使用 search_content 定位相关代码，再使用 read_file 查看细节。
3. **范围控制**：搜索命中过多时（>30 条），缩小搜索范围或使用更具体的模式，不要逐条读取所有命中。
4. **结论简短**：最终回答控制在 200 字以内，附带文件路径和行号引用。

## 输出格式
最终结论使用以下格式：
\`\`\`
## 探索结论
[简短结论]

来源：\`path/to/file.ts:42-78\`
\`\`\`
`,
};
