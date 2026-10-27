# 变更日志（Changelog）

## 维护约定

- 每个未发布变更先追加到 `## [Unreleased]`，发布时移动到对应版本小节；
- 条目按类型分组：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）；
- 版本号由 `npm version <patch|minor|major>` 管理（自动 bump + 同步 `src/index.ts` 的 VERSION + git tag）。

## [Unreleased]

### Added — v5.0 M4 T16：`concertoai fix` 报错自动修（2026-10-28 完成）

> 定位：**`check` 说「不行」之后的下一步——一条命令让 AI 试着修。** `fix` 只做 **薄包装**（判断与修复逻辑一个字都不重写），「每次写盘都必须问」不放宽。148 文件 / 2035 用例全绿（+1 文件 / +20 用例）。

- **`src/cli/fix.ts`（新增）**：`runFixCommand`（命令入口 + 全依赖注入，测试不跑真实 verify / 不碰真实终端）/ `buildFixDiagnosis`（纯函数：错误 → 修复策略）/ `formatFixPlan`（纯字符串渲染，TUI 可复用）+ `MAX_DIAGNOSIS_ENTRIES = 20` / `MAX_MESSAGE_DISPLAY = 200`（G5：超长输出不淹没终端）
- **G6 薄包装：动作优先级抽成唯一判定源** `strategyFor(error)`（`src/loop/self-heal/repair.ts`）——`repairVerifyReport`（真修）与 `fix --dry-run`（诊断）**共用同一份**「lint → 确定性 `lint:fix` / type 简单错误 → 模型修复 / 其余 → 转人工」判定。分类复用 `parseVerifyReport`、执行复用 `runSelfHeal`、报告复用 `formatSelfHealReport`，**`fix.ts` 里没有第二套 verify 解析，也没有第二个 if/else 优先级表**（否则会出现「诊断说 lint 直修、真修却走模型」的自相矛盾）
- **`--dry-run` 零写入**：只跑 `npm run verify` + 解析，输出「共 N 个问题 + 每条错误打算怎么修 + 最多尝试几次」。**不调模型（不花钱）、不跑 `lint:fix`、不建快照、不写盘**，且**不需要 API Key**——第一次进项目、还没配 Key 的用户也能先看清问题（边缘路径①）
- **退出码权威**（承接 T15 假通过教训）：`--dry-run` 的通过与否**只看子进程真实退出码**，解析只回答「哪条错误、打算怎么修」；退出码非 0 却一条错误都解析不出 → 明说「**没能定位**」并指向 `concertoai check`，**绝不写成「无需修复」**
- **两道审批门**：① **开跑前确认**——覆盖 `lint:fix` 这类确定性修复（它本身不弹审批框，不兜一层就是「静默改文件」）② **模型修复每次写盘前逐条确认**（复用 `runSelfHeal` 的 `requestApproval`，T8/T9 的风险 insight 自动生效）。非 TTY 且无 `--auto-approve` → **fail-closed 拒绝启动**并指路 `--dry-run`；Ctrl+C / 回答不是 y 一律当拒绝
- **超限转人工 + 现场保留**：复用既有 `MAX_SELF_HEAL_ATTEMPTS`（2 次）与 `RepairVerifyResult.exceeded`；文案只给**真实存在**的命令（`concertoai snapshot list` / `concertoai snapshot clean`）+ 快照目录路径——`snapshot restore` 至今不存在，**一个字都不写**（T10 / T12 空头支票教训，ADR-044）；修复无效的改动由 self-heal 在复验失败时**自动回滚**，不需要用户手敲回滚
- **无 Key 不静默降级**：没配 Key 时明说「只跑 lint 直修，模型修复已跳过（配好 Key 可自动修类型错误）」，不假装修完了
- **i18n**：`zh.fix.*` / `en.fix.*` **同构**（诊断标题 / 通过 / 未能定位 / 摘要 / 策略清单 / 截断 / dry-run 声明与下一步 / 审批标题与提示 / 取消 / 缺 Key / 转人工 / 现场保留 / 三类动作文案）+ `cli.fix.description / dryRun / autoApprove`（en 无 CJK 由 `en.test.ts` 看住）
- **命令注册**：`src/cli/index.ts` 注册 `fix`（`--dry-run` / `--auto-approve` / `-m` / `--lang`），插入 `COMMON_COMMAND_ORDER`（`check` 之后）→ 首屏「常用命令」自动跟随（顺序表非文案表）；**`self-heal` 保留不删**（旧脚本 / 文档引用它，改语义 = 静默改变行为），`fix` 是它的推荐入口

### 测试（v5.0 T16）

- `tests/cli/fix.test.ts` **20 用例**，围绕「会不会偷偷写盘 / 会不会假装修好」组织：
  - 纯函数层：诊断构造（verify 通过 → 零条目、次数上限复用 `MAX_SELF_HEAL_ATTEMPTS`）/ 动作一律来自 `strategyFor`（lint→lint-fix、type 简单→model-fix、build→none + 建议）/ 超上限截断 + `hiddenCount` / 退出码非 0 但解析不出错误 → **不冒充通过** / 通过时不渲染策略清单 / 未通过且零条目 → 明说「没能定位」/ 渲染含 dry-run 零写入声明
  - 命令入口层：verify 通过 → exit 0 且 `lint:fix`／审批**零调用** / verify 失败 → exit 1 + 策略清单且**一次都没写盘** / 首次进裸项目（verify 跑不起来）不崩 / 无 Key 也能诊断（不构造模型客户端）/ 非 TTY fail-closed（verify 一次都没跑）/ 回答 n 与 **Ctrl+C（undefined）** 均视为取消且零写入 / lint 直修后通过 / 模型修复审批**拒绝**（文件原样未改）与**通过**（落盘 + 审批恰好 1 次）/ 修不好 → 转人工 + 现场保留并给出真实存在的 snapshot 命令
  - **薄包装源码护栏**：`fix.ts` 不许自带 verify 解析、不许直接 `spawn`/`ChildProcessQaRunner` 起子进程（必须经注入点）
- **基线校准**：147 文件 / 2015 用例 → **148 文件 / 2035 用例**全绿（`npm run verify`）

### Changed — v5.0 T16 顺带：工具循环上限 50 → 200（文档三处同步）

- `src/loop/loop.ts`：`MAX_LOOP_TURNS` **50 → 200**（用户手动调整，长任务不再频繁触发 `interrupted`）；`LoopOptions.maxTurns` 的 JSDoc 同步
- **文档同步**（纪律 1「常量改动必须搜全量引用」）：`ARCHITECTURE.md` §2 全景图与 §5 目录树的 `MAX_LOOP_TURNS = 50` 两处、`user-guide.md` §11 安全模型「工具循环上限 50 轮」一处，全部改为 **200**

### Added — v5.0 M4 T15：`concertoai check` 提交前只读体检（2026-10-28 完成）

> 定位：**「现在这份代码能不能提交？」一条命令回答，只读、零写入。** 此前「能不能提交」只能靠手敲 `npm run verify` 再从几百行翻滚输出里自己找结论；而 `self-heal` 会动手修——用户 2026-10-28 拍板：**体检先行，修东西是 `self-heal` 的事**。147 文件 / 2015 用例全绿（+1 文件 / +25 用例）。

- **`src/cli/check.ts`（新增）**：`runCheck`（纯逻辑 + 依赖注入，测试不跑真实 verify）/ `runCheckCommand`（命令入口，返回退出码）/ `formatCheckReport`（纯字符串渲染，Ink 可复用）
- **G6 薄包装铁律**：四段分类**复用** `src/loop/self-heal` 的 `parseVerifyReport`，失败摘要**复用** `src/utils/error-summary` 的 `extractErrorSummary`——`check.ts` 里**没有第二套 verify 输出解析**（源码护栏用例盯着：出现 `STAGE_MARKER` / `error TS` / 自带段标记即红）
- **退出码权威，解析只做归因**：通过与否**只看子进程真实退出码**，解析结果只回答「哪段挂了、挂在哪一行」。这条避免了两个方向的假话——解析器没认出成功标记 ≠ 失败；解析器没认出错误 ≠ 通过
- **「不静默成功」三态**（本项目最容易犯的错就是假通过）：① 无 `package.json` → 「这里不是 Node 项目，无法体检」② 有 `package.json` 但 build / lint / typecheck / test 全缺 → 「**没做检测就不算通过**」③ 退出码非 0 却一条错误都定位不出 → 四段全「结果无法判定」+ 末尾带 `extractErrorSummary` 兜底单行——**三种一律 `exit 1`**
- **`&&` 链诚实**：`verify` 定义顺序从**脚本定义**解析（不是猜输出），先跑 test 的项目里 test 失败后 build 标「未执行（前一段失败）」，**不冒充通过**
- **无 `verify` 脚本 → 分项检测**：按固定顺序 build → lint → type → test 各跑一次（`typecheck` / `type` 两种写法都兼容），逐段用退出码判定；缺哪段就说「未配置检测脚本」，**不算通过也不算失败**
- **下一步命令不打空头支票**（T10 / T12 两次踩坑的延续）：`npm run lint:fix` **仅在项目真的配了这个脚本时**才给；其余一律指向**已注册**的 `concertoai self-heal`——M4 的 `fix` 尚未落地，一个字都不写
- **G5 输出受控**：每段输出最多 40 行 + 明确告知「共 N 行，已显示前 40 行」；`--json` 给机器可读结构（`ok` / `mode` / `stages` / `failedStages` / `conclusion` / `nextCommands` / `code`），供 T17 `commit` 直接复用
- **`ChildProcessQaRunner` 增加 `script` 参数**（`src/agents/qa.ts`，默认 `verify` 行为逐字节不变）：分项检测复用既有 spawn + 超时 + **Windows 进程树终止**逻辑，不复制第二套执行器（G6）
- **i18n**：`zh.check.*` / `en.check.*` 同构（标题 / 四段状态 / 截断提示 / 结论 / 下一步 / 三种「无法体检」文案 / 超时 / 运行失败），`cli.check.description` + `--json` 说明
- **命令注册**：`src/cli/index.ts` 注册 `check`（`--json`），并插入 `COMMON_COMMAND_ORDER` 的预留位（首屏「常用命令」第一条=提交前主路径第一步）；`code !== 0` 时写 `process.exitCode`，CI 可直接用
- **顺带修掉一处工作区脏状态**：`src/loop/self-heal/classifier.ts` 被此前的工具写成了 CRLF（内容与 HEAD 一致，`git diff --numstat` 零行），导致 `npm run lint` 的 format 段报错 → 行尾归一为 LF，**不改一个字符**

### 测试（v5.0 T15）

