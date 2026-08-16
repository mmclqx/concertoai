# REVIEW v4.1.1 自我审查报告（self-review）

> 审查版本：v4.1.1（P0 热修：循环依赖友好失败 + safeAction 泛型化 + Windows stderr 合并 + preflight 完整初始化 + 测试事故恢复）
> 审查日期：2026-08-17 · 审查人：AI 自我审查（独立完成，不参考其他审查者；基于实际代码逐文件审查，非复述提交信息）
> 方法论：沿数据流逐文件追踪（parser → scheduler → executor → cli → i18n）+ 关键疑点主动深挖（不轻信修复声明）+ 边界推演 + 与回归测试断言对照 + 事故恢复现场复核

---

## 〇、审查范围

| 模块 | 变更（Commit） | 审查重点 |
|------|------|----------|
| workflow/parser.ts（inferDependencies 环检测） | aabde3a | 加边前环检测语义 / 直接环+间接环 / 与 scheduler.hasDependencyPath 复用 |
| workflow/executor.ts（CyclicDependencyError 捕获 + cycle 字段） | aabde3a | 捕获边界 / toRunResult 对环的安全性（**主动深挖疑点**）/ 快照收尾 |
| cli/index.ts（safeAction 泛型化 + workflow action 包裹） | aabde3a | 泛型参数类型保留 / 未预期异常兜底路径 |
| cli/workflow.ts（runFailedCycle + stdout/stderr 合并 + preflight 停止） | aabde3a / 57f413b | 失败分支路由 / stderr 合并正确性 / P1-4 停止提示 |
| utils/error-summary.ts（tsc help 识别 + biome 文件标题） | aabde3a / 57f413b | 识别特征可靠性 / 兜底退化 |
| workflow/preflight.ts（biome 2.x 模板 + tsconfig 自动生成） | 57f413b | 模板版本前瞻 / 半完成裁剪 / 自动修复完整性 |
| workflow/types.ts（WorkflowRunResult.cycle） | aabde3a | 字段语义 |
| i18n zh/en（runFailedCycle / preflightStopped） | aabde3a | 键同构 / en 无 CJK |
| 回归测试（parser/executor/cli/error-summary/preflight） | cb4cdc9 / 74d41a0 | 断言是否真实验证修复（非空转） |
| 测试事故恢复（package.json 污染） | 本次会话 | 恢复完整性 / 无残留 / 防再犯 |

---

## 一、P0-1 循环依赖：生成侧环检测 + 消费侧友好失败

### 1.1 生成侧（parser.inferDependencies）— ✅ 确认正确

```ts
// parser.ts：推断每条边前检查「加 from→to 边是否成环」
if (hasDependencyPath(tasks, rule.to, step.name)) {
  continue; // 目标 to 已（直接/间接）依赖 from → 加边必成环 → 跳过
}
```

- **语义推演**：`hasDependencyPath(tasks, from, to)` = from 是否直接/间接依赖 to（scheduler.ts 注释「判断 from 是否直接或间接依赖 to」）。此处调用 `(tasks, rule.to, step.name)` = **to 是否依赖 from**。若 to 依赖 from，则加 `from → to` 边形成 `from → to → … → from` 环 → 跳过 ✓。
- **场景复现验证（release 模板）**：模板已声明 `build.depends: ['test']`（build 依赖 test）；推断规则「`npm run test` → to: 'build'」建议 `test → build`。环检测：build 依赖 test → 为真 → 跳过 → **不再生成 test→build 边** ✓。修复前正是这条边导致 `test → build → test` 环崩溃。
- **间接环也覆盖**：`a → b → c` 已声明，规则建议 `c → a` → 检测到 c 依赖 a？否；但 a 依赖 c（a→b→c 路径）→ `hasDependencyPath(tasks, rule.to='a', step.name='c')` = a 是否依赖 c = 是 → 跳过 ✓（parser.test.ts 明确断言「间接成环也跳过」）。
- **任务列表构建**：环检测用 `steps.map(s => ({ id, dependencies: s.depends ?? [], run: () => ({ok:true}) }))`——只含已声明边，足够 hasDependencyPath 用（无副作用、不执行）✓。
- **自身依赖排除**：`rule.to !== step.name` 先于环检测，自环不产生 ✓。
- **测试对照**：parser.test.ts「不推断会成环的依赖（release 模板）」断言 `not.toContainEqual({from:'test', to:'build'})` 且「间接成环也跳过」断言 `not.toContainEqual({from:'c', to:'a'})`——**断言反向（不产生坏边）+ 正向（正常边仍产生）双覆盖** ✓ 符合 AGENTS 自查 14（有边与无反向边）。

