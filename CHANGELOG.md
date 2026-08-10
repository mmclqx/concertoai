# 变更日志（Changelog）

## 维护约定

- 每个未发布变更先追加到 `## [Unreleased]`，发布时移动到对应版本小节；
- 条目按类型分组：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）；
- 版本号由 `npm version <patch|minor|major>` 管理（自动 bump + 同步 `src/index.ts` 的 VERSION + git tag）。

## [3.1.0] — 2026-08-11

> **版本归位（2026-08-10 · T0.1 / ADR-028）**：v2.2（peak-time / model-switcher，智能成本控制）与 v3.1（balance / doctor / self-heal / project / account / team / audit export 等）功能**随 v3.1.0 一并发布**（不补发 v2.2.0，避免两套 Unreleased 并存；两主题同为「成本控制 + 日常体验」）。

### Added — v3.1（AI 自我修复）

- **Verify 分类器**（`src/loop/self-heal.ts`）：`npm run verify` 输出四段统一解析（build/lint/type/test），复用 `qa.parseVerifyOutput` + Biome/tsc 段解析，输出统一 `VerifyReport`（passed + errors[]: stage/file/line/code/message + parseFailed）；ANSI 剥离 + 段标记切分 + 尽力而为
- **修复策略执行器**：lint → 确定性 `npm run lint:fix`（白名单免审批）；type 简单错误（缺 import / 缺类型标注）→ 模型生成修复（审批 fail-closed，每次 1 个）；type 复杂 / build / test → 结构化反馈不自动修；`MAX_SELF_HEAL_ATTEMPTS=2` 超限转人工
- **快照与回滚**：修复前 `SnapshotManager` 登记快照，修复后强制 verify + diff 审查；目标错误未消失或引入新错误 → rollback 恢复原状；修复有效 → commit 清理
- **触发入口**：`concertoai self-heal`（非交互）+ chat 内 `/self-heal`（修复期间状态条可见）；仅修复 ConcertoAI 自身代码，不自动修用户项目

### Added — v3.1（多项目管理 + 多租户登录）