- `tests/cli/check.test.ts` **25 用例**，围绕「会不会骗人」组织：
  - 主路径：全绿 → `✅ 可以提交` + `exit 0`；lint 失败 → 归因 lint + type/test 标「未执行」+ `nextCommands = [npm run lint:fix, concertoai self-heal]`；tsc 错误写在 **stderr** 也能归因 type；`verify` 先跑 test 时顺序按脚本定义
  - 假通过防线：无 `package.json` / 无任何检测脚本 / 退出码非 0 但解析不出原因——**三种都必须 `exit 1` 且结论里不许出现「可以提交」**
  - 边缘路径（G5 四覆盖）：首次运行裸目录 / 命令跑不起来（`spawn ENOENT` 不崩）/ **Ctrl+C 中断**（`ok=false` + `timedOut=false` + stderr 只有 `^C` → 判不了且仍给下一步）/ 500 行噪声输出截断到 40 行
  - 两条红线：**零写入**（运行时断言执行过的脚本列表里永远没有 `fix`；真实落盘断言 `package.json` 与源码文件的**内容与 mtime 前后一致**）+ **薄包装**（源码护栏，含 `lint:fix` 只许「存在性探测」或「建议命令」两种身份）
  - 命令注册护栏：`concertoai check --help` 起**真实进程**，必须有 `--json` 与描述（不打空头支票）
- **变异测试自证护栏有牙**：① 把 `check` 改成「顺手跑 `lint:fix`」→ **2 红**（零写入 + 源码护栏）② 把结论改成「永远 `ok = true`」→ **6 红**；两次均自动还原并逐字比对（`restored identical: true`）
- **基线校准**：146 文件 / 1990 用例 → **147 文件 / 2015 用例**全绿（`npm run verify`）

### Added — v5.0 M3 场景可发现 T14：`--help` 首屏精简（2026-10-28 完成）

> 定位：**首屏只给动词，不给 21 条命令的平铺清单。** 新手打开 `--help` 面对一屏 46 行命令列表，等于没有帮助（v4.0「输出淹没」同类问题）。146 文件 / 1990 用例全绿（+14 用例）。

- **分层首屏（`src/cli/index.ts`）**：`renderGroupedHelp` 输出四段——**快速开始（3 步）→ 常用命令 → 交互（斜杠）→ 高级（其余命令折叠成一行）**，实测 **33 行**（预算 ≤ 40）
- **`COMMON_COMMAND_ORDER` 是顺序表而不是文案表**：首屏每行的命令名与描述都从 `program.commands` **现取**，本表只决定谁排前面 → 命令改名 / 删除 / 描述改动时首屏自动跟随，不存在「手写的第二份文案忘记同步」
- **`findCommand`：查不到 = 不渲染**——把「不打空头支票」（T10 / T12 两次踩坑，ADR-044）从人工核对变成代码保证：表里写了但没注册的命令，一个字都不会出现在用户眼前
- **`program.configureHelp({ visibleCommands })`**：默认隐藏 commander 的命令平铺，**`--all` 时才显示完整 21 条**（`concertoai --help --all`）；`visibleCommands` 读 `process.argv` 而非 `program.opts()`——`--help` 被解析即打印退出，同批 `--all` 此刻可能尚未进 opts
- **M4 预留位**：`check` / `fix` / `commit` / `review` 属 M4（T15-T19），**当前未注册故首屏一个字不出现**；M4 落地后只改 `COMMON_COMMAND_ORDER` 一个数组即可（顺序即产品主张：提交前主路径）
- **i18n**：`help.*` 新增 `fastStart` / `fast1` / `fast2` / `fast3` / `common` / `commonHint` / `slash` / `slashPlan` / `slashReview` / `slashWorkflow` / `slashHints` / `advanced` / `advancedHint`（zh/en 同构）
- **首次进入引导**：复用 T13 已有 `missing-project-rules` 提示（**不新增第二套**），「第一次有、第二次无」由 T12/T13 用例覆盖

### Fixed — v5.0 T14：三个「verify 说全绿、实则不成立」的问题

- **`visibleCommands` 类型错被 build 掩盖**：返回 `readonly Command[]` 与 commander 签名（`Command[]`）不符，**esbuild/tsup 不做类型检查所以 `npm run build` 全绿，只有 `npm run typecheck` 会红** → 改为 `[...cmd.commands]`。教训：build 通过不等于类型正确
- **旧测试断言已删除的 i18n 键**：`tests/cli/help.test.ts` 还在断言 `help.gettingStarted` / `step1-3` / `example*`（T14 已替换为 `fast*`），必然红 → 测试随文案重写
- **`tests/cli/slash-skill.test.ts` 污染真实 home 并制造 flaky**：`/skill install` 写入的是**全局**目录 `~/.concertoai/skills`（由 `os.homedir()` 推导），原先只隔离了 `tmp`（cwd），于是 ① 开发者真实 home 累积 **191 个 `install-test-*` 残留目录**（AGENTS 第 17 条：临时资源必须清理）② 与 `tests/skill/loader.test.ts` 并行时，后者「先 `loadAll` 再数全局技能数量」两次读取之间被插入新技能 → 计数不等 → **`npm run verify` 偶发红（首轮全量实测仅此一处失败、单跑必绿）**。改为 `vi.spyOn(os, 'homedir')` 落进用例 `tmp` + `vi.restoreAllMocks()`，实测跑测试前后 191 → 191 不再泄漏

### 测试（v5.0 T14）

- `tests/cli/help.test.ts` **重写为 17 用例**：用 tsx 起**真实进程**跑 `--help` / `--help --all`，再从 `Commands:` 段解析出「注册表」反查首屏——**拿注册表校验首屏，而不是拿首屏自证首屏**
  - 行数预算（≥ 25 且 ≤ 40，防淹没也防空壳）/ 四段顺序 / `configureHelp` 真的生效（首屏无 `Commands:`，`--all` 有）
  - **常用命令段每一行都真实注册，且描述与注册值逐字相同**（不漂移、不手写）
  - 快速开始三步引用的命令都真存在 / `workflow`·`plugin`·`team` 归入「高级」/ **常用 ∪ 高级 = 全部注册命令**（防某个命令在首屏彻底消失）/ 首屏两段名字反向必须都在注册表
  - **M4 四动词双向不变量**：未注册 → 首屏一个字不许出现；已注册 → 必须上首屏（M4 改 `COMMON_COMMAND_ORDER` 时会立刻被盯住）
  - i18n 死文案检测（每个 `help.*` 键都必须真被渲染出来）/ 斜杠命令走真实解析器（`/review` `/workflow` `/hints`）/ `/plan` 查 TUI 分派分支
- **变异测试三次自证护栏有牙**：① 摘掉 `configureHelp` → **2 红** ② 往 `COMMON_COMMAND_ORDER` 塞未注册的 `check` → **不红且行为正确**（`findCommand` 按设计过滤，用户看不到假命令）③ 硬写一行 `check` 到首屏 → **3 红**
- **基线校准**：146 文件 / 1990 用例全绿（`npm run verify`）

### Added — v5.0 M3 场景可发现 T12：场景提示引擎（2026-10-28 完成）

> 定位：用户「卡住」时，在输入框上方给**一行灰字 + 一条可直接复制执行的命令**。**默认开启但极保守**（用户拍板）——任何可能频繁触发的东西都是负资产（v4.0「进度刷屏 / 输出淹没」教训）。141 文件 / 1914 用例全绿（+1 文件 / +45 用例）。

- **`src/core/suggestion.ts`（新增）**：纯判定层 + IO 层**严格分离**（对齐 `reflection-store.ts`）。三条确定性规则（**只认数出来的事实，禁止耗时 / Token / 消息长度 / 模型自评等间接信号**）：
  | 规则 id | 触发条件（连续 / 确定） | priority | 提示命令 |
  |---|---|---|---|
  | `missing-project-rules` | 无 AGENTS.md 且无 CARBON.md，**且已有 ≥1 轮用户输入**（不抢开场欢迎语） | 10 | `concertoai init` |
  | `repeated-verify-failure` | **连续 2 轮** verify / self-heal 失败 | 20 | `concertoai self-heal` |
  | `repeated-edit-rejection` | **同一文件连续 2 次**被拒 | 30 | `/review <file>` |
- **七条硬约束在引擎内实现，不靠调用方自觉**：① 同时最多 **1 条**（priority 最高）② 同 id **每会话 1 次** ③ 同 id **全局 10 分钟冷却**（持久化 `~/.concertoai/hint-state.json`，重启仍生效）④ **每会话总计 ≤ 3 条**（跨 id）⑤ **Esc / 忽略 → 本会话立刻全静默**（且不清全局冷却）⑥ `hints: 'off'`（或 `CONCERTOAI_HINTS=off`）→ 恒 `null` ⑦ **纯函数：判定层无 IO、不调 `Date.now()`**（时间一律注入 `now`，源码护栏用例看住）
- **`config.hints`（新增配置项）**：`on`（默认）/ `off`；`config set hints on|off` + 环境变量 `CONCERTOAI_HINTS`（非法值 **fail-closed 不写盘**；env 写错值**回落配置文件**而非静默推翻用户设置）
- **`src/store/paths.ts`**：新增 `hintStatePath()`（单一来源）；`hint-state.json` 原子写（临时文件 + rename）+ 写前淘汰过期/超量记录（≤50 条），**读坏 / 写失败一律不抛错**（提示功能不得让对话崩掉）
- **i18n `hints.*`（zh/en）**：文案本体入字典（Ink 与引擎零文案字面量）；`repeatedEditRejectionNoFile` 为「拿不到可用路径」的降级文案，配合 `/review` auto 模式

### Changed — v5.0 T12：命名 `tips` → `hints`（全链路统一）

- 用户 2026-10-28 拍板：提示的是「下一步该做什么」，`hints` 比 `tips`（小技巧）语义更准，且避免与未来「使用技巧」功能撞名
- 联动五处：`config.hints` / `CONCERTOAI_HINTS` / `~/.concertoai/hint-state.json` / `/hints off` / i18n `hints.*`；任务书 T12-T13 与开发计划同步修订

### Fixed — v5.0 T12：清掉一处「空头支票」隐患（任务书级）

- 任务书 T13 原规则表把命令写成 `concertoai fix` 与 `concertoai review <file> --fix`，**这两个命令至今未注册**（`fix` 属 M4 T15-T19）——若照抄进提示就是 T10 已踩过的「文案承诺不存在的命令」坑。已改为真实存在的 `concertoai self-heal` 与 `/review <file>`；**护栏用例实跑 `--help` 断言动词真注册**（不是断言文案里有这个字符串）+ 用真实 `parseReviewCommand` 断言斜杠命令可解析。等 M4 落地 `fix` 后**下个版本**再加规则
- **占位符永不出门**：文件路径含空格时（`/review` 按空格拆参数会被拆坏）→ 降级为不含 `{file}` 的文案 + `/review` auto 模式；用例断言终态文案与命令均无 `{}`/`<>` 残留
- **`tests/setup.ts` 隔离**：测试进程默认 `CONCERTOAI_HINTS=off`，防止 `npm test` 把冷却时间戳写进开发者真实 `hint-state.json`（后果是**开发者自己用 CLI 时提示被莫名静音 10 分钟**，比 T10 那次复盘污染更难排查）

