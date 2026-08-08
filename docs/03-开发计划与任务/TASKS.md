# Lumen 开发任务看板

> 最后更新：2026-08-08
> 当前里程碑：**v2.1 规划中**（v1.0: 20/20 ✅ · v1.1: 12/12 ✅ · v2.0: 15/15 ✅ · v2.1: 0/25）
> 基于：[v2.1 开发计划](./v2.1-dev-plan.md) · [v2.1 详细任务](./v2.1-dev-tasks.md)

---

## 📊 总览

| 指标 | 数值 |
|------|------|
| 总任务数 | 72（v1.0: 20 ✅ + v1.1: 12 ✅ + v2.0: 15 ✅ + v2.1: 25） |
| P0 任务 | 16（v1.1: 6 ✅ + v2.0: 5 ✅ + v2.1: 5） |
| P1 任务 | 20（v1.1: 6 ✅ + v2.0: 10 ✅ + v2.1: 4） |
| P2 任务 | 8（v2.1: 8） |
| 待开始 | 25 |
| 进行中 | 0 |
| 已完成 | 47 |
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
| **V2.1-M1 子代理 MCP 工具支持** | **P0** | **3** | ⬜ 待开始 |
| **V2.1-M2 技能嵌套与子代理调用** | **P0** | **4** | ⬜ 待开始 |
| **V2.1-M3 技能市场基础** | **P1** | **4** | ⬜ 待开始 |
| **V2.1-M4 轻量级知识图谱 + RAG** | **P1** | **4** | ⬜ 待开始 |
| **V2.1-M5 Reviewer Agent 代码评审智能体** | **P0** | **8** | ⬜ 待开始 |
| **V2.1-M6 集成测试与文档** | **P1** | **2** | ⬜ 待开始 |

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

- [ ] **T1.1** SubagentDef.allowedMcpServers + spawner MCP 工具按需加载
  - 涉及文件：`src/agent/types.ts`（修改）、`src/agent/spawner.ts`（修改）
  - 预估：2h
  - 依赖：无
  - 待开始

- [ ] **T1.2** explore/research 子代理声明 MCP 服务
  - 涉及文件：`src/agent/builtin/explore.ts`（修改）、`src/agent/builtin/research.ts`（修改）、`src/cli/chat.tsx`、`src/cli/run.ts`
  - 预估：1h
  - 依赖：T1.1
  - 待开始

- [ ] **T1.3** 子代理 MCP 集成测试
  - 涉及文件：`tests/agent/spawner.test.ts`（修改）、`tests/agent/mcp-integration.test.ts`（新增）
  - 预估：1h
  - 依赖：T1.1、T1.2
  - 待开始

---

### V2.1-M2：技能嵌套与子代理调用（P0，约 5h）

- [ ] **T2.1** @skill / @agent 引用语法 + 加载器展开
  - 涉及文件：`src/skill/types.ts`（修改）、`src/skill/loader.ts`（修改）、`docs/SKILL.md`
  - 预估：2h
  - 依赖：无
  - 待开始

- [ ] **T2.2** 循环引用检测 + 深度限制
  - 涉及文件：`src/skill/loader.ts`（修改）
  - 预估：1h
  - 依赖：T2.1
  - 待开始

- [ ] **T2.3** 技能内 @agent 触发子代理
  - 涉及文件：`src/cli/slash/skill.ts`（修改）、`src/agent/spawner.ts`（修改）、`src/ui/App.tsx`（修改）
  - 预估：2h
  - 依赖：T2.1、T2.2、V2.1-M1 T1.2
  - 待开始

- [ ] **T2.4** 技能嵌套集成测试
  - 涉及文件：`tests/skill/loader.test.ts`（修改）、`tests/skill/nesting-e2e.test.ts`（新增）
  - 预估：1h
  - 依赖：T2.1、T2.2、T2.3
  - 待开始

---

### V2.1-M3：技能市场基础（P1，约 4h）

- [ ] **T3.1** 注册表规范 + 内置注册表文件
  - 涉及文件：`skills/registry.json`（新增）、`docs/SKILL.md`（修改）
  - 预估：1h
  - 依赖：无
  - 待开始

- [ ] **T3.2** /skill install 命令
  - 涉及文件：`src/cli/slash/skill.ts`（修改）
  - 预估：2h
  - 依赖：T3.1
  - 待开始

- [ ] **T3.3** /skill search + /skill update 命令
  - 涉及文件：`src/cli/slash/skill.ts`（修改）
  - 预估：1h
  - 依赖：T3.2
  - 待开始

