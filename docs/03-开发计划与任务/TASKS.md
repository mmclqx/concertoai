# Lumen 开发任务看板

> 最后更新：2026-08-09
> 当前里程碑：**🚀 v3.0 开发中**（M1 接口定义 · T1.1~T1.3 已完成）（v1.0: 20/20 ✅ · v1.1: 12/12 ✅ · v2.0: 15/15 ✅ · v2.1: 25/25 ✅ · v3.0: 5/24）
> 基于：[v3.0 开发计划](./v3.0-dev-plan.md) · [v3.0 详细任务](./v3.0-dev-tasks.md)

---

## 📊 总览

| 指标 | 数值 |
|------|------|
| 总任务数 | 96（v1.0: 20 ✅ + v1.1: 12 ✅ + v2.0: 15 ✅ + v2.1: 25 ✅ + v3.0: 24） |
| P0 任务 | 30（v1.1: 6 ✅ + v2.0: 5 ✅ + v2.1: 5 ✅ + v3.0: 14） |
| P1 任务 | 30（v1.1: 6 ✅ + v2.0: 10 ✅ + v2.1: 4 ✅ + v3.0: 10） |
| P2 任务 | 8（v2.1: 8） |
| 待开始 | 19 |
| 进行中 | 0 |
| 已完成 | 77 |
| 已阻塞 | 0 |

---

## 🎯 里程碑进度

| 里程碑 | 级别 | 任务数 | 状态 |
|--------|------|--------|------|
| ~~V1-M1 可靠性加固~~ | P0 | 6 | ✅ 已完成 |
| ~~V1-M2 体验升级~~ | P1 | 4 | ✅ 已完成 |
| ~~V1-M3 能力扩展~~ | P1 | 4 | ✅ 已完成 |
| ~~V1-M4 发布工程~~ | P1 | 6 | ✅ 已完成 |
| **V1.1-M1 MCP 基础接入** | **P0** | **3** | 🟢 已完成 |
| **V1.1-M2 任务规划增强** | **P0** | **3** | 🟢 已完成 |
| **V1.1-M3 跨会话记忆** | **P1** | **3** | 🟢 已完成 |
| **V1.1-M4 集成测试与文档** | **P1** | **3** | ✅ 已完成 |
| **V2.0-M1 Token 精度与上下文智能** | **P0** | **3** | ✅ 已完成 |
| **V2.0-M2 子代理系统** | **P0** | **5** | ✅ 已完成 |
| **V2.0-M3 技能系统** | **P1** | **4** | ✅ 已完成 |
| **V2.0-M4 MCP 动态管理与体验增强** | **P1** | **3** | ✅ 已完成 |
| **V2.0-M5 集成测试与文档** | **P1** | **3** | ✅ 已完成 |
| **V2.1-M1 子代理 MCP 工具支持** | **P0** | **3** | ✅ 已完成 |
| **V2.1-M2 技能嵌套与子代理调用** | **P0** | **4** | ✅ 已完成 |
| **V2.1-M3 技能市场基础** | **P1** | **4** | ✅ 已完成 |
| **V2.1-M4 轻量级知识图谱 + RAG** | **P1** | **4** | ✅ 已完成 |
| **V2.1-M5 Reviewer Agent 代码评审智能体** | **P0** | **8** | ✅ 已完成 |
| **V2.1-M6 集成测试与文档** | **P1** | **2** | ✅ 已完成 |
| **V3.0-M0 启动前置** | **P0** | **2** | ✅ 已完成 |
| **V3.0-M1 接口定义与基础协议** | **P0** | **3** | ✅ 已完成 |
| **V3.0-M2 Orchestrator 核心** | **P0** | **3** | ⏳ 待开始 |
| **V3.0-M3 多角色 Agent 团队** | **P0** | **6** | ⏳ 待开始 |
| **V3.0-M4 Agent 市场基础** | **P1** | **4** | ⏳ 待开始 |
| **V3.0-M5 可观测性面板** | **P1** | **3** | ⏳ 待开始 |
| **V3.0-M6 集成测试与文档** | **P1** | **3** | ⏳ 待开始 |

---

## 📋 任务清单（按里程碑分组）

### V1-M1：可靠性加固（P0，约 10h）

- [x] **T1.1** 核实 DeepSeek 模型 ID 与定价
  - 涉及文件：`src/model/models.ts`
  - 预估：1h
  - 依赖：无
  - ✅ 2026-08-07 完成：按官方定价页数据更新（flash 1/2 元、pro 3/6 元、缓存命中价、并发限制、上下文 1M）

- [x] **T1.2** 透传真实 API usage
  - 涉及文件：`src/model/client.ts`, `src/loop/loop.ts`, `src/ui/StatusBar.tsx`
  - 预估：1.5h
  - 依赖：无
  - ✅ 2026-08-07 完成：LoopEvent 新增 usage 事件，状态条结束后显示真实 token（带「真实」标记），流式中仍为估算

- [x] **T1.3** 流式取消与断流策略（含用户中断）
  - 涉及文件：`src/loop/loop.ts`, `src/ui/App.tsx`, `src/model/client.ts`
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-07 完成：Ctrl+C 中断生成，已生成内容保留回填会话；网络断流给出中文错误，不自动重连

- [x] **T1.4** 编辑工具 CRLF/BOM 加固
  - 涉及文件：`src/tools/read.ts`, `src/tools/edit.ts`
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-07 完成：read_file/search 剥离 BOM；edit 规范化匹配（CRLF 与 LF 等价），写入保留原换行风格

- [x] **T1.5** 会话并发写保护
  - 涉及文件：`src/store/session.ts`
  - 预估：1.5h
  - 依赖：无
  - ✅ 2026-08-07 完成：进程内互斥锁 + 临时文件 rename 原子写 + 写后 size 校验（SessionConflictError 提示）

- [x] **T1.6** 上下文窗口管理（预算 + 裁剪）
  - 涉及文件：`src/loop/messages.ts`, `src/loop/context.ts`
  - 预估：3h
  - 依赖：T1.2
  - ✅ 2026-08-07 完成：80% 预算裁剪，保留 system + 最近整轮，裁剪日志记录，仅发送视角裁剪（历史完整持久化）