### 1.2 消费侧（executor.runWorkflow）— ✅ 确认正确（含主动深挖疑点）

```ts
try {
  result = await scheduler.schedule(buildTasks());
} catch (err) {
  if (err instanceof CyclicDependencyError) {
    failedStep = undefined;
    failedError = `循环依赖: ${err.cycle.join(' → ')}`;
    cycle = err.cycle;
    aborted = true;
    break; // 不再 unhandledRejection → crash.log
  }
  throw err; // 其余异常继续上抛（safeAction 兜底）
}
```

- **捕获边界正确**：只捕获 `CyclicDependencyError`，其余异常上抛由 safeAction 兜底（结构错误走友好失败通道，程序缺陷走崩溃通道——符合「结构性异常与执行失败分通道」教训）✓。
- **【主动深挖疑点】**：`toRunResult()` 末尾直接调用 `topologicalSort(...)`（**无 try/catch**）——循环依赖场景下 `workflow.steps` 依赖仍是环，若 topologicalSort 对环抛错，则 runWorkflow 返回时仍会崩溃，友好失败修复被破坏。
  - **核实结论：安全**。scheduler.ts 的 `topologicalSort` 是**纯函数**：环时返回 `{ order: 部分序, cycle: [...] }` **不抛错**（注释明确「存在环时返回 cycle 路径，不抛错，由调用方决定」）；抛 `CyclicDependencyError` 的只有 `TaskScheduler.schedule`（第 2 步拓扑排序后 `if (topo.cycle…) throw`）。因此 toRunResult 拿到的是部分序（Kahn 前缀），不会二次崩溃 ✓。这是「修复声明」与实际代码之间的关键边界，已亲自验证。
- **cycle 场景收尾**：aborted=true → 快照 `else if (aborted) rollback` ✓（有快照时回滚，无残留）。
- **结果语义**：`ok=false, state='failed', failedStep=undefined, cycle=[...]` → CLI 层走 `result.failedStep === undefined` 分支 → runFailedCycle ✓。
- **测试对照**：executor.test.ts 循环依赖改断言（+21 行）；cli/workflow.test.ts 循环依赖 CLI（+95 行内）——断言从「抛错」改为「ok:false + failedStep:undefined + cycle」，与实现一致，**非空转** ✓。

### 1.3 safeAction 泛型化 + workflow action 包裹 — ✅ 确认正确

```ts
function safeAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => void
```

- **泛型保留参数类型**：`A extends unknown[]` 使 commander 传入的 `(action: string, param?: string)` 类型不被抹成 unknown[]——TS strict 下编译通过（typecheck 绿）✓。
- **workflow action 已包裹**：`program.command('workflow <action> [param]')` 的 action 由 `safeAction(async (action, param) => …)` 包住 ✓——未预期异常（如 create 链路模型错误）不再 unhandledRejection 进 crash.log，改为「命令执行失败 + 堆栈 + fatalNextStep + exit(1)」✓。
- **create 的 API Key 失败容错**：`try { client = new DeepSeekClient(...) } catch { client = undefined }` —— create 无 Key 时降级为「无模型提示手动编写」，不阻断 list/init/run/export/import ✓。

### 1.4 CLI 失败分支路由 — ✅ 确认正确

```ts
if (result.ok) { runOk }
else if (result.failedStep === undefined) { runFailedCycle + runFailedNext }  // 循环依赖
else { runFailed + runFailedNext }                                            // 步骤失败
```

- failedStep===undefined 且 !ok 的场景只有 cycle（快照登记失败不置 failedStep）——分支路由无歧义 ✓。
- i18n：zh.ts:225 / en.ts:231 runFailedCycle、zh.ts:269 / en.ts:278 preflightStopped 键齐全，en 无 CJK ✓。

---

## 二、P0-2 Windows stderr 合并 — ✅ 确认正确

```ts
// defaultRunCommand catch 分支
const stdout = e.stdout ?? '';
const stderr = e.stderr ?? '';
const combined = `${stderr}\n${stdout}`.trim();
const errorText = combined !== '' ? combined : (e.message ?? String(err));
return { ok: false, stdout: …, stderr: errorText…, truncated };
```

- **问题还原**：Windows 下 `npm run <script>` 失败时，npm 包装脚本把子进程（tsc/biome）stdout 透传，真实错误（`error TS1287…`）在 **stdout**，err.stderr 为空 → 旧实现 `e.stderr ?? e.message` 只得到「Command failed: npm run typecheck」，真实错误全丢。
- **修复正确**：失败时合并 `stderr\nstdout`（两者都可能含关键行），仅当两者皆空才退回 message——信息不再丢失 ✓。
- **边界**：合并后统一放 stderr 字段返回，executor 用 `out.stderr.trim() || '命令执行失败…'` 作为失败原因 → 经 extractErrorSummary 提取关键行 ✓。截断上限 4000 + truncated 标记保留 ✓。
- **测试对照**：cli/workflow.test.ts stdout 合并 4 用例 ✓。

