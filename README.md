# Lumen

Lumen —— 面向个人开发者的**中文优先**终端编码助手 CLI（DeepSeek 驱动）。

在项目目录里启动：读取代码 → 提出 diff 方案 → 征求命令许可 → 跑验证 → 留下会话记录。

> 状态：v0.1 开发完成（全部 10 个任务验收通过，见 `docs/dev/TASKS.md`）。

## 环境要求

- Node.js ≥ 22（原生 fetch / SSE 流式）
- `DEEPSEEK_API_KEY` 环境变量（不写入任何配置文件）

## 快速开始

```bash
# 1. 设置 API key
set DEEPSEEK_API_KEY=sk-xxx        # Windows
export DEEPSEEK_API_KEY=sk-xxx     # macOS / Linux

# 2. 进入项目目录，启动交互式对话
npm run dev                        # 等价于 lumen chat

# 3. 或者一次性执行任务（非交互）
npm run dev -- run "看看这个项目"   # 等价于 lumen run "任务"
```

## 交互方式

| 操作 | 效果 |
| --- | --- |
| 输入文本 + Enter | 发送消息 |
| Shift+Enter | 换行 |
| 审批框出现时按 `y` / `n` | 批准 / 拒绝编辑或命令 |
| Esc | 退出（会话自动保存） |
| `lumen chat -r <会话ID>` | 恢复历史会话继续对话 |
| `lumen run "任务" --auto-approve` | 非交互执行并自动批准（谨慎） |

## 安全模型

- **编辑与命令一律审批**：`edit_file` / `run_command` 在落盘/执行前弹出审批框，无 yolo 模式
- **白名单免审批**：`git status` / `git diff` / `npm test` / `npm run test` 命中前缀直接执行
- **fail-closed**：审批回调未配置（如 `run` 默认模式）时，危险操作一律拒绝
- **路径沙箱**：所有工具只能访问项目目录内（`..` 逃逸 / 绝对路径越界一律拒绝）
- **上下文保护**：文件读取、搜索结果、工具回填、命令输出均按长度截断

## 会话记录

- 存储位置：`~/.lumen/sessions/<时间戳>.jsonl`（JSONL，每行一条消息）
- 自动保存：每轮对话结束即追加落盘，可随时 `-r` 续接
- 项目规则：自动加载项目根的 `AGENTS.md`（优先）或 `CARBON.md`，截断至 8000 字符注入系统提示

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发运行（进入 chat） |
| `npm run test` | 单元 + 集成 + UI 渲染测试（vitest，131 个用例） |
| `npm run test:watch` | 测试监听模式 |
| `npm run lint` / `npm run lint:fix` | Biome 检查 / 自动修复 |
| `npm run typecheck` | TypeScript 严格类型检查 |
| `npm run build` | tsup 打包到 `dist/`（ESM + d.ts） |
| `npm run verify` | 验收主命令：build + lint + typecheck + test |

## 目录结构

```
lumen/
├── docs/dev/             # 开发文档（开发计划、任务拆解）
├── src/
│   ├── cli/              # commander 入口（chat / run）
│   ├── ui/               # Ink TUI（App / 输入框 / 流式 / 审批框 / 状态条）
│   ├── loop/             # 会话主循环（工具分发 / 结果回填）
│   ├── model/            # DeepSeek SSE 客户端 / 模型表 / token 估算
│   ├── tools/            # 工具注册表（读 / 编辑 / shell，含审批门控）
│   ├── store/            # 会话持久化 / 项目规则加载
│   └── i18n/             # 中文文案表（全项目唯一文案来源）
└── tests/                # 镜像 src 结构的测试（12 个测试文件，131 个用例）
```

## 版权

本项目（Lumen）为**全新独立项目**，非任何上游项目的复制或派生。

所有代码、文档、测试的版权归项目作者所有（Copyright © 2026 Lumen 项目作者），保留一切权利。对外使用条款见 [LICENSE](LICENSE)。
