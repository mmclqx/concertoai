# ConcertoAI 架构文档

> 版本：v3.0（含 v2.2 / v3.1 预留已交付功能）· 2026-08-10
> 本文档基于当前代码实现编写，作为后续维护与扩展的技术参考。
> 配套文档：[v3.0 开发任务](../03-开发计划与任务/v3.0-dev-tasks.md)、[v3.1 开发计划](../03-开发计划与任务/v3.1-dev-plan-ai.md)、[任务看板](../03-开发计划与任务/TASKS.md)

---

## 1. 项目概览

ConcertoAI 是一款**中文优先**的终端编码助手 CLI（DeepSeek 驱动）。在项目目录里启动后，它读取代码、提出 diff 方案、征求命令许可、跑验证，并留下可续接的会话记录。

- **技术栈**：TypeScript (strict) + Node ≥22 + ESM，Ink 7 (React 19) 渲染 TUI，commander 解析 CLI，zod 做工具参数校验，vitest 测试，Biome 检查，tsup 打包
- **运行时依赖**：`ink` / `react` / `commander` / `zod` / `cli-highlight` / `chalk`
- **测试现状**：69 个测试文件、750 个用例，`npm run verify` 全绿，`npm audit` 0 漏洞；已用真实 `DEEPSEEK_API_KEY` 完成端到端冒烟
- **安全基线**：编辑与命令一律审批（fail-closed）、路径沙箱、结果截断、白名单免审批——无 yolo 模式
- **v3.1 预留功能（已交付）**：`concertoai balance`（余额查询）/ `concertoai doctor`（环境诊断）、配置目录迁移 `~/.lumen → ~/.concertoai`（`src/store/paths.ts` 单一来源 + 幂等迁移）；**v2.2 智能成本控制**（高峰时段模型自动切换，见 §4 D41）

## 2. 架构全景图

```
┌─────────────────────────────────────────────────────────────┐
│ cli/  commander 入口（src/cli/）                              │
│   index.ts   concertoai / concertoai chat / concertoai run "任务" / concertoai plan│
│              concertoai snapshot [list|clean]（v3.0 快照清理）      │
│              concertoai balance（v3.1 余额查询）/ concertoai doctor（v3.1 环境诊断）│
│   chat.tsx   chat 装配：TUI + loop + store（含 TTY 检查）      │
│   run.ts     run 一次性执行：loop + stdout 流式 + 存档          │
│   plan.ts    plan 计划-批准-执行三段式（readline y/n）          │
│   snapshot.ts 快照命令（SnapshotManager，T3.6）                │
│   balance.ts 余额命令（fetchBalance，GET /user/balance）       │
│   doctor.ts  环境诊断命令（Node/Key/配置/会话/模型/余额）       │
│   slash/     /agent /skill /mcp /memory /review 斜杠命令       │
└──────────────────────┬──────────────────────────────────────┘
                       │ render(<App …>) / runLoop(...)
┌──────────────────────▼──────────────────────────────────────┐
│ ui/  Ink TUI（src/ui/）                                      │
│   App.tsx          根组件 + 状态机 idle→streaming→approval→plan-approval
│   PromptInput      光标移动 + 输入历史 + 多行输入               │
│   StreamingView    markdown→ANSI 渲染（markdown.tsx + 高亮）   │
│   modals.tsx       EditConfirm / ShellConfirm / PlanConfirm   │
│   SessionPicker    -r 无 ID 时的会话列表选择                   │
│   ObservabilityPanel  Agent 协作流程树（v3.0，可展开收起）      │
│   ReviewReport    /review 审查报告渲染（v2.1，按严重程度着色）  │
│   Spinner          Braille 进度指示（思考中/工具执行）          │
│   StatusBar        模型名 + 真实 usage/估算 + 成本             │
└──────────────────────┬──────────────────────────────────────┘
                       │ ctx.requestApproval（审批挂起/恢复）
┌──────────────────────▼──────────────────────────────────────┐
│ loop/ 会话主循环（src/loop/）                                 │
│   loop.ts     runLoop：消息组装→模型→工具分发→回填（≤50 轮）   │
│   context.ts  上下文窗口管理（80% 预算裁剪 + 日志）            │
│   messages.ts ChatMessage⇄ApiMessage 序列化 / 工具结果格式化   │
│   types.ts    ChatMessage / ToolCall / Role                  │
└─────────┬───────────────────────────────┬───────────────────┘
          │ streamChat（ModelClient 抽象）  │ registry.run(...)
┌─────────▼──────────┐          ┌──────────▼───────────────────┐
│ model/ DeepSeek    │          │ tools/ 工具注册表（src/tools/）│
│  client.ts  SSE    │          │  registry.ts ToolSpec+zod 分发│
│  models.ts  模型表  │          │  read.ts   3 个只读工具       │
│  tokenizer.ts 估算 │          │  edit.ts   SEARCH/REPLACE     │
└─────────┬──────────┘          │  shell.ts  白名单+审批+超时   │
          │                     │  knowledge.ts knowledge_* 5 工具│
          │                     │  spawn.ts  spawn_subagent     │
          │                     └──────────┬───────────────────┘
┌─────────▼─────────────────────────────────▼─────────────────┐
│ balance/ 余额查询（src/balance/，v3.1）                       │
│  balance.ts  fetchBalance：GET /user/balance + BalanceError   │
│  index.ts    barrel（fetchBalance / BalanceInfo / 类型）      │
└──────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ core/ 智能成本控制（src/core/，v2.2）                         │
│  peak-time.ts    工作日/高峰小时判断（9-12、14-18 左闭右开）  │
│  model-switcher.ts 高峰时段模型切换：ask/switch/ignore 策略   │
└─────────────────────────────────────────────────────────────┘
┌─────────▼─────────────────────────────────▼─────────────────┐
│ store/ 持久化（src/store/）      i18n/ 文案（src/i18n/）       │
│  paths.ts         全局路径 ~/.concertoai + 迁移（v3.1）        │
│  session.ts       JSONL 会话（~/.concertoai/sessions/）        │
│  project-rules.ts AGENTS.md→CARBON.md 规则加载（≤8000 字符）  │
│  config.ts        ~/.concertoai/config.json（schema + 优先级解析）│
│  memory-store.ts  项目级跨会话记忆（.lumen-memory/ JSONL）     │
│  zh.ts / en.ts / index.ts  多语言字典 + locale 解析（t/setLocale）
└─────────────────────────────────┬───────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────┐
│ mcp/  MCP 客户端（src/mcp/）    planner/ 任务规划（src/planner/）│
│  client.ts     stdio 传输层     deps.ts     步骤依赖检测       │
│  manager.ts    多服务聚合       progress.ts 进度状态机         │
│  types.ts      协议类型定义     rollback.ts 文件快照与回滚      │
│  zod-adapter.ts JSON Schema→zod types.ts    计划步骤类型        │
│  builtin-servers.ts 预配置      │                              │
│  index.ts       barrel          │                              │
└─────────────────────────────────┴───────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ orchestrator/ 多 Agent 编排（v3.0 M1-M3）                     │
│   types.ts         AgentMessage / AgentContext / AgentDef     │
│   context.ts       显式上下文（序列化/子集提取/合并，≤64KB）   │
│   state-machine.ts 任务状态机（pending→…→completed/failed）   │
│   scheduler.ts     DAG 调度（拓扑排序 + 并行 + 重试 + 冲突）   │
│   loop.ts          对抗性闭环（Coder→Reviewer→QA ≤5 次）      │
│   transaction.ts   SnapshotManager 多文件事务回滚（T3.6）     │
└───────────────────────────┬─────────────────────────────────┘
┌───────────────────────────▼─────────────────────────────────┐
│ agents/ 专业 Agent（v3.0 M3） market/ Agent 市场（v3.0 M4）   │
│   orchestrator.ts Orchestrator 拆解  types.ts     注册表类型  │
│   architect.ts    架构师→spec        registry.ts  读写       │
│   coder.ts        编码+修复          installer.ts 安装器      │
│   reviewer.ts     Team Reviewer      promote.ts   技能升级    │
│   qa.ts           QA（verify 沙箱）  download.ts  共享下载    │
│   protocol.ts     Agent 接口契约（T1.2）                      │
│   registry.ts     AgentRegistry（T1.2）                       │
└───────────────────────────┬─────────────────────────────────┘
┌───────────────────────────▼─────────────────────────────────┐
│ observable/ 可观测性（v3.0 M5）                               │
│   trace.ts   TraceStore 调用链追踪（LRU 5000）                │
│   audit.ts   AuditLogger JSONL 审计日志（单条 <10ms）         │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向**（上层依赖下层，无反向）：

```
cli → ui → loop → model / tools → store / i18n / mcp / planner
             ↘        ↘          ↘
          loop/types   i18n     mcp（工具注入 loop）