---

### V1-M2：体验升级（P1，约 9.5h）

- [x] **T2.1** markdown 渲染 + 代码高亮
  - 涉及文件：`src/ui/StreamingView.tsx`
  - 预估：3h
  - 依赖：无
  - ✅ 2026-08-07 完成：纯 ANSI 渲染（标题/列表/加粗/行内码/代码块），cli-highlight 高亮，控制字符剥离

- [x] **T2.2** 输入框光标与历史
  - 涉及文件：`src/ui/PromptInput.tsx`
  - 预估：3h
  - 依赖：无
  - ✅ 2026-08-07 完成：←/→ 光标、Home/End、Backspace/Delete、↑/↓ 历史浏览（去重）、光标 ANSI 反显标记

- [x] **T2.3** resume 交互式会话列表
  - 涉及文件：`src/cli/chat.tsx`, `src/store/session.ts`
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-07 完成：-r 无 ID 交互选择（↑/↓ Enter Esc），-l 仅列表，SessionPicker 组件

- [x] **T2.4** 生成中断与进度指示
  - 涉及文件：`src/ui/App.tsx`, `src/ui/StreamingView.tsx`
  - 预估：1.5h
  - 依赖：T1.3
  - ✅ 2026-08-07 完成：Braille spinner（思考中/工具执行），审批等待状态行，Ctrl+C 中断经 T1.3 链路

---

### V1-M3：能力扩展（P1，约 13h）

- [x] **T3.1** 并行工具调度
  - 涉及文件：`src/loop/loop.ts`, `src/tools/registry.ts`
  - 预估：3h
  - 依赖：无
  - ✅ 2026-08-07 完成：parallelSafe 组内 Promise.all 并行，审批类串行；tool_call/result 事件按原始顺序

- [x] **T3.2** 工具调用修复管线（限次重试）
  - 涉及文件：`src/loop/loop.ts`, `src/tools/registry.ts`
  - 预估：3h
  - 依赖：无
  - ✅ 2026-08-07 完成：repairable 字段区分错误类型，可修复失败累计限 2 次，审批拒绝/越界/未知工具不计数

- [x] **T3.3** plan 模式
  - 涉及文件：`src/ui/modals.tsx`, `src/loop/loop.ts`, `src/cli/run.ts`
  - 预估：4h
  - 依赖：T3.1
  - ✅ 2026-08-07 完成：lumen plan 命令（计划→批准→执行三段式）+ 对话内 /plan（PlanConfirm 审批框，y/n）

- [x] **T3.4** 配置系统（`~/.lumen/config.json`）
  - 涉及文件：`src/store/config.ts`, `src/cli/chat.tsx`
  - 预估：3h
  - 依赖：无
  - ✅ 2026-08-07 完成：schema 版本配置，默认模型/白名单/审批策略/会话目录/locale，CLI > 环境变量 > 配置 > 默认

---

### V1-M4：发布工程（P1，约 12h）

- [x] **T4.1** npm 包与 bin
  - 涉及文件：`package.json`, `tsup.config.ts`
  - 预估：2h
  - 依赖：T1.1
  - ✅ 2026-08-07 完成：包名 @lumen/cli（未被占用），bin + CLI 入口，npm pack 预演 + 干净目录全局安装冒烟通过

- [x] **T4.2** 发布管线（Trusted Publishing）
  - 涉及文件：`package.json`, `CHANGELOG.md`
  - 预估：2h
  - 依赖：T4.1
  - ✅ 2026-08-07 完成：prepublishOnly=verify，npm version 同步 VERSION 常量，Trusted Publishing workflow，发布文档

- [x] **T4.3** CI（GitHub Actions）
  - 涉及文件：`.github/workflows/ci.yml`
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-07 完成：push/PR 自动 verify（Node 22），workflow_dispatch 真实 API 冒烟（secrets）；本地模拟冒烟通过

- [x] **T4.4** 依赖升级评估
  - 涉及文件：`package.json`, `vitest.config.ts`
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-07 完成：ts 5.9.3 / commander 15 / vitest 4.1.10 全量无回归；esbuild overrides 后 npm audit 0 漏洞

- [x] **T4.5** EN 文案与 locale 架构
  - 涉及文件：`src/i18n/`, 全项目文案引用
  - 预估：3h
  - 依赖：T3.4
  - ✅ 2026-08-07 完成：en.ts 字典（与 zh 键同构）+ i18n/index（resolveLocale/setLocale/t），--lang/LUMEN_LOCALE/LANG/配置优先级，默认中文

- [x] **T4.6** 文档与发布件
  - 涉及文件：`README.md`, `docs/`
  - 预估：3h
  - 依赖：T4.1
  - ✅ 2026-08-07 完成：README 发布版、用户手册、CONTRIBUTING、ARCHITECTURE 同步 v1.0（D13-D19）

---

### V1.1-M1：MCP 基础接入（P0，约 8h）

- [x] **T1.1** 实现 MCP 客户端核心（连接、发现、调用工具）
  - 涉及文件：`src/mcp/client.ts`, `src/mcp/manager.ts`, `src/mcp/types.ts`, `src/mcp/zod-adapter.ts`, `src/mcp/index.ts`
  - 预估：3h | 实际：约 2h
  - 依赖：无
  - ✅ 2026-08-08 完成：stdio 客户端（握手/请求/响应/超时）+ 多服务管理器（并发/聚合/路由/故障隔离）+ mock 服务 + 18 测试全绿

- [x] **T1.2** 集成 filesystem MCP 服务
  - 涉及文件：`src/mcp/builtin-servers.ts`, `src/store/config.ts`, `src/cli/chat.tsx`
  - 预估：2.5h | 实际：约 1.5h
  - 依赖：T1.1
  - ✅ 2026-08-08 完成：配置系统支持 mcpServers，内置 3 种预配置，chat 启动自动连接 + 注册工具，5 集成测试

