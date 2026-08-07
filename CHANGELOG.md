# 变更日志（Changelog）

## 维护约定

- 每个未发布变更先追加到 `## [Unreleased]`，发布时移动到对应版本小节；
- 条目按类型分组：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）；
- 版本号由 `npm version <patch|minor|major>` 管理（自动 bump + 同步 `src/index.ts` 的 VERSION + git tag）。

## [Unreleased]

- 无

## [0.1.0] - 2026-08-07

### Added

- CLI 三命令：`lumen chat`（交互式 TUI）/ `lumen run <task>`（一次性执行）/ `lumen plan <task>`（计划-批准-执行）
- DeepSeek 流式对话（SSE 解析、超时与指数退避重试、用户中断与断流保留）
- 5 个核心工具：read_file / search_content / list_directory / edit_file / run_command
- 安全基线：编辑与命令一律审批（fail-closed）、路径沙箱、结果截断、命令白名单免审批
- 会话持久化（JSONL）与 resume（`-r` 交互式会话列表、`-l` 仅列表）
- Ink TUI：markdown 渲染 + 代码高亮、输入框光标/历史、动态进度指示、状态条（真实 usage）
- 项目规则加载（AGENTS.md / CARBON.md）
- 配置系统（`~/.lumen/config.json`，CLI > 环境变量 > 配置 > 默认）
- 上下文窗口管理（80% 预算裁剪）、并行工具调度、工具调用修复管线（限次重试）

### Changed

- 模型表按 DeepSeek 官方定价页核实（flash / pro 的 ID、上下文 1M、定价、并发限制）

### Fixed

- CRLF/BOM 编辑兼容、会话并发写保护（进程内锁 + 原子写入 + 冲突检测）
