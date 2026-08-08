# Lumen 用户手册

> 面向使用 Lumen 完成日常编码辅助的个人开发者。版本：v2.0。

## 1. 安装与升级

### 安装

```bash
npm install -g @lumen/cli
```

要求 Node.js ≥ 22。验证：

```bash
lumen --version
lumen --help
```

### 升级

```bash
npm update -g @lumen/cli
```

会话与配置存放在 `~/.lumen/`，升级不影响已有数据。

## 2. 命令参考

### `lumen` / `lumen chat` —— 交互式对话

| 选项 | 说明 |
| --- | --- |
| `-r, --resume [id]` | 恢复会话；不带 ID 时列出全部会话供键盘选择 |
| `-l, --list` | 仅打印历史会话列表（时间/消息数/首条摘要），不进入对话 |
| `-m, --model <id>` | 指定模型（默认读取配置，最后兜底 deepseek-v4-flash） |
| `--lang <zh\|en>` | 界面语言 |

### `lumen run "<任务>"` —— 一次性执行

| 选项 | 说明 |
| --- | --- |
| `-m, --model <id>` | 指定模型 |
| `--auto-approve` | 自动批准编辑与命令执行（**谨慎**；默认危险操作全部拒绝） |
| `--lang <zh\|en>` | 界面语言 |

默认（无 `--auto-approve`）下，编辑与命令一律拒绝（fail-closed），只读工具与白名单命令可执行。

### `lumen plan "<任务>"` —— 计划模式

1. 模型输出分步执行计划（markdown 列表）；
2. 展示计划，终端输入 `y` 批准 / `n` 拒绝（需交互式终端，或 `--auto-approve` 跳过）；
3. 批准后，模型按计划逐步执行（编辑/命令仍走审批，除非 `--auto-approve`）。

计划模式增强：
- **依赖检测**：自动分析步骤间依赖关系，按拓扑顺序调度，循环依赖提前报错；
- **进度跟踪**：TUI 实时展示每步状态（⏳ 进行中 / ✅ 已完成 / ❌ 失败），失败步骤可跳过或重试；
- **文件回滚**：编辑前自动快照，步骤失败时可回滚已完成的文件变更。

## 3. 交互细节

### 输入框

- ← / → 移动光标，Home / End 跳转行首尾；
- Backspace / Delete 删除光标前/处字符；
- ↑ / ↓ 浏览本会话输入历史（重复输入自动去重，上限 50 条）；
- Shift+Enter 换行；Enter 发送。

### 生成过程

- 思考中/工具执行时显示 Braille spinner；
- **Ctrl+C** 中断生成：已生成内容保留并回填会话，可继续输入；
- 网络中断：保留已生成部分并提示中文错误，不自动重连，请重试。

### 审批

- `edit_file` / 非白名单 `run_command` 会弹出审批框（黄色边框）；
- `y` 批准、`n` 拒绝；拒绝后模型会收到拒绝信息并调整方案，但**不会自动重试同一操作**；
- 审批策略可在配置中改为 `allowlist-only`（只放行白名单，其余一律拒绝且不弹框）。

### 对话内计划（/plan）

输入 `/plan 任务`：先由模型输出计划 → 弹出 PlanConfirm 审批框（品红色边框）→ `y` 批准后自动执行，`n` 拒绝。

## 4. 配置参考

文件：`~/.lumen/config.json`。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | number | 1 | 配置格式版本；不匹配时按空配置处理 |
| `defaultModel` | string | deepseek-v4-flash | 默认模型 ID |
| `allowlist` | string[] | 内置 4 条 | 免审批命令前缀 |
| `approvalPolicy` | `"ask" \| "allowlist-only"` | ask | 审批策略 |
| `sessionDir` | string | `~/.lumen/sessions` | 会话存储目录 |
| `locale` | `"zh" \| "en"` | zh | 界面语言 |
| `mcpServers` | `MCPServerEntry[]` | `[]` | MCP 服务连接配置（v1.1 新增），每项含 `name`/`command`/`args`/`env` |

优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

环境变量：`LUMEN_MODEL` / `LUMEN_ALLOWLIST`（逗号分隔）/ `LUMEN_APPROVAL` / `LUMEN_SESSION_DIR` / `LUMEN_LOCALE`；语言还会参考系统 `LANG`（zh/en 前缀）。

## 5. MCP 服务配置