- [x] **T1.3** 集成 memory MCP 服务
  - 涉及文件：`src/mcp/builtin-servers.ts`, `src/loop/memory-injector.ts`
  - 预估：2.5h | 实际：约 1.5h
  - 依赖：T1.1
  - ✅ 2026-08-08 完成：MemoryInjector（检索/注入/写入）+ App 集成 + 4 测试

---

### V1.1-M2：任务规划增强（P0，约 6h）

- [x] **T2.1** 实现计划步骤依赖检测
  - 涉及文件：`src/planner/deps.ts`, `src/planner/types.ts`
  - 预估：2h | 实际：约 1h
  - 依赖：无
  - ✅ 2026-08-08 完成：步骤提取 + 显式/文件/隐式依赖 + 拓扑排序 + 循环检测 + 并行组 + 12 测试

- [x] **T2.2** 实现计划执行进度跟踪
  - 涉及文件：`src/planner/progress.ts`, `src/ui/modals.tsx`
  - 预估：2h | 实际：约 1h
  - 依赖：T2.1
  - ✅ 2026-08-08 完成：PlanProgress 状态机 + PlanProgressView 组件 + 8 测试

- [x] **T2.3** 实现计划回滚/撤销能力
  - 涉及文件：`src/planner/rollback.ts`, `src/tools/edit.ts`, `src/tools/registry.ts`
  - 预估：2h | 实际：约 1h
  - 依赖：T2.2
  - ✅ 2026-08-08 完成：SnapshotStore + ToolContext 注入 + edit 自动快照 + 5 测试

---

### V1.1-M3：跨会话记忆（P1，约 6h）

- [x] **T3.1** 实现项目级记忆存储
  - 涉及文件：`src/store/memory-store.ts`
  - 预估：2h | 实际：约 45min
  - 依赖：无
  - ✅ 2026-08-08 完成：JSONL CRUD + 标签/关键词检索 + 项目隔离 + 11 测试

- [x] **T3.2** 实现记忆检索与注入
  - 涉及文件：`src/loop/local-memory.ts`, `src/loop/memory-injector.ts`, `src/ui/App.tsx`, `src/cli/chat.tsx`
  - 预估：2h | 实际：约 30min
  - 依赖：T3.1
  - ✅ 2026-08-08 完成：双源记忆注入（本地 + MCP）合并到 system prompt

- [x] **T3.3** 实现记忆管理命令（`/remember`, `/forget`）
  - 涉及文件：`src/cli/slash/memory.ts`, `src/ui/App.tsx`
  - 预估：2h | 实际：约 45min
  - 依赖：T3.1
  - ✅ 2026-08-08 完成：parseMemoryCommand + executeMemoryCommand + App 拦截 + 8 测试（`/remember`, `/forget`）

---

### V1.1-M4：集成测试与文档（P1，约 4h）

- [x] **T4.1** MCP 全链路集成测试
  - 涉及文件：`tests/mcp/e2e.test.ts`, `tests/mcp/mock-server.ts`
  - 预估：1.5h | 实际：约 30min
  - 依赖：T1.1、T1.2、T1.3
  - ✅ 2026-08-08 完成：3 个 E2E 用例（单服务全链路/多服务并发/ToolSpec 注册）

- [x] **T4.2** 更新 README 与用户手册
  - 涉及文件：`README.md`, `docs/05-用户与开发指南/user-guide.md`, `CHANGELOG.md`
  - 预估：1.5h | 实际：约 1h
  - 依赖：全部功能实现后
  - ✅ 2026-08-08 完成：README 新增 MCP/记忆/计划增强章节；用户手册新增第 5-6 章 MCP 配置与跨会话记忆、配置表增加 mcpServers；CHANGELOG v1.1 条目校验完整

- [x] **T4.3** 更新架构文档与测试报告
  - 涉及文件：`docs/02-架构设计/ARCHITECTURE.md`, `docs/07-测试报告.md`
  - 预估：1h | 实际：约 45min
  - 依赖：T4.2
  - ✅ 2026-08-08 完成：架构文档新增 mcp/planner/memory-store 模块、MCP 数据流（§3.5）、决策 D20-D23、测试数更新；测试报告全面更新为 32 文件/292 用例、v1.1 模块分层统计、E2E/计划/记忆场景

---

### V2.0-M1：Token 精度与上下文智能（P0，约 6h）

- [x] **T1.1** 集成 BPE tokenizer（tiktoken / gpt-tokenizer 降级）
  - 涉及文件：`src/model/tokenizer.ts`（重写）
  - 预估：2h | 实际：约 0.5h
  - 依赖：无
  - ✅ 2026-08-08 完成：tiktoken o200k_base 编码器 + 懒加载单例 + 降级 CJK 加权 + 向后兼容别名

- [x] **T1.2** 精确成本计算 + 缓存命中显示
  - 涉及文件：`src/model/models.ts`、`src/model/client.ts`、`src/ui/StatusBar.tsx`
  - 预估：1.5h | 实际：约 0.5h
  - 依赖：T1.1
  - ✅ 2026-08-08 完成：costFor 缓存命中拆分 + cacheHitCostFor + StatusBar 💾 缓存命中行

- [x] **T1.3** 智能摘要压缩
  - 涉及文件：`src/loop/context.ts`（重写）、`src/loop/loop.ts`、`src/loop/messages.ts`
  - 预估：2.5h | 实际：约 1h
  - 依赖：T1.1
  - ✅ 2026-08-08 完成：compressContext 异步智能压缩 + trimContext 降级 + 摘要注入 + 11 测试

---

### V2.0-M2：子代理系统（P0，约 8h）

- [x] **T2.1** 定义子代理类型与通信协议
  - 涉及文件：`src/agent/types.ts`（新增）
  - 预估：1h | 实际：约 15min
  - 依赖：无
  - ✅ 2026-08-08 完成：SubagentDef/Task/Result/ToolName 类型定义

- [x] **T2.2** 实现子代理 spawner
  - 涉及文件：`src/agent/spawner.ts`（新增）、`src/agent/index.ts`（新增）
  - 预估：3h | 实际：约 45min
  - 依赖：T2.1
  - ✅ 2026-08-08 完成：SubagentSpawner（隔离 runLoop + 白名单 + 超时）+ LoopOptions.maxTurns