```

**v3.0 多 Agent 层**（独立于主循环，由 cli/chat 装配，消费同一 ModelClient 抽象）：

```
orchestrator/（协议/调度/闭环/事务） ──► agents/（4 专业 Agent）
      │  types/state-machine               │  AgentRegistry（agents/registry.ts）
      ▼                                    ▼
 observable/（追踪/审计）            market/（注册表/安装/promote）
      ▲ 消费 orchestrator types            ▲ 消费 agents/registry + orchestrator types
```

## 3. 核心数据流

### 3.1 启动装配（chat 模式）

```
cli/index.ts（无子命令或 chat）
  → getApiKey()：DEEPSEEK_API_KEY 缺失则报错退出
  → resolveStartupModel()（v2.2）：CLI -m 优先 → maybeSwitchModel 读取配置
      高峰时段（工作日 9-12 / 14-18）按 peakTimeStrategy 决策：
      ask=交互确认 / switch=直接切本地模型 / ignore=保持主模型；非高峰不打扰
  → chat.tsx：TTY 检查（非交互终端友好报错）
  → 组装：DeepSeekClient（本地模型按 ollamaBaseUrl 构建）+ ToolRegistry(5 工具) + ToolContext{白名单}
  → loadProjectRules(cwd)：AGENTS.md 优先 / CARBON.md 兜底，注入系统提示
  → SessionStore：resume 则读历史，否则 create 新会话
  → render(<App …/>)（本地模型成本按 0 展示，避免 costFor 未知模型抛错）
```

### 3.2 一轮对话（App.send → runLoop）

```
用户在 PromptInput 输入 + Enter
  → App.send(text)：busy 防重入，user 消息入历史
  → runLoop(options, history, text)：
      ① systemPrompt 注入（history 无 system 时）
      ② streamAssistantReply：流式累积 content + 增量拼接 tool_calls
      ③ 无工具调用 → 返回完整消息历史（本轮结束）
      ④ 有工具调用 → 逐条执行（顺序）：
           JSON.parse(arguments) → registry.run(name, args, ctx)
           → 结果 formatToolResult 截断回填为 tool 消息
         → 回到 ②（最多 MAX_LOOP_TURNS = 50 轮，超限返回 interrupted 不抛错，已累积结果保留）
  → App：消息历史更新、token 估算累计、store.appendAll 落盘
```

### 3.3 审批流（编辑/命令）

```
工具执行（edit_file / run_command）
  → 白名单命中（词边界匹配）→ 免审批直跑
  → 否则 requestApproval(ctx, {kind, summary, detail})
      TUI：App 挂起流程（phase=approval），弹审批框，y/Enter 批准、n/Esc 拒绝
      测试：注入 stub；run 模式：默认拒绝（fail-closed）
  → 通过才 fs.writeFile / spawn；拒绝返回 ok:false，不产生副作用
```

### 3.4 消息生命周期与序列化

```
会话层 ChatMessage { role, content, toolCallId?, toolCalls? }
   │  toApiMessages()（loop/messages.ts）
   ▼
API 层 ApiMessage { role, content, name?, tool_call_id?, tool_calls? }
   │  streamChat SSE（client.ts）
   ▼
增量 chunk { choices[].delta: { content?, reasoning_content?, tool_calls?[] } }
   │  loop 累积：content 拼接 / tool_calls 按 index 增量拼接
   ▼
完整 assistant 消息 → 工具结果回填 → 下一轮
   │  JSON.stringify → JSONL 行
   ▼
~/.concertoai/sessions/<id>.jsonl
```

### 3.5 MCP 服务交互路径（v1.1）

```
启动（chat.tsx）
  → loadConfig()：读取 mcpServers 配置
  → McpManager(configs)：并发启动所有 MCP 服务（stdio transport）
  → manager.listTools() → 聚合为 ToolSpec（serverName/toolName 前缀）
  → registry.registerExternal(tools)：注入 ToolRegistry

模型调用 MCP 工具
  → loop：tool_call 事件 → registry.run('serverName/toolName', args)
  → manager.callTool(name, args)：按前缀路由到对应 McpClient
  → MCP 服务进程：执行 tools/call → 返回 content[]
  → 结果回填：formatToolResult(mcpResult) → tool 消息追加到历史

MCP 服务故障
  → 单服务断开：不影响其他服务；manager 标记 disconnected
  → 内置工具不受影响（独立于 MCP 工具）