---

## 三、P0-A/P0-B/P0-C preflight 完整初始化 — ✅ 确认正确

### 3.1 defaultBiomeJson 2.x 兼容（P0-A）

```ts
$schema: 'https://biomejs.dev/schemas/2.5.8/schema.json'
linter: { enabled: true, rules: { preset: 'recommended' } }  // 替代 deprecated recommended: true
```

- biome 2.x（实测 2.5.8）对配置 schema 版本校验（Expected CLI / Found schema 不匹配则 deserialize 失败）+ `recommended` 字段 deprecated——模板升 2.5.8 schema + preset 是正确写法 ✓。
- 仓库自身 biome.json $schema 2.5.7 → 2.5.8 顺手同步（消除本地 deserialize 噪音）✓。
- 测试断言：`not.toContain('recommended')`（避免旧字段回归）+ $schema 指向 2.x ✓。

### 3.2 defaultTsconfigJson + 自动生成（P0-B）

```ts
compilerOptions: { target: esnext, module: nodenext, moduleResolution: nodenext,
  strict: true, noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true },
include: ['**/*.ts']
```

- 裸项目无 tsconfig 时 tsc 打印 help（exit 1）而非检查文件——生成精简基线保证「装完直接 run」typecheck 可跑通 ✓。
- `autoInitForScript('typecheck')` 现在同时 `writeFile: tsconfig.json`；`checkPrerequisites` 对需要 typecheck 的工作流检测 tsconfig.json 缺失（kind:'config'，可自动修复）✓。
- **半完成裁剪推演（主动验证）**：场景「tsc 已装但 tsconfig.json 缺失」→ script 缺失项的 fix.install 是否被裁剪（避免重复 npm install）？
  - missing 含：script(typecheck, fix: install typescript + write tsconfig + addScript)、config(tsconfig.json, fix: write tsconfig)
  - depMissing = {}（无 dep 缺失项，因 binExists('tsc')=true）
  - 裁剪逻辑：`toolForInstall='tsc'`，`!depMissing.has('tsc')` = true → **delete fix.install** ✓ 不重复安装；writeFile 维度：tsconfig.json 不存在 → 保留 ✓。config 缺失项本身保留其 writeFile（continue 跳过裁剪）✓。
  - 结论：裁剪逻辑正确，不会重复安装也不会漏写文件。
- 测试断言：`tsconfig?.fix?.writeFile?.file === 'tsconfig.json'`（缺失可自动修复）+「脚本已配置但依赖未装 → 只报依赖缺失」场景补 tsconfig.json 后 `result.ok` ✓。

### 3.3 tsc help 摘要识别（P0-C）

```ts
const tscHelp =
  lines.some((l) => /tsc: The TypeScript Compiler - Version/i.test(l)) &&
  (lines.some((l) => /COMMON COMMANDS/i.test(l)) || lines.some((l) => /\btsc --init\b/.test(l)));
```

- 识别特征：TS 版本横幅 + help 特征行——真实 TS7.0.2 help 样本测试（`> tsc --noEmit` 包装首行 + 版本行 + `tsc --init` 行）断言 `line 含「缺少 tsconfig.json」+「npx tsc --init」` 且 `not.toContain('> mt43@1.0.0 typecheck')`（不再拿 npm 包装首行当摘要）✓。
- **优先级正确**：`error TS` 行先于 tscHelp 匹配（真实编译错误优先于 help 兜底）✓。
- **一致性观察**：摘要建议「运行 npx tsc --init」是手动路径；preflight 自动初始化现在已自动生成 tsconfig.json——两者不冲突（自动路径优先，手动路径供未走 preflight 的场景）✓。

---

## 四、P1-4 preflight 停止提示 — ✅ 确认正确

```ts
// autoActions.length === 0（如仅 test 缺失不可自动）且用户拒绝继续
if (answer?.toLowerCase() !== 'y' && …) {
  console.log(d.preflightStopped);  // 「已停止执行，请先配置缺失项后重试。」
  return false;
}
```

- 修复前：用户拒绝继续 → 静默 return false（像「假按钮」）；修复后明确提示已停止 ✓（测试事故记录 v4.1.1-test-result-1.md 实测该文案出现）。zh/en 双键 ✓。

---

## 五、测试事故恢复复核 — ✅ 确认完整