- [x] **T2.3** 内置 explore 子代理
  - 涉及文件：`src/agent/builtin/explore.ts`（新增）
  - 预估：2h | 实际：约 15min
  - 依赖：T2.2
  - ✅ 2026-08-08 完成：EXPLORE_AGENT（200 字结论 + 文件引用）

- [x] **T2.4** 内置 research 子代理
  - 涉及文件：`src/agent/builtin/research.ts`（新增）
  - 预估：1h | 实际：约 15min
  - 依赖：T2.3
  - ✅ 2026-08-08 完成：RESEARCH_AGENT（500 字结论 + 对比分析）

- [x] **T2.5** 主循环集成子代理调用
  - 涉及文件：`src/tools/registry.ts`、`src/loop/loop.ts`、`src/cli/chat.tsx`
  - 预估：1h | 实际：约 30min
  - 依赖：T2.2、T2.3、T2.4
  - ✅ 2026-08-08 完成：spawn_subagent 工具 + chat.tsx/run.ts 集成

---

### V2.0-M3：技能系统（P1，约 6h）

- [x] **T3.1** 定义 SKILL.md 规范 + 内置 3 个技能
  - 涉及文件：`docs/SKILL.md`（新增）、`skills/`（新增 3 个技能目录）
  - 预估：0.5h | 实际：约 15min
  - 依赖：无
  - ✅ 2026-08-08 完成：SKILL.md 规范 + code-review/explain/refactor 技能

- [x] **T3.2** 实现 Skill 加载器
  - 涉及文件：`src/skill/types.ts`（新增）、`src/skill/loader.ts`（新增）、`src/skill/index.ts`（新增）
  - 预估：2h | 实际：约 30min
  - 依赖：T3.1
  - ✅ 2026-08-08 完成：SkillLoader（YAML frontmatter 解析 + 双路径扫描 + 项目级覆盖全局级）

- [x] **T3.3** 实现 `/skill` 斜杠命令
  - 涉及文件：`src/cli/slash/skill.ts`（新增）、`src/ui/App.tsx`（修改）
  - 预估：1.5h | 实际：约 30min
  - 依赖：T3.2
  - ✅ 2026-08-08 完成：/skill list + /skill <name> + 技能注入 system prompt

- [x] **T3.4** 内置技能测试
  - 涉及文件：`tests/skill/loader.test.ts`（新增）、`tests/cli/slash-skill.test.ts`（新增）
  - 预估：2h | 实际：约 20min
  - 依赖：T3.2、T3.3
  - ✅ 2026-08-08 完成：19 测试（loader 8 + slash-skill 11）

---

### V2.0-M4：MCP 动态管理与体验增强（P1，约 4h）

- [x] **T4.1** `/mcp` 斜杠命令
  - 涉及文件：`src/cli/slash/mcp.ts`（新增）、`src/ui/App.tsx`（修改）、`src/mcp/manager.ts`（修改）
  - 预估：1.5h | 实际：约 30min
  - 依赖：无
  - ✅ 2026-08-08 完成：/mcp status/connect/disconnect + manager.connect/disconnectServer/statusAll

- [x] **T4.2** MCP 状态条展示
  - 涉及文件：`src/ui/StatusBar.tsx`（修改）、`src/mcp/manager.ts`（修改）
  - 预估：1h | 实际：约 15min
  - 依赖：T4.1
  - ✅ 2026-08-08 完成：状态条 🔌 N/M 服务摘要

- [x] **T4.3** 缓存命中 token UI 展示
  - 涉及文件：`src/ui/StatusBar.tsx`（修改）、`src/model/client.ts`（确认）
  - 预估：1.5h | 实际：已在 T1.2 完成
  - 依赖：T1.2、T4.2
  - ✅ 2026-08-08 完成：StatusBar 💾 缓存命中行

---

### V2.0-M5：集成测试与文档（P1，约 4h）

- [x] **T5.1** 子代理 + 技能系统 E2E 测试
  - 涉及文件：`tests/agent/spawner.test.ts`、`tests/agent/e2e.test.ts`、`tests/skill/e2e.test.ts`
  - 预估：1.5h | 实际：约 30min
  - 依赖：T2.5、T3.4
  - ✅ 2026-08-08 完成：13 新测试（spawner 7 + e2e 2 + skill-e2e 4）

- [x] **T5.2** 更新 README、用户手册、架构文档
  - 涉及文件：`README.md`、`docs/05-`、`docs/02-`
  - 预估：1.5h | 实际：约 20min
  - 依赖：全部功能实现后
  - ✅ 2026-08-08 完成：README 新增 v2.0 功能章节；ARCHITECTURE 更新决策 D24-D27

- [x] **T5.3** 更新 CHANGELOG、TASKS 看板、测试报告
  - 涉及文件：`CHANGELOG.md`、`TASKS.md`、`docs/07-`、`docs/07.1-`
  - 预估：1h | 实际：约 15min
  - 依赖：T5.2
  - ✅ 2026-08-08 完成：CHANGELOG v2.0 条目 + TASKS 全部标记完成

---

---

### V2.1-M1：子代理 MCP 工具支持（P0，约 4h）

- [x] **T1.1** SubagentDef.allowedMcpServers + spawner MCP 工具按需加载
  - 涉及文件：`src/agent/types.ts`（修改）、`src/agent/spawner.ts`（修改）
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-08 完成：SubagentDef.allowedMcpServers 字段 + spawner 构造接收 McpManager + 按声明加载 MCP 工具（原始名注册，不加前缀）+ 服务不可用降级不阻塞

- [x] **T1.2** explore/research 子代理声明 MCP 服务
  - 涉及文件：`src/agent/builtin/explore.ts`（修改）、`src/agent/builtin/research.ts`（修改）、`src/cli/chat.tsx`、`src/cli/run.ts`
  - 预估：1h
  - 依赖：T1.1
  - ✅ 2026-08-08 完成：explore 声明 filesystem、research 声明 filesystem+github、chat.tsx 传入 mcpManager 到 spawner

