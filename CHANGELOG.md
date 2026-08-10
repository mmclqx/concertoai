# 变更日志（Changelog）

## 维护约定

- 每个未发布变更先追加到 `## [Unreleased]`，发布时移动到对应版本小节；
- 条目按类型分组：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）；
- 版本号由 `npm version <patch|minor|major>` 管理（自动 bump + 同步 `src/index.ts` 的 VERSION + git tag）。

## [Unreleased]

> **版本归位（2026-08-10 · T0.1）**：本区块同时包含 v2.2（peak-time / model-switcher / ADR-023，智能成本控制）与 v3.1（balance / doctor 等预留功能）两组未发布变更，均**随 v3.1.0 一并发布**（不补发 v2.2.0，理由见 `docs/03-开发计划与任务/v3.1-dev-plan-ai.md` §9——避免两套 Unreleased 并存；两主题同为「成本控制 + 日常体验」）。发布时整块移入 `## [3.1.0]` 条目。

### Added — v3.1

- **`concertoai balance` 命令**：查询 DeepSeek 账户余额（官方 `GET /user/balance`），按币种输出总额/赠送/充值；新模块 `src/balance/`（`fetchBalance` + `BalanceError` + 15s 超时）
- **`concertoai doctor` 命令**：环境诊断（Node 版本/平台/API Key/配置文件/会话目录/模型表 + 账户余额），单项失败不中断、汇总退出码；无 API Key 时余额项标记跳过
- **i18n 扩展**：`balance` / `doctor` 两组文案（zh/en 键同构，en.test.ts 断言一致）
- **测试**：`tests/balance/`（5 用例）+ `tests/cli/balance.test.ts`（4 用例）+ `tests/cli/doctor.test.ts`（5 用例），总计 750 用例全绿

### Added — v2.2（智能成本控制）

- **高峰时段检测**：`src/core/peak-time.ts`（`isWorkday` / `isPeakHour` / `isPeakTime`），工作日（周一至周五）9:00-12:00 / 14:00-18:00 判定为高峰时段（左闭右开）
- **模型自动切换器**：`src/core/model-switcher.ts`；启动时读取 `~/.concertoai/config.json` 的 `peakTimeStrategy`（`ask` 交互确认 / `switch` 直接切换 / `ignore` 忽略），高峰时段可切到本地 ollama 模型
- **配置扩展**：`ConcertoAIConfig` 新增 `peakTimeStrategy`（默认 `ask`）/ `ollamaModel`（默认 `qwen3.6:27b-q4_K_M`）/ `ollamaBaseUrl`（默认 `http://localhost:11434/v1`），`resolveConfig` 兜底校验非法值
- **CLI 集成**：`concertoai` / `concertoai chat` 启动经 `resolveStartupModel` 应用切换；本地模型按 `ollamaBaseUrl` 构建客户端（OpenAI 兼容 /v1）、成本按 0 展示（避免 `costFor` 未知模型抛错）；非交互环境 ask 策略自动跳过不阻塞
- **i18n 扩展**：`peakTime` 五条文案（askSwitch / switched / declined / ignored / noInteractive）
- **测试**：`tests/core/peak-time.test.ts`（8 用例）+ `tests/core/model-switcher.test.ts`（16 用例）+ `tests/store/config.test.ts` 新增 3 用例，总计 750 用例全绿

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