- [ ] **T3.4** 技能市场集成测试
  - 涉及文件：`tests/cli/slash-skill.test.ts`（修改）
  - 预估：1h
  - 依赖：T3.2、T3.3
  - 待开始

---

### V2.1-M4：轻量级知识图谱 + RAG（P1，约 6h）

- [ ] **T4.1** 知识图谱存储层（types + store）
  - 涉及文件：`src/knowledge/types.ts`（新增）、`src/knowledge/store.ts`（新增）、`src/knowledge/index.ts`（新增）
  - 预估：2h
  - 依赖：无
  - 待开始

- [ ] **T4.2** 向量化与检索 + knowledge_* 工具
  - 涉及文件：`src/knowledge/search.ts`（新增）、`src/tools/knowledge.ts`（新增）
  - 预估：2h
  - 依赖：T4.1
  - 待开始

- [ ] **T4.3** 双源记忆合并（本地图谱 + MCP memory）
  - 涉及文件：`src/loop/memory-injector.ts`（修改）、`src/loop/local-memory.ts`（修改）
  - 预估：2h
  - 依赖：T4.1、T4.2
  - 待开始

- [ ] **T4.4** 知识图谱集成测试
  - 涉及文件：`tests/knowledge/store.test.ts`、`tests/knowledge/search.test.ts`、`tests/knowledge/e2e.test.ts`
  - 预估：1h
  - 依赖：T4.1、T4.2、T4.3
  - 待开始

---

### V2.1-M5：Reviewer Agent 代码评审智能体（P0，约 8h）

- [ ] **T5.1** RA 类型定义 + SubagentDef.knowledgeBase 扩展
  - 涉及文件：`src/reviewer/types.ts`（新增）、`src/agent/types.ts`（修改）
  - 预估：1h
  - 依赖：无
  - 待开始

- [ ] **T5.2** RA 知识库加载器
  - 涉及文件：`src/reviewer/knowledge.ts`（新增）、`skills/reviewer/knowledge/`（新增 10 份 KB 文档）
  - 预估：1h
  - 依赖：T5.1
  - 待开始

- [ ] **T5.3** 9 维审查子代理定义（5 个子代理）
  - 涉及文件：`src/reviewer/dimensions.ts`（新增）
  - 预估：2h
  - 依赖：T5.1
  - 待开始

- [ ] **T5.4** RA 工作流引擎（上下文收集 + 知识激活）
  - 涉及文件：`src/reviewer/engine.ts`（新增）
  - 预估：1h
  - 依赖：T5.2、T5.3
  - 待开始

- [ ] **T5.5** RA 工作流引擎（并行子代理 + 结果聚合）
  - 涉及文件：`src/reviewer/engine.ts`（修改）
  - 预估：1h
  - 依赖：T5.4、V2.1-M1
  - 待开始

- [ ] **T5.6** RA 工作流引擎（自动测试 + 自动修正/回滚）
  - 涉及文件：`src/reviewer/engine.ts`（修改）、`src/reviewer/auto-fix.ts`（新增）
  - 预估：1h
  - 依赖：T5.5
  - 待开始

- [ ] **T5.7** /review 命令 + 报告渲染
  - 涉及文件：`src/cli/slash/review.ts`（新增）、`src/ui/ReviewReport.tsx`（新增）、`src/ui/App.tsx`（修改）
  - 预估：1.5h
  - 依赖：T5.6
  - 待开始

- [ ] **T5.8** RA 知识库 10 份文档编写
  - 涉及文件：`skills/reviewer/knowledge/KB-01~KB-10`（新增）
  - 预估：0.5h
  - 依赖：无
  - 待开始

---

### V2.1-M6：集成测试与文档（P1，约 3h）

- [ ] **T6.1** RA + 子代理 MCP + 技能嵌套 + 知识图谱 E2E
  - 涉及文件：`tests/reviewer/engine.test.ts`、`tests/reviewer/e2e.test.ts`
  - 预估：1.5h
  - 依赖：M1-M5 全部完成
  - 待开始

- [ ] **T6.2** 文档更新 + CHANGELOG + TASKS 看板
  - 涉及文件：`README.md`、`docs/02-`、`docs/05-`、`docs/SKILL.md`、`docs/07-`、`CHANGELOG.md`、`TASKS.md`
  - 预估：1.5h
  - 依赖：T6.1
  - 待开始

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

---

*任务完成后请及时更新状态。*