```

## 4. 关键设计决策

> **先读这里再动手**：本节记录关键决策的「原因」。当你想修改某个模块（工具分发、审批流、会话存储、SSE 解析……）时，请先查阅对应条目，理解其设计意图。很多约束（fail-closed、路径沙箱、分层截断）是安全基线的一部分，破坏它们等于破坏产品承诺。

| # | 决策 | 理由 | 代码位置 |
| --- | --- | --- | --- |
| D1 | **函数式 runLoop**：返回完整消息历史，调用方持有状态 | 多轮对话、resume、持久化天然支持；无隐式状态 | `src/loop/loop.ts` |
| D2 | **ModelClient 抽象接口**，DeepSeekClient 实现之 | 测试注入 Fake 模型驱动全链路，无需网络 | `src/model/client.ts` |
| D3 | **SSE 解析器独立**（`readSseEvents`，字节级行切分 + TextDecoder stream 模式） | 跨 chunk 截断、UTF-8 多字节边界安全 | `src/model/client.ts` |
| D4 | **工具统一 ToolSpec 契约**：zod parameters + `parallelSafe` 字段位 + execute | 注册/校验/分发/捕获错误统一；v0.2 并行调度预留 | `src/tools/registry.ts` |
| D5 | **审批在工具内部强制**（fail-closed：回调未配置默认拒绝） | 即使调用方误用，危险操作也无法绕过审批 | `edit.ts` / `shell.ts` / `registry.ts` |
| D6 | **白名单词边界匹配**（`npm test` 命中 `npm test --x`，不命中 `npm testx`） | 用户提前授权安全命令，其余每次审批 | `src/tools/shell.ts` |
| D7 | **路径沙箱 resolveSafe**：所有工具路径基于 `ctx.cwd` 解析，越界拒绝 | 模型不可信，防止 `..` 逃逸/绝对路径越界 | `src/tools/read.ts` |
| D8 | **分层截断防上下文膨胀**：read_file 50k 字符 / search 100 条 / 工具回填 20k / shell 输出 20k / 规则 8k | 成本与上下文控制 | 各工具 + `messages.ts` + `project-rules.ts` |
| D9 | **会话 JSONL 宽松读取**（空行跳过、损坏行计数） | 容忍手动编辑；毫秒时间戳 id + `wx` 排他创建防同毫秒覆盖 | `src/store/session.ts` |
| D10 | **BPE 精确 Token 计数**（v2.0 升级）：tiktoken o200k_base 编码器，懒加载单例；失败降级 CJK 加权 | 误差从 ±40% 降至 <5%；缓存命中 token 按低价计费 | `src/model/tokenizer.ts` |
| D11 | **工具失败不中断循环**：ok:false 回填让模型自行修正 | 模型可自愈（换参数/换工具），循环上限兜底 | `src/loop/loop.ts` |
| D12 | **中文文案单一来源** `i18n/zh.ts` + `fmt()` 占位符 | 全项目文案可检索、可统一改 | `src/i18n/zh.ts` |
| D13 | **并行工具调度**（T3.1）：连续 `parallelSafe` 工具组内并行，审批类串行 | 只读工具并行提速；审批框不与并行执行交错；事件按原始顺序回填 | `loop.ts` + `registry.ts` |
| D14 | **无子命令默认进 chat**（commander program.action） | 产品定位：`cd 项目 && concertoai` 直接可用 | `src/cli/index.ts` |
| D15 | **修复管线**（T3.2）：`repairable` 字段区分错误，可修复失败限 2 次终止 | 防模型死循环刷失败；审批拒绝/越界绝不重试 | `loop.ts` + `registry.ts` |
| D16 | **上下文裁剪**（T1.6）：80% 预算，保留 system + 最近整轮，仅发送视角 | 给回复留余量；不截断持久化历史 | `loop/context.ts` |
| D17 | **配置优先级**（T3.4）：CLI > 环境变量 > 配置文件 > 默认值 | 可预测、可覆盖；schema 版本兜底 | `store/config.ts` |
| D18 | **locale 字典**（T4.5）：`zh`/`en` 键同构 + `setLocale`/`t()` | 文案单点维护；启动期固定语言 | `i18n/index.ts` |
| D19 | **会话原子写**（T1.5）：进程内锁 + 临时文件 rename + 写后 size 校验 | 并发不损坏；跨进程冲突提示（尽力而为） | `store/session.ts` |
| D20 | **MCP 多服务聚合**（v1.1）：`serverName/toolName` 前缀 + 故障隔离 + 降级 | 工具名不冲突；单服务故障不影响全局；内置工具在 MCP 不可用时仍可用 | `mcp/manager.ts` |
| D21 | **计划依赖拓扑排序**（v1.1）：显式声明 + 文件引用 + 隐式读写 → 拓扑序 | 确保步骤按正确顺序执行；循环依赖提前报错 | `planner/deps.ts` |
| D22 | **文件快照回滚**（v1.1）：编辑前自动备份 → 失败可选回滚 → 成功后清理 | 计划执行中某步失败时可恢复；非文件操作回滚时跳过并提示 | `planner/rollback.ts` |
| D23 | **双源记忆注入**（v1.1）：本地 JSONL + MCP memory 知识图谱合并注入 | 本地轻量零依赖，MCP 支持复杂查询；两者互补 | `loop/local-memory.ts` + `loop/memory-injector.ts` |
| D24 | **智能摘要压缩**（v2.0）：触发 80% 预算时优先调模型生成摘要，失败回退裁剪 | 保留信息密度而非粗暴丢弃；摘要自身计入预算 | `loop/context.ts` |
| D25 | **子代理隔离执行**（v2.0）：独立 runLoop + 受限 ToolRegistry + 无审批 | 探索/研究任务不污染主上下文；只读无需审批 | `agent/spawner.ts` |
| D26 | **技能系统 SKILL.md**（v2.0）：frontmatter 元数据 + markdown 正文，通过 /skill 命令注入 | 可复用指令模板；项目级/全局级双路径 | `skill/loader.ts` + `cli/slash/skill.ts` |
| D27 | **MCP 动态管理**（v2.0）：`/mcp` 命令 + 状态条实时摘要 + 单服务级 connect/disconnect | 运行时灵活管理，无需重启 | `cli/slash/mcp.ts` + `ui/StatusBar.tsx` |
| D28 | **知识图谱**（v2.1）：JSONL 持久化 + 内存邻接表索引 + LRU 淘汰（1000 实体），按项目隔离 | 轻量零依赖，O(1) 关系查询；批量写入去重不退化平方级 | `knowledge/store.ts` + `tools/knowledge.ts` |
| D29 | **子代理 MCP 工具**（v2.1）：allowedMcpServers 声明加载，MCP 工具去前缀注册 | 子代理可访问 filesystem/github 等外部能力；服务不可用静默降级 | `agent/spawner.ts` |
| D30 | **技能嵌套与市场**（v2.1）：@skill 递归展开（≤3 层 + 循环检测）+ @agent 引用 + /skill install/search/update | 技能可组合复用；市场命令异步网络操作 | `skill/loader.ts` + `cli/slash/skill.ts` |
| D31 | **Reviewer Agent**（v2.1）：9 维审查聚合为 5 个并行子代理 + 自动测试（npm run verify） | 多视角交叉验证；结果按 (file,title) 去重 + 严重程度排序 | `reviewer/engine.ts` + `reviewer/dimensions.ts` |
| D32 | **系统性性能优化**（v2.1）：O_APPEND 追加 / chunk 一次 join / 工具定义缓存 / 关系邻接表 / 懒加载 / 流式节流 | 大会话与长回复不再 O(n²) 退化 | session/loop/tools/knowledge/ui 各模块 |
| D33 | **Orchestrator 中介模式**（v3.0 / ADR-015）：Agent 间通信一律经 Orchestrator 转发，不做点对点 | 降低耦合；所有消息可追踪；v3.1 再评估点对点 | `agents/orchestrator.ts` |
| D34 | **Agent 接口标准化**（v3.0 / ADR-016）：AgentMessage/AgentContext/Artifact + AgentDef（interfaces 用 zod Schema）| 接口即契约；第三方 Agent 可插拔；M1 修正项落实（discriminated union / zod schema / 运行时状态拆分） | `orchestrator/types.ts` + `agents/protocol.ts` |
| D35 | **对抗性闭环循环上限 ≤ 5**（v3.0 / ADR-017）：MAX_LOOP_ATTEMPTS=5，超限退出并保留中间结果 + 触发 onRollback | 防止 Coder↔Reviewer 无限拉锯；5 次覆盖绝大多数修复场景 | `orchestrator/loop.ts` |
| D36 | **Agent 市场复用技能市场架构**（v3.0 / ADR-018）：registry.json + 安装器 + sha256 校验，`type: skill|agent` 区分 | 避免重复建设；共享下载/校验/写入底层；Agent 本质是特殊技能 | `market/` + `skill/` |
| D37 | **可观测性结构化调用链 + 审计日志**（v3.0 / ADR-019）：TraceStore LRU + AuditLogger JSONL，非外部 APM | 零外部依赖；CLI 自包含；JSON 导出即可满足审计 | `observable/` |
| D38 | **v3.0 不做沙箱容器隔离**（v3.0 / ADR-020）：进程级隔离（子代理）足够 | Docker/K8s 复杂度高，v3.1 评估 | `agent/spawner.ts` |
| D39 | **配置目录迁移 ~/.lumen → ~/.concertoai**（v3.1）：`store/paths.ts` 单一来源 + `migrateLegacyHome` 幂等迁移（rename 失败回退复制，CLI 入口自动调用） | 品牌统一；旧数据无缝迁移；路径定义不散落各模块 | `store/paths.ts` + `cli/index.ts` |
| D40 | **余额查询独立模块 + CLI 命令**（v3.1）：`balance/fetchBalance` 调用官方 `GET /user/balance`（超时 15s、非 2xx 抛 BalanceError），`concertoai balance` 输出各币种总额/赠送/充值；`concertoai doctor` 环境诊断内嵌余额显示（无 key 标记跳过） | 轻量只读 GET 单次不重试；余额为字符串不做精度转换；doctor 单项失败不中断、汇总退出码 | `balance/` + `cli/balance.ts` + `cli/doctor.ts` |
| D41 | **高峰时段模型自动切换**（v2.2）：`core/peak-time.ts` 判定工作日+高峰小时（9-12 / 14-18 左闭右开）；`core/model-switcher.ts` 按 `peakTimeStrategy`（ask/switch/ignore）决策，ask 在交互终端确认后切到本地 ollama 模型（`ollamaModel`/`ollamaBaseUrl`）；CLI 启动（`resolveStartupModel`）与 chat 装配消费，本地模型成本按 0 展示 | 高峰时段 API 成本高且可被本地模型替代；非高峰/周末零打扰；策略默认 ask 尊重用户；本地模型不在 DeepSeek 模型表，避免 costFor 抛错 | `core/` + `store/config.ts` + `cli/index.ts` + `cli/chat.tsx` + `ui/App.tsx` |

## 5. 目录结构说明

```
concertoai/
├── package.json          ESM；scripts: dev/build/test/test:watch/lint/lint:fix/typecheck/verify
├── tsconfig.json         strict 全开；verbatimModuleSyntax；jsx: react-jsx；noEmit（tsup 负责产物）
├── biome.json            Biome 2.5；lint 范围 src tests
├── vitest.config.ts      include tests/**/*.test.{ts,tsx}（注意：必须含 tsx，否则 UI 测试被静默跳过）
├── tsup.config.ts        entry：src/index.ts（库）+ src/cli/index.ts（CLI）→ dist/（ESM + d.ts + sourcemap）
├── CHANGELOG.md          变更日志（npm version 发布流程）
├── scripts/              sync-version.mjs（npm version 钩子）/ smoke-install.mjs（安装冒烟）
├── docs/
│   ├── 01-产品定位与范围.md
│   ├── 02-架构设计/ARCHITECTURE.md   ← 本文档
│   ├── 03-开发计划与任务/            v0.1/v1.0 计划与任务书 + 任务看板
│   ├── 04-发布流程.md
│   ├── 05-用户与开发指南/user-guide.md
│   └── 06-会议与决策记录/DECISIONS.md（ADR）
├── .github/workflows/     ci.yml（push/PR verify + 手动冒烟）/ publish.yml（Trusted Publishing）
├── src/
│   ├── index.ts          barrel：导出公共 API（VERSION / agent / loop / model / tools / store / i18n 等）
│   ├── version.ts        VERSION 常量（轻量 --version，独立于 barrel，v2.1）
│   ├── agent/            子代理系统（v2.0，详见 §4 D25 / D29）
│   │   ├── spawner.ts    子代理隔离执行（独立 runLoop + 受限 registry + allowedMcpServers）
│   │   ├── types.ts      SubagentDef / SubagentResult / SubagentTask 类型
│   │   ├── index.ts      barrel
│   │   └── builtin/      内置子代理注册
│   │       ├── explore.ts  只读探索子代理（read/search/list，结论 ≤200 字）
│   │       ├── research.ts 研究型子代理（多角度对比分析，结论 ≤500 字）
│   │       └── index.ts    registerBuiltinSubagents
│   ├── cli/
│   │   ├── index.ts      commander 入口：concertoai（默认 chat）/ chat / run / plan / snapshot / balance / doctor；DEEPSEEK_API_KEY 检查
│   │   ├── chat.tsx      chat 装配：TTY 检查、配置加载、注册表、规则加载、MCP 启动、resume、render(App)
│   │   ├── run.ts        run 装配：非交互、stdout 流式、--auto-approve 显式开启、存档
│   │   ├── plan.ts       plan 装配：计划轮 → 终端 y/n → 执行轮（含依赖检测/进度/回滚）
│   │   ├── snapshot.ts   concertoai snapshot [list|clean]：快照残留列出/清理（v3.0 M3）
│   │   ├── balance.ts    concertoai balance：余额查询（fetchBalance，v3.1）
│   │   ├── doctor.ts     concertoai doctor：环境诊断（Node/Key/配置/会话/模型/余额，v3.1）
│   │   ├── common.ts     CLI 共享：白名单 / 注册表构建 / OS 提示（轻量加载，v2.1）
│   │   └── slash/        斜杠命令处理器
│   │       ├── agent.ts  /agent list / install / remove / promote（v3.0 M4）
│   │       ├── memory.ts /remember /forget /memories
│   │       ├── mcp.ts    /mcp status / connect / disconnect（v2.0）
│   │       ├── skill.ts  /skill list / use / install / search / update（v2.0/v2.1）
│   │       └── review.ts /review 审查命令（v2.1）
│   ├── ui/
│   │   ├── App.tsx       状态机组件：send/sendPlan/executePlan/审批挂起/消息渲染/错误显示
│   │   ├── PromptInput.tsx  光标移动 + 历史浏览 + 多行输入
│   │   ├── StreamingView.tsx 流式 markdown→ANSI（空文本显示 spinner）
│   │   ├── markdown.tsx   markdown 解析 + cli-highlight 高亮（纯 ANSI 字符串）
│   │   ├── modals.tsx    ApprovalModal + EditConfirm/ShellConfirm/PlanConfirm
│   │   ├── SessionPicker.tsx 会话列表交互选择（-r 无 ID）
│   │   ├── ObservabilityPanel.tsx Agent 协作流程树面板（v3.0 M5，可展开/收起）
│   │   ├── ReviewReport.tsx /review 审查报告组件（v2.1，问题分级渲染）
│   │   ├── Spinner.tsx   Braille 进度指示
│   │   └── StatusBar.tsx 模型名/token（真实 usage/估算）/成本（costFor 实时计算）
│   ├── loop/
│   │   ├── loop.ts       runLoop / MAX_LOOP_TURNS=50 / MAX_REPAIRS=2 / LoopEvent（chunk/tool_call/tool_result/usage/error）
│   │   ├── context.ts    上下文窗口管理（trimContext：80% 预算、整轮保留、日志）
│   │   ├── messages.ts   消息构造 + toApiMessages + formatToolResult（20k 截断）
│   │   ├── types.ts      ChatMessage / ToolCall / Role
│   │   ├── local-memory.ts  本地记忆检索与注入（v1.1）
│   │   └── memory-injector.ts MCP memory 检索与注入（v1.1）
│   ├── model/
│   │   ├── client.ts     DeepSeekClient（implements ModelClient）+ readSseEvents + ApiError/TimeoutError + Usage
│   │   ├── models.ts     MODEL_PROFILES（flash 默认/pro，官方定价 2026-08 核实）+ costFor
│   │   └── tokenizer.ts  estimateTokens（CJK 加权）/ estimateMessageListTokens
│   ├── balance/          余额查询（v3.1）
│   │   ├── balance.ts    fetchBalance（GET /user/balance）+ BalanceError + 超时
│   │   └── index.ts      barrel（fetchBalance / BalanceInfo / DeepSeekBalance / FetchBalanceOptions）
│   ├── core/             智能成本控制（v2.2，详见 §4 D41）
│   │   ├── peak-time.ts  工作日/高峰小时判断（isWorkday / isPeakHour / isPeakTime）
│   │   └── model-switcher.ts 高峰时段模型切换（applyPeakStrategy / maybeSwitchModel，ask/switch/ignore）
│   ├── tools/
│   │   ├── registry.ts   ToolSpec/ToolContext/ToolRegistry/ApprovalRequest/ToolResult（repairable/parallelSafe 字段）
│   │   ├── read.ts       read_file/search_content/list_directory + resolveSafe（BOM 剥离）
│   │   ├── edit.ts       edit_file：SEARCH 规范化匹配（CRLF）、保留换行风格、审批后落盘、快照（v1.1）
│   │   ├── shell.ts      run_command：白名单免审、每次审批、超时杀进程树、输出截断
│   │   ├── knowledge.ts knowledge_* 5 工具（知识图谱，v2.1 详见 §4 D28）
│   │   └── spawn.ts      spawn_subagent 工具工厂（子代理调用，v2.0）
│   ├── mcp/              MCP 协议客户端（v1.1 新增，详见 §4 D20）
│   │   ├── client.ts     stdio transport（握手/请求/响应/超时）
│   │   ├── manager.ts    多服务生命周期管理、工具聚合与路由
│   │   ├── types.ts      JSON-RPC 2.0 消息 + tools/list/tools/call 类型
│   │   ├── zod-adapter.ts JSON Schema → Zod schema 转换
│   │   ├── builtin-servers.ts filesystem/memory/github 预配置
│   │   └── index.ts      barrel
│   ├── planner/          任务规划增强（v1.1 新增，详见 §4 D21-D22）
│   │   ├── deps.ts       步骤依赖解析 + 拓扑排序 + 循环检测
│   │   ├── progress.ts   进度状态机（pending→in_progress→completed/failed/skipped）
│   │   ├── rollback.ts   文件快照存储与回滚恢复
│   │   └── types.ts      计划步骤、依赖关系类型定义
│   ├── knowledge/        知识图谱存储（v2.1，详见 §4 D28）
│   │   ├── store.ts      JSONL 持久化 + 内存邻接表索引 + LRU 淘汰 + 懒加载
│   │   ├── search.ts     关键词检索（name/type/observation 评分）
│   │   ├── types.ts      实体/关系/图类型
│   │   └── index.ts      barrel（v2.1）
│   ├── reviewer/         Reviewer Agent（v2.1，详见 §4 D31）
│   │   ├── engine.ts     6 步审查工作流（5 并行子代理 + 自动测试 npm run verify）
│   │   ├── dimensions.ts 9 维审查定义与 5 子代理分组
│   │   ├── knowledge.ts  知识库上下文加载
│   │   ├── types.ts      审查报告/问题/严重程度类型
│   │   └── index.ts      barrel（v2.1）
│   ├── skill/            技能系统（v2.0/v2.1，详见 §4 D26 / D30）
│   │   ├── loader.ts     SKILL.md 加载 + @skill 递归展开（≤3 层）/ @agent 引用
│   │   ├── types.ts      SkillDef / SkillFrontmatter / AgentRef 类型
│   │   └── index.ts      barrel
│   ├── orchestrator/     多 Agent 编排核心（v3.0 M1-M3，详见 §4 D33/D35）
│   │   ├── types.ts      AgentMessage / AgentContext / AgentDef / AgentState / Artifact（T1.1）
│   │   ├── context.ts    显式上下文：serialize/deserialize/extractSubset/mergeContexts（≤64KB，T1.3）
│   │   ├── state-machine.ts 任务状态机：转换守卫 + onTransition 事件（T2.1）
│   │   ├── scheduler.ts  DAG 调度：拓扑排序 + 并发池（默认 3）+ 重试 + 冲突检测（T2.2）
│   │   ├── loop.ts       对抗性闭环编排：runTeamLoop（Coder→Reviewer→QA ≤5 次，T3.5）
│   │   ├── transaction.ts SnapshotManager 多文件事务快照/回滚/提交（T3.6）
│   │   └── index.ts      barrel
│   ├── agents/           专业 Agent（v3.0 M3，详见 §4 D33/D34）
│   │   ├── protocol.ts   Agent 接口契约：execute/send/receive + AgentDef schema（T1.2）
│   │   ├── registry.ts   InMemoryAgentRegistry：register/get/list/unregister/permissionsOf（T1.2）
│   │   ├── orchestrator.ts Orchestrator：需求拆解 Task[] + 按调度器分配 + 聚合（T2.3）
│   │   ├── architect.ts  架构师：需求 → ArchitectSpec（T3.1）
│   │   ├── coder.ts      编码 Agent：spec 实现 + 反馈修复 + 事务登记（T3.2）
│   │   ├── reviewer.ts   Team Reviewer：ReviewResult（approve/reject 打回，T3.3）
│   │   ├── qa.ts         QA：子代理沙箱执行 npm run verify + 结构化报告（T3.4）
│   │   └── index.ts      barrel
│   ├── market/           Agent 市场（v3.0 M4，详见 §4 D36）
│   │   ├── types.ts      MarketRegistry / AgentRegistryItem（复用技能 schema + type 区分）
│   │   ├── registry.ts   市场注册表读写 + 内置 4 Agent 条目（T4.1）
│   │   ├── installer.ts  AgentInstaller：下载 → sha256 → 接口合规 → 注册（T4.2）
│   │   ├── promote.ts    技能 → Agent 脚手架生成器（T4.4）
│   │   ├── download.ts   共享下载函数（fetchVerifiedContent，T4.2 抽取）
│   │   └── index.ts      barrel
│   ├── observable/       可观测性（v3.0 M5，详见 §4 D37）
│   │   ├── trace.ts      TraceStore 调用链追踪（LRU 5000 + 状态机订阅，T5.1）
│   │   ├── audit.ts      AuditLogger JSONL 审计日志（异步追加，T5.2）
│   │   └── index.ts      barrel
│   ├── store/
│   │   ├── paths.ts      全局路径单一来源（~/.concertoai/）+ migrateLegacyHome 旧目录迁移（v3.1）
│   │   ├── session.ts    SessionStore：create/append/appendAll/read/list；锁 + 原子写 + 冲突检测
│   │   ├── project-rules.ts  loadProjectRules：AGENTS→CARBON 优先级、8k 截断
│   │   ├── config.ts      loadConfig/writeConfig/resolveConfig（CLI > env > 配置 > 默认；含 mcpServers）
│   │   └── memory-store.ts   MemoryStore：JSONL CRUD + 标签/关键词检索 + 项目隔离（v1.1）
│   └── i18n/
│       ├── zh.ts         中文字典 + fmt()
│       ├── en.ts         英文字典（键与 zh 同构）
│       └── index.ts      resolveLocale / setLocale / t() / DICTS
└── tests/                镜像 src 结构（69 个文件 / 750 用例），含 tests/agent/、tests/agents/、tests/balance/、tests/cli/、tests/core/、tests/e2e/、tests/i18n/、tests/knowledge/、tests/loop/、tests/market/、tests/mcp/、tests/model/、tests/observable/、tests/orchestrator/、tests/planner/、tests/reviewer/、tests/skill/、tests/store/、tests/tools/、tests/ui/ 等
```

## 6. 5分钟快速体验

> 目标：从零跑通第一次真实对话，立刻获得正反馈。

### 6.1 开发环境准备

- **Node.js ≥ 22**（npm 随附；`node --version` 确认）
- 无其他全局依赖（vitest / Biome / tsup 均为项目内 devDependencies）
- `DEEPSEEK_API_KEY` 环境变量（不写入任何配置文件）

**Windows 注意事项**：

- `npm run dev`（chat 模式）需在**真实终端**（PowerShell / cmd / Windows Terminal）运行；管道或脚本调用会因 TTY 检查失败并提示「需要交互式终端」——此时改用系统终端，或 `npm run dev -- run "任务"` 走非交互路径。
- 设置环境变量：cmd 用 `set DEEPSEEK_API_KEY=sk-xxx`，PowerShell 用 `$env:DEEPSEEK_API_KEY="sk-xxx"`。
- 仓库当前未配置远程（origin 未推送），从本地目录进入即可；发布后把下面第 1 步换成 `git clone <url>`。

### 6.2 完整命令链（约 5 分钟）

```bash
# 1. 进入项目（当前未发布远程；发布后为 git clone <url>）
cd F:\developer\2026\concertoai