Lumen 支持通过 [MCP（Model Context Protocol）](https://modelcontextprotocol.io) 连接外部工具服务。

### 配置示例

```json
{
  "schemaVersion": 1,
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    {
      "name": "memory",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  ]
}
```

### 内置预配置

三种常用 MCP 服务的推荐配置（`src/mcp/builtin-servers.ts`）：

| 服务 | 用途 | 需额外准备 |
| --- | --- | --- |
| `filesystem` | 文件系统读写（受限在指定目录内） | 允许访问的目录路径 |
| `memory` | 跨会话知识图谱存储与检索 | 无 |
| `github` | GitHub 仓库操作（Issue/PR/文件） | `GITHUB_PERSONAL_ACCESS_TOKEN` 环境变量 |

### 工作原理

- 启动时自动连接已配置的 MCP 服务（并发），工具以 `服务名/工具名` 格式注册；
- MCP 工具与内置工具共存——MCP 服务不可用时自动降级，不影响内置工具；
- 模型在对话中可直接调用 MCP 工具（如 `filesystem/read_file`），调用结果回填上下文。

## 6. 跨会话记忆

Lumen 支持项目级跨会话记忆，帮助模型在多次对话中「记住」项目上下文。

### 存储位置

项目根目录 `.lumen-memory/memories.jsonl`（JSONL 格式，每行一条记忆）。各项目独立存储，互不干扰。

### 对话内命令

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `/remember <内容>` | 模型生成记忆摘要，确认后写入 | `/remember 这个项目使用 vitest 做测试框架` |
| `/forget <关键词>` | 搜索匹配记忆，选择后删除 | `/forget vitest` |
| `/memories` | 列出当前项目所有已保存的记忆 | `/memories` |

### 自动检索

每轮对话开始时，Lumen 自动从本地记忆中检索与当前问题相关的内容（按关键词 + 标签匹配，最多 5 条），以「# 项目记忆」块注入系统提示。无相关记忆时不注入。

> **与 MCP memory 的关系**：本地记忆（`.lumen-memory/`）是零依赖的轻量方案，MCP memory 服务提供知识图谱能力。两者可同时启用，记忆合并注入上下文。

## 7. 会话管理

- 每轮对话结束自动追加到 `~/.lumen/sessions/<id>.jsonl`；
- `lumen chat -r` 列出全部会话（时间/消息数/首条摘要），↑/↓ + Enter 选择；
- 会话文件为 JSONL：每行一条消息，可手动编辑（损坏行会被跳过并计数）；
- 并发写入有保护：同一会话内串行、原子落盘；跨进程冲突会提示。

## 8. 安全模型

- 审批门控：编辑与命令一律审批（fail-closed），无 yolo 模式；
- 路径沙箱：工具只能访问项目目录内；
- 白名单：命令前缀词边界匹配（`npm test` 命中 `npm test --x`，不命中 `npm testx`）；
- 截断：文件 50k 字符、搜索结果 100 条、工具回填 20k、命令输出 20k、项目规则 8k；
- 上下文：超模型 80% 预算自动裁剪（保留 system + 最近轮），记录日志；
- 防失控：工具循环上限 10 轮；可修复失败累计超 2 次终止；审批拒绝/越界不进入重试管线。

## 9. 故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报"未找到 DEEPSEEK_API_KEY" | 设置环境变量后重试 |
| chat 提示需要交互式终端 | 用真实终端运行，或改用 `lumen run` |
| 生成中断/网络错误 | 已保留内容会回填；直接重试即可 |
| 状态条显示"（真实）" | token 为 API 真实用量；流式中为估算值 |
| 命令全部被拒绝 | run 模式需 `--auto-approve`；chat 模式确认审批框按 y |
| 想要英文界面 | `--lang en` 或配置 `locale` |

## 10. 从 v0.1 迁移

v1.0 从 v0.1 的变更：

- 安装方式改为 `npm install -g @lumen/cli`（`lumen` 命令）；
- 会话文件格式不变（JSONL），旧会话可直接 `lumen chat -r` 恢复；
- 新增 `lumen plan`、对话内 `/plan`、配置系统、EN 界面；
- 交互增强：光标/历史输入、markdown 渲染与代码高亮、真实 token 统计。

v1.1 新增：

- **MCP 协议接入**：连接外部工具服务（filesystem / memory / github）；
- **跨会话记忆**：`/remember` `/forget` `/memories` 管理项目知识；
- **计划增强**：依赖检测、进度跟踪、文件回滚。

v2.0 新增：

- **BPE 精确 Token 计数**：`tiktoken`（o200k_base）替换 CJK 加权估算，误差 <5%，状态条显示缓存命中成本（`💾 缓存命中 N token（¥X）`）；
- **智能摘要压缩**：上下文超 80% 预算时优先调模型生成摘要，失败回退旧裁剪策略；
- **子代理系统**：模型可调用 `spawn_subagent` 启动隔离子代理（`explore` / `research`），独立上下文 + 只读工具集，回填结论不污染主对话；
- **技能系统**：`/skill list` 列出技能、`/skill <name>` 注入 system prompt（内置 code-review / explain / refactor，自定义放 `.lumen/skills/<name>/SKILL.md`）；
- **MCP 动态管理**：`/mcp status` `/mcp connect <name>` `/mcp disconnect <name>` 运行时管理连接，状态条显示 `🔌 N/M 服务`。