### Added — v5.0 M3 场景可发现 T13：场景提示 UI + 真实 PTY 端到端（2026-10-28 完成）

> 定位：把 T12 的判定结果**呈现成一个用户真的看得见、也关得掉的东西**——输入框上方**一行灰字 + 一条完整可复制命令**，不进消息流、不弹框、不挤压输入框。146 文件 / 1976 用例全绿（+5 文件 / +62 用例）。

- **`src/ui/hint-signals.ts`（新增）**：状态信号采集，只认「数得出来的事实」——`hasProjectRulesFile`（只看 `AGENTS.md`/`CARBON.md` 存在性）/ `countUserTurns`（直接数 user 消息）/ `isVerifyClassCommand`（字面量前缀白名单，**不构造动态正则**，避免把「读错文件」也算成质量关卡失败）/ `nextFailureStreak`（`passed` 必须归零，否则「连续」退化成「累计」）/ `nextRejectStreak`（换文件从 1 起算、批准即归零；无文件上下文不计数）
- **`src/ui/hint-text.ts`（新增）**：纯字符串排版，**零 Ink / React 依赖**（铁律①：先变字符串，Ink 只上色）。`renderHintLine` 先给「命令 + 分隔符」留足宽度再截断文案，**命令永不截断**；宽度不够时**整句丢文案只留命令**（半条命令 = 负价值）。`resolveHintLine` 一行做完阶段门禁 + 排版；`isHintVisiblePhase` 作为阶段放行的**唯一判据**（新增阶段默认不放行）
- **`src/ui/HintBar.tsx`（新增）**：只干一件事——把算好的一行字符串染成 `<Text dimColor>`。**不渲染时返回 `null` 而非空 `<Text>`**（空 Text 会白占一行，正是「挤压输入框」）
- **`src/cli/slash/hints.ts`（新增）**：`/hints on|off|status` **会话级**静音（不写配置文件），回执必带恢复方式（`/hints on`）；`dismiss` 语义与引擎约束⑤「忽略即静默」对齐
- **`scripts/pty-drive-t13.mjs`（新增）**：真实 TUI + 真实 PTY 的端到端驱动，四条断言补足单测盲区——① 无规则文件项目里发消息后出现 `concertoai init` 提示（组件级渲染覆盖不到「App 真的把 state 传给 HintBar」）② 提示是**灰字**（ANSI dim，只能看真实终端字节）③ 提示是**单行**（💡 与命令同行，不折行）④ `/hints off` 后提示消失且回执给出恢复方式。隔离纪律：项目目录与 `HOME` 全部指向临时目录，绝不污染开发者真实 `hint-state.json`

### Changed — v5.0 T13：`awaiting` 阶段（提示与自救不再押在「这一轮跑成功」上，ADR-045）

- **`HintPhase` 新增 `awaiting`**：`streaming` 内部再分两种——「已有产出」（`streamed` 有字 / 有工具在跑）仍为 `streaming`，提示必须让位；「尚无产出」（已提交、屏幕上只有 spinner）为 `awaiting`，允许提示。判据全部来自**已有状态的确定性组合**，不引入计时器 / 超时阈值（承接 ADR-044「只认确定性事实」）
- **提示判定解耦于对话成败**：判定层不再看 `phase`，信号源只有「用户已产生输入」（`countUserTurns`，提交那一刻已回填，与 API 成败无关）+ 规则文件存在性；引擎返回 `null` 时**不主动清空**已显示的提示（否则「每会话 1 次」会退化成「闪 1 下」）
- **输入框在 `awaiting` 保持可用**：`inputActive = idle || awaiting`。真正流式输出期间仍禁用，②不放松
- **`/hints` 提到 `busy` 守卫之前**：它是纯会话内操作（不碰模型、不碰工具、不排队），而用户最想静音的时刻恰恰是「发了消息正在等回复」——被 `busy` 挡掉就是假按钮

### Fixed — v5.0 T13：三个「单测全绿、真实终端全红」的缺陷

- **提示永不出现（假 Key / 断网）**：原判定挂在 `phase === 'idle'`，而 `runLoop` 挂起时 `phase` 永远是 `streaming` → 「这个项目没有规则文件」这条最该早早告诉用户的提示**一次都没出现**（PTY 四条断言全红的直接原因）。改为判定不看 `phase` + `awaiting` 阶段放行
- **`/hints off` 敲不进去**：输入框 `active={phase === 'idle'}`，同场景下**整个输入框不接受按键**——提示看得见却关不掉，想静音只能 Ctrl+C 杀掉会话。改为 `awaiting` 也放行
- **提示行折行把命令劈开**：`HintBar` 把 `process.stdout.columns`（终端列数）直接当排版预算，但它渲染在 `paddingX={1}` 容器**内部** → 100 列终端里可用仅 98 → 排满必然折行（`concertoai init` 的 `init` 掉到下一行，违反「单行」要求）。新增 `HINT_CONTAINER_PADDING_X` 常量按容器内宽换算
- **等待期提交需求的静默丢弃**：输入框活了以后，等待期敲的普通需求不能排队，但**绝不能静默吞掉** → 新增「⏳ 正在等待模型回复…（Ctrl+C 中断；/hints off 可静音提示）」回执（i18n `prompt.busyWaiting` zh/en）

### 测试（v5.0 T13）

- 新增 5 文件：`tests/ui/hint-text.test.ts`（排版 / 截断 / 阶段门禁 / `isHintVisiblePhase`）、`tests/ui/hint-bar.test.tsx`（**源码护栏**：组件零中文字面量、无 `<Box>`；单行 dimColor；**卡满边界宽度** 100/120/160 三档断言 `displayWidth ≤ columns - padding*2`）、`tests/ui/hint-signals.test.ts`（信号口径：passed 归零 / 换文件重计 / 无文件不计数 / verify 类白名单）、`tests/ui/hint-app.test.tsx`（**App 级集成**：挂起模型 `HangingModel`（`streamChat` 零字节永不 settle）→ 提示照样出现 / 等待期 `/hints off` 有效 / 等待期普通需求给回执不静默）、`tests/cli/slash-hints.test.ts`
- **端到端**：`scripts/pty-drive-t13.mjs` 四条断言全部 PASS；跑后自证清理（`PTY 1 个已终止 / 临时目录已删除`，`%TEMP%\ccai-*` 与残留进程均为 0）
- **基线校准**：146 文件 / 1976 用例全绿（`npm run verify`）

### Added — v5.0 M1 基线承接（T1-T7，2026-10-27 全部完成）

> v5.0 定位：**从「黑盒引擎」到「透明驾驶舱」**——让用户看得见、看得懂、管得住每一步（含花钱）。M1 为「日常可用」基线承接（v4.2 计划并入）。128 文件 / 1609 用例全绿。

- **`npx @concertoai/cli` 零安装可用 + 缺 Key 中文引导**（T1）：隔离目录实测零安装；缺 Key 时给出三种**均真实生效**的配置方式 + 获取链接；修复入口不读 `config.json` 中 `providers.deepseek.apiKey` 的真实缺口；新增 Node 版本中文提示（`engines>=22`，TTY-only，`CONCERTOAI_NO_NODE_WARN=1` 可静默）
- **`concertoai update`**（T2）：版本对比（fetch 可注入）→ 确认升级 / `--yes`；npx 场景拒绝误升级；非 TTY fail-closed；错误输出截断
- **`ccai` 短命令**（T3）：`bin` 双入口指向同一 CLI 产物，与 `concertoai` 完全等价
- **`THIRD_PARTY_NOTICES` 脚本化生成**（T4）：`npm run notices`；修正 `cli-highlight`=ISC、补 highlight.js BSD-3、如实记录 tiktoken 缺 LICENSE
- **`concertoai init` 一次分析双文件输出**（T5）：`AGENTS.md`（给 AI）+ `PROJECT_GUIDE.md`（给人）；每条结论带 `文件:行号` 证据硬约束（无证据写「未检测到」）；默认不覆盖、非 TTY 不覆盖、`--force` 显式覆盖；有界扫描（400 文件 / 200KB / 跳过构建产物）
- **`/model` 模型查看与切换 + `model auto` 预设**（T6 / ADR-039）：`/model`（状态+当前时段单价+升级提示）/ `list` / `auto` / `<id>`；**auto = 固定起始档 flash + 手动一键切换，无任何无监督自动升级**；升级方向（变贵）走审批框确认（`kind:'model'`，y/Enter 批准、n/Esc 拒绝、异常 fail-closed），降级方向直接生效；成本对比与 `doctor` 月成本预估同口径；非 deepseek Provider 明确拒绝并指路 `provider switch`
- **DeepSeek 高峰/空闲双档计价**（T7 / ADR-038）：flash 输入 1.5/3.0、输出 4.5/9.0、缓存命中 0.05/0.10；pro 4.5/9.0、13.5/27.0、0.15/0.30（空闲/高峰，元每百万 token），并发 2500/500；`priceTierFor(at)` / `priceFor(model, tier)` / `tierLabel`；状态条与 `concertoai balance` 标注「高峰价 / 空闲价」

### Added — v5.0 M2 审批透明化 T8：审批风险评估引擎（2026-10-27 完成）

> 定位：把审批框里「一行 summary + 一片 diff」变成「批什么 / 影响谁 / 重点看哪行」。**纯本地分析，零模型调用、零 Token、零网络**（ADR-040）。131 文件 / 1714 用例全绿。