- **项目注册表**（`src/store/projects.ts`）：`~/.concertoai/projects.json` CRUD + 重名/嵌套拒绝 + 路径规范化（`\` → `/`）+ 宽松读取
- **project 命令**：`concertoai project add/list/remove/info/switch`；启动 `-p <name>`（等价 cd）或按 cwd 自动探测
- **隔离矩阵**：会话按项目分目录（`sessions/<projectKey>/`）、审批白名单项目级合并、MCP 按项目声明；全局配置/技能/Agent 共享；无项目时行为与 v3.0 一致
- **多账号存储**（`src/store/accounts.ts`）：`~/.concertoai/accounts/<name>/config.json`（0600）+ `active-account` 指针；Key 不落日志
- **account 命令**：`concertoai login/logout/whoami/account switch|list`；login 交互输入 Key 不回显（`--key` 供 CI）；Key 打码 `sk-****abcd`
- **API Key 解析链**：CLI > 环境变量 `DEEPSEEK_API_KEY` > active account > config.json；doctor 余额行标注账号/环境变量优先

### Added — v3.1（结构化错误 + Orchestrator CLI + 运维）

- **结构化错误增强**（`src/tools/error-codes.ts`）：ToolResult 支持 `code?`/`suggestion?`（可选，向后兼容）；read（PATH_OUTSIDE_SANDBOX/FILE_NOT_FOUND/DIR_NOT_FOUND/SENSITIVE_FILE）、edit（SEARCH_NOT_FOUND/SEARCH_NOT_UNIQUE/FILE_ALREADY_EXISTS/WRITE_FAILED/EDIT_REJECTED）、shell（SHELL_REJECTED/TIMEOUT/COMMAND_NOT_FOUND/EXIT_N）、knowledge（ENTITY_NOT_FOUND/STORE_UNAVAILABLE）全带中文建议；registry 兜底 `inferErrorCode`；ToolRepairError 渲染 💡 建议行
- **`concertoai team "<任务>"`**（`src/cli/team.ts`）：拆解 → 展示确认 → 4 角色装配（Architect/Coder/Reviewer/QA）→ 对抗性闭环（≤5 次）→ 事务回滚兜底 → 聚合工件；`--dry-run` 仅输出拆解清单
- **`/orchestrate <任务>`**（`src/cli/slash/orchestrate.ts`）：chat 内触发 team 全链路，traceStore 透传（`o` 键面板可见 spans）+ 审计记录
- **`concertoai audit export [--out <file>]`**（`src/cli/audit.ts`）：审计日志保序 JSON 导出（复用 `AuditLogger.exportJson`），无文件非错误退出
- **`/agent update [name]`**：指定名称复用 installer update 语义（版本落后覆盖 / 已最新提示）；无参列出可更新 Agent
- **`/review --severity <strict|normal|lenient>`**：`determineReviewAction` 三档阈值（strict=medium 必拒 / normal=critical 必拒+medium 结合 QA 失败可拒 / lenient=仅 critical 拒），非法值报错列出合法值

### Added — v2.2 + 预留功能（随 v3.1.0 发布）

- **高峰时段检测与模型切换**：`src/core/peak-time.ts` + `model-switcher.ts`；工作日 9:00-12:00 / 14:00-18:00 高峰，`peakTimeStrategy`（ask/switch/ignore）决定是否切本地 ollama 模型
- **`concertoai balance` 命令**：查询 DeepSeek 账户余额（官方 `GET /user/balance`），按币种输出总额/赠送/充值
- **`concertoai doctor` 命令**：环境诊断（Node/平台/API Key/配置/会话/模型/余额），单项失败不中断、汇总退出码；余额行标注账号（v3.1 多账号接入）
- **配置目录迁移**：`~/.lumen → ~/.concertoai` 幂等迁移（rename 失败回退复制），路径定义单一来源 `store/paths.ts`
- **进程级崩溃日志**：`src/cli/crash-handler.ts`，uncaughtException / unhandledRejection → `~/.concertoai/crash.log`（同步写盘 + 非零退出）
- **审批键位优化**：审批框 `y/Enter` 批准、`n/Esc` 拒绝（v3.1 M1 附带）
- **trace 查询优化**（S4）：`TraceStore.queryByTaskId` 维护 parentTaskId 子任务索引，由 O(n²) 降为 O(n)

### 测试（v3.1）

- 新增 `tests/loop/self-heal.test.ts`、`tests/loop/error-reporting.test.ts`、`tests/store/projects.test.ts`、`tests/store/accounts.test.ts`、`tests/cli/project.test.ts`、`tests/cli/project-isolation.test.ts`、`tests/cli/account.test.ts`、`tests/cli/team.test.ts`、`tests/cli/audit.test.ts`、`tests/cli/slash-orchestrate.test.ts`、`tests/cli/slash-review.test.ts`、`tests/e2e/team-cli.test.ts`、`tests/e2e/self-heal.test.ts`、`tests/e2e/project-isolation.test.ts` 等
- **基线校准**：84 文件 / 923 用例全绿（`npm run verify`），npm audit 0 漏洞

## [3.0.0] — 2026-08-09

### Added — v3.0

- **多 Agent 协作团队（Orchestrator 模式）**：`src/orchestrator/` + `src/agents/`；需求拆解为 Task[]（含依赖）→ DAG 拓扑调度（并行/重试/冲突检测）→ 聚合交付
- **4 个专业 Agent**：`architect`（需求→设计 spec）/ `coder`（实现+修复）/ `reviewer`（9 维审查 approve/reject 打回）/ `qa`（沙箱执行 npm run verify）
- **对抗性闭环**：Coder → Reviewer → QA 修复循环（≤ 5 次，`MAX_LOOP_ATTEMPTS`），超限退出保留中间结果并触发事务回滚
- **多文件事务回滚**：`SnapshotManager` 任务级快照（`.concertoai/snapshots/<taskId>/`）+ 原子回滚 + 外部修改检测 + `concertoai snapshot [list|clean]` 命令
- **Agent 市场**：`src/market/`；`/agent list / install <name> / remove <name> / promote <skill>`；复用技能市场 registry.json 架构 + sha256 校验 + 接口合规检查
- **可观测性**：`src/observable/`；TraceStore 调用链追踪（LRU 5000）+ AuditLogger JSONL 审计日志（<10ms）+ ObservabilityPanel 流程树 TUI
- **显式上下文管理器**：AgentContext 序列化/子集提取/合并（≤64KB）+ 来源追踪（ADR-016 修正项落实）
- **任务状态机 + 调度器**：转换守卫 + onTransition 事件；拓扑排序 + 并发池 + 循环依赖检测 + 指数退避重试
- **ADR-015~020 回填**：DECISIONS.md 补齐 v3.0 全部架构决策记录
- **Agent 开发指南**：`docs/05-用户与开发指南/agent-dev-guide.md`（接口契约 + 脚手架 + 打包发布 + 发布清单）

### Changed — v3.0

- `src/agent/`（v2.1 子代理）与 `src/agents/`（v3.0 专业 Agent）并存；子代理保持 explore/research 隔离执行
- `src/cli/slash/agent.ts` 命令层接口化（`AgentManager` 窄接口，根治测试绑定具体类）
- 上下文管理：Agent 侧显式上下文（64KB）与主循环裁剪（80% 预算）双轨

### Fixed — v3.0

- 多 Agent 写盘无原子性 → 任务级事务回滚兜底（含已审批部分文件）
- 外部 Agent 越权风险 → 权限声明 fail-closed + 接口合规检查 + sha256 校验三重防护

## [2.1.0] — 2026-08-08

### Added
- **子代理 MCP 工具支持**：`SubagentDef.allowedMcpServers` 字段使子代理可按声明加载 MCP 服务工具
- **技能嵌套与子代理调用**：`@skill:<name>` 内联展开 + `@agent:<name>` 运行时子代理触发；循环检测 + 深度限制 ≤ 3
- **技能市场基础**：`/skill install / search / update` 命令 + `skills/registry.json` 注册表 + sha256 校验
- **轻量级知识图谱 + RAG**：Entity/Relation/Observation 三层模型 + JSONL 持久化 + TF-IDF 搜索 + LRU 淘汰 + 5 个 `knowledge_*` 工具
- **Reviewer Agent 代码评审智能体**：9 维审查 / 5 子代理并行 / 自动测试 / `/review` 命令 / 10 份知识库文档
- **双源记忆合并**：MemoryInjector 同时检索本地知识图谱 + MCP memory，按 (entityName, observation) 去重

### Changed
- `SubagentSpawner` 构造接收可选 `McpManager` 参数（向后兼容）
- `SkillLoader.loadAll()` 改为两遍加载（先解析注册 → 后展开引用）
- `buildRegistry()` 接受可选 `knowledgeTools` 参数
- `MemoryInjector` 支持可选 `KnowledgeStore` 双源检索

### Fixed
- `maskSecrets()` / `.env` 文件读取拒绝 / `search_content` 跳过 `.env`（安全加固）

## [2.0.0] - 2026-08-08

### Added — v2.0

- **BPE 精确 Token 计数**：使用 `tiktoken`（o200k_base 编码器）替换 CJK 加权估算，误差 <5%；懒加载单例避免重复初始化
- **缓存命中成本**：状态条显示 `💾 缓存命中 N token（¥X）`，缓存命中与普通输入按各自单价计费
- **智能摘要压缩**：上下文超 80% 预算时优先调模型生成对话摘要，失败回退旧裁剪策略
- **子代理系统**：`src/agent/` 模块；`explore`（只读探索）和 `research`（深度研究）两个内置子代理
- **spawn_subagent 工具**：模型可调用子代理执行隔离任务，结果结构化回填不污染主对话
- **技能系统**：`src/skill/` 模块；SKILL.md 规范 + 3 个内置技能（code-review/explain/refactor）
- **/skill 命令**：`/skill list` 列出技能、`/skill <name>` 注入技能指令为 system prompt
- **MCP 动态管理**：`/mcp status` `/mcp connect <name>` `/mcp disconnect <name>` 运行时管理
- **MCP 状态条**：状态条显示 `🔌 N/M 服务` 连接摘要
- **子代理/技能 E2E 测试**：`tests/agent/` 和 `tests/skill/` 共 13 个新用例

### Changed — v2.0

- `costFor` 支持缓存命中 token 拆分计费；新增 `cacheHitCostFor` 函数
- `trimContext` → `compressContext`（异步智能压缩）；`trimContext` 保留为降级方案
- `LoopOptions.maxTurns` 可选覆写（子代理用更少轮数上限）
- 旧 `estimateTokens` 内部指向 BPE `countTokens`（向后兼容别名，v2.1 移除）

### Added — v1.1（随 v2.0.0 首次发布）

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
- **配置扩展**：`ConcertoAIConfig.mcpServers` 支持 MCP 服务连接配置

## [0.1.0] - 2026-08-07

### Added

- CLI 三命令：`concertoai chat`（交互式 TUI）/ `concertoai run <task>`（一次性执行）/ `concertoai plan <task>`（计划-批准-执行）
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