# 2. 安装依赖（仅首次）
npm install

# 3. 设置 API Key（cmd 语法）
set DEEPSEEK_API_KEY=sk-你的密钥

# 4. 第一次体验：非交互执行，立刻看到成果
npm run dev -- run "列出这个项目的文件结构"

# 5. 进阶：进入交互式对话（需真实终端）
npm run dev
#    → 输入「读一下 package.json 并总结」+ Enter
#    → 输入「运行 npm run test 看看结果」→ npm test 命中白名单，免审批直跑
#    → 尝试编辑类指令 → 弹出审批框，y / Enter 批准，n / Esc 拒绝
#    → Esc 退出，会话自动保存到 ~/.concertoai/sessions/
```

**预期输出**（第 4 步）：模型流式回复 + 结尾 `会话已保存: <会话ID>`。

## 7. 开发调试指南

### 7.1 环境与命令

```bash
npm install        # Node ≥22
npm run dev        # 开发运行（= concertoai，默认进 chat，需真实 TTY）
npm run verify     # 验收：build + lint + typecheck + test（--silent）
```

| 命令 | 说明 |
| --- | --- |
| `npm run dev -- run "任务"` | 非交互执行（真实 API） |
| `npm run dev -- chat -m deepseek-v4-pro` | 指定模型 |
| `npm run dev -- chat -r <会话ID>` | 恢复会话 |
| `npm run test:watch` | 测试监听 |
| `npm run lint:fix` | Biome 自动修复 |

### 7.2 测试策略（三层）

| 层 | 方式 | 推荐阅读（文件 → 具体用例） |
| --- | --- | --- |
| 单元 | mock SSE 字节流（逐字节切分）、临时目录夹具、真实子进程（node -e） | `tests/model/client.test.ts` → 「跨 chunk 逐字节切分」；`tests/tools/read.test.ts` → 「路径越界被拒绝」；`tests/tools/shell.test.ts` → 「超时自动终止」 |
| 集成 | FakeModel 脚本驱动 runLoop 全链路（含审批拒绝、分片拼接、轮数上限） | `tests/loop/loop.test.ts` → 「工具调用 → 执行 → 结果回填」与「审批拒绝」 |
| UI | ink-testing-library 渲染断言（状态条/审批框/App 全流程） | `tests/ui/app.test.tsx` → 「审批流：y 批准后落盘并继续」与「n 拒绝不落盘」 |

### 7.3 关键调试经验（踩坑记录）

1. **Ink 7 按键注入**：普通文本块会整体作为 `input` 传入（多字符一次事件）；`\r` 必须**单独 `stdin.write('\r')`** 才会被识别为 Enter（混在文本里会被当普通字符）。
2. **UI 测试时序**：`stdin.write('文本')` 与 `write('\r')` 之间必须 `await sleep(50)`——React 重渲染未完成时回车回调读到旧 value 闭包。
3. **vitest include**：`tests/**/*.test.{ts,tsx}` ——漏掉 `tsx` 会导致 UI 测试被静默跳过（verify 仍绿，极具迷惑性）。
4. **含 JSX 的装配文件必须 `.tsx`**（如 `chat.tsx`），`.ts` 下 JSX 是解析错误。
5. **超时杀进程树**：Windows 下 `child.kill()` 只杀 cmd.exe 壳，残留子进程会锁目录（EBUSY）——用 `taskkill /T /F` / POSIX 进程组 SIGKILL。
6. **毫秒级 id 碰撞**：连续 create 可能同毫秒覆盖文件——`wx` 排他创建 + EEXIST 重试（曾导致 list 测试间歇性失败）。
7. **真实 API 冒烟**：机器上有 `DEEPSEEK_API_KEY` 时 `npm run dev -- run "任务"` 可端到端验证（SSE→loop→回复→存档）。
8. **`npm run dev` 需真实 TTY**：管道/编辑器内嵌终端会触发"需要交互式终端"提示（by design）。

## 8. 已知问题与规划

### 8.1 已知问题（v1.0 状态）

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| 模型 ID 与定价为开发期暂定值 | ✅ T1.1 已按官方定价页核实（2026-08） | `models.ts` |
| StreamingView 纯文本 | ✅ T2.1 markdown→ANSI + cli-highlight 高亮 | `ui/markdown.tsx` |
| PromptInput 无光标/历史 | ✅ T2.2 光标 + Home/End + ↑/↓ 历史（去重） | `ui/PromptInput.tsx` |
| 成本条无真实 usage | ✅ T1.2 透传 API usage（真实标记） | `loop/loop.ts` + `ui/StatusBar.tsx` |
| 工具顺序执行 | ✅ T3.1 并行调度（parallelSafe 组内并行） | `loop/loop.ts` |
| 白名单硬编码 | ✅ T3.4 配置化（config/environment 覆盖） | `store/config.ts` |
| resume 手输 ID | ✅ T2.3 交互式会话列表（-r 无 ID / -l） | `ui/SessionPicker.tsx` |
| PlanConfirm 未实现 | ✅ T3.3 plan 模式（CLI + 对话内 /plan） | `ui/modals.tsx` |
| audit 告警（1 critical） | ✅ T4.4 依赖升级 + esbuild overrides → 0 漏洞 | package.json |
| `run` 模式非 `--auto-approve` 时危险操作全被拒 | 保留（安全优先，by design） | `cli/run.ts` |

### 8.2 v1.1 已解决

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| 仅有内置工具，无法扩展 | ✅ MCP 协议接入（stdio client + 多服务管理 + 聚合路由） | `mcp/` |
| 计划无依赖感知 | ✅ 依赖检测（显式/文件/隐式 + 拓扑排序 + 循环检测） | `planner/deps.ts` |
| 计划执行无进度反馈 | ✅ 进度状态机 + PlanProgressView TUI 组件 | `planner/progress.ts` |
| 计划失败无法回滚 | ✅ 文件快照 + 逐步骤回滚恢复 | `planner/rollback.ts` |
| 记忆仅限当前会话 | ✅ 本地 JSONL 记忆（`/remember` `/forget` `/memories`）+ MCP memory 注入 | `store/memory-store.ts` + `cli/slash/memory.ts` |

### 8.3 v2.0 已解决

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| Token 估算误差大（±40%） | ✅ BPE 精确计数（tiktoken o200k_base），误差 <5% | `model/tokenizer.ts` |
| 缓存命中 token 未展示 | ✅ 状态条缓存命中行 + 分价计费 | `ui/StatusBar.tsx` + `model/models.ts` |
| 上下文超预算直接丢弃 | ✅ 智能摘要压缩（>5 条调模型，失败回退裁剪） | `loop/context.ts` |
| 探索/研究污染主上下文 | ✅ 子代理系统（explore/research 隔离子代理） | `agent/` |
| 无可复用技能指令 | ✅ 技能系统（SKILL.md + /skill 命令 + 3 内置技能） | `skill/` + `cli/slash/skill.ts` |
| MCP 启动后不可管 | ✅ /mcp 动态管理（connect/disconnect/status） | `cli/slash/mcp.ts` + `mcp/manager.ts` |

### 8.4 v2.1 已解决

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| 子代理仅内置只读工具 | ✅ allowedMcpServers 声明加载 MCP 工具（explore→filesystem、research→filesystem/github；服务不可用降级） | `agent/spawner.ts` |
| 技能不可组合、无市场 | ✅ @skill 递归展开（≤3 层 + 循环检测）+ @agent 引用 + /skill install/search/update | `skill/loader.ts` + `cli/slash/skill.ts` |
| 无项目级结构化记忆 | ✅ 轻量知识图谱（JSONL + 内存邻接表索引 + LRU，按项目隔离），knowledge_* 5 工具 + 双源记忆注入 | `knowledge/` + `tools/knowledge.ts` + `loop/memory-injector.ts` |
| 无自动化代码评审 | ✅ Reviewer Agent（/review）：9 维审查聚合 5 并行子代理 → 聚合排序 → 自动测试 | `reviewer/` + `cli/slash/review.ts` + `ui/ReviewReport.tsx` |
| 长会话/长回复性能退化 | ✅ 系统性 O(n²)→O(n) 优化（O_APPEND / chunk join / registry 缓存 / 邻接表 / 懒加载 / 流式节流） | session/loop/tools/knowledge/ui |

### 8.5 v3.0 已解决

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| 单 Agent 无法胜任复杂任务 | ✅ 多 Agent 团队：Orchestrator 拆解 + DAG 调度（拓扑排序/并行/重试/冲突检测）+ 聚合交付 | `orchestrator/` + `agents/orchestrator.ts` |
| Coder↔Reviewer 无闭环 | ✅ 对抗性闭环：Coder 实现 → Reviewer 审查（approve/reject）→ QA 验证 → 修复循环 ≤ 5 次，超限回滚 | `orchestrator/loop.ts` |
| 多文件修改无法原子回滚 | ✅ 任务级事务快照（SnapshotManager）+ `concertoai snapshot clean` + 外部修改检测 | `orchestrator/transaction.ts` + `cli/snapshot.ts` |
| 无可复用的 Agent 分发机制 | ✅ Agent 市场：/agent install/remove/list + 技能 promote（sha256 + 接口合规检查，复用技能市场架构） | `market/` + `cli/slash/agent.ts` |
| 多 Agent 协作不可观测 | ✅ 调用链追踪（TraceStore LRU）+ 审计日志（AuditLogger JSONL <10ms）+ 流程树面板 | `observable/` + `ui/ObservabilityPanel.tsx` |

### 8.6 v2.2 已解决

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| 高峰时段 API 成本高且无法干预 | ✅ 高峰时段检测（工作日 9-12 / 14-18）+ 模型自动切换：peakTimeStrategy=ask/switch/ignore，可切到本地 ollama 模型（成本按 0 展示） | `core/` + `store/config.ts` + `cli/index.ts` + `cli/chat.tsx` + `ui/App.tsx` |

### 8.7 规划（v3.1+，详见 [v3.1-dev-plan-ai.md](../03-开发计划与任务/v3.1-dev-plan-ai.md)）

- **P0 AI 自我修复闭环（M1）**：`src/loop/self-heal.ts` —— verify 四段（build/lint/typecheck/test）统一分类（复用 `agents/qa.ts` `parseVerifyOutput`）→ lint 确定性 `lint:fix` / 简单类型错误模型修复（审批）→ SnapshotManager 快照 + 修复后 verify + 失败回滚 → `/self-heal` + `concertoai self-heal`
- **P1 多项目管理（M2）**：`concertoai project add/switch/list/remove/info` + 隔离矩阵（会话目录 / 审批白名单 / MCP 服务按项目隔离，全局配置/技能/Agent 共享）
- **P1 Orchestrator CLI 入口（M5）**：`concertoai team "<任务>"`（--dry-run 拆解预览）+ `/orchestrate` + `concertoai audit export` + `/agent update` + `/review --severity`
- **P2 多租户登录（M3）**：`~/.concertoai/accounts/<name>/config.json`（多 API Key，git credential 模式）+ `login/logout/whoami/account switch`
- **P2 结构化错误增强（M4）**：各工具错误带 `code` + `suggestion`（复用 M1 分类器）
- **评估项（E1~E4）**：点对点通信 / Docker 沙箱 / 评分系统 → 否决（维持 ADR-015/020）；TS7 → 延后 v3.2；S1（外部 Agent zod→JSON Schema）→ v3.2 可选
- **工程**：S4 trace 查询索引优化（parentTaskId → 子任务索引，消除 O(n²)）；版本归位（v2.2 + v3.1 预留功能随 v3.1.0 一并发布）

---

## 9. 术语表

| 术语 | 说明 |
| --- | --- |
| SSE | Server-Sent Events：服务器单向推送的事件流协议；DeepSeek 流式响应按 `data: {...}` 行下发，`[DONE]` 收尾 |
| JSONL | JSON Lines：每行一条 JSON 的文本格式；会话存档采用它，支持逐行追加与宽松续读 |
| fail-closed | 默认拒绝：审批回调未配置时，危险操作（编辑/命令）一律拒绝——宁可误拒，不可漏放 |
| 路径沙箱 | 所有工具路径基于项目根（ctx.cwd）解析，`..` 逃逸 / 绝对路径越界一律拒绝 |
| TTY | 交互式终端设备；chat 模式的 raw mode 输入依赖它，非 TTY 环境会友好报错 |
| token | 模型文本的最小计价单位；ConcertoAI 用 CJK 加权估算（中文 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token） |
| BPE | Byte-Pair Encoding：主流 tokenizer 算法，v0.2 计划替换估算 |
| barrel | 汇总导出文件（src/index.ts），对外暴露统一的公共 API 入口 |
| hunk | diff 中一个连续变更块，形如 `@@ -a,b +c,d @@`（编辑工具的审批详情即 hunk 列表） |
| 白名单 | 用户提前授权的命令前缀（如 npm test），命中（词边界匹配）可免审批执行 |
| parallelSafe | ToolSpec 上的字段位，标记工具可否并行执行（T3.1 起由 loop 调度消费：组内并行、审批类串行） |
| active account | 当前生效的 API Key 账号指针（`~/.concertoai/accounts/active-account`），`whoami` 读取展示（v3.1） |
| 项目隔离 | 多项目管理下会话/审批白名单/MCP 服务按项目分目录存储，全局配置/技能/Agent 共享（v3.1） |
| self-heal | AI 自我修复闭环：`npm run verify` 失败 → 分类（lint/type）→ 自动修复 → 验证 → 回滚（v3.1） |

---

*本文档与代码同步维护：修改架构/数据流/常量后请同步更新，并保持引用（文件/函数/常量名）与实现一致。*