- **`core/approval-insight.ts`（新增）**：主入口 `analyzeApproval` → `parseDiff`（剥 CRLF/BOM，不做列偏移）→ 规则匹配 → 影响面聚合 → `ApprovalInsight`（`level` / `changeNatures`≤3 / `hits` / `focusLines` / `impact` / `degraded`）；另导出 `analyzeDiff` / `levelOf` / `focusLinesFrom` / `changeNaturesFrom` 等纯函数
- **`core/risk-rules.ts`（新增）**：15 条风险规则（删除/破坏性、覆盖写、状态删除、数据库写、鉴权、密钥硬编码、网络超时、静默吞错、错误分支删除、并发、配置环境变量、文件系统越界、依赖变更、测试断言弱化、进程退出），每条含 `level` / `target` / `prefilter` 粗筛 / `patterns` / `negativePatterns` 排除 / `why` / `suggestion`（人话字段有测试断言非占位符）；`config.riskRules.disabled` 可关闭单条
- **`core/impact-scan.ts`（新增）**：影响面扫描「谁 import 了我」——只在 medium/high 时执行（省掉 90% IO）、文件数上限 2000、并发池 32（禁止裸 `Promise.all`，防 Windows EMFILE）、单文件失败计入 `skippedCount` 不中断、300ms 硬超时、5s TTL 缓存（key = 路径 + mtime）
- **降级矩阵 8 行 + G2 铁律**：非 TTY / CI / diff > 500 行 / 影响面超时 / 分析抛错 / `approvalInsight='plain'` / 无命中 / 文件数 > 2000 各有独立行为与单测；**分析抛错时返回 `degraded='error'` 的可渲染空 insight，审批流程照旧**（可选功能绝不挟持核心流程）
- **`config.approvalInsight` / `config.riskRules`（新增配置项）**：`rich`（默认）/ `plain`（v4.1.1 原貌）/ `disabled[]`
- **发布门实测（`scripts/bench-approval.mjs` + `scripts/verify-false-positive.mjs`，新增）**：analyzeDiff 100 行 P95 **0.34ms**（预算 5ms）/ 500 行 P95 **1.00ms**（20ms）/ 单规则 10 万字符 **0.77ms**（20ms）/ analyzeImpact 200 文件 **19.89ms**（80ms）/ 审批框出现 P95 **14.59ms**（150ms）；**误报率 0/19 = 0%**（门 ≤1 条且 <5%）、high 级误报 **0**、标注 risk 召回 **7/7 = 100%**

### Fixed — v5.0 T8 实测发现的两处真实缺陷

- **规则正则 ReDoS**：`dependency-change` 的 `\w[\w-]*` 无界量词在 10 万字符单行上退化 O(n²)，bench 实测单规则 **1766ms**（预算 20ms）→ 键长收敛为 `{1,40}` + 字面量起点定位，修复后 **0.77ms**；新增护栏用例「15 条规则 × 10 万字符长行逐条 <20ms」。详见 `docs/09-踩坑记录/2026-10-27-风险规则正则ReDoS爆炸.md`
- **规则 prefilter 死模式**：同一条规则的 `prefilter` 只写了 `": "^` / `": "~`，导致「无引号键」与「依赖段本身」两条 pattern **永远跑不到**（等于静默失效）→ 收紧为覆盖全部形态的 `['"dependencies"', '"devDependencies"', ': "']`，并加三形态命中 + 反例不命中的回归用例。详见 `docs/09-踩坑记录/2026-10-27-风险规则粗筛漏掉形态导致死模式.md`
- **误报收窄（实测驱动）**：`fs-boundary` 的 5 条 high 级命中全部是 `import … from '../core/x'` 这类模块路径（40 段真实 hunk 抽样），已加 `negativePatterns` 排除「specifier 是字符串字面量」的形态，同时保留 `await import(path.join('..', x))` 这类真风险

### Known limitations — v5.0 T8

- 规则**逐行**匹配（不做跨行上下文）：`test-assertion-change` 会把「断言随文案/价格改动一起重写」也提示出来（medium 级），T9 UI 将以「建议重点关注」而非「危险」措辞呈现
- 影响面只答「谁 import 了我」：间接引用与动态拼接路径看不到——`ImpactSummary.status` 会明确标注「未分析」，**不得呈现为「无影响」**

### Added — v5.0 M2 审批透明化 T9：审批框升级为「风险教学卡」（2026-10-28 完成）

> 定位：把 T8 的分析结果真正搬上屏幕，一眼看懂**批什么 / 影响谁 / 重点看哪行**。架构铁律：**纯字符串函数优先，Ink 只做着色与边框**（ADR-041 / §4 D70-D71）。136 文件 / 1805 用例全绿（+5 文件 / +91 用例）。

- **`src/ui/approval-text.ts`（新增）**：审批卡**唯一文案来源** `renderApprovalLines(opts): ApprovalLine[]`——返回带**语义角色**的行（title / intent / nature / impact / risk / attention / focus / diff-add / diff-del / diff-hunk / diff-context / detail / fold / buttons / help），**零 Ink / React import**（护栏测试扫源码）；同文件导出 `renderApprovalText`（非 TTY 出口，与 TTY 逐行同源）、`isPlainApproval`、`analyzeApproval`→可渲染对象的 `describeImpact`、`fileLineNumbers`（按 hunk 头把 diff 下标还原成**文件行号**）、`analyzableDetail`（shell 命令文本按「新增源码行」参与规则匹配）
- **`src/utils/text-width.ts`（新增）**：`displayWidth` / `truncateToWidth` / `wrapToWidth` / `stripAnsi`（CJK 与全角算 2、emoji 与 VS16 序列算 2、组合符号/零宽/ANSI 算 0）——**禁止用 `.length` 判宽度**（中文行必然溢出边框）；diff 行**截断**、解释性散文**折行**两把尺子分开（见下方 Fixed 第 1 条）
- **`src/ui/toggle-throttle.ts`（新增）**：`createToggleThrottle(apply, opts)` 80ms 展示态节流（`RENDER_THROTTLE_MS`），语义为**丢弃中间态**（连按 10 次最多 2 帧），时钟/定时器可注入、无 `setInterval`、`dispose()` 清 pending（卸载不留悬挂 timer）
- **`src/ui/modals.tsx`**：`ApprovalModal` 重写为「角色 → 颜色 + 边框 + memo + useMemo」的纯外壳（组件内**零用户可见文案字面量**，护栏测试剥离注释后断言）；high=红 / medium=黄 / **low=绿不标红**；`PlanProgressView` 的硬编码中文一并迁入 i18n（`plan.progress*`）
- **`src/ui/App.tsx`**：`requestApproval` **先弹 plain 框再异步补 insight**（G2：绝不等待分析，`approvalSeq` 丢弃上一次审批的迟到结果）；`[v]` / `[?]` 走节流器且意图用 **ref** 维护（见下方 Fixed 第 2 条）；`y`/`n`/Esc/Ctrl+C 走 `finishApproval`，**语义与 v4.1.1 逐字节一致**（`y`→approve、`n`/Esc/Ctrl+C→reject、fail-closed），决议**不经过节流**
- **`src/tools/registry.ts`（`ApprovalInsightHint`）/ `edit.ts` / `shell.ts`**：`ApprovalRequest` 新增可选 `insightHint: { file?, intent? }`——`edit_file` 传目标文件与「新建 / 局部修改」，shell **刻意不传**（命令没有目标文件，影响面「不适用」而不是白扫一遍全库）
- **i18n（`zh` / `en`）**：`approval.*` 新增 rich 卡片键组（等级标题 / 操作意图 / 改动性质 / 影响面四态 / 风险点 / 关注行 / 折叠提示 / 按键 / `[?]` 说明）+ `plan.progress*`；**代码注释里写明「本组文案不得出现『危险』二字」**
- **发布门实测（`scripts/bench-approval-ui.mjs`，新增；`npm run bench:approval-ui`）**：三段分别计时（分析 / 文案 / Ink 首帧），端到端 **P95 8.83ms**（后续复跑 9.72 / 7.96 / 7.48 / 7.39ms，**预算 150ms**）、文案生成 P95 **≤0.54ms**、Ink 首帧 P95 **≤8.61ms**（最坏 36.51ms 首轮冷启动）；`tsup` 新增 `ui/modals` 入口仅供基准脚本 import 真实组件（不塞进库 barrel，避免 import 库的人白加载 Ink）

### Fixed — v5.0 T9 实测发现的两处真实缺陷

- **解释性散文被当 diff 行截断，`[?]` 说明的关键半句被砍掉**：早期实现所有行统一走 `truncateToWidth`——对 **diff 行**正确（源码不能折行），对**散文**就是信息丢失（「只是『建议重点关注』，不是结论」正好被省略号吃掉，恰恰是 T8 已知局限要求必须传到的那句话）→ 两把尺子分开：diff/命令行**截断**、标题/改动性质/影响面/风险点/关注行/说明**折行**（`pushWrapped` 处理缩进续行 + `maxLines` 兜底）；回归用例断言整句在且不带 `…`。详见 `docs/09-踩坑记录/2026-10-28-审批卡散文按宽度截断导致说明被砍掉.md`
- **连按 `v` 读到旧渲染快照，切换语义整段失效**：`useInput` 里用 `!diffFull`（渲染快照）算意图，同一批 React 更新内 10 次按键算出的目标值**全是 `true`**，节流器「丢弃中间态」忠实地把错误合并成看似合理的结果（10 次连按停在展开态）→ 展示态逻辑真值改用 **ref**（同步赋值），`requestApproval` / `finishApproval` 双入口 ref+state 一起归零；「意图正确」与「节流生效」分开测（`toggle-throttle.test.ts` 原子断言 apply 次数 ≤3 且最后一次值正确）。详见 `docs/09-踩坑记录/2026-10-28-连按v意图读到旧渲染快照.md`

### Known limitations — v5.0 T9

- diff 折叠只保「⚠️ 行 ± 2 行」：多 hunk 的大改动需要按 `v` 才看得到全貌（性能红线的代价，刻意接受）
- 「建议重点关注」的行号由 hunk 头推算，hunk 头非标准/被截断时回退到 diff 下标，可能与真实文件行号有偏差
- 影响面仍是「谁 import 了我」的近似（不做 AST）：动态 import 拼接路径、字符串路径引用不计入

### Added — v5.0 M2 审批透明化 T10/T11：拒绝复盘 + 配置降级（2026-10-28 完成，M2 封板）

> 定位：T9 让用户「看得懂」审批，T10 让「拒绝过的原因能被记住」，T11 让「想要原味审批 / 慢机器不卡」有出口。140 文件 / 1869 用例全绿（较 T9 基线 +4 文件 / +64 用例）。