- [x] **T1.3** 子代理 MCP 集成测试
  - 涉及文件：`tests/agent/spawner.test.ts`（修改）
  - 预估：1h
  - 依赖：T1.1、T1.2
  - ✅ 2026-08-08 完成：5 个新测试（未声明不加载/无 McpManager 不崩溃/MCP 可用注册/MCP 不可用降级/内置 explore+research 声明验证）+ 342 用例全绿

---

### V2.1-M2：技能嵌套与子代理调用（P0，约 5h）

- [x] **T2.1** @skill / @agent 引用语法 + 加载器展开
  - 涉及文件：`src/skill/types.ts`（修改）、`src/skill/loader.ts`（修改）
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-08 完成：@skill/@agent 引用正则 + 两遍加载（先解析注册后展开）+ SkillRef/AgentRef 类型定义

- [x] **T2.2** 循环引用检测 + 深度限制
  - 涉及文件：`src/skill/loader.ts`（修改）
  - 预估：1h
  - 依赖：T2.1
  - ✅ 2026-08-08 完成：chain 追踪 + 直接/间接循环检测 + MAX_NEST_DEPTH=3 + rawBodies 保证深度检测正确

- [x] **T2.3** 技能内 @agent 触发子代理
  - 涉及文件：`src/cli/slash/skill.ts`（修改）、`src/ui/App.tsx`（修改）
  - 预估：2h
  - 依赖：T2.1、T2.2、V2.1-M1 T1.2
  - ✅ 2026-08-08 完成：SkillCommandResult.agentRefs 传递 + App.tsx inline 模式异步 spawn 子代理替换占位符

- [x] **T2.4** 技能嵌套集成测试
  - 涉及文件：`tests/skill/loader.test.ts`（修改）
  - 预估：1h
  - 依赖：T2.1、T2.2、T2.3
  - ✅ 2026-08-08 完成：7 个新测试（@skill 展开/@agent 收集/直接循环/间接循环/3 层正常/深度限制/4 层拒绝）+ 349 用例全绿

---

### V2.1-M3：技能市场基础（P1，约 4h）

- [x] **T3.1** 注册表规范 + 内置注册表文件
  - 涉及文件：`skills/registry.json`（新增）
  - 预估：1h
  - 依赖：无
  - ✅ 2026-08-08 完成：RegistryEntry schema + 3 内置技能条目（sha256 校验值）+ 注册表 JSON

- [x] **T3.2** /skill install 命令
  - 涉及文件：`src/cli/slash/skill.ts`（修改）
  - 预估：2h
  - 依赖：T3.1
  - ✅ 2026-08-08 完成：fetchRegistry + fetchSkill + sha256 校验 + 版本比较 + 写入 globalSkillsDir

- [x] **T3.3** /skill search + /skill update 命令
  - 涉及文件：`src/cli/slash/skill.ts`（修改）、`src/ui/App.tsx`（修改）
  - 预估：1h
  - 依赖：T3.2
  - ✅ 2026-08-08 完成：search 模糊匹配 / update 全部或指定 + App.tsx 路由市场命令

- [x] **T3.4** 技能市场集成测试
  - 涉及文件：`tests/cli/slash-skill.test.ts`（修改）
  - 预估：1h
  - 依赖：T3.2、T3.3
  - ✅ 2026-08-08 完成：12 新测试（install 成功/已安装跳过/未找到/网络错误 + search 模糊/全部 + 解析 6 个）+ 361 用例全绿

---

### V2.1-M4：轻量级知识图谱 + RAG（P1，约 6h）

- [x] **T4.1** 知识图谱存储层（types + store）
  - 涉及文件：`src/knowledge/types.ts`（新增）、`src/knowledge/store.ts`（新增）、`src/knowledge/index.ts`（新增）
  - 预估：2h
  - 依赖：无
  - ✅ 2026-08-08 完成：Entity/Relation/Observation 三层模型 + JSONL 持久化 + Map 内存索引 + LRU 淘汰

- [x] **T4.2** 向量化与检索 + knowledge_* 工具
  - 涉及文件：`src/knowledge/search.ts`（新增）、`src/tools/knowledge.ts`（新增）
  - 预估：2h
  - 依赖：T4.1
  - ✅ 2026-08-08 完成：TF-IDF 关键词搜索 + 关系关联度加权 + 5 个知识图谱工具注册

- [x] **T4.3** 双源记忆合并（本地图谱 + MCP memory）
  - 涉及文件：`src/loop/memory-injector.ts`（修改）
  - 预估：2h
  - 依赖：T4.1、T4.2
  - ✅ 2026-08-08 完成：MemoryInjector 支持双源检索 + (entityName, observation) 联合去重

- [x] **T4.4** 知识图谱集成测试
  - 涉及文件：`tests/knowledge/store.test.ts`（新增）
  - 预估：1h
  - 依赖：T4.1、T4.2、T4.3
  - ✅ 2026-08-08 完成：8 个测试（CRUD/搜索/LRU/持久化）+ 369 用例全绿

---

### V2.1-M5：Reviewer Agent 代码评审智能体（P0，约 8h）

- [x] **T5.1** RA 类型定义 + SubagentDef.knowledgeBase 扩展
  - 涉及文件：`src/reviewer/types.ts`（新增）、`src/agent/types.ts`（修改）
  - 预估：1h
  - 依赖：无
  - ✅ 2026-08-08 完成：ReviewDimension/Severity/ReviewIssue/ReviewReport + SubagentDef.knowledgeBase

- [x] **T5.2** RA 知识库加载器
  - 涉及文件：`src/reviewer/knowledge.ts`（新增）
  - 预估：1h
  - 依赖：T5.1
  - ✅ 2026-08-08 完成：三级优先级加载 + 字符数截断 + formatKnowledgeContext

- [x] **T5.3** 9 维审查子代理定义（5 个子代理）
  - 涉及文件：`src/reviewer/dimensions.ts`（新增）
  - 预估：2h
  - 依赖：T5.1
  - ✅ 2026-08-08 完成：9 维聚合为 5 子代理 + 各自 system prompt + JSON 解析 + 严重程度倾向

