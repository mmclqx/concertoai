# Lumen

Lumen —— 面向个人开发者的**中文优先**终端编码助手 CLI（DeepSeek 驱动）。

在项目目录里启动：读取代码 → 提出 diff 方案 → 征求命令许可 → 跑验证 → 留下可续接的会话记录。

> 状态：v1.1 开发中（`npm run verify` 全绿，292 个用例；`npm audit` 0 漏洞）。
> v1.0 已发布 GitHub，v1.1 新增 MCP 协议接入 / 任务规划增强 / 跨会话记忆。

## 环境要求

- Node.js ≥ 22
- `DEEPSEEK_API_KEY` 环境变量（不写入任何配置文件）

## 安装

```bash
npm install -g @lumen/cli
```

安装后直接使用 `lumen` 命令（开发仓库内可用 `npm run dev` 代替）。

## 快速开始

```bash
# 1. 设置 API key（PowerShell 用 $env: 语法）
set DEEPSEEK_API_KEY=sk-xxx        # Windows cmd
export DEEPSEEK_API_KEY=sk-xxx     # macOS / Linux

# 2. 进入项目目录，启动交互式对话
lumen                              # 等价于 lumen chat

# 3. 一次性执行任务（非交互）
lumen run "看看这个项目"

# 4. 先生成执行计划，批准后自动执行
lumen plan "重构这个模块"
```

## 交互方式

| 操作 | 效果 |
| --- | --- |
| 输入文本 + Enter | 发送消息 |
| ← / → / Home / End | 移动光标（插入/删除位置） |
| ↑ / ↓ | 浏览本会话输入历史（去重） |
| Shift+Enter | 换行 |
| Ctrl+C（生成中） | 中断生成，已生成内容保留 |
| 审批框出现时按 `y` / `n` | 批准 / 拒绝编辑或命令 |
| 输入 `/plan 任务` | 对话内计划模式：先出计划，批准后执行 |
| Esc | 退出（会话自动保存） |

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `lumen` / `lumen chat` | 交互式对话（`-r [id]` 恢复 / `-l` 仅列会话 / `-m` 模型 / `--lang`） |
| `lumen run "任务"` | 一次性执行（`--auto-approve` 谨慎使用 / `-m` / `--lang`） |
| `lumen plan "任务"` | 计划-批准-执行三段式（`--auto-approve` 跳过确认） |
| `lumen chat -l` | 仅打印历史会话列表 |

## 安全模型

- **编辑与命令一律审批**：`edit_file` / `run_command` 在落盘/执行前弹出审批框，无 yolo 模式；审批拒绝绝不自动重试
- **白名单免审批**：`git status` / `git diff` / `npm test` / `npm run test` 默认命中前缀直接执行（可在配置中自定义）
- **审批策略**：`ask`（默认逐个审批）/ `allowlist-only`（只放行白名单，其余一律拒绝，不弹框）
- **fail-closed**：审批回调未配置（如 `run` 默认模式）时，危险操作一律拒绝
- **路径沙箱**：所有工具只能访问项目目录内（`..` 逃逸 / 绝对路径越界一律拒绝）
- **上下文保护**：文件读取、搜索结果、工具回填、命令输出均按长度截断；超模型 80% 预算自动裁剪旧消息
- **健壮性**：可修复的工具失败限 2 次重试后终止；连续失败、循环失控均有上限

## 配置

配置文件：`~/.lumen/config.json`（带 `schemaVersion` 字段；不存在即用默认）。

```json
{
  "schemaVersion": 1,
  "defaultModel": "deepseek-v4-flash",
  "allowlist": ["npm test", "git status"],
  "approvalPolicy": "ask",
  "sessionDir": "~/.lumen/sessions",
  "locale": "zh"
}
```

优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

| 配置项 | 环境变量 | 默认 |
| --- | --- | --- |
| 模型 | `LUMEN_MODEL` | deepseek-v4-flash |
| 白名单（逗号分隔） | `LUMEN_ALLOWLIST` | 内置 4 条 |
| 审批策略 | `LUMEN_APPROVAL` | ask |
| 会话目录 | `LUMEN_SESSION_DIR` | `~/.lumen/sessions` |
| 语言 | `LUMEN_LOCALE`（或 `LANG` zh/en 前缀） | zh |

## 会话记录

- 存储位置：`~/.lumen/sessions/<时间戳>.jsonl`（JSONL，每行一条消息）
- 自动保存：每轮对话结束即追加落盘；`lumen chat -r` 无 ID 时列出全部会话供选择
- 项目规则：自动加载项目根的 `AGENTS.md`（优先）或 `CARBON.md`，截断至 8000 字符注入系统提示

## FAQ

**没有 API key 会怎样？** 启动时报错退出，提示设置 `DEEPSEEK_API_KEY`。

**管道/编辑器内嵌终端无法使用 chat？** chat 需要真实 TTY；用 `lumen run "任务"` 走非交互路径。

**成本如何？** 状态条实时显示 token 与成本（API 真实 usage，带"（真实）"标记）；模型定价按 DeepSeek 官方定价页维护在 `MODEL_PROFILES`。

**数据存在哪？** 全部本地：会话在 `~/.lumen/sessions/`，配置在 `~/.lumen/config.json`；仅对话请求发送给 DeepSeek API。

**如何换英文？** `lumen chat --lang en`，或配置 `locale: "en"` / 环境变量 `LUMEN_LOCALE=en`。

**从 v0.1 迁移？** v0.1 为开发期版本（`npm run dev` 直接跑源码）；v1.0 通过 `npm install -g @lumen/cli` 安装，命令与配置完全兼容，会话文件格式不变（JSONL）。

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发运行（tsx 直接跑源码） |
| `npm run test` / `test:watch` | 单元 + 集成 + UI 渲染测试 |
| `npm run lint` / `lint:fix` | Biome 检查 / 自动修复 |
| `npm run typecheck` | TypeScript 严格类型检查 |
| `npm run build` | tsup 打包到 `dist/`（ESM + d.ts + CLI 入口） |
| `npm run verify` | 验收主命令：build + lint + typecheck + test |

## 文档

- [用户手册](docs/05-用户与开发指南/user-guide.md) —— 详细使用说明
- [架构文档](docs/02-架构设计/ARCHITECTURE.md) —— 技术设计
- [发布流程](docs/04-发布流程.md) —— 版本与发布
- [贡献指南](CONTRIBUTING.md) —— 参与开发

## 版权

本项目（Lumen）为**全新独立项目**，非任何上游项目的复制或派生。

所有代码、文档、测试的版权归项目作者所有（Copyright © 2026 Lumen 项目作者 mmclqx），保留一切权利。对外使用条款见 [LICENSE](LICENSE)。