- **`core/reflection-store.ts`（新增，T10）**：拒绝复盘记录（ADR-042 / §4 D72）。`buildReflection`（纯函数：类别去重 + 上限 5 / 关注行上限 10 / **未分析写 `unknown` 而非 `low`**）+ `appendReflection`（**O_APPEND** 单次追加，**永不抛错**，失败返 `{ok:false}`）+ `readReflections`（按时间倒序、同毫秒后写的在上、损坏行跳过并计数、`limit`）+ `clearReflections`（幂等）+ `isReflectionsEnabled`（环境变量 > config 双轨，**非法值回落下一层而非回落默认**）
- **`cli/reflect.ts`（新增，T10）**：`concertoai reflect list [--limit N]`（倒序表格：时间 / 级别 / 文件 / 风险类别，按**显示宽度**补空格中文不糊版；未分析显示「— 未分析」不冒充低风险）+ `reflect clear [--yes]`（**非 TTY 无 `--yes` fail-closed**：复盘是不可再生的判断历史，不让脚本静默清空；`（y/N）` 回车 = 取消，与审批框回车 = 批准刻意不同）；`--limit` 非法时如实提示后按默认 20 继续
- **`ui/App.tsx`（T10）**：拒绝时 `finishApproval(false, request, insight)` → `recordRejection` **fire-and-forget**（决议先 `resolve(false)`，写盘不阻塞退出，G2′）；新增 `notice` 中性提示行（「已记录到本地复盘」用灰字，不复用 error 红字——拒绝是正常操作不是报错）；`reflectionsEnabled` 缺省读 `CONCERTOAI_REFLECTIONS`
- **`store/config.ts`（T11）**：新增 `ApprovalInsightMode` / `ReflectionsMode` + 默认常量 + `validateConfigValues`（**非法值提示一次不抛错**，与 `pricingHolidays` 同口径）+ `isApprovalInsightMode` / `isReflectionsMode` 类型守卫；`ResolvedConfig` 新增 `approvalInsight` / `reflections`（**环境变量在解析层合并**，入口不再各读一份）
- **`concertoai config set`（T11）**：支持 `reflections <on|off>` / `approvalInsight <rich|plain>`——拒绝提示里承诺的命令**必须真能用**；非法值 **fail-closed 不写盘**（与「读取时宽容」刻意相反：写入是用户明确表达意图的时刻）
- **i18n**：`reflect.*`（22 键）/ `cli.reflect.*`（3 键）/ `approval.impactNotNeeded`（第五态）中英双语
- **测试**：`tests/core/reflection-store.test.ts`（22）+ `tests/cli/reflect.test.ts`（15）+ `tests/ui/approval-reflect.test.tsx`（8）+ `tests/ui/approval-degrade.test.tsx`（12）+ `tests/store/config.test.ts`（+5）+ `tests/setup.ts`（全局测试隔离）

### Fixed — v5.0 T10/T11 实测发现的三处真实缺陷

- **`npm test` 把测试数据写进开发者真实复盘记录**（T10 让既有缺陷产生副作用）：`reflections` 默认 on + 写入路径是真实 `~/.concertoai/reflections.jsonl` + T9 集成测试会走真实「按 n 拒绝」→ 一次全量跑完多了 **16 条**垃圾记录（project 全是 `mkdtemp` 临时目录名）→ 新增 `tests/setup.ts` 全局 `CONCERTOAI_REFLECTIONS=off` + App 缺省读该环境变量 + 要测写入的用例**显式**开启 + 护栏用例断言「未传 prop 时遵循 env=off」；受影响的「默认 on」配置测试在 describe 内 `vi.stubEnv('')` 显式声明前提。详见 `docs/09-踩坑记录/2026-10-28-测试污染真实复盘记录.md`
- **分析被降级时复盘把所有编辑记成「低风险」**：`analyzeApproval` 降级时 `hits` 为空 → `levelOf([])` 返回 `'low'`，直接记录会让非 TTY / CI 环境下的复盘表一片「✅ 低」而事实是**根本没分析**（`undefined` 只覆盖了「分析未到达」）→ 判据改用 `insight.degraded`，`buildReflection` 侧 `unknown` 时同时丢掉 categories。详见 `docs/09-踩坑记录/2026-10-28-降级未分析却记录成低风险.md`
- **【T8/T9 存量缺陷】低风险不扫影响面，UI 却说「你的项目太大」**：`emptyImpact()` 缺省 `skipped`，而 `skipped` 的文案是「影响面未分析（项目过大，文件数超过 2000）」——单文件临时项目也会被这么说（实测在 T11 对照组截图里看到）→ `ImpactSummary.status` 新增第五态 **`not-needed`** + 独立文案「低风险改动，未做影响面扫描（仅中高风险才扫）」，`skipped` 现在只表示真超限。详见 `docs/09-踩坑记录/2026-10-28-低风险未扫影响面被说成项目过大.md`

### Known limitations — v5.0 T10/T11

- 复盘只记「编辑类拒绝」：shell 命令拒绝不记（命令没有文件风险面，`file` 会为空）——若要覆盖需先定义「命令的影响面」语义
- `reflect list` 不做按项目 / 等级过滤（当前 `--limit` + 肉眼够用；等 M5 本地指标再考虑）
- 复盘记录无自动轮转（只追加不清空）：一天几十条量级下暂无问题，若长期使用需配合 `reflect clear`

### Changed — v5.0 M1

- **计价时段与 ollama 切换时段解耦**（T7 / R7）：`core/peak-time.ts` 拆 `PRICING_PEAK_RANGES` + `isPricingPeakTime`（厂商定价事实）与 `SWITCH_PEAK_RANGES` + `isPeakTime`（可被用户关闭的切换策略），`PEAK_TIME_RANGES` 保留为切换口径别名；`costFor` / `cacheHitCostFor` / `costForProvider` / `costProfileFor` 统一接受 `at` 时间注入，Provider 层以 `now()` 构造注入（消除「白天测高峰价、晚上测空闲价」的时间依赖 flaky）
- **审批类别扩展**：`ApprovalRequest.kind` 增加 `'model'`（模型升级确认），与 edit/shell 共用同一 fail-closed 决议机制

### Fixed — v5.0 T7 修订（用户核对官方定价页后）

- **flash 价格按官方订正**（原任务书数字有误）：缓存命中 0.05/0.10 → **0.02/0.04**，输入（未命中）1.5/3.0 → **1/2**（空闲/高峰，元每百万 token）；输出 4.5/9.0 与 pro 全部数字经核对无误。来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（已落 ADR-038）。连带：flash→pro 切换倍数由「≈3.0 倍」变为「≈3.7 倍」，`/model` 与 `auto` 文案同步
- **计价高峰排除中国法定节假日 + 纳入调休上班日**（`src/core/holidays.ts` 新增）：`计价工作日 = (周一~周五 且 非法定节假日) 或 调休上班日`；节假日优先于调休（同日两者都有 → 按节假日算，fail-safe 向便宜）；**切换口径 `isPeakTime` 保持不变**（v2.2 语义，避免静默改变用户已配置的 ollama 切换行为）。节假日数据**不内置推测值**（国务院逐年发布，猜错一天 = 算错钱），支持 `config.pricingHolidays: { holidays, makeupWorkdays }` 运行时装载；非法日期提示后忽略；**未配置时 `concertoai balance` 显式提示「可能显示错误档位」**，不静默犯错
- **【存量缺陷】v3 配置迁移后 `legacy` 里的字段全部失效**（v4.0 起潜伏）：`migrateV3ToV4` 把 `allowlist` / `peakTimeStrategy` / `mcpServers` / `sessionDir` / `locale` 等收进 `legacy` 子对象，但全仓**零处读取** `legacy`（消费方都读顶层）→ 迁移「成功」但这些配置全失效（白名单要重批、MCP 不启动、高峰策略回落 ask）。本轮因新增 `pricingHolidays` 走同一路径而暴露，`loadConfig` 读取层新增 `flattenLegacy`（**顶层优先**，legacy 只补缺失键，不改写磁盘）+ 2 条回归用例。详见 `docs/09-踩坑记录/2026-10-27-配置迁移legacy字段无人消费.md`

> 历史遗留（待 T23.2 文档收尾统一处理）：下方 v4.1.0 热修条目实际已随 v4.1.1 发布，尚未移动到 `[4.1.1]` 小节。

> v4.1.0 发布后热修（v4.1.1 已发布，条目待归档）。117 文件 / 1402 用例全绿（+12）。

### Fixed

- **release 模板依赖推断叠加生成环 → workflow run 崩溃**（真实手工测试复现，证据 `docs/11-手工测试结果/v4.0-test-result.md`）：模板预置 `build depends: [test]` + 推断新增 `test 依赖 build` → `CyclicDependencyError: test → build → test` unhandledRejection 进 crash.log。双层修复——① 根因层 `inferDependencies` 推断每条边前 `hasDependencyPath` 环检测（目标已依赖来源则跳过，不再生成环）；② 防御层 `executor` 捕获 `CyclicDependencyError` 转友好失败结果（`WorkflowRunResult.cycle` 环路径 + CLI `runFailedCycle` 文案「💡 编辑 release.yml 移除互相依赖的 depends」），不再崩溃；③ 兜底层 `safeAction` 泛型化包住 workflow action，未预期异常统一「命令执行失败 + 💡 下一步」出口。回归测试 executor 改断言 + parser 2 用例（直接环/间接环）
- **Windows 下 `npm run <script>` 失败真实错误丢失**：npm 包装脚本把子命令（tsc/biome 等）错误透传到 **stdout**、`err.stderr` 为空 → 摘要只显示无用的「Command failed: npm run typecheck」。`defaultRunCommand` 失败时合并 stdout+stderr，两者皆空才退回 err.message。4 回归测试
- **biome format/lint 错误摘要无操作性**：此前命中 diff 头 `× Formatter would have printed…`（不知道哪个文件/怎么办）→ 改为识别 `<file> format/lint ━` 文件标题行 + 附「建议运行 biome check --write . 自动修复」。2 回归测试
- **preflight 用户拒绝（n）/非 TTY 静默退出**：`preflightAndInit` 拒绝继续时无任何输出直接返回 → 补「已停止执行，请先配置缺失项后重试」（i18n `preflightStopped` zh/en）。2 回归测试
- **preflight 自动初始化「装好了但跑不通」——biome 2.x 不兼容 + tsc 无 tsconfig 打印 help**（专家手工测试 mt43 暴露，证据 `docs/11-手工测试结果/v4.1.1-test-result.md`）：① `defaultBiomeJson()` 模板写死 1.9.4 schema + deprecated `recommended: true`，而 preflight 安装 `@biomejs/biome` 无版本上限 → npm 装到 2.5.8 → lint 报 `schema version does not match（Expected 2.5.8 / Found 1.9.4）` 必败 → 模板升 2.x（`$schema` 2.5.8 + `linter.rules.preset: 'recommended'`）；② typecheck 自动初始化只装 typescript + 注入 `tsc --noEmit`，裸项目无 tsconfig.json → tsc 不检查文件而是打印 help（exit 1）→ 新增 `defaultTsconfigJson()`（esnext/nodenext/strict/noEmit/skipLibCheck/verbatimModuleSyntax）+ autoInit 写文件 + checkPrerequisites 缺失检测（可自动修复）；③ error-summary 识别 tsc help 特征 → 摘要给出「缺少 tsconfig.json，npx tsc --init」可操作提示；biome 摘要由整行 ━ 标题改为「文件名 + 需要格式化/存在 lint 问题 + biome check --write .」。回归 3 用例 + `scripts/pty-drive-p0.mjs` 端到端 TTY 驱动（裸项目 → 自动初始化 → lint+typecheck 全过）

### 测试（v4.1 热修）