- [x] **T5.4** RA 工作流引擎（上下文收集 + 知识激活）
  - 涉及文件：`src/reviewer/engine.ts`（新增）
  - 预估：1h
  - 依赖：T5.2、T5.3
  - ✅ 2026-08-08 完成：ResolveScope（files/auto/PR）+ 知识库注入 + createReviewAgents

- [x] **T5.5** RA 工作流引擎（并行子代理 + 结果聚合）
  - 涉及文件：`src/reviewer/engine.ts`（新增）
  - 预估：1h
  - 依赖：T5.4、V2.1-M1
  - ✅ 2026-08-08 完成：Promise.allSettled 并行 spawn + 去重 + 严重程度排序 + buildSummary

- [x] **T5.6** RA 工作流引擎（自动测试 + 自动修正/回滚）
  - 涉及文件：`src/reviewer/engine.ts`（新增）
  - 预估：1h
  - 依赖：T5.5
  - ✅ 2026-08-08 完成：execSync npm run verify + autoFix 方法（仅 suggestion）+ 审批流集成

- [x] **T5.7** /review 命令 + 报告渲染
  - 涉及文件：`src/cli/slash/review.ts`（新增）、`src/ui/ReviewReport.tsx`（新增）、`src/ui/App.tsx`（修改）
  - 预估：1.5h
  - 依赖：T5.6
  - ✅ 2026-08-08 完成：/review auto/files/PR 三模式 + Ink 报告组件 + App.tsx 引擎集成

- [x] **T5.8** RA 知识库 10 份文档编写
  - 涉及文件：`skills/reviewer/knowledge/KB-01~KB-10`（新增）
  - 预估：0.5h
  - 依赖：无
  - ✅ 2026-08-08 完成：项目规范/架构模式/类型安全/错误处理/安全清单/性能/测试/反模式/报告模板/自动修正规则

---

### V2.1-M6：集成测试与文档（P1，约 3h）

- [x] **T6.1** RA + 子代理 MCP + 技能嵌套 + 知识图谱 E2E
  - 涉及文件：`tests/reviewer/engine.test.ts`（新增）
  - 预估：1.5h
  - 依赖：M1-M5 全部完成
  - ✅ 2026-08-08 完成：11 个测试（命令解析/命令执行/报告格式化）+ 380 用例全绿

- [x] **T6.2** 更新 CHANGELOG、TASKS 看板、测试报告
  - 涉及文件：`CHANGELOG.md`、`TASKS.md`、`docs/07.2-手工测试报告-v2.1.md`
  - 预估：1h
  - 依赖：T6.1
  - ✅ 2026-08-08 完成：CHANGELOG v2.1 条目 + TASKS 全部 25 任务完成 + 手工测试报告 v2.1（41 项）

- [x] **T6.2** 文档更新 + CHANGELOG + TASKS 看板
  - 涉及文件：`README.md`、`docs/02-`、`docs/05-`、`docs/SKILL.md`、`docs/07-`、`CHANGELOG.md`、`TASKS.md`
  - 预估：1.5h
  - 依赖：T6.1
  - ✅ 2026-08-08 完成：TASKS 全部 25 任务完成 + CHANGELOG v2.1 + 手工测试报告 v2.1（41 项）
  - 待开始

---

### V3.0-M0：启动前置（P0，约 1h）

- [x] **T0.1** ADR-009~014 回填 DECISIONS.md
  - 涉及文件：`docs/06-会议与决策记录/DECISIONS.md`（修改 — 新增 ADR-009~014）
  - 预估：0.5h
  - 依赖：无
  - ✅ 2026-08-09 完成：6 条 ADR 按 ADR-001~008 格式回填（状态/日期/上下文/选项/结论/理由），409 用例全绿

- [x] **T0.2** 接口草图评审
  - 涉及文件：`src/orchestrator/types.ts`（草图 — 评审对象，仅定稿不实现）
  - 预估：0.5h
  - 依赖：T0.1
  - ✅ 2026-08-09 完成：AgentMessage/AgentContext/AgentDef 三类型评审通过，结论记入 ADR-016（含 5 项未决问题 → M1 修正项）

### V3.0-M1：接口定义与基础协议（P0，约 6h）

- [x] **T1.1** 定义 Agent 通信协议类型
  - 涉及文件：`src/orchestrator/types.ts`（新增）、`src/orchestrator/index.ts`（新增）
  - 预估：2h
  - 依赖：T0.2
  - ✅ 2026-08-09 完成：AgentMessage 泛型 + 判别联合 + 类型守卫、AgentContext/Artifact、AgentDef（zod schema）、AgentState/AgentRuntimeState 分离，落实 ADR-016 全部 5 项修正项；15 测试（424 全绿）

- [x] **T1.2** 定义 Agent 注册表接口 + 标准 Agent 接口
  - 涉及文件：`src/agents/protocol.ts`（新增）、`src/agents/registry.ts`（新增）、`src/agents/index.ts`（新增）
  - 预估：2h
  - 依赖：T0.2、T1.1
  - ✅ 2026-08-09 完成：Agent 契约（execute/send/receive + AgentRuntimeState + 输入输出 Schema 校验）+ InMemoryAgentRegistry（register/unregister/get/list/has/permissionsOf）；16 测试（440 全绿）

- [x] **T1.3** 实现显式上下文管理器
  - 涉及文件：`src/orchestrator/context.ts`（新增）、`tests/orchestrator/context.test.ts`（新增）、`src/orchestrator/index.ts`（修改）
  - 预估：2h | 实际：约 1h
  - 依赖：T0.2、T1.1
  - ✅ 2026-08-09 完成：serialize/deserialize 往返一致 + extractSubset 按 taskId 子集提取 + mergeContexts 合并去重（artifactId）+ 64KB 上限保护（serialize 抛 ContextLimitError / enforceLimit 截断标记）+ createArtifact 来源追踪（fromAgent/messageId/taskId）；修复 mergeContexts 4 个类型安全错误（ctx 空值检查 + first 可选链 ?? 默认值）；19 测试（473 全绿）

