# 变更日志（Changelog）

## 维护约定

- 每个未发布变更先追加到 `## [Unreleased]`，发布时移动到对应版本小节；
- 条目按类型分组：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）；
- 版本号由 `npm version <patch|minor|major>` 管理（自动 bump + 同步 `src/index.ts` 的 VERSION + git tag）。

## [Unreleased]

### Added — v1.1

- **MCP 协议接入**：`src/mcp/` 模块（客户端/管理器/类型），支持 stdio transport 连接外部 MCP 服务
- **MCP 工具注册**：MCP 服务工具以 `serverName/toolName` 前缀自动注册到 ToolRegistry
- **filesystem/memory/github MCP 预配置**：`src/mcp/builtin-servers.ts` 内置三种推荐配置
- **MCP Memory 注入**：`src/loop/memory-injector.ts` 每轮对话前检索 MCP memory 知识图谱
- **跨会话本地记忆**：`src/store/memory-store.ts` 项目级 JSONL 记忆存储（`.lumen-memory/`）
- **本地记忆注入**：`src/loop/local-memory.ts` 本地记忆检索合并到系统提示
- **记忆管理命令**：`/remember` `/forget` `/memories` 斜杠命令（`src/cli/slash/memory.ts`）
- **计划依赖检测**：`src/planner/deps.ts` 步骤依赖解析 + 拓扑排序 + 循环检测 + 并行组
- **计划进度跟踪**：`src/planner/progress.ts` 状态机 + PlanProgressView TUI 组件
- **计划回滚**：`src/planner/rollback.ts` SnapshotStore 文件快照与恢复，edit 工具自动快照
- **配置扩展**：`LumenConfig.mcpServers` 支持 MCP 服务连接配置

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