- 新增 10 用例：`tests/workflow/executor.test.ts`（循环依赖友好失败改断言）、`tests/workflow/parser.test.ts`（直接/间接环跳过 2）、`tests/utils/error-summary.test.ts`（format/lint 文件标题 2）、`tests/cli/workflow.test.ts`（stdout 合并 4 + preflight 停止 2）
- **v4.1.1 P0 追加 2 用例**：`tests/utils/error-summary.test.ts`（tsc help 特征 → 「缺少 tsconfig.json」提示 + biome 摘要去 ━ 断言 2）、`tests/workflow/preflight.test.ts`（tsconfig.json 缺失检测 + 默认 biome.json 2.x schema/preset + typecheck autoInit 写 tsconfig）
- **端到端验证**：`scripts/pty-drive-p0.mjs`（node-pty 真实 TTY：裸项目 → preflight 自动初始化 y→y → 断言「✅ 工作流 precommit 执行成功」+ failIf biome schema 报错 / tsc help）；`scripts/_ts7-check.mjs`（TS7 无 tsconfig help 行为实证）
- **基线校准**：117 文件 / 1402 用例全绿（`npm run verify`）

## [4.1.0] — 2026-08-15

> v4.1 定位：**体验打磨轮（Last-Mile UX）**——客户视角评价 5 个问题闭环（Missing script / F 假按钮 / 进度刷屏 / 输出淹没）+ 专家 5 建议 + 用户 3 反馈落地 + 发布前评审 4 条建议（loadWorkflow 错误传播 / retry:0 roundtrip / 安全模型 / CHANGELOG 确认），不做架构重构。117 文件 / 1390 用例全绿。

### Added

- **智能错误摘要 + 步骤输出截断**（`src/utils/error-summary.ts` + `truncate.ts`）：`extractErrorSummary` 识别 tsc（`error TS…`）/ biome（`× Found N errors`）/ npm（`npm error`）/ vitest（`FAIL`）关键行，兜底首行非空；`truncateMiddle` 头尾保留 + 中间省略标注；`workflow run` 失败先显示「💡 摘要：…」一行，再显示截断详情（4000 字符上限），消除 6 文件完整 diff 淹没提示
- **preflight 环境预检 + 轻量自动初始化**（`src/workflow/preflight.ts`）：`workflow run` 前三维预检（脚本缺失 / 依赖未装 `node_modules/.bin/<tool>` / 缺配置 biome.json）→ 打印报告 + 自动初始化操作计划 → 一次 y/N 审批 → 装 `@biomejs/biome`/`typescript` + 写 biome.json + `tsc --init` + 注入 scripts.lint/typecheck；test 无法猜框架仅提示；package.json JSON 读写 + 写入后校验，失败不落盘；非 TTY fail-closed 直接报清单退出
- **错误「下一步」指引 + CLI 风格统一**：workflow runFailed / workflowNotFound / safeAction 兜底统一「💡 下一步：…」具体命令（i18n zh/en 新增 `workflow.runFailedNext` / `cli.fatalNextStep`）
- **--help 增强 + 首次运行欢迎引导**：commander 自定义 help（开始使用 / 对话 / 项目 / 团队 / 运维 / 市场分组 + 每命令示例 + 新手三步「doctor 检查环境 → chat 开聊 → workflow 跑流程」）；chat 首次启动打印 3 行常用命令欢迎（`~/.concertoai/.welcome-seen` 标记文件，仅一次，mkdirSync 兜底）

### Changed

- **F 选项等待态闭环 + 60s 超时**：选 F 后进入等待循环——「请手动修改代码…Enter 重试 / a 放弃（60s 超时自动放弃回滚）」；超时 / Ctrl+C / 非 TTY → abort（fail-closed）；`promptLine` 扩展可选 `timeoutMs`（AbortController 竞速，缺省不超时，现有调用不变）
- **进度刷屏根因修复**：executor 创建 `TaskScheduler({ maxRetries: 0 })` 禁止内部静默重试（与失败恢复 UI R/S/F/A 架构冲突的根因）；步骤 `retry` 字段语义重定义为「用户通过 R/S/F/A 恢复后的重试次数上限」（缺省不限 = 旧行为不变，向后兼容；0 = 不允许恢复；N = 第 N+1 次恢复强制转 abort）
- **i18n 键重构**：`workflow.failureFixHint` → `failureFixWait` / `failureFixPrompt` / `failureFixInvalid`（en/zh 同构 317/317 一致）

### Fixed — v4.1（发布前专家评审建议，2026-08-15）

- **workflow 解析失败误报「工作流不存在」**（专家评审建议 1）：`loadWorkflow` catch 吞掉解析错误 → 手写 YAML 语法错（如内联列表 `depends: [lint]`）显示「工作流不存在」误导用户以为文件放错位置 → 新增 `loadWorkflowResult` 区分「文件不存在（ENOENT）vs 解析失败（真实错误 + 行号）」，CLI run/export 与 `/workflow` run/export 全部改用；解析失败展示「工作流 precommit 解析失败：第 7 行：depends 必须是列表…💡 请检查 YAML 语法（块状列表）」+ i18n `workflowParseError`（zh/en 同构）+ 3 回归测试
- **`retry: 0` export/import 后静默变「不限」**（专家评审建议 2）：`serializeWorkflowYaml` 此前 `retry > 0` 才输出 → `retry: 0`（= 不允许恢复）导出导入后语义静默变化 → 保留 `retry: 0` 输出，roundtrip 等价 + 回归测试

### 测试（v4.1）

- 新增 `tests/utils/error-summary.test.ts`（12 用例：四类摘要 + 截断边界）、`tests/workflow/preflight.test.ts`（10 用例）、`tests/cli/help.test.ts`（3 用例）；扩展 workflow F 等待态 7 用例、executor retry 语义 5 用例、loadWorkflowResult 3 用例、retry:0 roundtrip 1 用例、i18n 补键断言
- **真实 TTY 交互验证**（发布门补齐，2026-08-15）：`scripts/pty-drive.mjs`（node-pty ConPTY 驱动真实伪终端，子进程 `stdin.isTTY=true`）5 场景 C1-C5 全 PASS——preflight 自动初始化（y→计划→y→真实 `npm install` → lint 跑通）/ F 等待 Enter 重试 / F 等待 a 放弃回滚 / F 等待 60s 超时自动放弃 / 审批节点 y 继续；一键复现 `node scripts/pty-drive.mjs all`（C1 需网络、C4 需等 60s）
- **基线校准**：117 文件 / 1390 用例全绿（`npm run verify`）+ TTY 交互 5 场景全 PASS

## [4.0.1] — 2026-08-15

> v4.0.0 发布后专业审核（8.5/10）收尾补丁：修复 2 个真实端到端 bug（npm v4.0.0 携带）+ 文档/统计/归档同步 + team 静音回归。112 文件 / 1337 用例全绿。

### Fixed

- **Ctrl+C 被误判为崩溃**（用户实测）：workflow / plugin / provider 三处 `readline/promises` 的 `question()` 在 Ctrl+C 时抛 AbortError 未被捕获 → crash-handler 的 unhandledRejection 写 crash.log + exit(1)（用户主动取消被当崩溃，污染 crash.log 误导排查）→ 抽共享 `src/cli/prompt.ts`（promptLine 捕获 AbortError → undefined，Ctrl+C 视为正常取消，非 TTY → undefined，其他错误原样上抛）+ crash-handler 兜底（AbortError 不写 crash.log、退出码 130 SIGINT 惯例）
- **`/review --fix` 回滚项 reason 语义**：A 类写盘后 verify 失败被回滚的项，修复报告 reason 仍显示「待批量审批」而非「修复后验证失败，已自动撤销」（语义误导；真实端到端发现）→ `rolledback` 分支显式写 `reasonVerifyFailed` + 回归断言
- **LSP CodeAction「🔧 用 ConcertoAI 修复」在配置 `files.includes` 的项目中缺失**：biomeFixEdits 临时副本放系统临时目录被 biome.json includes 忽略（biome 处理 0 文件）→ 副本优先放项目 `src/`（无 src 回退 tmp）+ 2 个真实 biome 集成测试
- **Windows 下 LSP 真实诊断静默为空**：`execFileAsync('npx.cmd')` 抛 EINVAL（Node 无法直接 spawn .cmd）→ 改 `spawn(cmd, { shell: true })`（与 tools/shell.ts 跨平台策略一致）

### Changed

- **失败恢复 [F] 选项提示**：选 F 后打印「F 仅重跑失败步骤（不会自动修复），请先手动修改代码」——消除「F 会自动修」误解（i18n zh/en 新增 `workflow.failureFixHint`；v4.1 进一步升级为等待态闭环）
- **provider auth 取消提示**：Ctrl+C 取消认证时打印「已取消认证」而非误报「API Key 不能为空」（i18n zh/en 新增 `provider.authCanceled`）
- **precommit 模板前置说明**：description + lint 步骤 description 补「需项目已配置 lint/typecheck/test 脚本与格式约定（biome.json）」（覆盖「Missing script: lint」与 Windows CRLF/空格缩进 vs biome LF/Tab 默认冲突；v4.1 preflight 自动初始化闭环）
- `runTeamCommand` 新增 `silent` 选项：/orchestrate（chat 内）调用置 true，抑制 stdout/stderr 直写污染 TUI（进度经 onProgress、汇总经返回值承载）
- `docs/10-手工测试/07.5-快速执行卡` 归档至 `docs/03-开发计划与任务/archive/`（完整版在 docs 根）
- TASKS.md 总览同步 v4.0（161→214 任务）、ARCHITECTURE.md 5 处过期同步、07.8 统计 61→62 + 用例 1334→1337

## [4.0.0] — 2026-08-14

> v4.0 定位：**可扩展的插件化 AI 开发平台**——架构拐点（major），破坏性变更集中在新增面（config 格式 / CLI --provider / Plugin 接口），旧命令 / 会话 / 技能平滑迁移。M0~M8 全部落地：112 文件 / 1334 用例全绿，`npm audit` 0 漏洞，CI 三平台（ubuntu/windows/macos）。

### Breaking Changes — v4.0（已落地）

- **config.json 格式升级**（v3 → v4）：`model` 字段 → `defaultProvider` + `providers` 字典。启动时自动迁移（备份 `config.v3.bak` + `_migrated` 幂等标记），`-m` CLI 参数保持兼容（映射到 defaultProvider.model）；`concertoai config restore` 一键回滚
- **CLI 新增 `--provider`**：临时切换 Provider（`concertoai --provider openai`）；`concertoai provider list / auth` 子命令（Provider 认证 Key 安全存储）
- **工具与 Agent 注册改 Plugin 接口**：v4.0 起 Plugin 是公共 API（semver），内置 Provider / 工具 / 技能 / Agent 统一实现 Plugin 接口；旧注册方式保留兼容层
- **插件必须 ESM**：与 ConcertoAI 运行时（ESM）一致；CJS 插件在 v4.0 拒绝加载（明确报错提示迁移）
- **市场 schema 扩展 `plugins[]`**：兼容旧 `skills[]` / `agents[]`（installer 按 type 分派，零破坏）；`concertoai plugin` 命令族（install/list/remove/browse/recommend）
- **`concertoai workflow` 命令族新增**：工作流 YAML（steps/depends/retry/rollback/require:approval）+ 4 内置模板 + `workflow run <name>`（DAG 依赖排序 + SnapshotManager 整体回滚）
- **会话格式兼容**：JSONL 不变，新增 `session.version: 4` 字段（v3 会话可继续读取）