### V3.0-M2：Orchestrator 核心（P0，约 8h）

- [ ] **T2.1** 实现任务状态机
  - 涉及文件：`src/orchestrator/state-machine.ts`（新增）
  - 预估：3h
  - 依赖：T1.1、T1.2

- [ ] **T2.2** 实现任务调度器
  - 涉及文件：`src/orchestrator/scheduler.ts`（新增）
  - 预估：3h
  - 依赖：T1.1、T1.2、T2.1

- [ ] **T2.3** 实现 Orchestrator Agent 核心
  - 涉及文件：`src/agents/orchestrator.ts`（新增）、`src/loop/`（修改）
  - 预估：2h
  - 依赖：T2.1、T2.2

### V3.0-M3：多角色 Agent 团队（P0，约 14h）

- [ ] **T3.1** 实现 Architect Agent
  - 涉及文件：`src/agents/architect.ts`（新增）
  - 预估：3h
  - 依赖：T1.x、T2.3

- [ ] **T3.2** 实现 Coder Agent
  - 涉及文件：`src/agents/coder.ts`（新增）
  - 预估：3h
  - 依赖：T1.x、T2.3、T3.1

- [ ] **T3.3** 升级 Reviewer Agent（Team Reviewer）
  - 涉及文件：`src/agents/reviewer.ts`（新增）、`src/reviewer/`（修改）
  - 预估：3h
  - 依赖：T1.x、T2.3

- [ ] **T3.4** 实现 QA Agent
  - 涉及文件：`src/agents/qa.ts`（新增）
  - 预估：2h
  - 依赖：T1.x、T2.3

- [ ] **T3.5** 实现对抗性闭环流程
  - 涉及文件：`src/orchestrator/loop.ts`（新增）
  - 预估：1h
  - 依赖：T3.1、T3.2、T3.3、T3.4

- [ ] **T3.6** 实现多文件事务回滚
  - 涉及文件：`src/orchestrator/transaction.ts`（新增）、`src/cli/`（修改）
  - 预估：2h
  - 依赖：T3.2、T3.5

### V3.0-M4：Agent 市场基础（P1，约 7h）

- [ ] **T4.1** 定义 Agent 市场注册表格式
  - 涉及文件：`src/market/types.ts`（新增）、`src/market/registry.ts`（新增）
  - 预估：2h
  - 依赖：T1.2

- [ ] **T4.2** 实现 Agent 安装器
  - 涉及文件：`src/market/installer.ts`（新增）
  - 预估：2h
  - 依赖：T4.1

- [ ] **T4.3** 实现 /agent 管理命令
  - 涉及文件：`src/cli/slash/agent.ts`（新增）、`src/ui/App.tsx`（修改）
  - 预估：2h
  - 依赖：T4.2

- [ ] **T4.4** 实现 /agent promote <skill>
  - 涉及文件：`src/market/promote.ts`（新增）、`src/cli/slash/agent.ts`（修改）
  - 预估：1h
  - 依赖：T4.3、v2.1 技能系统（src/skill/）

### V3.0-M5：可观测性面板（P1，约 4h）

- [ ] **T5.1** 实现调用链追踪
  - 涉及文件：`src/observable/trace.ts`（新增）、`src/observable/index.ts`（新增）
  - 预估：1.5h
  - 依赖：T1.1、T2.1

- [ ] **T5.2** 实现审计日志
  - 涉及文件：`src/observable/audit.ts`（新增）
  - 预估：1h
  - 依赖：T5.1

- [ ] **T5.3** 实现可观测性面板 TUI
  - 涉及文件：`src/ui/ObservabilityPanel.tsx`（新增）、`src/ui/App.tsx`（修改）
  - 预估：1.5h
  - 依赖：T5.1、T5.2

### V3.0-M6：集成测试与文档（P1，约 4h）

- [ ] **T6.1** 多 Agent 协作 E2E 测试
  - 涉及文件：`tests/e2e/orchestrator.test.ts`、`tests/e2e/team-loop.test.ts`、`tests/orchestrator/transaction.test.ts`、`tests/market/installer.test.ts`、`tests/observable/trace.test.ts`（均新增）
  - 预估：1.5h
  - 依赖：M1-M5 全部完成

- [ ] **T6.2** 文档更新
  - 涉及文件：`README.md`、`docs/02-架构设计/ARCHITECTURE.md`、`docs/05-用户与开发指南/user-guide.md`、`docs/05-用户与开发指南/agent-dev-guide.md`（新增）
  - 预估：1.5h
  - 依赖：T6.1

- [ ] **T6.3** CHANGELOG + TASKS 看板 + 测试报告
  - 涉及文件：`CHANGELOG.md`、`docs/03-开发计划与任务/TASKS.md`、`docs/07-测试报告.md`
  - 预估：1h
  - 依赖：T6.2

---

## ⚠️ 阻塞任务清单（Blockers）

> 暂无阻塞任务

---

## 📝 变更日志

