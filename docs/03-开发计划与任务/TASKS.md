# Lumen 开发任务看板

> 最后更新：2026-08-08
> 当前里程碑：**v1.1 开发中**（v1.0 已发布，20/20 完成）
> 基于：[v1.1 开发完善计划](./v1.1-dev-plan.md) · [v1.1 详细任务](./v1.1-dev-tasks.md)

---

## 📊 总览

| 指标 | 数值 |
|------|------|
| 总任务数 | 32（v1.0: 20 ✅ + v1.1: 12） |
| P0 任务 | 6 |
| P1 任务 | 6 |
| 待开始 | 6 |
| 进行中 | 0 |
| 已完成 | 26 |
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
| **V1.1-M3 跨会话记忆** | **P1** | **3** | ⬜ 待开始 |
| **V1.1-M4 集成测试与文档** | **P1** | **3** | ⬜ 待开始 |

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

- [ ] **T3.1** 实现项目级记忆存储
  - 涉及文件：`src/store/memory-store.ts`
  - 预估：2h
  - 依赖：无
  - 待开始

- [ ] **T3.2** 实现记忆检索与注入
  - 涉及文件：`src/loop/memory-injector.ts`, `src/loop/loop.ts`
  - 预估：2h
  - 依赖：T3.1
  - 待开始

- [ ] **T3.3** 实现记忆管理命令（`/remember`, `/forget`）
  - 涉及文件：`src/cli/slash/memory.ts`, `src/ui/App.tsx`
  - 预估：2h
  - 依赖：T3.1
  - 待开始

---

### V1.1-M4：集成测试与文档（P1，约 4h）

- [ ] **T4.1** MCP 全链路集成测试
  - 涉及文件：`tests/mcp/e2e.test.ts`, `tests/mcp/mock-server.ts`
  - 预估：1.5h
  - 依赖：T1.1、T1.2、T1.3
  - 待开始

- [ ] **T4.2** 更新 README 与用户手册
  - 涉及文件：`README.md`, `docs/05-用户与开发指南/user-guide.md`, `CHANGELOG.md`
  - 预估：1.5h
  - 依赖：全部功能实现后
  - 待开始

- [ ] **T4.3** 更新架构文档与测试报告
  - 涉及文件：`docs/02-架构设计/ARCHITECTURE.md`, `docs/07-测试报告.md`
  - 预估：1h
  - 依赖：T4.2
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

---

*任务完成后请及时更新状态。*