### Added — v4.0（已落地）

- ✅ **`/review --fix`（M1 已落地）**：审查后一键自动修复——A/B 类分批（🟢 suggestion 可定位文件 → A 类尝试模型补丁；🔴 critical / 🟡 medium / 无文件 → B 类需人工判断）+ 一次批量审批 diff 摘要（fail-closed）+ snapshot-guard 快照回滚 + 增量 verify（lint+type 段）+ 报告底部「修复结果」区块（✅已修复 / ⚠需人工 / ❌自动回滚，每条带 diff 摘要），≤2 次交互；`reviewer/autofix.ts` 复用 self-heal snapshot-guard 状态机
- ✅ **`concertoai workflow`（M2 已落地）**：DAG 工作流引擎——4 内置模板（init-ts / upgrade-deps / release 含审批节点 / precommit）+ `workflow init` 交互选模板生成 `.concertoai/workflows/<name>.yml` + `workflow run <name>`（TaskScheduler 拓扑排序/并行/重试 + 审批节点 require:approval 暂停 + 失败恢复 R/S/F/A + SnapshotManager 整体回滚 + onProgress 进度推送）+ `workflow export/import` 分享（YAML 可提交 Git）+ `workflow create "<自然语言>"` 模型生成（非法降级人工编辑）+ 依赖推断提示确认（不静默写入）+ chat 内 `/workflow`；`src/workflow/` 复用 orchestrator/scheduler + transaction
- ✅ **多 Provider 切换（M3 已落地）**：DeepSeek / OpenAI（兼容协议，baseUrl 可配）/ Ollama（本地探测 /api/tags）任意切换——`concertoai --provider openai` 临时切换 / `config set provider openai` 持久化 / `provider list` 状态（🟢/🔴/🟡）+ `provider auth <name>` Key 安全存储（0600）+ config v3→v4 自动迁移（备份 + `_migrated` 幂等 + `config restore` 回滚）+ doctor 模型推荐（复杂度×预算×本地 Ollama + 月成本预估）+ 启动 fallback（主 Provider 故障自动切备选 ≤1 次）+ StatusBar 成本对比/会话结束 vs DeepSeek 估算
- ✅ **插件系统（M4 已落地）**：plugin.json 规范 + PluginLoader 双路径扫描（全局 `~/.concertoai/plugins/` + 项目 `.concertoai/plugins/`，ESM 强制非 ESM 拒绝并明确报错）+ PluginRuntime 动态装配（entry `create(ctx)` 单工具/多工具 → 工具注入 ToolRegistry 带 pluginSource/pluginPermission）+ 六类权限（read/write/network/shell/knowledge/mcp）安装时清单审批（彩色图标，拒绝 CANCELED 不落盘）+ 运行时两层校验（调用门槛粗粒度声明检查 fail-closed + `ctx.guard` 白名单细粒度 network/shell/mcp）+ shell 权限 guard 通过后仍走宿主审批流（插件不可绕过）+ 权限拒绝写审计日志；4 内置示例插件（git-status / api-docs / todo-tracker / release-helper）
- ✅ **插件市场（M4 已落地）**：MarketRegistry 扩展 `plugins[]`（兼容旧 skills[]/agents[]，installer 按 type 分派零破坏）+ `concertoai plugin install/search/list/remove/browse/recommend/popular`（下载 + sha256 校验 + 权限确认；browse 分类含下载量+评分；recommend 项目特征启发式；popular Top 10）+ chat 内 `/plugin` + 内置注册表 4 示例插件条目
- ✅ **多 Agent 并行 `team --parallel`（M5 已落地）**：自然语言「同时/并行/分别/各自/并发」自动触发并行分支 + 显式 `--parallel` 开关；拆解任务按依赖分层（复用 topologicalSort wave 分层，层内并行/层间串行）；纯串行链降级串行 + 提示「无法拆解为可并行任务」；组内文件冲突检测（复用 detectFileConflicts）+ 冲突组整组串行化（避免并行写同一文件竞态）+ 汇总报告提示「⚠️ A 和 B 都修改了 X，请检查保留哪个版本」；每任务独立 AgentContext/taskId（上下文/工件隔离）+ 独立 SnapshotManager 事务（成功 commit / 失败 rollback）；审批 fail-closed（拒绝不执行任何 Agent）；`src/orchestrator/parallel.ts` 复用 runTeamLoop 小闭环
- ✅ **LSP 三来源诊断 `concertoai lsp --stdio`（M6 已落地）**：LSP 3.17 最小闭环（JSON-RPC 2.0 + Content-Length 帧，跨平台 CRLF/LF，零运行时依赖）——VS Code 一行配置即可连接；保存 .ts/.tsx → 三来源诊断推送 Problems 面板：biome lint → Warning / tsc type → Error / self-heal 静态规则（未使用 import、显式 any、console.log）→ Information；CodeAction「🔧 用 ConcertoAI 修复」（biome check --write 临时副本生成整文件替换 diff，服务端不直接改用户文件）与「移除未使用的 import / console.log」行删除，应用后 didChange 触发重新诊断 → 诊断消失闭环；`src/lsp/` 协议/帧/诊断/服务器四模块 + `tests/lsp/` 35 用例；Web UI + VS Code 扩展骨架延后 v4.1
- ✅ **TS7 评估 NO-GO（M7 已落地）**：调研报告覆盖四维度（原生 type stripping / erasableSyntaxOnly / 工具链兼容 / Node 运行时），实证扫描 12 处不可擦除语法（1 enum + 11 参数属性）；决策：**锁定 TS 5.9，v4.1 再评估**（收益趋近 0——构建走 esbuild 不依赖 tsc 产物；成本真实 + 生态适配未验证）；ADR-037 / 决策表 D60；渐进准备（新代码避免 enum/参数属性/namespace）

### Fixed — v4.0（M4 收尾落地）

- **argv.json 字段语义修正（更正 v3.4 §六 错误结论，踩坑记录 §七）**：正确字段是**单数** `disable-extension`（值 = 字符串数组，禁用指定扩展）；复数 `disable-extensions` 只接受布尔值（true = 禁用全部），写成数组 VS Code 类型不匹配**静默忽略** → 禁用从未生效 → 崩溃第四次复发。`vscode-health.ts` 校验逻辑同步修正：单数+数组 ✅ 正确；复数+数组 ❌ 无效（本次根因，告警）；复数 true ⚠️ 合法但激进（提示改用单数）；`detectAiExtensions` 识别复数 true = 全部禁用（不误报"已装未禁用"）；i18n zh/en 文案同步 + 测试用例改写（vscode-health.test.ts 28 用例）

- ~~LSP 诊断（P2）~~：✅ M6 已落地（`concertoai lsp --stdio` 三来源诊断 + CodeAction）；Web UI / VS Code 扩展骨架延后 v4.1
- ~~team --parallel（P2）~~：✅ M5 已落地（自然触发并行 + 结果汇总 + 文件冲突提示）

## [3.4.0] — 2026-08-12

> v3.4 定位：**审查建议闭环 + i18n/正则完整性加固 + VS Code 崩溃防护**（小版本收尾 + 环境健康功能）。

### Fixed — v3.4（M1 审查建议闭环 S-C1 / I1 / I2 / I3）

- **collectKeys 加 maxDepth 兜底**（S-C1，`tests/i18n/en.test.ts`）：递归深度上限默认 5，超限抛清晰错误（含 maxDepth 值与路径），防未来 3 层嵌套字典栈溢出；现有 ≤2 层字典不受影响
- **feedback 数据层 i18n**（I1，`snapshot-guard.ts` 3 处 + `model.ts` 5 处）：`suggestionFor` 与「用户拒绝 / 写盘失败 / 已回滚」建议文案移入 `selfHeal.feedback*` 键组（feedbackBuildFailed / feedbackTestFailed / feedbackTypeError / feedbackFormatError / feedbackUnknown / feedbackDenied / feedbackWriteFailedRolledBack / feedbackWriteFailed），`--lang en` 下 self-heal 报告全路径不再混合中英
- **tsc 正则去 `gm` + 全项目 `/[gimy]` 复核**（I2，`classifier.ts`）：`TSC_ERROR_RE` / `TSC_ERROR_PRETTY_RE` 常量去标志位，使用处 `new RegExp(source,'gm')` 显式带（行为等价）；同步清理 `ANSI_RE`（classifier）、`mapOffset` 内联 `\r\n`（edit.ts）、`SECRET_PATTERN`（read.ts）、`CJK_RE`（tokenizer.ts）、`FILE_REF_RE`（planner/deps.ts）——全项目无带 `g` 标志常量残留（`/i` 单独使用无 lastIndex 陷阱保留）
- **en 字典 CJK 校验**（I3，`tests/i18n/en.test.ts`）：非空英文断言增加「不含 CJK（\u4e00-\u9fff）」校验，en 字典误抄中文会红；新增负面测试（含中文 mock 字典断言失败）

### Added — v3.4（M3 VS Code 崩溃防护）

- **`concertoai doctor --vscode`**（`src/cli/vscode-health.ts` 新增 + `doctor.ts` / `index.ts` 接线）：VS Code 四维只读健康诊断，单项 ✅/⚠️/❌ 标记，破坏性动作仅输出建议命令——
  - 进程数：Windows `tasklist` / POSIX `ps` 计数，>60 严重 / >40 警告 / ≤40 正常（对应 14 窗口×AI 扩展组合爆炸场景）
  - 崩溃转储：Crashpad `reports/*.dmp` 数量 + 总体积（>5 个或 >100MB 告警 + 平台清理命令）
  - AI 扩展：`code --list-extensions` 对照已知 AI 扩展清单（>3 告警）+ 已装未禁用核对（建议 `code --disable-extension <id>`）
  - argv.json：`~/.vscode/argv.json` 核对 `disable-extensions`（**复数**）字段名 / 值格式（数组或 true）/ 扩展 ID 双引号；Windows 无效位置 `%APPDATA%\Code\argv.json` 检测（踩坑记录 §六：单数字段名导致禁用从未生效）
- **doctor.vscode i18n 键组**：zh/en 同构 28 键（`vscodeProcess*` / `vscodeDump*` / `vscodeAiExt*` / `vscodeArgv*` / `vscodeTitle`），en 全英文过 CJK 断言

### 测试（v3.4）

