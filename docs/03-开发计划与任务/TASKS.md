# ConcertoAI 开发任务看板

> 最后更新：2026-10-28
> 当前里程碑：**🟡 v5.0 开发中（M1 7/7 ✅ + M2 审批透明化 4/4 ✅ + M3 场景可发现 3/3 ✅ 均已封板 + M4 动词化 2/5 🔄，2026-10-28）**（v5.0: M1 **7/7** ✅ · M2 **4/4** ✅ · M3 **3/3** ✅ · M4 **2/5** 🔄 · 下一步 **M4 T17 commit** · 148 文件 / 2035 用例全绿）
> 基于：[v5.0 开发计划](./v5.0-dev-plan.md) · [v5.0 开发任务](./v5.0-dev-tasks.md) · 历史：[v4.2 开发任务（已并入 v5.0 M1）](./v4.2-dev-tasks.md) · [v4.1 开发任务](./v4.1-dev-tasks.md) · [v4.0 开发任务](./v4.0-dev-tasks.md)

---

## 🆕 v5.0 进度（从「黑盒引擎」到「透明驾驶舱」）

> 计划：[`v5.0-dev-plan.md`](./v5.0-dev-plan.md) · 任务书：[`v5.0-dev-tasks.md`](./v5.0-dev-tasks.md) · 基线 v4.1.1（117 文件 / 1404 用例）

| 里程碑 | 任务 | 进度 | 状态 |
|--------|------|------|------|
| **M1 基线承接**（v4.2 并入） | T1 npx 实测 · T2 update · T3 ccai · T4 THIRD_PARTY · T5 init 双输出 · T6 model auto · T7 价格表 | **7/7** | ✅ **完成**（2026-10-27） |
| M2 审批透明化 | T8 风险引擎 ✅ · T9 审批 UI ✅ · T10 复盘记录 ✅ · T11 配置降级 ✅ | **4/4** | ✅ **完成·已封板**（2026-10-28） |
| M3 场景可发现 | T12 触发表引擎 ✅ · T13 三场景 UI ✅ · T14 首屏精简 ✅ | **3/3** | ✅ **完成·已封板**（2026-10-28） |
| M4 CLI 动词化 | T15 check ✅ · T16 fix ✅ · T17 commit · T18 review · T19 护栏 | **2/5** | 🔄 **进行中**（T16 完成 2026-10-28） |
| M5 收敛与度量 | T20 功能冻结 · T21 本地指标 · T22 定位重写 | 0/3 | ⬜ 待开始 |
| 收尾 | T23.1 回归 · T23.2 文档 · T23.3 手工测试 · T23.4 自审+发布 | 0/4 | ⬜ 待开始 |

### M1 任务明细