| 项 | 复核结果 |
|----|----------|
| package.json 恢复 | `git restore` 后 `git diff HEAD` 空；name/version/scripts/dev 依赖/type:module 全部与 HEAD 一致 |
| 残留清理 | 根目录 index.ts 已删；`.concertoai/workflows/` 已删（snapshots 空、skills 为原有内容保留）；`C:\tmp\concertoai-mt44` 已删 |
| 全局目录 | `~/.concertoai` sessions/audit/config 均无事故时刻写入（sessions 02:30 为 P0 测试、深夜为正常使用） |
| 功能性 | `npm run dev` 正常启动（非交互保护提示=预期行为）；`npm run verify` 全绿 |
| 防再犯 | AGENTS.md 新增自查第 16 条（手工测试隔离目录验证）+ 命令执行规则第 2 条（跨盘符 cd /d / pushd） |
| 文档落盘 | 踩坑记录 2026-08-16-手工测试cd跨盘符未生效污染项目根目录.md + 测试记录事故说明已提交 |

---

## 六、观察项（非阻塞，建议 v4.2）

| # | 观察 | 严重度 | 说明 |
|---|------|--------|------|
| 1 | `MAX_RECOVERY_ROUNDS=10` 循环自然耗尽且非 abort 时，快照事务**既不 commit 也不 rollback**（悬挂） | 低 | executor 收尾仅处理 `allDone`（commit）与 `aborted`（rollback）；10 轮后退出且 !allDone 时两分支都不进。实际不可达（用户每轮主动选择，连续 10 次失败仍不 abort 不现实）。建议 v4.2：循环自然退出且 !allDone 时显式 rollback 或强制转 abort |
| 2 | error-summary biome 文件标题正则 `^(\S+?)\s+(format\|lint)\s+━+` 对**含空格路径**退化 | 低 | `\S+?` 不能跨空白 → fileMatch null → 兜底返回整行标题（含 ━ 噪音，但文件名仍可读）。biome 输出相对路径（通常无空格）时无影响；不影响正确性 |
| 3 | safeAction catch 内 `process.exit(1)` 与 console.log 异步 flush 边界 | 低 | 管道下 console.log 异步，理论上未 flush 的 stdout 可能丢失。既有模式（chat/run/plan 一致），且仅「未预期异常」路径触发，可接受 |

---

## 七、结论

| 项 | 结果 |
|----|------|
| 阻断问题 | **0** |
| P0 修复正确性 | 全部确认（环检测语义 / executor 捕获边界 / **toRunResult 对环安全性（深挖疑点已解除）** / safeAction 泛型 / stderr 合并 / biome 2.x 模板 / tsconfig 自动生成 / tsc help 识别 / preflight 停止提示） |
| 回归测试 | 断言与实现逐条对照，非空转；直接环 + 间接环 + 真实 TS7 help 样本 + biome 2.x 字段断言 + stdout 合并 4 用例 |
| 测试事故恢复 | 完整（工作区干净 / verify 全绿 / 防再犯规范落盘） |
| 非阻塞建议 | 3 项（快照悬挂边界 / biome 标题正则空格路径 / exit flush）→ v4.2 |
| 发布门 | verify 全绿（build+lint+typecheck+全量测试）；手工测试报告 `docs/07.10-手工测试报告-v4.1.1.md` 已完成；**待办：版本号 bump 4.1.1（8 处联动）、npm whoami/audit、publish + tag + 工作区归零** |

## 八、发布前待办（按顺序）

1. 版本号联动 bump `4.1.0 → 4.1.1`：package.json + package-lock.json（顶部 2 处）+ src/version.ts + tests/smoke.test.ts + 硬编码 `@concertoai/cli@4.1.1` 段标记 + README 状态行 → 一次改完立即提交
2. 手工测试报告 `docs/07.10-手工测试报告-v4.1.1.md` —— **已完成**（2026-08-16：C1-C3 真实终端实测 + P0 修复前后对照 mt43 vs mt44 + 测试事故恢复 + test 脚本补全后 precommit 全绿路径；C5 审批节点待补脚本后复测，见报告已知问题 #1）→ **用户确认**
3. `npm whoami` + `npm audit` → `npm publish`（prepublishOnly=verify）→ `git tag v4.1.1` → 发布后 `git status` 归零（自查 #13）

---

*自我审查完成：不参考其他审查者；沿数据流逐文件追踪（parser → scheduler → executor → cli → i18n），主动深挖「toRunResult 对环安全性」「半完成裁剪是否重复安装」两处疑点并逐一推演解除；与回归测试断言逐条对照；事故恢复现场复核（git diff / 残留 / dev / verify / 全局目录）。*