| 日期 | 变更内容 | 作者 |
|------|---------|------|
| 2026-08-07 | T1.1 完成：核实 DeepSeek 模型 ID 与定价 | Carbon Code |
| 2026-08-07 | T1.2 完成：透传真实 API usage | Carbon Code |
| 2026-08-07 | T1.3 完成：流式取消与断流策略 | Carbon Code |
| 2026-08-07 | T1.4 完成：编辑工具 CRLF/BOM 加固 | Carbon Code |
| 2026-08-07 | T1.5 完成：会话并发写保护 | Carbon Code |
| 2026-08-07 | T1.6 完成：上下文窗口管理（V1-M1 全部完成） | Carbon Code |
| 2026-08-07 | T2.1 完成：markdown 渲染 + 代码高亮 | Carbon Code |
| 2026-08-07 | T2.2 完成：输入框光标与历史 | Carbon Code |
| 2026-08-07 | T2.3 完成：resume 交互式会话列表 | Carbon Code |
| 2026-08-07 | T2.4 完成：生成中断与进度指示（V1-M2 全部完成） | Carbon Code |
| 2026-08-07 | T3.1 完成：并行工具调度 | Carbon Code |
| 2026-08-07 | T3.2 完成：工具调用修复管线 | Carbon Code |
| 2026-08-07 | T3.3 完成：plan 模式 | Carbon Code |
| 2026-08-07 | T3.4 完成：配置系统（V1-M3 全部完成） | Carbon Code |
| 2026-08-07 | T4.1 完成：npm 包与 bin | Carbon Code |
| 2026-08-07 | T4.2 完成：发布管线 | Carbon Code |
| 2026-08-07 | T4.3 完成：CI | Carbon Code |
| 2026-08-07 | T4.4 完成：依赖升级评估 | Carbon Code |
| 2026-08-07 | T4.5 完成：EN 文案与 locale 架构 | Carbon Code |
| 2026-08-07 | T4.6 完成：文档与发布件（**v1.0 全部 20 个任务完成**） | Carbon Code |
| 2026-08-07 | T4.6 完善：文档重构收尾（docs 目录编号 01-06、修复死链与 `lumen init` 笔误、补充 ADR 与计划文档） | Carbon Code |
| 2026-08-08 | v1.1 计划启动：生成 `v1.1-dev-plan.md`、`v1.1-dev-tasks.md`，更新 TASKS 看板（+12 任务、4 里程碑） | Carbon Code |
| 2026-08-08 | **V1.1-M1 完成**：T1.1 MCP 客户端 + T1.2 filesystem 集成 + T1.3 memory 注入（23 新测试，mcp/ 模块全链路） | Carbon Code |
| 2026-08-08 | **V1.1-M2 完成**：T2.1 依赖检测 + T2.2 进度跟踪 + T2.3 文件回滚（25 新测试，planner/ 模块） | Carbon Code |
| 2026-08-08 | **V1.1-M3 完成**：T3.1 记忆存储 + T3.2 检索注入 + T3.3 管理命令（19 新测试，memory + slash 模块） | Carbon Code |
| 2026-08-08 | **V1.1-M4 全部完成**：T4.1 E2E 测试 ✅ + T4.2 README/用户手册更新 ✅ + T4.3 架构/测试报告更新 ✅（v1.1 全部 12 个任务 100% 完成） | Carbon Code |
| 2026-08-08 | v2.0 计划启动：生成 `v2.0-dev-plan.md`、`v2.0-dev-tasks.md`，更新 TASKS 看板（+15 任务、5 里程碑）、ADR-006/007/008 决策记录 | Carbon Code |
| 2026-08-08 | **V2.0-M1 完成**：T1.1 BPE tokenizer + T1.2 精确成本/缓存命中 + T1.3 智能摘要压缩（305 测试） | Carbon Code |
| 2026-08-08 | **V2.0-M2 完成**：T2.1-T2.5 子代理系统（spawner + explore/research + spawn_subagent 工具集成） | Carbon Code |
| 2026-08-08 | **V2.0-M3 完成**：T3.1-T3.4 技能系统（SKILL.md 规范 + SkillLoader + /skill 命令 + 19 测试） | Carbon Code |
| 2026-08-08 | **V2.0-M4 完成**：T4.1-T4.3 MCP 动态管理（/mcp 命令 + 状态条 MCP 摘要 + 缓存命中 UI） | Carbon Code |
| 2026-08-08 | **V2.0-M5 全部完成**：T5.1-T5.3 E2E 测试 + 文档更新（337 测试 / 37 文件） | Carbon Code |
| 2026-08-08 | 🎉 **v2.0 全部 15 个任务 100% 完成**（总 47 任务、337 测试、37 文件、npm run verify 全绿） | Carbon Code |
| 2026-08-08 | v2.1 计划启动：生成 `v2.1-dev-plan.md`、`v2.1-dev-tasks.md`，更新 TASKS 看板（+25 任务、6 里程碑）、ADR-009~014 待记录 | Carbon Code |
| 2026-08-08 | **V2.1-M1 完成**：T1.1-T1.3 子代理 MCP 工具支持（3 文件修改/3 任务/5 新测试/342 全绿） | Carbon Code |
| 2026-08-08 | **V2.1-M2 完成**：T2.1-T2.4 技能嵌套与子代理调用（7 文件修改/4 任务/7 新测试/349 全绿） | Carbon Code |
| 2026-08-08 | **V2.1-M6 完成**：T6.1-T6.2 集成测试 + 文档（11 E2E 测试/CHANGELOG/TASKS 终态/380 全绿） | Carbon Code |
| 2026-08-08 | **V2.1-M5 完成**：T5.1-T5.8 Reviewer Agent（16 文件新增/8 任务/369 全绿） | Carbon Code |
| 2026-08-08 | **V2.1-M4 完成**：T4.1-T4.4 轻量级知识图谱 + RAG（5 文件新增/4 任务/8 新测试/369 全绿） | Carbon Code |
| 2026-08-08 | **V2.1-M3 完成**：T3.1-T3.4 技能市场基础（4 文件修改/4 任务/12 新测试/361 全绿） | Carbon Code |
| 2026-08-09 | v3.0 计划建立：`v3.0-dev-plan.md`（v0.7）+ `v3.0-dev-tasks.md`，更新 TASKS 看板（+24 任务 / 7 里程碑） | Carbon Code |
| 2026-08-09 | **V3.0-M0 启动**：T0.1 ADR-009~014 回填 DECISIONS.md（6 条 ADR 格式对齐 ADR-001~008，409 用例全绿） | Carbon Code |
| 2026-08-09 | **V3.0-M0 完成**：T0.2 接口草图评审（AgentMessage/AgentContext/AgentDef 定稿，ADR-016 已采纳，5 项 M1 修正项） | Carbon Code |
| 2026-08-09 | **V3.0-M1 启动**：T1.1 Agent 通信协议类型（src/orchestrator/types.ts + index.ts，15 测试，424 全绿） | Carbon Code |
| 2026-08-09 | **V3.0-M1 推进**：T1.2 Agent 注册表 + 标准 Agent 接口（src/agents/，16 测试，440 全绿，达 v3.0 用例目标） | Carbon Code |

---

*任务完成后请及时更新状态。*