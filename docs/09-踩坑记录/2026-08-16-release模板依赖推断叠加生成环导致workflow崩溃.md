# [2026-08-16] release 模板依赖推断叠加生成环 → workflow run 崩溃（unhandledRejection 进 crash.log）

## 问题描述
- 现象（真实手工测试复现，证据 `docs/11-手工测试结果/v4.0-test-result.md`）：
  1. `concertoai workflow init` 选 release 模板 → 依赖推断提示「test 依赖 build / build 依赖 lint / publish 依赖 build」→ 用户确认 y → 生成 `release.yml`；
  2. `concertoai workflow run release` → preflight 预检有缺失项 → 用户继续 y → 执行中直接崩溃：
  ```
  [ConcertoAI] 未处理的 Promise 拒绝，详情见 ~/.concertoai/crash.log
  CyclicDependencyError: 检测到循环依赖: test → build → test
      at TaskScheduler.schedule (dist/chunk-…js:402)
      at runWorkflow (dist/chunk-…js:152)
      at async runWorkflowCli (dist/chunk-…js:1129)
  ```
  用户主动继续（y）却得到崩溃 + crash.log，无任何可操作的修复提示。
- 环境：Windows x64 / Node v22 / @concertoai/cli v4.0（手工测试期间复现；v4.1.0 发布后修复）

## 根因分析
- 直接原因：**模板预置依赖 + 推断新增依赖叠加产生环**。release 模板步骤 `build` 已预置 `depends: [test]`（先测试后构建），而 `inferDependencies` 的规则又建议 `test` 依赖 `build`（「test 前通常需要先 build」）→ 双向依赖 `test → build → test` 成环。
- 代码链路：
  1. `src/workflow/parser.ts` 的 `inferDependencies` 只检查「目标不存在或已声明 → 跳过」，**不检查加边后是否成环** → 照常输出 `{ from: 'test', to: 'build' }`，用户确认后写入 YAML；
  2. `runWorkflow` → `TaskScheduler.schedule` → `topologicalSort` 检测到环 → `throw new CyclicDependencyError`；
  3. **executor 未捕获该异常** → promise rejection 冒泡到 CLI action → crash-handler 的 unhandledRejection 写 crash.log + 崩溃（用户主动操作却体验为「程序崩了」）。
- 深层原因：
  1. **推断函数与调度器环检测脱节**：`inferDependencies`（生成侧）与 `TaskScheduler`（消费侧）分属两处，生成侧无环约束，消费侧只能事后抛错且无人兜底；
  2. **结构性异常缺友好层**：`CyclicDependencyError` 属于「配置错误」（结构性问题，非步骤执行失败），`runWorkflow` 只处理步骤失败（failedStep），未区分「执行失败」与「结构非法」，导致结构性错误走通用异常通道（崩溃）。

## 解决方案
- 双层修复：
  1. **根因层（parser.inferDependencies）**：推断每条边前用 `hasDependencyPath(tasks, rule.to, step.name)` 检查——若目标 `to` 已（直接或间接）依赖 `from`，加 `from → to` 边必成环 → 跳过该推断（继续尝试下一条规则）。环检测复用 scheduler 导出的 `hasDependencyPath`（语义：from 依赖 to）。
  2. **防御层（executor.runWorkflow）**：捕获 `CyclicDependencyError` → 转为友好失败结果（`ok:false` + `failedStep:undefined` + `cycle` 环路径），不抛异常；CLI 层 `runFailedCycle` 文案提示「检测到循环依赖（test → build → test）💡 请编辑 release.yml，移除互相依赖的 depends 后重跑」+ 不再进 crash.log。
  3. **兜底层（cli/index.ts）**：`safeAction` 泛型化包住 workflow action，其余未预期异常也不再 unhandledRejection（与 chat/run/plan 兜底一致，输出「命令执行失败 + 💡 下一步」）。
- 涉及文件：`src/workflow/executor.ts` / `src/workflow/parser.ts` / `src/workflow/types.ts`（WorkflowRunResult.cycle）/ `src/cli/index.ts` / `src/cli/workflow.ts` / `src/i18n/zh.ts`+`en.ts`（runFailedCycle）/ 回归测试 4 文件（executor 改断言 + parser 2 + cli 6 + error-summary 2，合计 1390→1400 用例）

## 经验教训
- 如何避免同类问题：
  1. **生成侧（推断/模板）与消费侧（调度/执行）必须共享环约束**：任何「推断依赖/加边」逻辑在写出前必须做环检测（`hasDependencyPath`），不能依赖消费侧事后抛错；
  2. **结构性异常（配置非法）与执行失败必须分通道**：配置错误应转「友好失败结果 + 修复建议」，绝不能让用户主动操作时看到崩溃（crash.log）——崩溃只留给真正的程序缺陷；
  3. **CLI action 一律包 safeAction**：新增命令族时立即用 safeAction 包裹，防止 unhandledRejection 绕过友好错误层。
- 是否需要更新规范：✅
- 规范更新位置：AGENTS.md 提交前自查清单——「解析/生成类逻辑共享约束」已在自查 10（解析正则多平台样本）基础上补充「推断加边前环检测」；后续新增依赖推断/加边逻辑强制带环检测。

## 相关链接
- 复现证据：`docs/11-手工测试结果/v4.0-test-result.md`（workflow run release → CyclicDependencyError 崩溃段）
- 相关 Commit：`fix(workflow): v4.1 热修——循环依赖友好失败 + 推断环检测…`（含 executor/parser/types/cli/index/i18n + 测试）