- 新增 `tests/cli/vscode-health.test.ts`（28 用例：进程数解析/阈值、转储统计/路径、扩展解析、argv.json 字段名/值格式/ID 引号/无效位置、doctor --vscode 集成回归）
- `tests/i18n/en.test.ts` 新增 maxDepth 超限 + CJK 负面测试（2 用例）
- **基线校准**：89 文件 / 1044 用例全绿（`npm run verify`），npm audit 0 漏洞

## [3.3.0] — 2026-08-11

> v3.3 定位：**消化 v3.2 审查遗留 + 质量收尾**（v3.2 审查报告 9.2/10 标注的「v3.3 方向」5 项全部落地，不做新功能面）。

### Fixed — v3.3（审查遗留 W1/W2）

- **lint:fix 失败 break 语义显式化**（W1，`src/loop/self-heal/repair.ts`）：`npm run lint:fix` 非零退出时补注释 + log「剩余 type 错误已跳过（环境问题），转人工」，说明显式转人工语义（行为不变，仍 break）
- **全局正则常量去 `g` 标志**（W2，`src/loop/self-heal/classifier.ts`）：`BIOME_RULE_ERROR_RE` / `BIOME_FORMAT_ERROR_RE` 定义不再带 `g`（消除 `lastIndex` 残留陷阱），使用处按需 `new RegExp(source, 'g')` 行为等价

### Changed — v3.3（完善建议 S1-S3）

- **self-heal 文案 i18n**（S1）：`selfHealPhaseLabel` / `actionLabel` / `formatSelfHealReport` 硬编码中文 → `src/i18n/zh.ts` / `en.ts` 新增 `selfHeal` 分组（阶段标签 6 + 动作标签 3 + 报告文案 15），`--lang en` 下状态条/报告全英文；`selfHealPhaseLabel` 公共签名不变
- **`resolveApiKeyCached` 缓存语义注释**（S3，`src/cli/common.ts`）：明确「缓存永不过期，仅适用 CLI 一次性进程；长驻进程应 `clearApiKeyCache()` 或直接 `resolveApiKey()`」
- **存量解析测试迁移**（S2）：`tests/agents/qa.test.ts` 内联 vitest 样本（`PASS_OUTPUT`/`FAIL_OUTPUT`）→ 样本库 `platform-samples.ts`（全绿用 `VITEST_PASS_WIN`、新增 `VITEST_FAIL_MIXED_POSIX`），消除样本散落

### 测试（v3.3）

- 样本库新增 `VITEST_FAIL_MIXED_POSIX`（POSIX 双失败文件 + ❯/× 混合形态）
- qa.test.ts 22 用例迁移后语义不变、用例数不减；i18n en.test.ts 键一致性断言覆盖新分组
- **基线校准**：88 文件 / 1014 用例全绿（`npm run verify`），npm audit 0 漏洞

## [3.2.0] — 2026-08-11

> v3.2 定位：**跨平台可靠 + 长任务可感知 + 代码可维护**（v3.1 核心功能已完整，聚焦把「事后修补」固化为「事前防线」，不做新的大功能面）。

### Added — v3.2（跨平台兼容性）

- **CI 三平台矩阵**（`.github/workflows/ci.yml`）：`strategy.matrix os: [ubuntu-latest, windows-latest, macos-latest]`，Windows 专属问题（spawn ENOENT / `__dirname` / 路径解析）CI 前置拦截
- **spawn 命令适配审计**（T1.2）：Windows 下 `.cmd`/`.bat` 一律 `shell: true` 或经 `getPlatformAdapter` 命令兼容层（`npx` → `npx.cmd` / `cat` → `type` / `tail` → `Get-Content` / `grep` → `findstr` / `rm -rf` → `rmdir` / `mkdir -p` / `sed -i` BSD 适配）
- **UNC 路径处理**（`src/store/projects.ts`，ADR-031）：`normalizeProjectPath` 盘符/UNC 双分支 + `isNested` 分隔符边界比较；项目注册表支持 `\\server\share\` 网络共享路径（规范化 + 嵌套拒绝）
- **EXDEV 跨盘回退**（`src/store/accounts.ts`）：原子写 rename 失败捕获 EXDEV → copyFile + unlink 回退（对齐 `migrateLegacyHome`）
- **跨平台样本库**：`tests/fixtures/platform-samples.ts`（Windows 反斜杠+盘符 / POSIX 双样本、CRLF/LF），解析类测试统一复用

### Added — v3.2（长任务可感知 + 用户体验）

- **team / /orchestrate 进度推送**（T4.1）：`runTeamCommand` 新增 `onProgress` 回调（拆解「📋 已拆解 N 个任务」/ 每轮闭环「🔁 第 x/5 轮 实现/审查/验证」/ 收尾「✅/❌」），CLI stdout 与 chat 消息流渐进推送，不再黑盒等待
- **self-heal 阶段进度**（T4.2）：`SelfHealPhase`（verify/lint-fix/model-fix/verify-fix/rollback/done）+ `onPhase` 透传，状态条 activeTool 随阶段动态更新
- **project / account 视觉**（T4.3）：`project list` 三列表格（名称|路径|注册时间）+ 当前 cwd 项目 ★（当前）chalk.green 高亮；`account list` active 绿色高亮
- **whoami 修复提示 + doctor 账号完整性**（T4.4）：账号缺失时输出可复制命令 `concertoai login <name>`；doctor 新增账号完整性检查项（无 active→ok / 指针指向缺失账号→fail + 修复命令）
- **启动期缓存**（T4.5，ADR-029）：`resolveApiKeyCached` / `loadProjectRegistryCached` 模块级缓存（同一进程、同一 accountsRoot/registryFile 只读一次），CLI 入口 `getApiKey`/`doctor`/`preAction`/`resolveProjectForCwd` 统一走缓存
- **Agent 市场版本管理**（T5.4）：`/agent list` 拉注册表对比「已安装 vs 最新」（落后「↑ 可更新到 <latest>」/ 最新「最新」/ 下架不标注，网络失败降级同步列表）；`/agent update --all` 批量更新（逐条 ✅/⏭️/❌，单个失败不影响其他）

### Changed — v3.2（质量与可维护性）

- **self-heal 模块化重构**（ADR-030）：`src/loop/self-heal.ts` 870 行单文件 → `classifier.ts`（四段解析）/ `repair.ts`（修复执行器）/ `snapshot-guard.ts`（快照状态机）+ `index.ts` barrel，单文件 ≤400 行；公共 API（`runSelfHeal`）不变
- **增量 verify**（T2.3）：lint 修复后仅 rerun lint 段（`runLintOnly`），通过则跳过全量 verify（调用次数 3 → ≤2）
- **快照失效通知**（T2.4）：`RepairVerifyResult.snapshotWarning` 字段，快照登记失败置位并在 /self-heal 报告与 CLI 输出展示
- **audit export 损坏行统计**（T3.2）：`exportJson` 返回 `{ entries, skipped }`，CLI 输出「共 N 条记录（跳过 M 条损坏行）」不静默
- **/orchestrate diagnostics**（T3.3）：`TeamCommandResult.diagnostics?` 字段，拆解失败记录原始模型输出（截断 ≤500 字符），区分「格式解析失败」vs「网络超时」
- **inferErrorCode 英文关键词**（T3.4）：outside sandbox / command not found / spawn ENOENT 英文关键词回归（en locale 样本）

### 测试（v3.2）

- 新增 `tests/cli/common.test.ts`（启动缓存 4 用例）、`tests/e2e/platform-e2e.test.ts`（Windows spawn 回归 + UNC 路径规范化 E2E）、`tests/fixtures/platform-samples.ts`
- 扩展：team onProgress 回调序列（单元 + E2E 全链路）、self-heal 增量 verify（单元 + E2E）、slash-agent 版本对比 + update --all（+9）、doctor 账号完整性、project 三列表格高亮、whoami 修复命令、self-heal 阶段序列
- **基线校准**：88 文件 / 1004 用例全绿（`npm run verify`），npm audit 0 漏洞

## [3.1.1] — 2026-08-11

### Fixed — v3.1.1 补丁（Windows/ESM/解析边界回归）

- **Windows QA 回归**（`src/agents/qa.ts`）：`ChildProcessQaRunner` 以 `shell: false` spawn `npm.cmd` → `.cmd` 无法被 CreateProcess 直接执行（ENOENT），team 闭环 QA 阶段在 Windows 直接失败；改为 `shell: true`，并注释防止重复拼接 `.cmd`（`npm.cmd.cmd`）
- **ESM `__dirname` 崩溃**（`src/reviewer/knowledge.ts`）：`builtinKbDir()` 引用 CJS 全局 `__dirname` → team / `/orchestrate` / `/review` 抛 `ReferenceError: __dirname is not defined`；改为接收 `cwd` 参数基于项目根定位，目录缺失时静默降级
- **Biome 解析漏类别**（`src/loop/self-heal.ts`）：lint 段正则只匹配 `lint/` 前缀，漏掉 `format`（Windows 反斜杠路径 + 行列可选）与 `assist/source/organizeImports` 两类错误 → self-heal 无法定位 lint 问题；新增 `BIOME_RULE_ERROR_RE`（lint|assist）+ `BIOME_FORMAT_ERROR_RE`（行列可选）双正则并行匹配
- **QA 空失败项边界**（`src/orchestrator/loop.ts`）：`passed=false` 且 `failedItems` 为空时返回空数组 → Coder 误判「首次实现」抛「缺少 ArchitectSpec」；改为返回 1 条通用 critical issue（dimension=tests）保证进入修复模式，函数导出供测试覆盖

### 测试（v3.1.1）

- 新增 `tests/reviewer/knowledge.test.ts`（4 用例：__dirname 回归 / 项目级 / 内置 / 截断）
- `tests/agents/qa.test.ts`（ChildProcessQaRunner Windows 回归）、`tests/loop/self-heal.test.ts`（format/assist/无行列/混合 4 用例）、`tests/orchestrator/loop.test.ts`（qaFailedToIssues 边界 4 用例）
- **基线校准**：85 文件 / 937 用例全绿（`npm run verify`）

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
- **基线校准**：84 文件 / 924 用例全绿（`npm run verify`），npm audit 0 漏洞

### 综合评价（专家评审 · 2026-08-11）

- **总体评分**：**8.5/10**（优秀但未到完美）——功能完整性 9/10、多模型适配 9/10、开发效率 9/10、代码质量 8/10、文档同步 8/10、自我修复 8/10；短板为 Windows 兼容性 7/10 与测试通过率 7.5/10
- **发布建议**：⚠️ 修复 team 的 `__dirname`（ESM/CJS 混用）后发布
- **6 个改进方向**：① Windows CI 矩阵 + shellTool 命令统一 ② 全项目统一 `import.meta.url` ③ 结构化错误码替代中文关键词匹配 ④ team 中间消息推送 ⑤ `self-heal.ts`（853 行）拆分 ⑥ 边缘场景测试覆盖
- **完整记录**：`docs/08-审查记录/v3.1-综合评价-2026-08-11.md`

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