| 任务 | 状态 | 说明 |
|------|------|------|
| **T1 npx 零安装实测 + 缺 Key 引导** | ✅ **完成**（2026-10-27） | ① 实测 v4.1.1 `npx` 零安装通过（**隔离目录**，`4.1.1` / `--help` exit 0）② 缺 Key 中文引导（三种**均真实生效**的配置方式 + 获取链接）③ **修复真实缺口**：入口 `getApiKey()` 此前不读 `config.json` 的 `providers.deepseek.apiKey`（方式 3 原本是空承诺）④ 新增 Node 版本中文提示（engines>=22，Node 20 不再只看到英文 EBADENGINE 刷屏；TTY-only + `CONCERTOAI_NO_NODE_WARN=1` 可静默）⑤ **修复存量 flaky**：`observability-panel` 性能断言改 3 次取最小值（verify 连跑 3 次全绿）· 新增 19 用例 |
| **T2 update** | ✅ **完成**（dc867ea） | 版本对比（fetch 可注入，测试不打网络）/ 确认升级 + `--yes` / npx 场景拒绝误升级 / 非 TTY fail-closed / 错误截断 · 19 用例 |
| **T3 ccai 短命令** | ✅ **完成**（0215457） | `bin` 双入口指向同一 `dist/cli/index.js`，与 `concertoai` 完全等价 · 3 用例 |
| **T4 THIRD_PARTY_NOTICES** | ✅ **完成**（0215457） | 脚本化生成（`npm run notices`）+ 修正 `cli-highlight`=ISC + 补 highlight.js BSD-3 + 如实记录 tiktoken 缺 LICENSE · 9 用例 |
| **T5 init 双输出** | ✅ **完成**（2026-10-27） | 一次扫描 `ProjectProfile` → 双文件输出（`AGENTS.md` 给 AI + `PROJECT_GUIDE.md` 给人）· **G7 证据硬约束**（每条结论带 `文件:行号`，无证据写「未检测到」）· 覆盖 fail-closed（默认不覆盖 / 非 TTY 不覆盖 / `--force`）· 有界扫描（400 文件 / 200KB / 跳过构建产物）· 非项目目录友好退出 · **实测修复 3 处误报**（动态 import、导出聚合行 `{ canAccess }`、模板字符串 lint）· **护栏用例**：生成内容只推荐真实注册的 CLI 命令 · 49 用例 |
| **T7 双档价格表 + 时段解耦** | ✅ **完成**（2026-10-27） | ① 新价格入库（**官方核对值**：flash 空闲/高峰：输入 1/2、输出 4.5/9.0、缓存命中 0.02/0.04；pro：4.5/9.0、13.5/27.0、0.15/0.30），并发 2500/500 ② **R7 解耦**：`peak-time.ts` 拆 `PRICING_PEAK_RANGES`+`isPricingPeakTime`（计价）与 `SWITCH_PEAK_RANGES`+`isPeakTime`（切 ollama），`PEAK_TIME_RANGES` 保留切换口径别名 ③ `priceTierFor(at)`/`priceFor`/`tierLabel` + `costFor`/`cacheHitCostFor`/`costForProvider` 全链 `at` 时间注入（Provider 层 `now()` 构造注入，消除时间依赖 flaky）④ 状态条 + `balance` 标注「高峰价 / 空闲价」 ⑤ **ADR-038** 落盘 · 新增 19 用例 ⑥ **修订（2026-10-27 用户核对官方页后）**：flash 价格订正（缓存命中 0.02/0.04、输入 1/2）+ **计价高峰排除中国法定节假日并纳入调休上班日**（`core/holidays.ts`，`config.pricingHolidays` 装载，未配置时 `balance` 显式提示）+ **连带修 v4.0 存量缺陷**（迁移 `legacy` 字段无人消费 → `flattenLegacy` 读取层摊平）· 新增 27 用例（holidays 17 + config 4 + models 3 + balance 2 + 其他） |
| **T6 model auto** | ✅ **完成**（2026-10-27） | ① config/CLI/`/model auto` 接受 `"auto"`：**固定起始档 flash**，round-trip 正确（v3 `defaultModel` 迁移 + v4 `providers.<p>.model` 双路径都有用例）② 启用时打印成本策略说明（当前时段**真实单价** + 「**不会自动升级**」+ 可复制升级命令与倍数）③ **保守边界落地**：升级（变贵）→ 走审批框 `kind:'model'` 确认（y/Enter 批准、n/**Esc 拒绝**、确认异常 fail-closed）；降级（变便宜）→ 直接生效 ④ `/model` 状态/列表/切换全链（非 deepseek Provider 明确拒绝并指路 `provider switch`）⑤ **源码级红线用例**：`auto.ts` 禁复杂度判定标识、slash 层禁 `setInterval/setTimeout`、`App.tsx` 中 `setModel(` 仅 1 处且在 `/model` 块内 ⑥ ADR-039 落盘 · 新增 57 用例（model/auto 33 + slash/model 17 + UI 7），全量 **127 文件 / 1582 用例**全绿 |
### M2 任务明细

| 任务 | 状态 | 说明 |
|------|------|------|
| **T8 审批风险评估引擎** | ✅ **完成**（2026-10-27） | 纯本地零模型零网络（ADR-040 / §4 D68-D69）：`core/approval-insight.ts`（`analyzeApproval`/`analyzeDiff`/`parseDiff`/`levelOf`/`focusLinesFrom`/`changeNaturesFrom`）+ `core/risk-rules.ts`（**15 条**规则，每条含 prefilter/patterns/negativePatterns/why/suggestion）+ `core/impact-scan.ts`（影响面「谁 import 了我」，唯一 IO：并发池 32 / 300ms 硬超时 / 5s TTL 缓存 / 文件上限 2000 / 单文件失败计入 skippedCount）· **降级矩阵 8 行逐行单测**（非TTY/CI/超大diff/超时/抛错/config-off/空命中/超大项目）+ **G2 铁律**（分析抛错返回可渲染空 insight，审批照旧）· **W1-W10 Windows 红线逐条单测**（含 LF/CRLF 一致、反斜杠路径、BOM、URL 中 `//` 不判注释、中文/emoji 行）· **fixtures 26 条真实 git diff 人工标注**（`tests/fixtures/approval/`，manifest 与 .diff 一一对应校验）· **发布门实测**：性能 6 项全达标（analyzeDiff 100 行 P95 0.34ms/5ms、单规则 10 万字符 0.77ms/20ms、analyzeImpact 200 文件 19.89ms/80ms、审批 P95 14.59ms/150ms）+ **误报 0/19=0%**、high 级误报 0、召回 7/7=100% · **实测抓到并修掉两处真实缺陷**：`dependency-change` 正则 ReDoS（1766ms→0.77ms）+ prefilter 死模式（两条 pattern 永远跑不到）· 新增 3 个测试文件 + 2 个发布门脚本（`scripts/bench-approval.mjs` / `scripts/verify-false-positive.mjs`）· **131 文件 / 1714 用例全绿**（本任务新增 3 个测试文件 / 105 用例：approval-insight 63 + impact-scan 31 + risk-rules 11（含 W8 防 ReDoS 2 条），基线 128 文件 / 1609 用例 → 131 文件 / 1714 用例） |
| **T9 审批 UI 升级** | ✅ **完成**（2026-10-28） | 审批框从「一行 summary + diff」变成**风险教学卡**（标题/操作意图/改动性质/影响面/风险点/建议重点关注行/折叠 diff/按键四件套 + `[?]` 内联说明），**架构铁律：纯字符串优先、Ink 只做着色与边框**（ADR-041 / §4 D70-D71）：`src/ui/approval-text.ts`（`renderApprovalLines` 唯一文案来源，返回带语义角色的行，**零 Ink/React 依赖**，护栏测试扫源码）+ `src/ui/toggle-throttle.ts`（`createToggleThrottle` 80ms 展示态节流，**丢弃中间态**，可注入时钟、无 `setInterval`、`dispose()` 清 pending）+ `src/utils/text-width.ts`（`displayWidth`/`truncateToWidth`/`wrapToWidth`，**禁止 `.length` 判宽度**）· `ApprovalModal` 改为「角色→颜色」纯外壳（**组件内零用户可见文案字面量**，`PlanProgressView` 硬编码中文一并入 i18n）；high 红 / medium 黄 / **low 绿不标红** · `App.tsx` **先弹 plain 框再异步补 insight**（G2，`approvalSeq` 丢弃迟到结果）、`y`/`n` 走 `finishApproval` 且**决议不节流**、`[v]`/`[?]` 意图用 **ref** 维护 · `ApprovalRequest.insightHint`（`edit` 传目标文件+意图 / shell **刻意不传** → 影响面「不适用」而非白扫全库）· **三条红线逐条护栏**：medium 全文无「危险」、未分析绝不说「0 个引用」（timeout/skipped/error/ok-zero 四态各自文案）、默认 diff ≤12 行 + `[v]` ≤500 行 · **实测抓到并修掉两处真实缺陷**：散文按宽度截断砍掉「不是结论」（改折行）+ 连按 `v` 读到渲染快照导致停在展开态（改 ref，意图与节流分开测）· **发布门实测**（`scripts/bench-approval-ui.mjs`）：端到端 P95 **8.83ms** / 预算 150ms、文案 P95 ≤0.54ms、Ink 首帧 P95 ≤8.61ms · 新增 5 个测试文件 / **91 用例**（approval-text 44 + approval-modal 13 + approval-integration 12 + toggle-throttle 10 + text-width 12），**136 文件 / 1805 用例全绿** |
| **T10 拒绝复盘记录** | ✅ **完成**（2026-10-28） | 拒绝编辑时留一条可回看的本地记录（ADR-042 / §4 D72）· `core/reflection-store.ts`（`buildReflection` 纯函数去重+截断+**未分析写 unknown 非 low** / `appendReflection` **O_APPEND 且永不抛错** / `readReflections` 倒序+损坏行跳过计数 / `clearReflections` 幂等 / `isReflectionsEnabled` 双轨开关）+ `cli/reflect.ts`（`list [--limit]` 倒序表格按**显示宽度**对齐 / `clear [--yes]` **非 TTY 无 --yes fail-closed**）+ `ui/App.tsx`（`finishApproval(false, …)` → `recordRejection` **fire-and-forget**，决议先 resolve 再写盘）+ 新增 `notice` 中性灰提示行（拒绝是正常操作，不复用 error 红字）+ `config set reflections on\|off`（兑现提示里的承诺命令，非法值 fail-closed）· **G8 零网络护栏**（源码断言无 fetch/http/net/axios）+ **写盘失败不阻塞**（只读目录 / 路径被占用两种失败均 `{ok:false}` 且 Promise 不 reject，UI 层断言模型第二轮照常继续）· `tests/core/reflection-store.test.ts`(22) + `tests/cli/reflect.test.ts`(15) + `tests/ui/approval-reflect.test.tsx`(8) · **实测抓两处真实缺陷**：① `npm test` 污染开发者真实复盘文件（16 条垃圾记录 → `tests/setup.ts` 全局 env 隔离 + App 缺省读 env + 护栏用例）② 降级时 `insight.level` 恒为 `low` 导致复盘全校「✅ 低」（判据改 `degraded`） |
| **T11 配置与降级收尾** | ✅ **完成**（2026-10-28） | `store/config.ts` 新增 `ApprovalInsightMode` / `ReflectionsMode` + `validateConfigValues`（非法值**提示一次不抛错**，与 pricingHolidays 同口径）+ 类型守卫；`ResolvedConfig.approvalInsight/reflections`（**环境变量在解析层合并**，入口不再各读一份）· `config set approvalInsight` / `config set reflections`（非法值 fail-closed 不写盘）· **`plain` 与 v4.1.1 逐字节一致**（三行文案 + detail 不截断 + shell/model 标题；快照断言）· **降级判定单一来源**（源码护栏：App 不读 `process.stdout.isTTY` / `process.env.CI`，只透传 `insightEnv`；`approval-insight.ts` 集中五类降级原因）· **顺带修 T8/T9 存量缺陷**：`ImpactSummary` 新增第五态 `not-needed`——低风险不扫影响面时此前复用 `skipped` 被渲染成「项目过大，文件数超过 2000」（单文件项目也这么说 = 假话）· `tests/ui/approval-degrade.test.tsx`(12) + `tests/store/config.test.ts`(+5) · M2 **4/4 封板** |

### M3 任务明细

| 任务 | 状态 | 说明 |
|------|------|------|
| **T12 触发表引擎** | ✅ **完成**（2026-10-28） | 「用户卡住时给一条能直接用的命令」的纯逻辑内核（ADR-044 / §4 D74-D75）· `core/suggestion.ts`（**纯判定层 + IO 层严格分离**，对齐 `reflection-store.ts`）：`SUGGESTION_RULES` 三条确定性规则（`missing-project-rules` 10 / `repeated-verify-failure` 20 / `repeated-edit-rejection` 30，**priority 大者优先**）+ `evaluateSuggestion({state, history, now})` + `recordSuggestionShown` / `dismissHints` / `pruneCooldowns` / `isCoolingDown` / `isHintsEnabled`（双轨开关）+ `readHintCooldowns` / `writeHintCooldowns`（原子写 `hint-state.json`，**永不抛错**）· **七条硬约束逐条在引擎内实现**（同时 ≤1 条 / 同 id 每会话 1 次 / 同 id 全局 10 分钟冷却 / **每会话总计 ≤3 条** / **Esc 即本会话全静默** / `hints off` 恒 null / **时间必须注入**）· **命名 `tips` → `hints` 全链路统一**（`config.hints` / `CONCERTOAI_HINTS` / `hint-state.json` / i18n `hints.*`）· **不打空头支票**：三条命令全部当场核实（`concertoai init` / `concertoai self-heal` / `/review <file>`），并落**护栏用例**——实跑 `--help` 断言动词真注册 + 用真实 `parseReviewCommand` 断言斜杠命令可解析；**任务书原写的 `concertoai fix` 至今不存在（属 M4），已按用户拍板改掉并记录** · **占位符永不出门**：路径含空格 → 降级 `repeatedEditRejectionNoFile` 文案 + `/review` auto 模式（不给一条会被拆坏的命令）· `config.ts` 四处接线（`HintsMode` / `hints?` / `isHintsMode` / `validateConfigValues` / `resolveConfig` 合并 env）+ `config set hints on\|off`（非法值 fail-closed）+ `paths.ts` `hintStatePath()` + zh/en `hints.*`（en 无 CJK 由 `en.test.ts` 看住）· `tests/core/suggestion.test.ts`(40) + `tests/store/config.test.ts`(+5) + `tests/setup.ts`（测试环境默认 `CONCERTOAI_HINTS=off`，防污染真实 `hint-state.json`）· **端到端实测**（隔离 HOME）：`config set hints off` 真写盘 / 非法值 exit 1 / `hints on` 回滚均通过 · **141 文件 / 1914 用例全绿** |
| **T13 场景提示 UI** | ✅ **完成**（2026-10-28） | 「一条灰字、单行、不挤压输入框，用户看得见也关得掉」（ADR-045 / 承接 ADR-044）· **四个新模块**：`ui/hint-signals.ts`（状态信号采集：`hasProjectRulesFile` / `countUserTurns` / `isVerifyClassCommand` / `nextFailureStreak` / `nextRejectStreak`——**只认数出来的事实**）+ `ui/hint-text.ts`（纯字符串排版：`renderHintLine` / `resolveHintLine` / `isHintVisiblePhase`，**零 Ink 依赖**，命令永不截断）+ `ui/HintBar.tsx`（只上色，`memo`，`null` 时不占行）+ `cli/slash/hints.ts`（`/hints on\|off\|status` 会话级开关，不写配置）· **三条硬要求逐条落地**：① 纯字符串渲染 Ink 只上色（源码护栏断言组件零中文字面量、无 `<Box>`）② 单行 + 不挤压输入框（`null` 而非空 `<Text>`；真实容器宽度换算 `HINT_CONTAINER_PADDING_X`）③ 超宽按 `displayWidth` 截断但**命令绝对完整**（宽度不够时丢文案保命令）· **`awaiting` 阶段（本轮核心修正）**：`idle` / `awaiting` 才渲染，`streaming`（有字/有工具）与审批焦点一律不画；输入框 `inputActive = idle \|\| awaiting`——断网/假 Key 时既能看见提示，也**敲得进** `/hints off` · **假按钮防护**：等待期提交普通需求不排队但给「⏳ 正在等待模型回复…」回执，绝不静默吞；`/hints` 提到 `busy` 守卫之前 · **真实 PTY 端到端**（`scripts/pty-drive-t13.mjs`，隔离项目目录 + 隔离 HOME + `try/finally` + `exit`/信号兜底 + Windows `taskkill /T`）：四条断言 ①②③④ **全部 PASS**，且跑后自证「PTY 1 个已终止 / 临时目录已删除 / 残留 0」· **单测抓不到、端到端才暴露的三个真 bug 全部修复**：① 判定绑 `phase==='idle'` → 永远不提示 ② 输入框 `active={phase==='idle'}` → 命令敲不进去 ③ 按终端列数排版 → 100 列终端里 `concertoai init` 被折行劈开 · 测试 6 文件（`hint-text` / `hint-signals` / `hint-bar` / `hint-app` / `slash-hints` 等）· 踩坑 2 条（PTY 清理未放 finally / 提示行按终端列数排版在容器内必然折行）· **146 文件 / 1976 用例全绿** |

| **T14 首屏精简** | ✅ **完成**（2026-10-28） | 「`--help` 首屏给动词不给 21 条命令平铺清单」（T14 验收：首屏 ≤ 40 行）· **分层渲染**：`src/cli/index.ts` 新增 `COMMON_COMMAND_ORDER`（**顺序表不是文案表**——命令名与描述一律从 `program.commands` 现取，改名/删命令/改描述时首屏自动跟随）+ `findCommand`（**查不到 = 不渲染**，T10/T12 的「不打空头支票」在此落地为代码而非人工核对）+ `renderGroupedHelp`（快速开始 3 步 → 常用命令 → 交互斜杠 → 高级折叠一行）· **`program.configureHelp({ visibleCommands })` 已挂载**（默认隐藏命令平铺，仅 `--all` 时显示；`visibleCommands` 读 `process.argv` 而非 `program.opts()`，因 `--help` 被解析即打印退出、同批 `--all` 可能尚未进 opts——两种参数顺序实测均 57 行等价，且各有用例）· **`readonly Command[]` → `[...cmd.commands]`**（commander 签名要可变数组；esbuild 不查类型，只有 `tsc` 会红——build 全绿 ≠ 类型正确）· **i18n 补齐** `help.fastStart/fast1/fast2/fast3/common/commonHint/slash/slashPlan/slashReview/slashWorkflow/slashHints/advanced/advancedHint`（zh/en 同构，`en.test.ts` 看住无 CJK；旧 `gettingStarted/step1-3/commands/example*` 死键全数退场）· **测试 `tests/cli/help.test.ts` 重写（17 用例）**：用 tsx 起**真实进程**跑 `--help` / `--help --all`，再拿 `Commands:` 段反查注册表做**交叉校验**（首屏每个名字必须查得到、描述必须与注册值逐字相同）+ 行数预算（≥25 且 ≤40）+ 四段顺序 + 常用∪高级=全部注册命令（无遗漏无重复）+ **M4 四动词双向不变量**（未注册则首屏一个字不许出现，注册了必须上首屏）+ i18n 死文案检测 + 斜杠命令走真实解析器 · **变异测试三次自证护栏有牙**：① 摘掉 `configureHelp` → 2 红 ② 往常用表塞未注册 `check` → **不红且正确**（`findCommand` 按设计过滤掉）③ 硬写一行 `check` → 3 红 · **首次进入引导复用 T13 `no-project-rules`**（不新增第二套，验收项「第一次有、第二次无」由 T12/T13 已有用例覆盖）· **顺带修一个挡住 verify 的既有 flaky**：`tests/cli/slash-skill.test.ts` 把技能装进**真实** `~/.concertoai/skills`（实测已累积 191 个 `install-test-*` 目录）且不清理 → 与 `tests/skill/loader.test.ts` 并行时计数不等（首轮全量实测仅此一处红、单跑必绿）；改为 `vi.spyOn(os,'homedir')` 隔离 + `vi.restoreAllMocks()` 清理，实测跑后 191→191 不再泄漏 · **146 文件 / 1990 用例全绿**（+14）|

### M4 任务明细

| 任务 | 状态 | 说明 |
|------|------|------|
| **T15 `concertoai check`** | ✅ **完成**（2026-10-28） | 「提交前一条命令判断能不能提交」——**只读，零写入**（`src/cli/check.ts` / `runCheckCommand`）· **G6 薄包装**：四段分类复用 `self-heal` 的 `parseVerifyReport`、失败摘要复用 `utils/error-summary` 的 `extractErrorSummary`，本源码内**没有第二套 verify 解析**（源码护栏盯着）· **退出码权威、解析只做归因**：通过与否只看子进程真实退出码，解析结果只回答「哪段挂了、挂在第几行」——避免「解析不到成功标记」被误判失败、「解析不到错误」被误判通过 · **不静默成功三态**：无 `package.json` → 「这里不是 Node 项目，无法体检」；有 `package.json` 但 build/lint/typecheck/test 全缺 → 「没做检测就不算通过」；退出码非 0 却一条错误都定位不出 → 四段全「结果无法判定」+ 末尾补 `extractErrorSummary` 兜底，三种均 `exit 1` · **`&&` 链诚实**：verify 先跑 test 时，后面 build 标「未执行（前一段失败）」，不冒充通过 · **无 verify 脚本 → 分项检测**（顺序固定 build→lint→type→test，`typecheck`/`type` 两种写法兼容）· **下一步命令不打空头支票**：`npm run lint:fix` 仅在项目真配了该脚本时才给，其余一律指向已注册的 `concertoai self-heal`（M4 的 `fix` 未落地故不许写）· **G5 输出受控**：每段最多 40 行 + `--json` 机器可读（供 T17 commit 复用）· `ChildProcessQaRunner` 增加 `script` 参数（默认 `verify`，行为不变）复用既有 Windows 进程树终止逻辑 · **25 用例**（`tests/cli/check.test.ts`），含真实落盘 mtime 零写入断言 + Ctrl+C 中断路径 + 命令注册护栏（`check --help` 真存在）· **变异测试自证护栏有牙**：改成「顺手跑 lint:fix」→ 2 红；改成「结论永远 ok=true」→ 6 红 · **147 文件 / 2015 用例全绿**（+1 文件 / +25 用例） |
| **T16 `concertoai fix`** | ✅ **完成**（2026-10-28） | 「报错太复杂，让 AI 试着修」——`self-heal` 的**薄入口**（`src/cli/fix.ts` / `runFixCommand` + `buildFixDiagnosis` + `formatFixPlan`）· **G6 薄包装**：分类复用 `parseVerifyReport`、执行复用 `runSelfHeal`、报告复用 `formatSelfHealReport`，并把「错误 → 修复动作」优先级从 `repair.ts` 的内联 if/else 抽成纯函数 **`strategyFor(error)`**——`repairVerifyReport`（真修）与 `fix --dry-run`（诊断）**共用同一份判定**，本文件内**没有第二套 verify 解析、也没有第二个优先级表**（否则会出现「诊断说 lint 直修、真修却走模型」的自相矛盾，源码护栏用例盯着）· **`--dry-run` 零写入**：只跑 verify + 解析 → 「共 N 个问题 + 每条错误打算怎么修 + 最多尝试几次」，**不调模型（不花钱）、不跑 lint:fix、不建快照、不写盘**，且**不需要 API Key**（第一次进项目、还没配 Key 也能先看清问题）· **退出码权威**（承接 T15 假通过教训）：通过与否只看子进程真实退出码，解析只做归因；退出码非 0 却一条错误都定位不出 → 明说「**没能定位**」并指向 `concertoai check`，**绝不写成「无需修复」** · **两道审批门**：① 开跑前确认（兜住 `lint:fix` 这类本身不弹审批框的确定性修复）② 模型修复每次写盘前逐条确认（复用 `runSelfHeal` 的 `requestApproval`，T8/T9 风险 insight 自动生效）；非 TTY 且无 `--auto-approve` → **fail-closed 拒绝启动**并指路 `--dry-run`；Ctrl+C / 回答不是 y 一律当拒绝（零写盘）· **超限转人工 + 现场保留**：复用既有 `MAX_SELF_HEAL_ATTEMPTS`(2) 与 `RepairVerifyResult.exceeded`；文案只给**真实存在**的命令（`concertoai snapshot list` / `concertoai snapshot clean`）+ 快照目录路径——`snapshot restore` 至今不存在，**一个字都不写**（T10 / T12 空头支票教训，ADR-044）；修复无效的改动由 self-heal 在复验失败时自动回滚，不需要用户手敲回滚 · **无 Key 不静默降级**：明说「只跑 lint 直修，模型修复已跳过」· **G5 输出受控**：诊断最多 20 条 + 单条 200 字符（超长不淹没终端）· **i18n** `zh.fix.*` / `en.fix.*` 同构（en 无 CJK 由 `en.test.ts` 看住）+ `cli.fix.description/dryRun/autoApprove` · **命令注册**：`fix`（`--dry-run` / `--auto-approve` / `-m`）插入 `COMMON_COMMAND_ORDER`（`check` 之后，顺序表非文案表 → 首屏自动跟随）；**`self-heal` 保留不删**（旧脚本 / 文档引用它，改语义 = 静默改变行为）· **20 用例**（`tests/cli/fix.test.ts`）围绕「会不会偷偷写盘 / 会不会假装修好」组织，含无 Key 也能诊断 / 非 TTY fail-closed / Ctrl+C 取消 / 审批拒绝与批准 / 修不好转人工，外加**薄包装源码护栏**（不许自带 verify 解析、不许直接起子进程）· **基线 147 文件 / 2015 用例 → 148 文件 / 2035 用例全绿**（+1 文件 / +20 用例）· **顺带**：`MAX_LOOP_TURNS` 50 → 200（用户手动调整）+ 三处文档同步 |

---

## 📊 总览（截至 v4.1.1）

| 指标 | 数值 |
|------|------|
| 总任务数 | 222（v1.0: 20 ✅ + v1.1: 12 ✅ + v2.0: 15 ✅ + v2.1: 25 ✅ + v3.0: 24 ✅ + v3.1: 27 ✅ + v3.2: 29 ✅ + v3.3: 9 ✅ + v3.4: 12 ✅ + v4.0: 41 ✅ + v4.1: 8 ✅ 全部完成） |
| P0 任务 | 102（v1.1: 6 ✅ + v2.0: 5 ✅ + v2.1: 5 ✅ + v3.0: 14 ✅ + v3.1: 7 ✅ + v3.2: 15 ✅ + v3.3: 9 ✅ + v3.4: 8 ✅ + v4.0: 27 ✅ + v4.1: 6 ✅ 全部完成） |
| P1 任务 | 70（v1.1: 6 ✅ + v2.0: 10 ✅ + v2.1: 4 ✅ + v3.0: 10 ✅ + v3.1: 14 ✅ + v3.2: 14 ✅ + v3.4: 4 ✅ + v4.0: 6 ✅ + v4.1: 2 ✅ 全部完成） |
| P2 任务 | 22（v2.1: 8 ✅ + v3.1: 6 ✅ + v4.0: 8 ✅ 全部完成） |
| 待开始 | 0 |
| 进行中 | 0 |
| 已完成 | 222（全部里程碑完成，v4.1.0 已发布 npm + tag） |
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
| **V3.0-M2 Orchestrator 核心** | **P0** | **3** | ✅ 已完成 |
| **V3.0-M3 多角色 Agent 团队** | **P0** | **6** | ✅ 已完成 |
| **V3.0-M4 Agent 市场基础** | **P1** | **4** | ✅ 已完成 |
| **V3.0-M5 可观测性面板** | **P1** | **3** | ✅ 已完成 |
| **V3.0-M6 集成测试与文档** | **P1** | **3** | ✅ 已完成 |
| **V3.1-M0 启动前置（版本归位 + 基线校准）** | **P0** | **2** | ✅ 已完成 |
| **V3.1-M1 AI 自我修复闭环** | **P0** | **5** | 🟢 已完成 |
| **V3.1-M2 多项目管理** | **P1** | **5** | 🟢 已完成 |
| **V3.1-M3 多租户登录** | **P2** | **4** | 🟢 已完成 |
| **V3.1-M4 结构化错误增强** | **P2** | **2** | 🟢 已完成 |
| **V3.1-M5 Orchestrator CLI 入口 + 运维命令补全** | **P1** | **5** | 🟢 已完成 |
| **V3.1-M6 集成测试与文档** | **P1** | **4** | 🟢 已完成 |
| **V3.2-M0 启动前置** | **P0** | **2** | ✅ 已完成 |
| **V3.2-M1 跨平台兼容性增强** | **P0** | **5** | ✅ 已完成（a5d30b1） |
| **V3.2-M2 self-heal 模块化重构** | **P0** | **4** | ✅ 已完成（4b5bf55） |
| **V3.2-M3 错误处理强化** | **P1** | **4** | ✅ 已完成（本次） |
| **V3.2-M4 用户体验优化** | **P1** | **5** | ✅ 已完成（本次） |
| **V3.2-M5 文档与扩展能力** | **P1** | **5** | ✅ 已完成（本次） |
| **V3.2-M6 集成测试与发布** | **P0** | **4** | ✅ 已完成（v3.2.0 已发布 npm，2026-08-11） |
| **V3.3-M1 审查遗留修复** | **P0** | **5** | 🟢 已完成（5996836：W1/W2/S1/S2/S3） |
| **V3.3-M2 回归与发布** | **P0** | **4** | 🟢 已完成（v3.3.0 已发布 npm + tag，2026-08-11） |
| **V3.4-M1 审查建议闭环** | **P0** | **4** | 🟢 已完成（7a60729：S-C1/I1/I2/I3） |
| **V3.4-M3 VS Code 崩溃防护** | **P1** | **4** | 🟢 已完成（5e62f79：doctor --vscode 四维） |
| **V3.4-M2 回归与发布** | **P0** | **4** | 🟢 已完成（v3.4.0 已发布 npm + tag，2026-08-12） |
| **V4.0-M0 启动前置** | **P0** | **3** | ✅ 已完成（0ca0524 / 36da80c） |
| **V4.0-M1 审查完就能修** | **P0** | **6** | ✅ 已完成（b184ed3，92 文件 / 1080 用例） |
| **V4.0-M2 流程能记住了** | **P0** | **6** | ✅ 已完成（e8466ea，98 文件 / 1127 用例） |
| **V4.0-M3 模型能换了** | **P0** | **7** | ✅ 已完成（968a373，103 文件 / 1187 用例） |
| **V4.0-M4 生态能扩展了** | **P1** | **6** | ✅ 已完成（本次提交，108 文件 / 1277 用例） |
| **V4.0-M5 多 Agent 能并行** | **P2** | **3** | ✅ 已完成（c23d5b7，109 文件 / 1299 用例） |
| **V4.0-M6 IDE 能诊断** | **P2** | **3** | ✅ 已完成（4bb3501，112 文件 / 1334 用例） |
| **V4.0-M7 TS7 评估** | **P2** | **2** | ✅ 已完成（34edf8b，NO-GO 决策门） |
| **V4.0-M8 回归与发布** | **P0** | **5** | ✅ 已完成（本次提交，v4.0.0 已发布 npm + tag） |
| **V4.1-M1 跑得通 + 失败不慌** | **P0** | **4** | ✅ 已完成（T1.1-T1.4：截断摘要 / F 等待态 / maxRetries 归零 + retry 语义 / preflight 自动初始化） |
| **V4.1-M2 出错有指引 + 界面专业 + 新手能上手** | **P1** | **2** | ✅ 已完成（T2.1-T2.2：下一步指引 / help 分组 + 首次欢迎引导） |
| **V4.1-M3 规范固化 + 回归 + 发布** | **P0** | **2** | ✅ 已完成（T3.1-T3.2：AGENTS 边缘路径规范 + 文档同步 + 发布，v4.1.0 已发布 npm + tag，117 文件 / 1390 用例） |

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
  - ✅ 2026-08-07 完成：concertoai plan 命令（计划→批准→执行三段式）+ 对话内 /plan（PlanConfirm 审批框，y/n）

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
  - ✅ 2026-08-07 完成：包名 @concertoai/cli（未被占用），bin + CLI 入口，npm pack 预演 + 干净目录全局安装冒烟通过

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
  - ✅ 2026-08-11 完成：src/cli/slash/orchestrate.ts（新增）+ App.tsx 拦截：/orchestrate <任务> 解析 → 包装 runTeamCommand 执行（chat 内用户已显式授权拆解/写盘，confirm 自动放行）→ 结果转聊天消息（✅/❌ 摘要）；无任务提示用法；可观测性：runTeamCommand 透传 traceStore，拆解/闭环 spans 经 o 键面板可见；审计日志记录 /orchestrate 操作
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
  - ✅ 2026-08-11 完成：/agent update [name]（slash/agent.ts + App.tsx）：指定名称复用 installer.install update 语义（版本落后覆盖 / ALREADY_INSTALLED 提示已最新）；无参数 fetch 注册表 + listInstalled + compareVersion 列出可更新项；/review --severity <strict|normal|lenient>：reviewer/types.ts 新增 ReviewSeverity/REVIEW_SEVERITIES + determineReviewAction(issues,{severity,testPassed}) 三档（strict=medium 必拒 / normal=critical 必拒+medium 结合 QA 失败可拒 / lenient=仅 critical 拒）；ReviewOptions/TeamReviewerOptions/ReviewEngineLike 透传 severity；slash/review.ts 解析 + 非法值报错列出合法值；App.tsx 短路非法值 + 透传 severity
  - ✅ 2026-08-11 完成：src/cli/audit.ts（新增）+ index.ts 注册 concertoai audit export [--out <file>]：遍历 ~/.concertoai/audit/*.jsonl，复用 AuditLogger.exportJson() 读回（损坏行跳过）→ 按 seq 保序合并输出 JSON 数组；默认 stdout / --out 写文件（目录自动创建）；无审计文件 → 「暂无审计日志」退出码 0
  - ✅ 2026-08-11 完成：src/cli/team.ts（新增）+ index.ts 注册 concertoai team <task>：decomposeRequirement 拆解 → 展示清单 + 终端确认（非 TTY 报错，--auto-approve 跳过）→ 装配 4 角色（CoderAgent+DiskFileWriter / TeamReviewerAgent+ReviewerEngine+SubagentSpawner / QaAgent+ChildProcessQaRunner）→ runTeamLoop 对抗性闭环（MAX_LOOP_ATTEMPTS=5）→ SnapshotManager 事务回滚兜底（onRollback，成功 commit）→ 聚合输出工件引用（code/review-result/test-report）+ 中文 summary；--dry-run 仅输出拆解清单不执行 Agent；formatTaskList 可读清单；拆解失败给中文错误不静默
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

- [x] **T2.1** 实现任务状态机
  - 涉及文件：`src/orchestrator/state-machine.ts`（新增）、`tests/orchestrator/state-machine.test.ts`（新增）、`src/orchestrator/index.ts`（修改）
  - 预估：3h | 实际：约 1h
  - 依赖：T1.1、T1.2
  - ✅ 2026-08-09 完成：TRANSITIONS 转换表（主流程 + reject/QA 失败打回 in_progress + 非终止态→failed）+ pending→in_progress 依赖守卫（fail-closed：未完成/状态未知/未配置查询均拒绝）+ canTransition/canTransitionTask 查询 + transition 执行（InvalidTransitionError / TransitionGuardError 抛错并记录 violations，上限 100）+ onTransition 事件订阅（可取消、多监听器、监听器异常不阻断）；27 测试（500 全绿）

- [x] **T2.2** 实现任务调度器
  - 涉及文件：`src/orchestrator/scheduler.ts`（新增）、`tests/orchestrator/scheduler.test.ts`（新增）、`src/orchestrator/index.ts`（修改）
  - 预估：3h | 实际：约 1.5h
  - 依赖：T1.1、T1.2、T2.1
  - ✅ 2026-08-09 完成：topologicalSort 拓扑排序 + 循环依赖检测（CyclicDependencyError 含环路径）+ hasDependencyPath + detectFileConflicts 文件级依赖冲突 + TaskScheduler 逐层并行（默认并发 3）+ 重试（最多 2 次指数退避）+ 级联跳过 + 8 个 barrel 导出接入 index.ts；修复 2 个 noUncheckedIndexedAccess 类型错误（游标越界防御）；26 测试（526 全绿）

- [x] **T2.3** 实现 Orchestrator Agent 核心
  - 涉及文件：`src/agents/orchestrator.ts`（新增）、`tests/agents/orchestrator.test.ts`（新增）、`src/agents/index.ts`（修改）
  - 预估：2h | 实际：约 1.5h
  - 依赖：T2.1、T2.2
  - ✅ 2026-08-09 完成：decomposeRequirement 模型拆解（低温度 + zod 校验 + JSON 围栏容错）→ onPlan 审批流（确认执行/拒绝取消无副作用）→ TaskScheduler 按 task.agent 分发到注册表 Agent → 聚合输出（executions/artifacts 中间工件引用/中文 summary）；artifactTypeForAgent 角色映射（spec/code/review-result/test-report）；13 测试（539 全绿）

### V3.0-M3：多角色 Agent 团队（P0，约 14h）

- [x] **T3.1** 实现 Architect Agent
  - 涉及文件：`src/agents/architect.ts`（新增）、`tests/agents/architect.test.ts`（新增）、`src/agents/index.ts`（修改）
  - 预估：3h | 实际：约 1.5h
  - 依赖：T1.x、T2.3
  - ✅ 2026-08-09 完成：ArchitectSpec（接口定义 + 文件结构 + 约束条件，供 Coder 直接消费）+ generateArchitectSpec/parseArchitectSpec（流式收集 + zod 校验 + 围栏容错 + 空设计拒产出）+ ArchitectAgent 标准契约（def 输入 description/输出 spec + 权限最小只读）+ onSpec 审批流（拒绝抛错不产出工件）；11 测试（550 全绿）

- [x] **T3.2** 实现 Coder Agent
  - 涉及文件：`src/agents/coder.ts`（新增）、`tests/agents/coder.test.ts`（新增）、`src/agents/index.ts`（修改）
  - 预估：3h | 实际：约 1.5h
  - 依赖：T1.x、T2.3、T3.1
  - ✅ 2026-08-09 完成：CoderInput（spec 实现 / issues 修复双模式）+ generateImplementation/generateFix（模型生成 + zod 校验 + 围栏容错）+ CoderAgent（审批后写盘，拒绝不写盘 fail-closed）+ CoderFileWriter 抽象（DiskFileWriter 写盘 + T3.6 事务接入点）+ diffForWrite 复用 planEdit SEARCH/REPLACE 语义；修复测试 3 个类型错误（ReviewIssue 需 dimension 字段 + FILES 常量）；14 测试（564 全绿）

- [x] **T3.3** 升级 Reviewer Agent（Team Reviewer）
  - 涉及文件：`src/agents/reviewer.ts`（新增）、`tests/agents/reviewer.test.ts`（新增）、`src/reviewer/`（修改）
  - 预估：3h | 实际：约 1.5h
  - 依赖：T1.x、T2.3
  - ✅ 2026-08-09 完成：ReviewResult 结构化输出（action + issues[] + summary + testPassed + report）+ determineReviewAction 判定（🔴 critical 必 reject / 🟡 medium 可 reject / 🟢 suggestion 不阻断）+ buildReviewResult（Report→Result 转换）+ TeamReviewerAgent（标准 Agent 契约，包装 v2.1 9 维审查引擎，保留 autoFix 🟢 走审批能力，权限只读）；13 测试（577 全绿）

- [x] **T3.4** 实现 QA Agent
  - 涉及文件：`src/agents/qa.ts`（新增）、`tests/agents/qa.test.ts`（新增）、`src/agents/index.ts`（修改）
  - 预估：2h | 实际：约 1h
  - 依赖：T1.x、T2.3
  - ✅ 2026-08-09 完成：ChildProcessQaRunner 沙箱执行 npm run verify（Windows taskkill 子树 + 超时 5min 保护）+ parseVerifyOutput 结构化解析（Test Files/Tests 计数 + FAIL 段提取文件/用例/错误）+ QaAgent（标准契约，权限 run_command 白名单 npm run verify）+ formatFeedbackIssues 失败详情→feedback 传回 Coder + 退出码兜底防漏判；修复 2 个解析 bug（failed 误匹配 FAIL / ✗ 用例行先命中 Error）；14 测试（591 全绿）

- [x] **T3.5** 实现对抗性闭环流程
  - 涉及文件：`src/orchestrator/loop.ts`（新增）、`tests/orchestrator/loop.test.ts`（新增）、`src/orchestrator/index.ts`（修改）
  - 预估：1h | 实际：约 0.5h
  - 依赖：T3.1、T3.2、T3.3、T3.4
  - ✅ 2026-08-09 完成：runTeamLoop 对抗性闭环（Coder 实现 → Reviewer 审查 → reject 反馈 Coder 修复 → approve → QA 验证 → 失败反馈修复）+ 终止条件（approve 且 QA 全绿）+ MAX_LOOP_ATTEMPTS=5 超限退出保留中间结果 + onRollback 触发（T3.6 接入点）+ 每轮上下文 artifacts（code/review-result/test-report）+ 依赖接口 CoderLike/ReviewerLike/QaLike（测试注入 Fake）；8 测试（599 全绿）

- [x] **T3.6** 实现多文件事务回滚
  - 涉及文件：`src/orchestrator/transaction.ts`（新增）、`tests/orchestrator/transaction.test.ts`（新增）、`src/cli/snapshot.ts`（新增）、`src/cli/index.ts`（修改）
  - 预估：2h | 实际：约 1h
  - 依赖：T3.2、T3.5
  - ✅ 2026-08-09 完成：SnapshotManager（begin 快照全部涉及文件 + recordWrite 任务写入登记 + rollback 外部修改检测恢复 + commit 清理）+ 回滚失败保留快照不静默覆盖 + `concertoai snapshot`/`concertoai snapshot clean` 命令（list/clean）+ taskId 路径编码防穿越；15 测试（614 全绿）

### V3.0-M4：Agent 市场基础（P1，约 7h）

- [x] **T4.1** 定义 Agent 市场注册表格式
  - 涉及文件：`src/market/types.ts`（新增）、`src/market/registry.ts`（新增）、`src/market/index.ts`（新增）、`tests/market/registry.test.ts`（新增）
  - 预估：2h | 实际：约 30min
  - 依赖：T1.2
  - ✅ 2026-08-09 完成：RegistryItemType/RegistryItemBase/AgentRegistryItem/MarketRegistry 类型（复用技能市场 registry.json + type 区分 skill/agent + AgentDef.interfaces/permissions/runtime 扩展 + 接口版本号）；zod schema 共用校验（parseMarketRegistry/parseAgentItem）；内置 4 Agent 条目（architect/coder/reviewer/qa）；fetchAgentContent sha256 校验 + fetchMarketRegistry 网络加载；13 测试，627 用例全绿

- [x] **T4.2** 实现 Agent 安装器
  - 涉及文件：`src/market/installer.ts`（新增）、`src/market/download.ts`（新增）、`src/market/registry.ts`（修改）、`src/market/index.ts`（修改）、`src/cli/slash/skill.ts`（修改）、`tests/market/installer.test.ts`（新增）
  - 预估：2h | 实际：约 1h
  - 依赖：T4.1
  - ✅ 2026-08-09 完成：AgentInstaller（注册表匹配→下载→sha256 校验→接口合规检查→写入 ~/.lumen/agents/<name>/→刷新 AgentRegistry）；parseAgentPackage 接口合规检查（interfaces/permissions 完整，fail-closed，8 种失败码）；download.ts 抽取共享 fetchVerifiedContent（技能市场 fetchSkill 同步复用）；agentDefFromPackage/compareVersion/listInstalled/remove 预埋 T4.3；13 测试 + 648 用例全绿

- [x] **T4.3** 实现 /agent 管理命令
  - 涉及文件：`src/cli/slash/agent.ts`（新增）、`src/ui/App.tsx`（修改）、`src/cli/chat.tsx`（修改）、`tests/cli/slash-agent.test.ts`（新增）
  - 预估：2h | 实际：约 1.5h
  - 依赖：T4.2
  - ✅ 2026-08-09 完成：/agent list（内置 4 Agent 条目 + 已安装外部 Agent，含权限/安装时间）、/agent install <name>（复用 T4.2 AgentInstaller，8 种失败码中文提示）、/agent remove <name>（内置拒绝卸载 + 注销 AgentRegistry）；chat.tsx 装配全局 AgentRegistry + AgentInstaller 注入 App；18 测试 + 666 用例全绿

- [x] **T4.4** 实现 /agent promote <skill>
  - 涉及文件：`src/market/promote.ts`（新增）、`src/cli/slash/agent.ts`（修改）、`src/market/index.ts`（修改）、`tests/market/promote.test.ts`（新增）
  - 预估：1h | 实际：约 1h
  - 依赖：T4.3、v2.1 技能系统（src/skill/）
  - ✅ 2026-08-09 完成：promoteSkill（读 SKILL.md → 生成 ~/.lumen/agents/<name>/agent.json + index.js 可执行骨架 → 注册 AgentRegistry）；derivePermissions 从技能 tools 推导（无 tools 默认只读三件套，fail-closed）；agent.json 与安装器 InstalledAgent 格式兼容（/agent list 可见）；技能原样保留；buildScaffoldIndexJs 生成可 import() 的 CJS 骨架（技能正文 JSON 字面量嵌入，转义安全）；/agent promote 命令接入（App.tsx 异步分支 + deps.loader）；10 测试 + 680 用例全绿

### V3.0-M5：可观测性面板（P1，约 4h）

- [x] **T5.1** 实现调用链追踪
  - 涉及文件：`src/observable/trace.ts`（新增）、`src/observable/index.ts`（新增）、`tests/observable/trace.test.ts`（新增）
  - 预估：1.5h | 实际：约 1h
  - 依赖：T1.1、T2.1
  - ✅ 2026-08-09 完成：TraceStore 内存 LRU（默认上限 5000 条，防无限增长）+ record 记录输入/输出/决策/耗时 + queryByTaskId 递归收集父子任务树（parentTaskId）+ subscribeToStateMachine 订阅状态机 onTransition 自动记录 decision span；6 测试

- [x] **T5.2** 实现审计日志
  - 涉及文件：`src/observable/audit.ts`（新增）、`tests/observable/audit.test.ts`（新增）
  - 预估：1h | 实际：约 0.5h
  - 依赖：T5.1
  - ✅ 2026-08-09 完成：AuditLogger JSONL 追加写入（O_APPEND，异步不阻塞主流程）+ AuditEntry（自增 seq + ts + kind：message/state-change/approval/rollback）+ exportJson 保序导出 + 损坏行跳过；性能基准单条写入 <10ms 单测断言；5 测试

- [x] **T5.3** 实现可观测性面板 TUI
  - 涉及文件：`src/ui/ObservabilityPanel.tsx`（新增）、`src/ui/App.tsx`（修改）、`src/cli/chat.tsx`（修改）、`tests/ui/observability-panel.test.tsx`（新增）
  - 预估：1.5h | 实际：约 1h
  - 依赖：T5.1、T5.2
  - ✅ 2026-08-09 完成：ObservabilityPanel 流程树组件（节点 = 任务/Agent，实时状态/耗时/消息数；输入→决策→输出摘要；可展开/收起不阻塞主对话）+ App/chat 挂载 TraceStore + AuditLogger 注入；50 节点渲染 <100ms 性能断言；4 测试

### V3.0-M6：集成测试与文档（P1，约 4h）

- [x] **T6.1** 多 Agent 协作 E2E 测试
  - 涉及文件：`tests/e2e/orchestrator.test.ts`（新增）、`tests/e2e/team-loop.test.ts`（新增）、`tests/orchestrator/transaction.test.ts`（新增）、`tests/market/installer.test.ts`（新增）、`tests/observable/trace.test.ts`（新增）
  - 预估：1.5h | 实际：约 1h
  - 依赖：M1-M5 全部完成
  - ✅ 2026-08-09 完成：E2E-1 FakeModel→Orchestrator 拆解 5 子任务→拓扑调度正确 + 并行组并发峰值 ≥2 + 聚合 5 工件；E2E-2 需求→拆解→Architect 设计 spec→闭环（approve + QA 通过）→上下文 artifacts；E2E-3 闭环超 5 次→onRollback→SnapshotManager 回滚→文件恢复任务前状态 + 快照清理；E2E-4 市场 install + promote→/agent list 识别全链路；4 个 e2e 用例 + 全量 750 用例全绿（v3.0 完成时 699，T0.1 基线校准；≥440 验收通过）

- [x] **T6.2** 文档更新
  - 涉及文件：`README.md`（修改）、`docs/02-架构设计/ARCHITECTURE.md`（修改）、`docs/05-用户与开发指南/user-guide.md`（修改）、`docs/05-用户与开发指南/agent-dev-guide.md`（新增）、`docs/06-会议与决策记录/DECISIONS.md`（修改 — ADR-015/017~020 回填）
  - 预估：1.5h | 实际：约 1.5h
  - 依赖：T6.1
  - ✅ 2026-08-09 完成：README v3.0 功能章节（多 Agent 团队 / Agent 市场 / 事务回滚 / 可观测性）+ snapshot 命令；ARCHITECTURE 新增 orchestrator/agents/market/observable 模块（§2 全景图 + §4 D33-D38 + §5 目录树核对 + §8.5 v3.0 已解决）；用户手册新增 6-8 章（多 Agent / Agent 市场 / 可观测性）+ snapshot 命令 + 章节顺延至 13；Agent 开发指南完整（接口契约 + 脚手架 + 打包发布 + 发布清单）；ADR-015/017~020 回填 DECISIONS.md（发布门要求 ADR-015~020 齐）

- [x] **T6.3** CHANGELOG + TASKS 看板 + 测试报告
  - 涉及文件：`CHANGELOG.md`（修改）、`docs/03-开发计划与任务/TASKS.md`（修改）、`docs/07-测试报告.md`（修改）
  - 预估：1h | 实际：约 1h
  - 依赖：T6.2
  - ✅ 2026-08-09 完成：CHANGELOG v3.0.0 条目（Added/Changed/Fixed，M0-M6 全部变更 + 修复原 Unreleased 格式错位）；TASKS 看板 24 个任务全部标记完成（M0-M6 全绿）；测试报告更新为 69 文件/750 用例（v3.0 完成时 63/699，T0.1 基线校准）+ v3.0 模块分层统计 + 关键场景 + 手动用例 M-23~26 + 覆盖缺口；v3.0.0 tag 待发布时打

---

### V3.1-M0：启动前置（P0，约 1h）

- [x] **T0.1** 版本归位决策落盘 + 基线校准
  - 涉及文件：`CHANGELOG.md`（修改 — `[Unreleased]` 标注「v2.2 + v3.1 功能随 v3.1.0 发布」）、`docs/03-开发计划与任务/TASKS.md`（修改 — 基线 750/69 校准 + v3.1 看板）、`docs/02-架构设计/ARCHITECTURE.md`（修改 — 版本基线核对）
  - 预估：0.5h
  - 依赖：无
  - ✅ 2026-08-10 完成：CHANGELOG `[Unreleased]` 标注「v2.2（peak-time/model-switcher/ADR-023）+ v3.1（balance/doctor）随 v3.1.0 一并发布（不补发 v2.2.0）」；全项目基线校准为 69 文件/750 用例（AGENTS.md / 07-测试报告 / 07.3 同步，ARCHITECTURE 已一致）；版本号三处一致 3.0.0；实测 `npm test -- --silent` 69 文件/750 用例全绿

- [x] **T0.2** 审查遗留复核（S1/S2/S3/S4）
  - 涉及文件：`docs/08-审查记录/v3.0-dev-review.md`（参考）、`src/core/peak-time.ts`（核对）、`src/core/model-switcher.ts`（核对）
  - 预估：0.5h
  - 依赖：T0.1
  - ✅ 2026-08-10 完成：S3 确认已在 7f477a5 修复（`agents/orchestrator.ts` 区分「Agent 未注册」/「Agent 已注册但未提供实现实例」+ 2 测试用例，verify 输出可见）；S1/S2/S4 处置与 v3.1-dev-plan-ai.md §7 一致（S1=v3.2 可选 E4、S2=维持 no-op v3.2 评估、S4=纳入 M6-T6.3）；`src/core/peak-time.ts` + `model-switcher.ts` 与 ARCHITECTURE D41 核对一致（9-12/14-18 左闭右开 / ask/switch/ignore / resolveStartupModel CLI 集成 / App.tsx 本地模型成本按 0）

### V3.1-M1：AI 自我修复闭环（P0，约 7h）

- [x] **T1.1** Verify 分类器（四段统一解析）
  - 涉及文件：`src/loop/self-heal.ts`（新增）、`src/agents/qa.ts`（复用 — parseVerifyOutput）
  - 预估：1.5h
  - 依赖：T0.2
  - ✅ 2026-08-10 完成：`VerifyReport`（passed + errors[]: {stage,file,line,code,message} + parseFailed）四段统一解析；`splitStages` 按 npm 段标记（`> @concertoai/cli@x.y.z <script>`）切分（typecheck→type 归一）；lint 段 Biome（FIXABLE / lint/rule / 文件:行:列）、type 段 tsc（`file(line,col): error TSxxxx` 标准 + pretty 格式）、build 段 tsup 失败标记、test 段复用 `parseVerifyOutput`；入口剥离 ANSI 颜色码；尽力而为解析（无法识别标记 parseFailed 不崩溃）；真实 verify 输出实测 4 段全解析（parseFailed 全 false）

- [x] **T1.2** 修复策略执行器
  - 涉及文件：`src/loop/self-heal.ts`（修改 — repairVerifyReport / isSimpleTypeError / generateModelFixPlan / runLintFixCommand / runVerifyCommand）
  - 预估：2.5h
  - 依赖：T1.1
  - ✅ 2026-08-10 完成：`MAX_SELF_HEAL_ATTEMPTS=2` + `repairVerifyReport(report, options)` 主流程：lint → 确定性 `npm run lint:fix`（走 shell 工具 + 白名单免审批）；type 简单错误（`Cannot find name/module` / `implicitly has an 'any' type` / `Property 'x' has no initializer`）→ 模型生成修复（每次 1 个，审批 fail-closed，拒绝跳过）；type 复杂（TS2322 等）/ build / test → 不自动修，`suggestionFor` 结构化反馈；模型修复输出 zod 校验（`parseModelFixOutput`）+ `planEdit` 唯一性校验；生产辅助 `runVerifyCommand`（复用 ChildProcessQaRunner）/ `runLintFixCommand`（shell 白名单）

- [x] **T1.3** 快照与回滚
  - 涉及文件：`src/loop/self-heal.ts`（修改）、`src/orchestrator/transaction.ts`（复用）
  - 预估：1h
  - 依赖：T1.1、T1.2
  - ✅ 2026-08-10 完成：模型修复落盘前 `SnapshotManager.begin(taskId, [file])` + `recordWrite` 登记快照（taskId 加随机后缀防同毫秒冲突；登记失败降级跳过回滚保护）；修复后强制 verify + `diffLineStat` diff 审查（变更文件 + 每文件变更行数）；回滚判定基于错误指纹（`file:code` 忽略行号——修复后行号漂移）：目标错误未消失或引入新错误（与修复前指纹集合比较）→ `rollback()` 恢复原状；修复有效 → `commit()` 清理快照；写盘失败 / 回滚失败（外部修改检测）→ 明确报错并保留快照；`SelfHealAttempt` 新增 `rolledBack` / `rollbackReason` 字段；未启用快照时修复无效保留变更并提示人工检查；新增 12 测试（T1.1 分类器 3 + 工具 2 + T1.2 执行器 2 + T1.3 快照回滚 5），`npm run verify` 70 文件 / 762 用例全绿

- [x] **T1.4** 触发入口（/self-heal + CLI）
  - 涉及文件：`src/cli/slash/self-heal.ts`（新增）、`src/cli/index.ts`（修改）、`src/ui/App.tsx`（修改）、`src/loop/self-heal.ts`（修改）
  - 预估：1h
  - 依赖：T1.2、T1.3
  - ✅ 2026-08-10 完成：`runSelfHeal` 主流程导出（RunSelfHealOptions 增加可注入 runVerify/runLintFix 供测试与两入口共用）；chat 内 `/self-heal` 拦截（App.tsx send 前置分支：置 streaming 阶段 + busy，修复期间状态条可见，完成后回写 assistant 消息并落盘会话）；`concertoai self-heal` CLI 子命令（src/cli/self-heal.ts 新增，非交互：`--auto-approve` 才放行模型修复，默认 fail-closed，无 TTY 可跑 lint 直修 + 结构化反馈）；同时修复历史 BUG：审批/计划审批阶段 Esc 与 Ctrl+C 不再退出应用而是拒绝当前操作（fail-closed），流式生成中 Esc 与 Ctrl+C 一致为中断生成不退出，仅 idle 态 Esc 退出（src/ui/App.tsx useInput，配套 4 个 UI 测试）

- [x] **T1.5** M1 单元测试
  - 涉及文件：`tests/loop/self-heal.test.ts`（新增）、`tests/cli/slash-self-heal.test.ts`（新增）、`tests/ui/app.test.tsx`（修改）
  - 预估：1h
  - 依赖：T1.1~T1.4
  - ✅ 2026-08-10 完成：新增 build 段（tsup 失败）+ test 段（vitest FAIL + ✗ 用例名）分类器样本；修复超限（连续失败 2 次 → exceeded=true + 每轮 model-fix 回滚 + 文件复原 + 快照清理）；runSelfHeal 触发入口 3 用例（verify 通过 / lint 直修闭环 / 无 client 时结构化反馈不崩溃）；slash-self-heal 9 用例（parse 识别 + execute 注入 runVerify/runLintFix + formatSelfHealReport 三类报告）；App 审批 Esc/Ctrl+C 行为 4 用例；`npm run verify` 71 文件 / 781 用例全绿

### V3.1-M2：多项目管理（P1，约 6h）

- [x] **T2.1** 项目注册表
  - 涉及文件：`src/store/projects.ts`（新增）、`src/store/paths.ts`（修改）
  - 预估：1.5h
  - 依赖：T0.2
  - ✅ 2026-08-10 完成：`ProjectRegistry`（load/save/add/remove/get/list/has + findByPath + updateConfig）读写 `~/.concertoai/projects.json`；重名抛 `PROJECT_ALREADY_EXISTS`；路径规范化（Windows 反斜杠→正斜杠，盘符大小写不敏感）；嵌套注册拒绝 `PROJECT_NESTED`（分隔符边界比较，`/foo/bar2` 不误判）；损坏 JSON / 版本不匹配 → 空注册表 + 警告（宽松读取）；原子写（临时文件 + rename）；`paths.ts` 新增 `projectsPath()`

- [x] **T2.2** project 命令
  - 涉及文件：`src/cli/project.ts`（新增）、`src/cli/index.ts`（修改）
  - 预估：1.5h
  - 依赖：T2.1
  - ✅ 2026-08-10 完成：`concertoai project add <name> [path]`（path 缺省 cwd；重名/嵌套输出明确错误）/ `list`（表格 name/path/addedAt）/ `remove`（🗑️ 卸载不删目录）/ `info`（path/whitelist/mcpServers）；命令无副作用（add 不创建目录）；`registryFile` 可注入供测试

- [x] **T2.3** 项目切换（switch + -p）
  - 涉及文件：`src/cli/project.ts`（修改）、`src/cli/index.ts`（修改）、`src/cli/chat.tsx`（修改）、`src/cli/common.ts`（修改 — resolveProjectForCwd / mergeAllowlist）
  - 预估：1.5h
  - 依赖：T2.1、T2.2
  - ✅ 2026-08-10 完成：`concertoai project switch <name>` 校验存在并提示 `-p`/cd 启动；全局 `-p, --project <name>`（commander preAction hook：校验项目存在 → chdir 到项目路径 → 后续 chat/run/plan 以项目路径为 cwd 装配）；未指定 `-p` 时 `resolveProjectForCwd(cwd)` 按 cwd 精确匹配已注册项目（未匹配 → 全局默认）；`mergeAllowlist` 全局白名单 + 项目级去重合并（全局前缀 + 项目追加）；会话目录按项目隔离（`~/.concertoai/sessions/<projectKey>/`，resume/-l 天然按项目过滤）；路径统一 `path.join`/`path.resolve` 跨平台一致

- [x] **T2.4** 隔离矩阵落地
  - 涉及文件：`src/store/paths.ts`（修改 — projectKeyFor / projectSessionsDir）、`src/cli/chat.tsx`（修改 — 会话目录/MCP 按项目）、`src/cli/common.ts`（修改 — 白名单合并）、`src/store/projects.ts`（修改 — updateConfig）
  - 预估：1h
  - 依赖：T2.1、T2.3
  - ✅ 2026-08-10 完成：会话按项目分目录 `~/.concertoai/sessions/<projectKey>/`（`projectKeyFor` 项目名安全化防路径穿越：空格/中文→`_`、`.`/`..` 前缀 `p_`）；resume 列表按项目过滤；审批白名单项目级 `whitelist[]` 与全局合并生效（`mergeAllowlist` 去重，词边界匹配规则不变）；MCP 服务按项目 `mcpServers[]` 启动（`project?.mcpServers ?? resolved.mcpServers`，未配置回退全局）；无项目时行为与 v3.0 完全一致

- [x] **T2.5** M2 单元测试
  - 涉及文件：`tests/store/projects.test.ts`（新增）、`tests/cli/project.test.ts`（新增）、`tests/store/paths.test.ts`（修改 — projectKeyFor/projectSessionsDir）、`tests/cli/project-isolation.test.ts`（新增 — 隔离矩阵）
  - 预估：0.5h
  - 依赖：T2.1~T2.4
  - ✅ 2026-08-10 完成：注册表 CRUD/重名/嵌套/路径规范化/宽松读取（14 用例）；命令 add/list/remove/info/switch 正常与异常路径（12 用例）；隔离矩阵项目 A/B 会话目录/白名单/MCP 互不串 + 默认模式兼容（11 用例）；`projectKeyFor`/`projectSessionsDir`（5 用例）；`npm run verify` 74 文件 / 828 用例全绿（新增 18 用例，含 M1 lint 修复后基线）

### V3.1-M3：多租户登录（P2，约 4h）

- [x] **T3.1** accounts 存储
  - 涉及文件：`src/store/accounts.ts`（新增）、`src/store/paths.ts`（修改）
  - 预估：1.5h
  - 依赖：T0.2
  - ✅ 2026-08-11 完成：AccountStore（saveAccount / getApiKeyFor / setActiveAccount / getActiveAccount / listAccounts / removeAccount）读写 `~/.concertoai/accounts/<name>/config.json` + `active-account` 指针；saveAccount 原子写（临时文件 + rename）+ chmod 0600（POSIX；Windows 尽力而为跳过不报错）；重名默认返回 `exists`（overwrite=true 才覆盖）；listAccounts 只返回账号名不含 Key；removeAccount purge 语义（purge=false 仅清 active 指针 / purge=true 删账号目录）；Key 值不写日志不进入审计输出；修复 `readdir(withFileTypes)` 返回 `Dirent[]` 的类型标注（原误标 `string[]`）

- [x] **T3.2** account 命令
  - 涉及文件：`src/cli/account.ts`（新增）、`src/cli/index.ts`（修改）
  - 预估：1.5h
  - 依赖：T3.1
  - ✅ 2026-08-11 完成：`src/cli/account.ts`（新增）+ `account-types.ts`（新增）+ index.ts 注册 `login`/`logout`/`whoami`/`account list|switch`；login 交互输入 Key 不回显（promptSecret 掩码拦截 readline 输出，非 TTY 提示用 `--key`）+ `--key` 非交互注入（CI 场景）；重名覆盖前交互确认（fail-closed）；logout 清除 active 指针（提示不删文件，`--purge` 才删）；whoami 显示账号名 + `maskApiKey` 打码（`sk-****abcd`，短 Key 全掩码）；account list 表格 + active 标记；任意命令输出不包含完整 Key；修复 `readline.Interface` 实例无 `output` 属性（类型定义核实）→ 改用创建 rl 时传入的 `process.stdout`（行为等价）

- [x] **T3.3** API Key 解析接入
  - 涉及文件：`src/cli/index.ts`（修改）、`src/cli/common.ts`（修改）、`src/cli/doctor.ts`（修改）
  - 预估：0.5h
  - 依赖：T3.1、T3.2
  - ✅ 2026-08-11 完成：`resolveApiKey` 解析链（CLI `--api-key` 预留 > 环境变量 `DEEPSEEK_API_KEY` > active account > config.json 预留）；无任何来源返回 `{source:none}` 由调用方报错退出（fail-closed）；`maskApiKey` 打码（后 4 位 + sk- 前缀，短 Key 全掩码）；index.ts `getApiKey` 包装 + doctor 传 `keySource`/`keyAccountName`；doctor 余额行标注 `账号: work (sk-****abcd)` / `（环境变量优先）`；环境变量与账号并存时明确显示环境变量优先

- [x] **T3.4** M3 单元测试
  - 涉及文件：`tests/store/accounts.test.ts`（新增）、`tests/cli/account.test.ts`（新增）
  - 预估：0.5h
  - 依赖：T3.1~T3.3
  - ✅ 2026-08-11 完成：`tests/store/accounts.test.ts`（新增）+ `tests/cli/account.test.ts`（新增）；存储 CRUD（save/list/remove/purge/setActive/getActive）+ POSIX 0600 权限（Windows 跳过）+ 重名状态；命令 login/logout/whoami/switch/list 正常与异常路径 + 打码正则断言（任意输出不含完整 Key）；`resolveApiKey` 优先级（env > account > config）+ `maskApiKey` 边界（短 Key/非 sk 前缀）；`npm run verify` **76 文件 / 858 用例全绿**（基线 69/750 校准，门检要求 ≥785/72 已达成）

### V3.1-M4：结构化错误增强（P2，约 1h）

- [x] **T4.1** 统一错误结构 + 补齐建议
  - 涉及文件：`src/tools/registry.ts`（修改）、`src/tools/read.ts`（修改）、`src/tools/edit.ts`（修改）、`src/tools/shell.ts`（修改）、`src/loop/loop.ts`（修改）
  - 预估：0.5h
  - 依赖：T1.2
  - ✅ 2026-08-11 完成：新增 `src/tools/error-codes.ts`（ToolErrorCode 15 码 + TOOL_ERROR_SUGGESTIONS 中文建议 + toolError 构造器 + SandboxError + inferErrorCode 兜底）；ToolResult 扩展 `code?`/`suggestion?`（可选，向后兼容）；read（PATH_OUTSIDE_SANDBOX/FILE_NOT_FOUND/DIR_NOT_FOUND/SENSITIVE_FILE）、edit（SEARCH_NOT_FOUND/SEARCH_NOT_UNIQUE/FILE_ALREADY_EXISTS/WRITE_FAILED/EDIT_REJECTED）、shell（SHELL_REJECTED/TIMEOUT/COMMAND_NOT_FOUND/EXIT_N）、knowledge（ENTITY_NOT_FOUND/STORE_UNAVAILABLE）全带 code+suggestion；registry.run 未知工具 UNKNOWN_TOOL + 异常兜底 inferErrorCode；loop.ts ToolRepairError 失败详情行渲染 6 空格缩进 💡 suggestion（无则保持旧格式）

- [x] **T4.2** M4 单元测试
  - 涉及文件：`tests/loop/error-reporting.test.ts`（新增）
  - 预估：0.5h
  - 依赖：T4.1
  - ✅ 2026-08-11 完成：`tests/loop/error-reporting.test.ts`（新增 15 用例）：read/edit/shell/knowledge 各错误分类断言（code + suggestion 非空）+ ToolRepairError 渲染兼容（含 suggestion 渲染 💡 / 旧结构不渲染 / registry 兜底 UNKNOWN_TOOL）；同步校准 read.test.ts 两处过时断言（v3.0 ENOENT/不是文件 → M4 中文错误码消息 + code 断言）；清理 ~/.concertoai/skills 72 个 install-test/skip-test 测试残留（SkillLoader 扫全局目录导致计数不稳定）；`npm run verify` **77 文件 / 874 用例全绿**

### V3.1-M5：Orchestrator CLI 入口 + 运维命令补全（P1，约 4h）

- [x] **T5.1** concertoai team 命令
  - 涉及文件：`src/cli/team.ts`（新增）、`src/cli/index.ts`（修改）、`src/agents/orchestrator.ts`（复用）、`src/orchestrator/loop.ts`（复用）、`src/orchestrator/transaction.ts`（复用）
  - 预估：1.5h
  - 依赖：T0.2
  - ✅ 2026-08-11 完成：`src/cli/team.ts`（新增）+ index.ts 注册 `concertoai team <task>`：`decomposeRequirement` 拆解 → 展示清单 + 终端确认（非 TTY 报错，--auto-approve 跳过）→ 装配 4 角色（CoderAgent+DiskFileWriter / TeamReviewerAgent+ReviewerEngine+SubagentSpawner / QaAgent+ChildProcessQaRunner）→ `runTeamLoop` 对抗性闭环（MAX_LOOP_ATTEMPTS=5）→ SnapshotManager 事务回滚兜底（onRollback，成功 commit）→ 聚合输出工件引用（code/review-result/test-report）+ 中文 summary；`--dry-run` 仅输出拆解清单不执行 Agent；`formatTaskList` 可读清单；拆解失败给中文错误不静默

- [x] **T5.2** /orchestrate 斜杠命令
  - 涉及文件：`src/cli/slash/orchestrate.ts`（新增）、`src/ui/App.tsx`（修改）
  - 预估：1h
  - 依赖：T5.1
  - ✅ 2026-08-11 完成：`src/cli/slash/orchestrate.ts`（新增）+ App.tsx 拦截：`/orchestrate <任务>` 解析 → 包装 runTeamCommand 执行（chat 内用户已显式授权拆解/写盘，confirm 自动放行）→ 结果转聊天消息（✅/❌ 摘要）；无任务提示用法；可观测性：runTeamCommand 透传 traceStore，拆解/闭环 spans 经 `o` 键面板可见；审计日志记录 /orchestrate 操作

- [x] **T5.3** concertoai audit export
  - 涉及文件：`src/cli/audit.ts`（新增）、`src/cli/index.ts`（修改）、`src/observable/audit.ts`（复用）
  - 预估：0.5h
  - 依赖：T0.2
  - ✅ 2026-08-11 完成：`src/cli/audit.ts`（新增）+ index.ts 注册 `concertoai audit export [--out <file>]`：遍历 ~/.concertoai/audit/*.jsonl，复用 `AuditLogger.exportJson()` 读回（损坏行跳过）→ 按 seq 保序合并输出 JSON 数组；默认 stdout / --out 写文件（目录自动创建）；无审计文件 → 「暂无审计日志」退出码 0

- [x] **T5.4** /agent update + /review --severity
  - 涉及文件：`src/cli/slash/agent.ts`（修改）、`src/cli/slash/review.ts`（修改）、`src/reviewer/engine.ts`（修改）
  - 预估：0.5h
  - 依赖：T0.2
  - ✅ 2026-08-11 完成：`/agent update [name]`（slash/agent.ts + App.tsx）：指定名称复用 `installer.install` update 语义（版本落后覆盖 / ALREADY_INSTALLED 提示已最新）；无参数 fetch 注册表 + listInstalled + compareVersion 列出可更新项；`/review --severity <strict|normal|lenient>`：reviewer/types.ts 新增 `ReviewSeverity`/`REVIEW_SEVERITIES` + `determineReviewAction(issues,{severity,testPassed})` 三档（strict=medium 必拒 / normal=critical 必拒+medium 结合 QA 失败可拒 / lenient=仅 critical 拒）；ReviewOptions/TeamReviewerOptions/ReviewEngineLike 透传 severity；slash/review.ts 解析 + 非法值报错列出合法值；App.tsx 短路非法值 + 透传 severity

- [x] **T5.5** M5 单元测试
  - 涉及文件：`tests/cli/team.test.ts`（新增）、`tests/cli/audit.test.ts`（新增）、`tests/cli/slash/orchestrate.test.ts`（新增）、`tests/cli/slash/agent.test.ts`（修改）、`tests/cli/slash/review.test.ts`（修改）
  - 预估：0.5h
  - 依赖：T5.1~T5.4
  - ✅ 2026-08-11 完成：tests/cli/team.test.ts（7 用例：dry-run 不执行/审批拒绝不写盘/闭环成功聚合工件/超限回滚/拆解失败）/ tests/cli/audit.test.ts（4 用例：无文件/保序合并/--out/损坏行）/ tests/cli/slash-orchestrate.test.ts（7 用例）/ tests/cli/slash-review.test.ts（12 用例：三档阈值差异）/ tests/cli/slash-agent.test.ts（+5 update 用例）；校准 tests/agents/reviewer.test.ts medium 语义（normal 下结合 testPassed）；npm run verify **81 文件 / 912 用例全绿**

### V3.1-M6：集成测试与文档（P1，约 4h）

- [x] **T6.1** E2E 集成测试
  - 涉及文件：`tests/e2e/team-cli.test.ts`（新增）、`tests/e2e/self-heal.test.ts`（新增）、`tests/e2e/project-isolation.test.ts`（新增）
  - 预估：1h
  - 依赖：M1-M5 全部完成
  - ✅ 2026-08-11 完成：`tests/e2e/team-cli.test.ts`（2 用例：FakeModel 拆解 → autoApprove → 对抗性闭环收敛文件落地 + 快照提交清理；QA 连续失败 → onRollback 事务回滚新增文件删除）/ `tests/e2e/self-heal.test.ts`（2 用例：注入 lint 错误 → verify 失败 → 自动 lint:fix → verify 通过闭环收敛；注入 type 简单错误 → 模型修复审批 → 修复后 verify 仍失败 → 快照回滚恢复原状）/ `tests/e2e/project-isolation.test.ts`（3 用例：注册项目 A/B → resolveProjectForCwd 按 cwd 命中 → 会话 JSONL 写各自目录 + list 互不可见；白名单合并去重；项目 MCP 声明互不串 + audit export 保序导出）

- [x] **T6.2** 文档更新
  - 涉及文件：`README.md`（修改）、`docs/05-用户与开发指南/user-guide.md`（修改）、`docs/02-架构设计/ARCHITECTURE.md`（修改）、`CHANGELOG.md`（修改）
  - 预估：1.5h
  - 依赖：T6.1
  - ✅ 2026-08-11 完成：README 新增 v3.1 功能章节（self-heal / project / account / team+audit / 结构化错误）；user-guide 新增 5 章节（self-heal / project / team / audit export / account）+ v3.1 快速了解 + 配置目录迁移；ARCHITECTURE 新增 D42~D46 决策 + 目录树与实际文件核对（project/self-heal/team/audit/account/error-codes/projects/accounts/crash-handler/orchestrate 全部入树）+ §8.7 v3.1 已解决；CHANGELOG 归位 `[3.1.0]` 条目（v2.2 + v3.1 功能合并，无 `[Unreleased]` 残留）

- [x] **T6.3** 收尾：S4 优化 + 预留功能条目 + ADR 记录
  - 涉及文件：`src/observable/trace.ts`（修改）、`docs/05-用户与开发指南/user-guide.md`（修改）、`docs/06-会议与决策记录/DECISIONS.md`（修改 — ADR-024~028）
  - 预估：1h
  - 依赖：T6.2
  - ✅ 2026-08-11 完成：`src/observable/trace.ts` S4 优化（childIndex parentTaskId→子任务索引，record 增删/覆盖/LRU 淘汰同步维护，queryByTaskId BFS 收集子树 + 单次遍历，O(n²)→O(n)）+ `tests/observable/trace.test.ts` 新增 4 用例（深链跨任务/覆盖改挂/LRU 淘汰/5000 条冒烟）；user-guide 补 balance/doctor/目录迁移章节；DECISIONS.md 记录 ADR-024~028（self-heal 确定性 / 项目隔离矩阵 / 多账号 git-credential / Orchestrator CLI 入口 / 版本归位）+ E1~E4 评估结论（点对点否决 / Docker 沙箱否决 / TS7 延后 / 评分否决+S1 延后）

- [x] **T6.4** 测试报告落盘
  - 涉及文件：`docs/07.4-手工测试报告-v3.1.md`（新增）
  - 预估：0.5h
  - 依赖：T6.3
  - ✅ 2026-08-11 完成：`docs/07.4-手工测试报告-v3.1.md` 新增（发布前模板：四大新能力 12 项 + v3.0 回归 + 已知问题；基线 84 文件 / 923 用例全绿）

---

### V3.2-M0：启动前置（P0，约 1h）

- [x] **T0.1** 版本归位 + 基线校准
  - 涉及文件：`CHANGELOG.md`、`TASKS.md`、`ARCHITECTURE.md`
  - ✅ 2026-08-11 完成：CHANGELOG `[3.1.1]` 补丁归位（无 `[Unreleased]` 残留）；ARCHITECTURE/TASKS 基线校准 85 文件 / 937 用例

- [x] **T0.2** 审查遗留复核（处置矩阵落盘）
  - 涉及文件：`REVIEW-v3.1-full-2026-08-11.md`、`v3.1-综合评价-2026-08-11.md`
  - ✅ 2026-08-11 完成：问题清单 1~9 校准为「已修 7 / 待办 2」（⚠️#7 → T4.1 一并验证、ℹ️#9 → P2 i18n），矩阵落盘执行日志 135704

### V3.2-M1：跨平台兼容性增强（P0，约 6h）

- [x] **T1.1** Windows/macOS CI 矩阵
- [x] **T1.2** spawn 命令适配审计
- [x] **T1.3** UNC 路径处理
- [x] **T1.4** accounts EXDEV 回退
- [x] **T1.5** 跨平台样本库
  - ✅ 2026-08-11 完成（a5d30b1）：三平台 CI 矩阵（fail-fast: false）+ spawn 审计清单落盘（v3.2-m1-spawn审计清单.md，5 调用点全合规）+ UNC normalize/isNested（盘符/UNC 双分支）+ atomicReplace EXDEV 回退（copyFile+unlink）+ platform-samples 22 项；**86 文件 / 960 用例全绿**（+23）；踩坑记录「vitest 失败文件解析漏判 Windows 盘符路径」

### V3.2-M2：self-heal 模块化重构（P0，约 5h）

- [x] **T2.1** 拆分为 3 模块（classifier/repair/snapshot-guard + index barrel）
- [x] **T2.2** applyModelFix 抽取（状态机独立，attempt 第 4 参数）
- [x] **T2.3** 增量 verify（lint 段修复跳过全量，≤2 次调用）
- [x] **T2.4** 快照失效通知（snapshotWarning 字段 + CLI 展示）
  - ✅ 2026-08-11 完成（4b5bf55）：870 行单文件 → 5 模块（目录内最大 311 行 <400）+ applyModelFix 状态机 + 增量 verify（lint 确定性修复跳过全量）+ snapshotWarning；公共 API 不变（旧文件删除，目录 index 承接）；**86 文件 / 965 用例全绿**（+5）

### V3.2-M3：错误处理强化（P1，约 2h）

- [x] **T3.1** 残留 __dirname 扫描
  - 涉及文件：全项目 `src/`
  - ✅ 2026-08-11 完成：grep `__dirname|__filename` → 裸引用 0 命中（loader.ts 用 `fileURLToPath(import.meta.url)` 合法推导；reviewer/knowledge.ts 仅注释）
- [x] **T3.2** audit export 损坏行统计
  - 涉及文件：`src/observable/audit.ts`、`src/cli/audit.ts`、`tests/cli/audit.test.ts`
  - ✅ 2026-08-11 完成：`exportJson` 返回 `{ entries, skipped }`（损坏行不再静默）；CLI 输出「共 N 条（跳过 M 条损坏行）」——stdout 模式走 stderr 不污染 JSON 管道，`--out` 模式并入导出文案
- [x] **T3.3** /orchestrate diagnostics
  - 涉及文件：`src/cli/team.ts`、`src/cli/slash/orchestrate.ts`、`tests/cli/team.test.ts`
  - ✅ 2026-08-11 完成：`OrchestratorDecomposeError`（kind parse/network + raw ≤500）+ `TeamCommandResult.diagnostics`；/orchestrate 失败消息展示「🔍 诊断（格式解析失败/网络调用失败）+ 原始输出截断」
- [x] **T3.4** inferErrorCode en 样本回归测试
  - 涉及文件：`tests/loop/error-reporting.test.ts`
  - ✅ 2026-08-11 完成：4 断言（spawn ENOENT Windows 变体 / outside sandbox 反斜杠路径 / command not found .cmd / 无关键词不误报），含 Windows 样本
  - ✅ **86 文件 / 976 用例全绿**（+11，本次提交）

### V3.2-M4：用户体验优化（P1，约 4h）

- [x] **T4.1** team 进度推送（onProgress 回调 + CLI stdout + /orchestrate 消息流两处接入）
  - ✅ 2026-08-11 完成：TeamProgress 联合类型 + formatTeamProgress 中文文案 + onProgress 透传；CLI stdout（index.ts）与 App.tsx 聊天消息流渐进推送（拆解/每轮闭环/收尾）；测试断言回调序列（decomposed→loop-attempt×3→done、审批拒绝 done:false）
- [x] **T4.2** self-heal 阶段进度（activeTool 随阶段动态更新）
  - ✅ 2026-08-11 完成：SelfHealPhase 类型（verify/lint-fix/model-fix/verify-fix/rollback/done）+ repair/index 透传 onPhase + selfHealPhaseLabel 中文名 + App.tsx activeTool 名称随阶段更新；测试断言阶段序列
- [x] **T4.3** project/account 视觉（project list 三列表格 + active 高亮）
  - ✅ 2026-08-11 完成：project list 三列表格（名称|路径|注册时间）+ 当前 cwd 项目 ★（当前）chalk.green 高亮；account list active 绿色高亮；测试断言表头/高亮/非 active 不带标记
- [x] **T4.4** whoami 修复提示 + doctor 账号完整性检查
  - ✅ 2026-08-11 完成：whoami 缺失提示改为「请重新登录：concertoai login <name>」（可复制）；doctor 新增账号完整性检查项（无 active→ok、指针指向缺失/损坏账号→fail + 修复命令）；i18n zh/en 补字段；测试覆盖两分支
- [x] **T4.5** 启动期缓存（apiKey/keySource/accountName + ProjectRegistry + config 一次解析）
  - ✅ 2026-08-11 完成：resolveApiKeyCached / loadProjectRegistryCached 模块级缓存（同 accountsRoot/registryFile 命中，clear 失效）；index.ts getApiKey/doctor/preAction 接入；resolveProjectForCwd 复用；新增 tests/cli/common.test.ts（4 用例）
  - ✅ **87 文件 / 990 用例全绿**（M4，本次提交）

### V3.2-M5：文档与扩展能力（P1，约 3h）

- [x] **T5.1** 用户手册补全（self-heal/team/project-account/audit 章节）
  - ✅ 2026-08-11 完成：user-guide.md 版本头 v3.0→v3.2；doctor 账号完整性检查项 + 典型场景；self-heal 典型场景 + /self-heal 阶段进度说明；project list 三列表格 + 当前高亮示例；team 进度推送说明 + 典型场景；audit 损坏行统计 + 示例；whoami 修复命令 + account list 高亮示例；/agent list 版本对比 + update --all 命令与示例；v3.2 新增能力章节（≥4 章节含示例）
- [x] **T5.2** ARCHITECTURE 增量同步（第 2 节全景图 + 第 5 节目录树 + D 决策表）
  - ✅ 2026-08-11 完成：版本头 v3.2 + v3.2 新增能力摘要；第 2 节全景图 slash/ 标注 /agent 版本对比 + update --all；D 决策表新增 D47~D50（ADR-029~032 引用）；第 5 节目录树 M4 已同步（common 缓存 / self-heal onPhase / tests 基线 88/1004）
- [x] **T5.3** DECISIONS ADR-029~032（API Key 解析链 / self-heal 范围限定 / 项目嵌套拒绝 / 跨平台 CI 基线）
  - ✅ 2026-08-11 完成：ADR-029（API Key 解析链统一 + 启动期缓存）/ ADR-030（self-heal 修复范围限定 + 模块化）/ ADR-031（项目注册表路径规范化 + 嵌套拒绝）/ ADR-032（跨平台 CI 矩阵 + spawn 兼容基线）全部落盘，上下文/选项/结论/理由四要素齐备
- [x] **T5.4** Agent 市场版本管理增强（/agent list 版本对比 + update --all；共享策略 P2 评估）
  - ✅ 2026-08-11 完成：agent.ts `SlashAgentCommand.update` 扩展 all 字段 + parse `/agent update --all`；`executeAgentMarketCommand` list 走异步拉注册表 → `formatAgentListWithLatest`（落后「↑ 可更新到 <latest>」/ 最新「最新」/ 下架不标注，网络失败降级同步列表）；update --all 批量更新（复用 install + 注册表引用避免重复拉取，逐条 ✅/⏭️/❌）；App.tsx list 接入异步分支；测试 +8 用例（parse --all / 批量成功 / 无可更新 / 注册表不可达 / 单失败不中断 / list 版本对比 3 分支 + 下架不标注）
  - ✅ 共享策略 P2 评估结论（v3.2-dev-plan.md P2 评估项落盘）：**不做项目级声明**——Agent 安装目录已是全局 `~/.concertoai/agents/` 天然共享（ADR-025 隔离矩阵「全局配置/技能/Agent 共享」），项目级版本/权限声明收益低，避免过度设计
- [x] **T5.5** 执行日志功能（P0，用户要求）— ✅ 已提前落地：execution-log-20260811-135318/135704/140143/144648/170827/173015 + AGENTS.md 规范
  - ✅ **88 文件 / 1004 用例全绿**（M5+M6 E2E，本次提交）

### V3.2-M6：集成测试与发布（P0，约 3h）

- [x] **T6.1** E2E（team 进度全链路 / self-heal 增量 verify / Windows spawn 回归 / UNC 路径）
  - ✅ 2026-08-11 完成：`tests/e2e/team-cli.test.ts` +onProgress 回调序列 E2E（decomposed → loop-attempt×3 → done + 真实写盘）；`tests/e2e/self-heal.test.ts` +增量 verify E2E（lint 修复后仅 rerun lint 段通过即跳过全量，verify 仅 1 次）；`tests/e2e/platform-e2e.test.ts` 新增（E2E-A Windows spawn 回归：npx→npx.cmd + shell:true 真实 spawn；E2E-B UNC 路径规范化：findByPath 精确匹配 + 分隔符边界）；版本号 3.1.0→3.2.0 全量同步（version.ts / classifier.ts 注释 / smoke / slash-self-heal / self-heal 测试）；**88 文件 / 1004 用例全绿**（npm run verify 全绿）
- [x] **T6.2** 文档同步（README / user-guide / ARCHITECTURE / CHANGELOG v3.2.0 条目）
  - ✅ 2026-08-11 完成：README 状态行 1004 用例 / 88 测试文件 + v3.2 新增功能章节；ARCHITECTURE 测试现状 + 目录树基线 88/1004（tests/e2e/ 含 platform-e2e）；CHANGELOG v3.2.0 条目基线校准 87/999 → 88/1004；user-guide 无 3.1.0 残留引用（T5.1 已同步 v3.2）
- [x] **T6.3** 手工测试报告 07.5（Windows 重点：self-heal/team/project/account 全流程）
  - ✅ 2026-08-11 完成：`docs/07.5-手工测试报告-v3.2.md` 落盘（前置准备 + 1.1-1.5 新功能测试 24 用例 + v3.0/v3.1 回归抽查 12 用例 + 统计表；自动化基线已执行全绿，真实 API 冒烟待执行）
- [x] **T6.4** 发布动作（npm run verify → npm version 3.2.0 → npm publish → git tag v3.2.0）
  - ✅ 2026-08-11 完成：**v3.2.0 已发布 npm**（2026-08-11 14:23 UTC，`@concertoai/cli@3.2.0`）；T6.5 手工测试 3 问题已修复（self-heal stderr 归段 / team 快照动态登记 registerWrite / 超时 killTree 等待），88 文件 / 1014 用例全绿；tag v3.2.0 移至含修复提交 9921a77

---

## ⚠️ 阻塞任务清单（Blockers）

> 暂无阻塞任务

---

## 📝 变更日志

| 日期 | 变更内容 | 作者 |
|------|---------|------|
| 2026-08-11 | **V3.2-M5 完成**：T5.1-T5.5 文档与扩展能力（user-guide 补全 ≥4 章节 + ARCHITECTURE D47~D50 + ADR-029~032 + Agent 市场版本对比/update --all + 共享策略 P2 评估结论）；**87 文件 / 999 用例全绿**（+9） | Carbon Code |
| 2026-08-11 | **V3.2-M6 完成（v3.2 全部 29 任务收官）**：T6.1 E2E（team 进度回调全链路 + self-heal 增量 verify + platform-e2e Windows spawn/UNC）→ **88 文件 / 1004 用例全绿**（+5）；T6.4 **v3.2.0 发布 npm**；T6.5 手工测试 3 问题修复（stderr 归段 / registerWrite / killTree）→ **88 文件 / 1014 用例全绿**（+10） | Carbon Code |
| 2026-08-11 | **V3.2-M4 完成**：T4.1-T4.5 用户体验优化（team/self-heal 进度推送 + project/account 视觉高亮 + whoami 修复提示 + doctor 账号完整性 + 启动期缓存）；**87 文件 / 990 用例全绿**（+14） | Carbon Code |
| 2026-08-11 | **V3.2-M3 完成**：T3.1-T3.4 错误处理强化（__dirname 扫描 0 命中 / audit export 损坏行统计 / /orchestrate diagnostics / inferErrorCode en 样本回归）；**86 文件 / 976 用例全绿**（+11） | Carbon Code |
| 2026-08-11 | **V3.1-M6 完成（v3.1 全部 27 任务收官）**：T6.1 E2E 集成测试（team 全链路 / self-heal 修复+回滚 / project 隔离 / audit export）+ T6.2 文档更新（README / user-guide / ARCHITECTURE D42~D46 / CHANGELOG v3.1.0 归位）+ T6.3 收尾（trace S4 O(n²)→O(n) + ADR-024~028 + E1~E4 评估）+ T6.4 测试报告落盘（07.4）；**84 文件 / 923 用例全绿**（门检 ≥785/72） | Carbon Code |
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
| 2026-08-07 | T4.6 完善：文档重构收尾（docs 目录编号 01-06、修复死链与 `concertoai init` 笔误、补充 ADR 与计划文档） | Carbon Code |
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
| 2026-08-09 | **V3.0-M1 完成**：T1.3 显式上下文管理器（serialize/extractSubset/mergeContexts，64KB 上限，19 测试，473 全绿） | Carbon Code |
| 2026-08-09 | **V3.0-M2 完成**：T2.1-T2.3 状态机 + 调度器 + Orchestrator 核心（27/26/13 测试，591 全绿） | Carbon Code |
| 2026-08-09 | **V3.0-M3 完成**：T3.1-T3.6 多角色 Agent 团队 + 事务回滚（architect/coder/reviewer/qa + runTeamLoop + SnapshotManager，614 全绿） | Carbon Code |
| 2026-08-09 | **V3.0-M4 完成**：T4.1-T4.4 Agent 市场基础（注册表/安装器//agent 命令/promote，680 全绿） | Carbon Code |
| 2026-08-09 | **V3.0-M5 完成**：T5.1-T5.3 可观测性（TraceStore + AuditLogger + 面板，699 全绿 → T0.1 校准 750） | Carbon Code |
| 2026-08-09 | **V3.0-M6 完成**：T6.1-T6.3 集成测试 + 文档 + 收尾（4 E2E / README / 架构文档 / 用户手册 / Agent 开发指南 / ADR-015~020 / CHANGELOG / 测试报告，699 全绿 → T0.1 校准 750） | Carbon Code |
| 2026-08-09 | **V3.0 手工测试报告**：新增 `docs/07.3-手工测试报告-v3.0.md`（六大核心功能 18 项 + v2.1 回归 12 项 + 参考脚本 + 已知问题 5 条） | Carbon Code |
| 2026-08-11 | **V3.1-M4 完成**：T4.1-T4.2 结构化错误增强（error-codes 15 码 + read/edit/shell/knowledge code+suggestion + ToolRepairError 渲染兼容；77 文件/874 用例全绿） | Carbon Code |
| 2026-08-11 | **V3.1-M5 完成**：T5.1-T5.5 Orchestrator CLI 入口 + 运维命令补全（team 命令 / /orchestrate / audit export / /agent update / /review --severity；81 文件/912 用例全绿） | Carbon Code |
| 2026-08-11 | **V3.1-M3 完成**：T3.1-T3.4 多租户登录（accounts 存储 + login/logout/whoami/account 命令 + API Key 解析链 + doctor 账号标注；76 文件/858 用例全绿） | Carbon Code |
| 2026-08-10 | **V3.1-M0 启动（T0.1 完成）**：版本归位决策落盘（v2.2 + v3.1 随 v3.1.0 一并发布，不补发 v2.2.0）+ 全项目基线校准（69 文件 / 750 用例）+ v3.1 任务看板建立（27 任务 / 7 里程碑） | Carbon Code |
| 2026-08-10 | **V3.1-M0 完成（T0.2 完成）**：审查遗留复核（S3 已在 7f477a5 修复；S1/S2/S4 处置与计划 §7 一致；src/core/ 与 ARCHITECTURE D41 核对一致）→ M0 两任务全绿，v3.1 进入 M1 | Carbon Code |
| 2026-08-10 | **V3.1-M1 启动（T1.1 完成）**：Verify 分类器四段统一解析（src/loop/self-heal.ts 新增；复用 qa.parseVerifyOutput；ANSI 剥离 + 段标记切分 + 尽力而为）→ 真实 verify 输出实测 4 段全解析 | Carbon Code |
| 2026-08-10 | **V3.1-M1 推进（T1.2 完成）**：修复策略执行器（lint→lint:fix 免审批 / type 简单→模型修复走审批 / 复杂→结构化反馈 / MAX_SELF_HEAL_ATTEMPTS=2）+ 生产辅助 runVerifyCommand/runLintFixCommand | Carbon Code |

---

### V3.3-M1：审查遗留修复（P0，约 2h）

> 背景：v3.2 审查报告（REVIEW-v3.2-full-2026-08-11，总评 9.2/10）标注的「v3.3 方向」5 项（W1/W2 + S1-S3）全部消化，不做新功能面。4.0 决策：先做 v3.3，4.0（插件市场/DAG/TS7）延后（见 v3.3-dev-plan §1）。

- [x] **T1.1** W1：lint:fix 失败 break 语义显式化
  - 涉及文件：`src/loop/self-heal/repair.ts`
  - ✅ 2026-08-11 完成：`if (!fix.ok)` 分支补注释 + log「剩余 type 错误已跳过（环境问题），转人工」（行为不变，仍 break）

- [x] **T1.2** W2：全局正则常量去 `g` 标志
  - 涉及文件：`src/loop/self-heal/classifier.ts`
  - ✅ 2026-08-11 完成：`BIOME_RULE_ERROR_RE` / `BIOME_FORMAT_ERROR_RE` 去 `g` + W2 注释（使用处 new RegExp(source,'g') 行为等价）

- [x] **T1.3** S1：self-heal 文案 i18n
  - 涉及文件：`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/cli/slash/self-heal.ts`
  - ✅ 2026-08-11 完成：新增 `selfHeal` 分组（阶段 6 + 动作 3 + 报告 15 键）；`selfHealPhaseLabel`/`actionLabel`/`formatSelfHealReport` 走 `t()`/`fmt()`；`--lang en` 全英文；en.test.ts 键一致性通过

- [x] **T1.4** S3：缓存过期机制注释
  - 涉及文件：`src/cli/common.ts`
  - ✅ 2026-08-11 完成：`resolveApiKeyCached` JSDoc 补「缓存永不过期，仅适用 CLI 一次性进程；长驻进程应 clearApiKeyCache 或直接 resolveApiKey」

- [x] **T1.5** S2：存量解析测试迁移到 platform-samples
  - 涉及文件：`tests/fixtures/platform-samples.ts`、`tests/agents/qa.test.ts`
  - ✅ 2026-08-11 完成：新增 `VITEST_FAIL_MIXED_POSIX`；qa.test.ts 删除内联 `PASS_OUTPUT`/`FAIL_OUTPUT` 改用样本库（22 用例语义不变、用例数不减）

### V3.3-M2：回归与发布（P0，约 1.5h）

- [x] **T2.1** 回归
  - ✅ 2026-08-11 完成：`npm run verify` 88 文件 / 1014 用例全绿 + `npm audit` 0 漏洞

- [x] **T2.2** 文档同步
  - 涉及文件：`CHANGELOG.md`、`ARCHITECTURE.md`、`TASKS.md`、`AGENTS.md`
  - ✅ 2026-08-11 完成：CHANGELOG [3.3.0] 条目、ARCHITECTURE 版本头 v3.3 + 能力行 + 配套文档、TASKS 总览/里程碑/本区块、AGENTS.md 版本头 v3.3

- [x] **T2.3** 手工测试报告 07.6
  - 涉及文件：`docs/07.6-手工测试报告-v3.3.md`（新增）
  - ✅ 2026-08-11 完成：5 项修复 + 10 回归抽查；实测 `LUMEN_LOCALE=en` 全英文；修复 config.test.ts 环境变量敏感假失败

- [x] **T2.4** 发布动作
  - 涉及文件：`package.json` / `package-lock.json` / `src/version.ts` / `tests/smoke.test.ts`（版本号联动）
  - ✅ 2026-08-11 完成：npm version 3.3.0 → verify 88/1014 全绿 → npm whoami（mmclqx）→ npm publish（latest=3.3.0）→ git tag v3.3.0

---

### V3.4-M1：审查建议闭环（P0，约 1.5h）

> 背景：v3.3 C 审查唯一完善建议 S-C1（collectKeys 深度限制）+ v3.3 自我审查 I1/I2/I3（feedback 数据层 i18n / tsc 正则残留 gm / en 字符集校验）四项闭环，延续「0 遗留」标准。4.0 决策继续延后。

- [x] **T1.1** S-C1：collectKeys 加 maxDepth 参数
  - 涉及文件：`tests/i18n/en.test.ts`
  - ✅ 2026-08-12 完成：`collectKeys(obj, prefix, depth, maxDepth=5)` 超限抛清晰错误（含 maxDepth 值与路径）；2 层正常 + 6 层超限负面测试

- [x] **T1.2** I2：TSC 正则去 `gm` + 全项目 `/[gimy]` 复核
  - 涉及文件：`src/loop/self-heal/classifier.ts`、`src/tools/edit.ts`、`src/tools/read.ts`、`src/model/tokenizer.ts`、`src/planner/deps.ts`
  - ✅ 2026-08-12 完成：`TSC_ERROR_RE`/`TSC_ERROR_PRETTY_RE` 去 gm（使用处 new RegExp 显式带）；同步清理 `ANSI_RE`/`SECRET_PATTERN`/`CJK_RE`/`FILE_REF_RE`/mapOffset 内联 `\r\n`——全项目无带 g 标志常量残留（`/i` 保留）

- [x] **T1.3** I3：en.test.ts 字符集校验
  - 涉及文件：`tests/i18n/en.test.ts`
  - ✅ 2026-08-12 完成：非空英文断言增加「不含 CJK（\u4e00-\u9fff）」；负面测试（含中文 mock 字典断言失败）

- [x] **T1.4** I1：feedback 数据层 i18n
  - 涉及文件：`src/loop/self-heal/snapshot-guard.ts`、`src/loop/self-heal/model.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`
  - ✅ 2026-08-12 完成：`suggestionFor` 5 处 + snapshot-guard 3 处硬编码中文 → `selfHeal.feedback*` 键组（8 键），en 下拒绝/写盘失败/回滚路径全英文

### V3.4-M3：VS Code 崩溃防护（P1，约 2h）

> 背景：2026-08-11 深夜 VS Code 再次闪退（12 转储 / 511MB / 83 进程），根因是 argv.json 写错位置**且字段名写错**（单数 `disable-extension`）导致 5 个 AI 扩展从未禁用 + 14 窗口×全套扩展组合爆炸（踩坑记录 §五/§六）。将排查 SOP 固化为 `concertoai doctor --vscode` 健康检查。

- [x] **T3.1** VS Code 进程数检测
  - 涉及文件：`src/cli/vscode-health.ts`（新增）、`src/cli/doctor.ts`（接入）
  - ✅ 2026-08-12 完成：Windows `tasklist` / POSIX `ps` 解析 + 阈值分级（>60 ❌ / >40 ⚠️ / ≤40 ✅）；命令失败/超时降级「无法检测」不崩溃

- [x] **T3.2** 崩溃转储堆积检测
  - 涉及文件：`src/cli/vscode-health.ts`（新增）
  - ✅ 2026-08-12 完成：三平台 Crashpad 路径 + `*.dmp` 数量/体积统计（>5 或 >100MB ❌，1~5 ⚠️）+ 平台清理命令输出

- [x] **T3.3** AI 扩展数量与 argv.json 核对
  - 涉及文件：`src/cli/vscode-health.ts`（新增）
  - ✅ 2026-08-12 完成：`code --list-extensions` 解析对照已知 AI 清单（>3 告警）+ 已装未禁用核对；argv.json 字段名（复数 `disable-extensions`）/ 值格式（数组或 true）/ 扩展 ID 引号三项校验 + Windows 无效位置检测（踩坑记录 §六）

- [x] **T3.4** i18n + 测试 + CLI 接线
  - 涉及文件：`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/cli/index.ts`、`tests/cli/vscode-health.test.ts`
  - ✅ 2026-08-12 完成：doctor.vscode 键组 zh/en 同构 28 键（en 全英文过 CJK 断言）；`doctor --vscode` 开关接线；28 个新测试（含集成回归）

### V3.4-M2：回归与发布（P0，约 1.5h）

- [x] **T2.1** 回归
  - ✅ 2026-08-12 完成：`npm run verify` 89 文件 / 1044 用例全绿 + `npm audit` 0 漏洞

- [x] **T2.2** 文档同步
  - 涉及文件：`CHANGELOG.md`、`ARCHITECTURE.md`、`TASKS.md`、`AGENTS.md`
  - ✅ 2026-08-12 完成：CHANGELOG [3.4.0] 条目、ARCHITECTURE 版本头 v3.4 + 能力行 + doctor/vscode-health 目录树 + D51/D52、AGENTS.md 版本头 v3.4 + v3.4 完成条目

- [x] **T2.3** 手工测试报告 07.7 + 自我审查报告
  - 涉及文件：`docs/07.7-手工测试报告-v3.4.md`（新增）、`docs/08-审查记录/REVIEW-v3.4-self-review-2026-08-12.md`（新增）
  - ✅ 2026-08-12 完成：07.7 报告（4 修复 + doctor --vscode 10 用例 + 7 回归抽查）；自我审查独立完成（发现 M1/M3 执行日志遗漏 + 3 个实现期问题已修复）

- [x] **T2.4** 发布动作
  - 涉及文件：`package.json` / `package-lock.json` / `src/version.ts` / `tests/smoke.test.ts`（版本号联动）+ 段标记样本 + README
  - ✅ 2026-08-12 完成：npm version 3.4.0 → verify 89/1044 全绿 → npm whoami（mmclqx）→ npm publish（latest=3.4.0）→ git tag v3.4.0

---

## V4.0-M1：审查能修了——/review --fix（P0，约 5h）✅ 已完成

> 用户故事：我运行 /review，ConcertoAI 告诉我 15 个建议。现在它批量审批一次，修好能自动修的，复杂的一起展示，修完自动跑 verify，修坏自动回滚。全程只敲一个「y」。
> 复用：self-heal snapshot-guard 状态机（快照→写盘→verify→commit/rollback，ADR-030）。
> 提交：`b184ed3` · verify 92 文件 / 1080 用例全绿

- [x] **T1.1** 一键修复入口
  - 涉及文件：`src/cli/slash/review.ts`（--fix 解析 + 提示）、`src/reviewer/engine.ts`（autoFix 委托 + 无问题短路）、`src/ui/App.tsx`（--fix 接线 + 进度推送）
  - ✅ 2026-08-12 完成：`/review --fix` 解析（auto/files/pr × --fix 组合）+ 审查完成后自动进入修复模式；无问题短路不进入修复流程（engine.autoFix + runAutoFix 双短路）；进度条「正在修复第 x/y 个问题…」渐进推送聊天消息（onProgress 接线）

- [x] **T1.2** 智能分批 + 批量审批
  - 涉及文件：`src/reviewer/autofix.ts`（新增，categorizeIssue A/B 分批）、`tests/reviewer/autofix.test.ts`（新增）
  - ✅ 2026-08-12 完成：A 类 = 🟢 suggestion + 可定位文件（尝试模型补丁，一次批量审批 diff 摘要）；B 类 = 🔴 critical / 🟡 medium / 无文件（聚合展示需人工判断，不自动修——安全阀门 fail-closed）

- [x] **T1.3** 修复执行引擎
  - 涉及文件：`src/reviewer/autofix.ts`（applyOneFix 快照→写盘→verify→commit/rollback）、`src/ui/App.tsx`（增量 verify：lint + typecheck 段）
  - ✅ 2026-08-12 完成：每个修复快照登记（SnapshotManager + 随机 taskId 防同毫秒冲突）→ 写盘 → 增量 verify（lint+type 段，跳过 build/test）→ 通过 commit / 失败自动 rollback；快照登记失败降级跳过回滚保护（与 self-heal 语义一致）

- [x] **T1.4** 修复报告
  - 涉及文件：`src/reviewer/types.ts`（fixResult 字段）、`src/reviewer/engine.ts`（formatReport 修复结果区块 + compactDiff 摘要）、`src/ui/ReviewReport.tsx`（UI 区块）、`tests/ui/review-report.test.tsx`（新增）
  - ✅ 2026-08-12 完成：报告底部「修复结果」区块——✅ 已修复 x / ⚠ 需人工 y / ❌ 自动回滚 z；每条带 diff 摘要（≤8 行截断）与失败原因；formatReport 文本 + ReviewReportView UI 双渲染，ink-testing-library UI 用例 2 个

- [x] **T1.5** 安全阀门
  - 涉及文件：`src/reviewer/autofix.ts`（批量审批 fail-closed + 回滚兜底）
  - ✅ 2026-08-12 完成：审批拒绝 → 全部 manual 不写盘（fail-closed）；verify 失败 → 自动 rollback 恢复原文件；拒绝后不自动重试；补丁生成失败（模型非法 JSON / search 不唯一 / 文件不存在）→ 降级 manual 不中断整体流程

- [x] **T1.6** i18n + 测试 + v3.4 遗留收尾
  - 涉及文件：`src/i18n/zh.ts`、`src/i18n/en.ts`（reviewer.autofix* 键组 + selfHeal.log* 日志语言化）、`src/loop/self-heal/repair.ts`（I4 遗留日志 i18n）、`tests/planner/deps.test.ts`（FILE_REF_RE lastIndex 回归）
  - ✅ 2026-08-12 完成：zh/en 键同构（collectKeys + CJK 断言通过）；repair.ts 硬编码中文日志 → `selfHeal.log*` 键组；FILE_REF_RE 跨 step lastIndex 回归测试；新增 36 用例（autofix 29 + UI 2 + engine 0 + deps 1 + 现有改造），verify 92 文件 / 1080 用例全绿

---

## V4.0-M2：流程能记住了——concertoai workflow（P0，约 6.5h）✅ 已完成

> 用户故事：每次发版手动跑 lint → test → build → changelog → publish。现在定义 release.yml 后敲 `concertoai workflow run release`，ConcertoAI 知道依赖顺序、审批节点、失败自动回滚。
> 复用：scheduler（DAG 拓扑/并行/重试）+ SnapshotManager（事务回滚）+ onProgress（进度推送）+ PlanConfirm（审批节点）——禁止另起炉灶（§3.4）。
> 提交：本次 · verify 98 文件 / 1127 用例全绿

- [x] **T2.1** 4 个开箱即用的工作流模板
  - 涉及文件：`src/workflow/templates.ts`（新增）、`src/workflow/types.ts`（新增）
  - ✅ 2026-08-12 完成：4 内置模板（init-ts / upgrade-deps / release / precommit）以 TS 常量定义（`workflow export` 序列化为 YAML）；release 含审批节点示例（publish 前 require: approval + files 快照跟踪）；`getWorkflowTemplate` 深拷贝防污染注册表；模板 roundtrip 可解析

- [x] **T2.2** 自然语言生成工作流
  - 涉及文件：`src/workflow/nl-generator.ts`（新增）、`src/workflow/parser.ts`（新增）
  - ✅ 2026-08-12 完成：`workflow create "<描述>"` 调模型生成 YAML → ```yaml 围栏剥离 → parseWorkflowYaml（zod 校验：缺失字段/非法名/未知键/缩进）→ 展示确认；非法 YAML → 降级提示「AI 生成失败，请手动编辑 YAML 或重试」；未配置模型直接报错不调模型

- [x] **T2.3** 工作流执行引擎
  - 涉及文件：`src/workflow/executor.ts`（新增，复用 TaskScheduler + SnapshotManager）
  - ✅ 2026-08-12 完成：DAG 拓扑排序（test 依赖 build 串行、无依赖并行并发 >1）；审批节点 require:approval 暂停等待（拒绝 fail-closed 视为失败）；失败恢复 UX R/S/F/A（retry 不重跑已完成 / skip 下游剔除依赖继续 / abort 整体快照回滚）；onProgress 进度推送；整体回滚边界（任一步失败且放弃 → 全部回滚，全部完成含跳过 → commit）

- [x] **T2.4** 步骤智能命名 + 自动依赖推断
  - 涉及文件：`src/workflow/parser.ts`（inferDependencies）、`src/cli/workflow.ts`（confirmInferredDependencies）
  - ✅ 2026-08-12 完成：命令语义启发式（test→build / publish→build / build→lint / lint→typecheck，每步最高优先级一条）；推断结果提示用户确认（y/N），非 TTY/拒绝保持原配置不静默写入；init/create 链路接入

- [x] **T2.5** 工作流分享
  - 涉及文件：`src/cli/workflow.ts`（export/import）
  - ✅ 2026-08-12 完成：`workflow export <name>` 输出 YAML（可重定向）；`workflow import <file>` 解析校验 → 注册到 `.concertoai/workflows/<name>.yml`（可提交 Git 团队共享）；roundtrip 等价 + 非法 YAML 报错带行号

- [x] **T2.6** CLI + /workflow + i18n + 测试
  - 涉及文件：`src/cli/workflow.ts`（新增）、`src/cli/slash/workflow.ts`（新增）、`src/cli/index.ts`、`src/ui/App.tsx`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`tests/workflow/*.test.ts`、`tests/cli/workflow.test.ts`、`tests/cli/slash-workflow.test.ts`
  - ✅ 2026-08-12 完成：`concertoai workflow list/init/run/export/import/create` 全部可用（run 走 DAG 引擎 + 进度 `▎ 正在执行 step x/y` + 失败恢复交互）；`/workflow` chat 内可用（进度推送消息 + 审批走统一 requestApproval 弹窗 + SnapshotManager 快照）；zh/en `workflow.*` 键组同构（collectKeys + CJK 断言通过）；新增 47 用例（workflow 4 文件 36 + cli 2 文件 11），verify 98 文件 / 1127 用例全绿

---

## V4.0-M3：模型能换了——多 Provider 切换（P0，约 5.5h）✅ 已完成

> 用户故事：想试 OpenAI 的模型，以前只能 DeepSeek。现在 config 加一行或临时 `--provider` 立刻切换，切换前状态条告知成本对比；第一次用 `provider auth` 输 Key 安全存储；Ollama 本地模型自动探测。
> 复用：accounts/ 存储体系（Key 0600）、core/model-switcher（Ollama 复用）、model/client（重构为 Provider 接口）。
> 提交：`968a373` · verify 103 文件 / 1187 用例全绿

- [x] **T3.1** 一键切换模型
  - 涉及文件：`src/cli/index.ts`（--provider）、`src/cli/provider.ts`（新增）、`src/model/registry.ts`（新增 ProviderRegistry）、`src/model/router.ts`（新增 ProviderRouter）
  - ✅ 2026-08-12 完成：`--provider openai` 临时切换（本次进程生效）+ `config set provider` 持久化（写 defaultProvider）+ `provider list` 状态标记（🟢/🔴/🟡）+ `-m` 兼容（映射 defaultProvider.model）

- [x] **T3.2** 智能模型推荐
  - 涉及文件：`src/cli/doctor.ts`（模型推荐区块）、`src/model/recommend.ts`（detectComplexity + recommendProvider）
  - ✅ 2026-08-12 完成：项目复杂度检测（文件/依赖启发式）× 预算 × 本地 Ollama 探测 → 推荐 Provider+模型组合 + 月成本预估（日均 20 次对话）

- [x] **T3.2a** 实时成本提示
  - 涉及文件：`src/model/cost.ts`（compareCost/estimateMonthlyCost）、`src/ui/StatusBar.tsx`
  - ✅ 2026-08-12 完成：切换时状态条成本对比（倍率）+ 会话结束实际消费 vs 备选 Provider 估算；OpenAI 定价表独立

- [x] **T3.2b** Provider 认证流程
  - 涉及文件：`src/cli/provider.ts`（auth <name> / --verify）、`src/store/accounts.ts`（复用 0600 存储）
  - ✅ 2026-08-12 完成：交互输入 Key（不回显）→ healthCheck 验证 → 保存 accounts/<name>/config.json 0600；`--verify` 仅验证不保存；Key 不落日志/会话/审计

- [x] **T3.3** Provider 实现（DeepSeek/OpenAI/Ollama）
  - 涉及文件：`src/model/provider.ts`（接口四能力）、`src/model/providers/{deepseek,openai,ollama}.ts`（新增）
  - ✅ 2026-08-12 完成：Provider 接口 chat/tokenize/cost/healthCheck；DeepSeek 默认 + OpenAI 兼容协议（baseUrl 可配）+ Ollama（/api/tags 探测 + /v1 兼容端点 + 成本 0）

- [x] **T3.4** 无感 fallback
  - 涉及文件：`src/model/router.ts`（fallback ≤1 次）、`src/ui/StatusBar.tsx`（提示）
  - ✅ 2026-08-12 完成：主 Provider 故障 → 自动切备选（config 或默认）+ 状态条通知；用户可手动切回

- [x] **T3.5** config v3→v4 自动迁移 + CLI + i18n + 测试
  - 涉及文件：`src/store/migration.ts`（实现）、`src/store/config.ts`（V4Config schema + loadConfig 迁移）、`src/cli/doctor.ts`（迁移完整性四检测）、`src/cli/config.ts`（config set provider / restore）
  - ✅ 2026-08-12 完成：字段映射（defaultModel→providers.deepseek.model、ollamaModel+ollamaBaseUrl→providers.ollama）+ 备份 config.v3.bak + `_migrated` 幂等 + 原子写（临时文件 rename EXDEV 回退）+ doctor 四检测 + `config restore` 回滚；zh/en `provider.*`/`migration.*` 键组同构；M3 累计新增用例 ≥ 14

---

## V4.0-M4：生态能扩展了——插件市场（P1，约 5h）✅ 已完成

> 用户故事：团队有人写了「自动生成 API 文档」插件发布到市场。我 `concertoai plugin browse` 分类浏览（4.7 分 / 1.2k 下载），或 `plugin recommend` 自动推荐（检测到 Express+TypeORM → api-docs + migration-helper）。`plugin install api-docs` 输入 y 确认权限安装完成，输入 /api-docs 即用。
> 复用：market/ registry + installer（sha256/版本比较）、审批流（权限审批）、audit.ts（权限审计）；进程内 + 权限拦截（子进程隔离延后 v4.1，§3.2/§3.6）。
> 提交：本次 · verify 108 文件 / 1277 用例全绿（M4 新增 83 用例 ≥ 16 验收门）

- [x] **T4.1** 插件安装/搜索/列表/移除
  - 涉及文件：`src/plugin/installer.ts`（新增）、`src/plugin/loader.ts`（新增）、`src/cli/plugin.ts`（新增）
  - ✅ 2026-08-12 完成：install 全流程（注册表匹配 → 下载/builtin 直装 → sha256 校验 → 权限清单确认 fail-closed → 落盘 plugin.json + ESM 入口）+ search 模糊搜索（名称/描述/作者/分类，按下载量降序）+ list（已安装字典序）+ remove（删除安装目录）；内置插件（sha256='builtin'）从 builtin.ts 直装不下载；包 name 与注册表条目一致性校验；已安装最新版 ALREADY_INSTALLED 跳过重复下载

- [x] **T4.1a** 插件发现
  - 涉及文件：`src/cli/plugin.ts`（browse/recommend/popular）、`src/market/registry.ts`（分类/下载量/评分字段）
  - ✅ 2026-08-12 完成：browse 按分类（tool/workflow/agent）含下载量+评分；recommend 项目特征启发式（Express 路由 / TODO 标记 / package.json / git 仓库 → api-docs / todo-tracker / release-helper / git-status）；popular Top 10（下载量降序）

- [x] **T4.2** 权限一目了然
  - 涉及文件：`src/plugin/permissions.ts`（新增六类权限 + PermissionEnforcer）、`src/plugin/manager.ts`（新增生命周期）、`src/observable/audit.ts`（复用）
  - ✅ 2026-08-12 完成：六类权限（read/write/network/shell/knowledge/mcp）+ 彩色图标安装清单；运行时两层校验（调用门槛粗粒度声明检查 fail-closed + `ctx.guard` 白名单细粒度 network allowedDomains / shell allowlist / mcp servers）；shell 权限 guard 通过后仍走宿主审批流（approvalCtx 闭包捕获 mount 注入，插件不可绕过）；权限拒绝写审计日志（plugin-permission-denied）；无 detail 退化声明检查不误杀（D57）

- [x] **T4.3** 插件市场 registry 扩展
  - 涉及文件：`src/market/types.ts`（plugins[] + PluginRegistryItem + BUILTIN_PLUGIN_ITEMS）、`src/market/registry.ts`（pluginItemSchema + find/list/searchPluginItems）、`src/market/installer.ts`（installByType 分派）
  - ✅ 2026-08-12 完成：MarketRegistry 增加 plugins[]（type 判别联合，旧 skills[]/agents[] schema 不变零破坏回归）；内置 4 示例插件条目（git-status/api-docs/todo-tracker/release-helper，sha256='builtin'）；installByType 按 type 分派（plugin→PluginInstaller / agent→AgentInstaller / skill→installSkillFromRegistry 抽取 src/skill/installer.ts 单一来源，ADR-036 / D56）

- [x] **T4.4** 插件规范 plugin.json + 加载器
  - 涉及文件：`src/plugin/types.ts`（新增 Plugin/PluginContext/pluginJsonSchema）、`src/plugin/loader.ts`（新增双路径扫描 + ESM 强制）
  - ✅ 2026-08-12 完成：plugin.json 解析 + zod schema 校验（entry 必填、strict 未知字段拒绝、permissions 默认 []）；全局 `~/.concertoai/plugins/` + 项目 `.concertoai/plugins/` 双路径扫描（同名项目级覆盖全局级）；ESM 强制（.mjs 或 .js+同目录 package.json type=module，非 ESM 拒绝并明确报错）；目录名与 name 一致性校验；entry 缺失拒绝

- [x] **T4.5** CLI + /plugin + i18n + 测试
  - 涉及文件：`src/cli/plugin.ts`（命令族接线）、`src/cli/slash/plugin.ts`（新增 /plugin）、`src/cli/index.ts`（注册）、`src/i18n/zh.ts` / `en.ts`（plugin.* 键组）、`tests/plugin/*.test.ts` + `tests/cli/plugin.test.ts`
  - ✅ 2026-08-12 完成：`concertoai plugin install/search/list/remove/browse/recommend/popular` 全部可用；`/plugin` chat 内可用（list/install/remove）；zh/en `plugin.*` 键组同构（collectKeys + CJK 断言通过）；makePermissionConfirm TTY 交互 + --yes 自动通过，非 TTY 拒绝 fail-closed；集成测试覆盖 install 全链路（下载→sha256→权限→确认→落盘）；M4 新增 83 用例（permissions 20 + loader 12 + installer 23 + runtime 6 + cli 22），verify 108 文件 / 1277 用例全绿

---

## V4.0-M5：多 Agent 能并行了——team --parallel（P2，约 3h）✅ 已完成

> 用户故事：我让 ConcertoAI「同时修复登录模块的 bug 和重构用户模块的类型定义」。以前它得一个接一个做。现在它并行处理——两个 Agent 同时工作，互不干扰。做完后自动汇总结果给我看。如果有两个 Agent 改了同一个文件，它会提示冲突让我决定。
> 复用：scheduler 拓扑分层 + detectFileConflicts + SnapshotManager 事务回滚 + runTeamLoop 小闭环（禁止另起炉灶）。
> 提交：本次 · verify 109 文件 / 1299 用例全绿（M5 新增 22 用例 ≥ 10 验收门）

- [x] **T5.1** 自然触发并行
  - 涉及文件：`src/orchestrator/parallel.ts`（新增 detectParallelIntent / buildParallelGroups / isParallelizable）、`src/cli/team.ts`（并行分支）、`src/cli/index.ts`（--parallel 选项）
  - ✅ 2026-08-13 完成：自然语言并行意图识别（同时/并行/分别/各自/并发/多线程强关键词 → 自动进入并行分支）；显式 `--parallel` 开关；拆解任务按依赖分层（复用 topologicalSort，wave 分层同 scheduler 语义）；纯串行链 → 降级串行 + 提示「无法拆解为可并行任务，已按顺序执行」

- [x] **T5.2** 结果自动汇总 + 文件冲突提示
  - 涉及文件：`src/orchestrator/parallel.ts`（detectGroupConflicts / buildParallelSummary / runParallelTeams）
  - ✅ 2026-08-13 完成：并行执行后自动汇总「✅ N 个任务全部完成」；组内文件冲突检测（复用 detectFileConflicts）+ 冲突组整组串行化（安全写盘，避免并行写同一文件竞态）+ 汇总报告提示「⚠️ A 和 B 都修改了 src/utils.ts，请检查保留哪个版本」；conflictMode='abort' 可选（报告冲突不执行）

- [x] **T5.3** 审批节点 + 上下文隔离 + i18n + 测试
  - 涉及文件：`src/cli/team.ts`（每任务独立快照 begin/rollback/commit + onProgress taskId）、`src/i18n/zh.ts` / `en.ts`（team.parallel 键组）、`tests/cli/team-parallel.test.ts`（新增 22 用例）
  - ✅ 2026-08-13 完成：审批 fail-closed（拆解确认在并行分支前，拒绝不执行任何 Agent）；每任务独立 AgentContext/taskId（artifacts 隔离，测试断言峰值并发=2）；每任务独立 SnapshotManager 事务（成功 commit / 失败 onRollback 回滚）；zh/en `team.parallel` 键组同构（collectKeys + CJK 断言通过）；M5 新增 22 用例（意图识别 2 + 分层 5 + 冲突 3 + 并行执行 6 + 集成 5 + 文案 1），verify 109 文件 / 1299 用例全绿

---

## V4.0-M6：IDE 能诊断——LSP 三来源诊断（P2，约 2.5h）✅ 已完成

> 用户故事：我在 VS Code 里打开项目，保存一个 .ts 文件，Problems 面板立刻出现 Biome 的警告、tsc 的类型错误，还有 ConcertoAI 的「未使用 import / 显式 any / console.log」建议。点一下「🔧 用 ConcertoAI 修复」，文件自动修好，诊断消失。
> 复用：self-heal classifier.parseLintErrors（平台样本已覆盖）+ biomeFixEdits（临时副本，不直接改用户文件）+ snapshot 无关（本版只产出 diff，不落盘）。
> 提交：本次 · verify 112 文件 / 1334 用例全绿（M6 新增 35 用例 ≥ 8 验收门）

- [x] **T6.1** 保存即诊断
  - 涉及文件：`src/lsp/server.ts`（新增 LspServer 主循环）、`src/lsp/protocol.ts`（新增 LSP 3.17 最小协议子集）、`src/lsp/diagnostics.ts`（新增三来源诊断聚合）、`src/lsp/framing.ts`（新增 Content-Length 帧编解码）、`src/lsp/index.ts`（barrel）
  - ✅ 2026-08-13 完成：`concertoai lsp --stdio` 启动 LSP 服务器（initialize 能力声明 textDocumentSync:1 + codeActionProvider + serverInfo）；didOpen/didChange/didSave → 三来源诊断推送（biome lint → Warning / tsc type → Error / self-heal 静态规则 → Information）→ publishDiagnostics；跨平台 stdio（CRLF/LF 帧变体 + Windows 盘符 URI 转换，平台样本双覆盖）；同 uri 诊断任务合并（进行中标记 pending，避免高频 didChange 排队子进程）；异步诊断不阻塞帧主循环

- [x] **T6.2** 一键修复入口
  - 涉及文件：`src/lsp/server.ts`（textDocument/codeAction 处理）、`src/lsp/diagnostics.ts`（biomeFixEdits 临时副本 diff + selfHealCodeActions 行删除）
  - ✅ 2026-08-13 完成：lint 诊断 → CodeAction「🔧 用 ConcertoAI 修复」（biome check --write 临时副本 → 整文件替换 edit，服务端不直接改用户文件）；self-heal R1/R3 →「移除未使用的 import」/「移除 console.log 调试语句」行删除 edit；R2（显式 any）不可自动修复不提供 CodeAction；客户端应用 edit 后 didChange 触发重新诊断 → 已修复诊断消失（闭环测试覆盖）

- [x] **T6.3** CLI + 跨平台 stdio + i18n + 测试
  - 涉及文件：`src/cli/lsp.ts`（新增 lsp 命令接线）、`src/cli/index.ts`（注册 lsp 命令 + --stdio 必需校验）、`src/i18n/zh.ts` / `en.ts`（cli.lsp 键组）、`tests/lsp/*.test.ts`（新增 framing 7 + diagnostics 20 + server 8 = 35 用例）
  - ✅ 2026-08-13 完成：`concertoai lsp --stdio` 命令可用（缺 --stdio 报错 exit 1）；zh/en `cli.lsp` 键组同构（collectKeys + CJK 断言通过）；M6 新增 35 用例（协议/帧 7 + 诊断纯函数 20 + 服务器集成 8），verify 112 文件 / 1334 用例全绿

---

## V4.0-M7：TypeScript 7 评估（P2，约 1.5h）✅ 已完成

> 用户故事：TS7（原生编译器）发布在即，要不要迁？——先调研，再决策，不盲迁。
> 提交：本次 · 无代码变更（纯调研 + 决策落盘，verify 112 文件 / 1334 用例保持全绿）

- [x] **T7.1** TS7 调研 → go/no-go 决策门
  - 涉及文件：`docs/10-技术评估/ts7-evaluation.md`（新增 — 调研报告）
  - ✅ 2026-08-14 完成：调研覆盖四维度——① 原生 type stripping（Node 22.6+/23.6+/24；本项目发布物是编译后 JS 不受影响）② erasableSyntaxOnly（实证扫描：**1 enum `LspSeverity` + 11 参数属性 = 12 处不可擦除语法**）③ 工具链兼容（tsup/vitest 走 esbuild 不依赖 tsc 产物；biome 自研 parser；TS7 适配声明缺失）④ Node 运行时要求（本项目运行时不需要 type stripping）。**决策门：NO-GO**——收益趋近 0（build 71ms / typecheck 秒级，构建不依赖 tsc 产物）+ 12 处改造成本 + 生态风险未验证

- [x] **T7.2** 决策落盘
  - 涉及文件：`docs/06-会议与决策记录/DECISIONS.md`（修改 — ADR-037）、`docs/02-架构设计/ARCHITECTURE.md`（修改 — 决策表 D60）
  - ✅ 2026-08-14 完成：ADR-037「TS7 评估 NO-GO——锁定 TS 5.9，v4.1 再评估」落盘（上下文/选项/结论/理由四段式）；ARCHITECTURE 决策表 D60 同步（含渐进准备约束：新代码避免 enum/参数属性/namespace，`LspSeverity` 记入 v4.1 迁移清单）；v4.1 再评估三触发条件写入调研报告 §5（TS7 正式版+工具链适配 / 性能瓶颈 / Node ≥22.6 用户占比）

---

## V4.0-M8：回归与发布（P0，约 2.5h）✅ 已完成

> 用户故事：v4.0 从「能做什么」到「正式交付」——回归、文档、测试报告、发布。
> 提交：本次 · verify 112 文件 / 1334 用例全绿（≥1120/≥95 门）· v4.0.0 已发布 npm + tag

- [x] **T8.1** 全量回归
  - 涉及文件：无（验证动作）
  - ✅ 2026-08-14 完成：`npm run verify` 全绿（build 94ms / lint / typecheck / test 112 文件 / 1334 用例，≥1120/≥95 门）；`npm audit --omit=dev` 0 漏洞；CI 三平台矩阵（ubuntu/windows/macos + node 22）配置核对；v3.4 遗留收尾（I4 + FILE_REF_RE）M1 T1.6 已覆盖

- [x] **T8.2** 文档同步
  - 涉及文件：`CHANGELOG.md`（[4.0.0] 条目：Breaking 7 项落地 + Added M1~M7 汇总 + 无 [Unreleased] 残留）、`docs/02-架构设计/ARCHITECTURE.md`（版本头 v4.0 + §1 v4.0 已完成 + 决策表 D60）、`docs/05-用户与开发指南/`（user-guide v4.0 命令 + 新增 migration-guide-v4.md / plugin-dev-guide.md / workflow-syntax.md）、`README.md`（状态行 v4.0 已发布 + 功能摘要）、`AGENTS.md`（版本头 v4.0.0 + 当前开发阶段 v4.0 已完成 + v4.1 规划）、`TASKS.md`（看板）
  - ✅ 2026-08-14 完成：CHANGELOG Breaking Changes 7 项（≥6 门）全部落地确认 + Added M1~M7 汇总 + [Unreleased] 清零；迁移指南（含升级/回滚/一键降级）齐备；插件开发指南（plugin.json/六类权限/ESM 入口/内置示例）齐备；工作流语法参考（YAML 字段/命令族/执行语义/模板）齐备；用户手册补 v4.0 命令参考；ARCHITECTURE 全景图/目录树/决策表三处同步；README/AGENTS 版本号联动

- [x] **T8.2a** 性能基准对比
  - 涉及文件：`docs/07.8-手工测试报告-v4.0.md`（性能对比区块）
  - ✅ 2026-08-14 完成：冷启动 `--version` v3.2 基线 164ms vs v4.0 139ms（未退化，启动期缓存 ADR-029 生效）；dist 体积 1342KB → 2091KB（+56% 功能面扩展但冷启动未随体积退化）；build 耗时 ~71ms（v3.1）→ 94ms（同量级 esbuild 链路）；首响应由流式渲染主导；数据写入 07.8 二、性能基准对比

- [x] **T8.3** 手工测试报告 07.8 + 自我审查报告
  - 涉及文件：`docs/07.8-手工测试报告-v4.0.md`（新增）、`docs/08-审查记录/REVIEW-v4.0-self-review-2026-08-14.md`（新增）
  - ✅ 2026-08-14 完成：07.8 报告含测试日期/环境/通过失败项/已知问题（参考 07.7 格式）；用户验收场景全部通过（M1~M7 各里程碑 61 用例 + 性能 3 + 回归 8 = 72 项，0 失败）；自我审查独立完成（重点：插件权限模型完备性 / Provider 切换行为差异 / 工作流事务回滚边界 / 市场 schema 向后兼容 / 破坏性变更清单完整性——5 重点全部通过，0 阻断）

- [x] **T8.4** 发布动作
  - 涉及文件：`package.json` / `package-lock.json` / `src/version.ts` / `tests/smoke.test.ts` / `README.md`（版本号联动 4.0.0，AGENTS.md 自查第 8 条）
  - ✅ 2026-08-14 完成：`npm whoami` 验证令牌；`npm version 4.0.0` 后版本号多文件联动一致（package.json + package-lock 顶部 2 处 + src/version.ts + tests/smoke.test.ts + README + AGENTS + self-heal 段标记 `@concertoai/cli@4.0.0`）；`npm run verify` 全绿（prepublishOnly 自动 verify）；`npm publish` 成功（latest=4.0.0）；`git tag v4.0.0` 已打并推送；全项目 `3.\d+.\d+` 搜索排除遗漏

---

*任务完成后请及时更新状态。*