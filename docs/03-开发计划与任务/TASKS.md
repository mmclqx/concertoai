# Lumen 开发任务看板

> 最后更新：2026-08-07
> 当前里程碑：V1-M1（可靠性加固）
> 基于：[v1.0 开发完善计划](./v1.0-dev-plan.md)

---

## 📊 总览

| 指标 | 数值 |
|------|------|
| 总任务数 | 20 |
| P0 任务 | 7 |
| P1 任务 | 13 |
| 待开始 | 9 |
| 进行中 | 0 |
| 已完成 | 11 |
| 已阻塞 | 0 |

---

## 🎯 里程碑进度

| 里程碑 | 级别 | 任务数 | 状态 |
|--------|------|--------|------|
| V1-M1 可靠性加固 | P0 | 6 | ✅ 已完成 |
| V1-M2 体验升级 | P1 | 4 | ✅ 已完成 |
| V1-M3 能力扩展 | P1 | 4 | 🔄 进行中（1/4） |
| V1-M4 发布工程 | P1 | 6 | ⏳ 未开始 |

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

- [ ] **T3.2** 工具调用修复管线（限次重试）
  - 涉及文件：`src/loop/loop.ts`, `src/tools/registry.ts`
  - 预估：3h
  - 依赖：无

- [ ] **T3.3** plan 模式
  - 涉及文件：`src/ui/modals.tsx`, `src/loop/loop.ts`, `src/cli/run.ts`
  - 预估：4h
  - 依赖：T3.1

- [ ] **T3.4** 配置系统（`~/.lumen/config.json`）
  - 涉及文件：`src/store/config.ts`, `src/cli/chat.tsx`
  - 预估：3h
  - 依赖：无

---

### V1-M4：发布工程（P1，约 12h）

- [ ] **T4.1** npm 包与 bin
  - 涉及文件：`package.json`, `tsup.config.ts`
  - 预估：2h
  - 依赖：T1.1

- [ ] **T4.2** 发布管线（Trusted Publishing）
  - 涉及文件：`package.json`, `CHANGELOG.md`
  - 预估：2h
  - 依赖：T4.1

- [ ] **T4.3** CI（GitHub Actions）
  - 涉及文件：`.github/workflows/ci.yml`
  - 预估：2h
  - 依赖：无

- [ ] **T4.4** 依赖升级评估
  - 涉及文件：`package.json`, `vitest.config.ts`
  - 预估：2h
  - 依赖：无

- [ ] **T4.5** EN 文案与 locale 架构
  - 涉及文件：`src/i18n/`, 全项目文案引用
  - 预估：3h
  - 依赖：T3.4

- [ ] **T4.6** 文档与发布件
  - 涉及文件：`README.md`, `docs/`
  - 预估：3h
  - 依赖：T4.1

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

---

*任务完成后请及时更新状态。*