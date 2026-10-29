# AGENTS.md - ConcertoAI 项目开发规范

> 最后更新：2026-10-29
> 版本：v4.1.0

---

## 项目定位

ConcertoAI 是一款**面向个人开发者的终端编码助手 CLI**（DeepSeek 驱动，中文优先）。它不是一个通用工具，而是一个有明确设计哲学的产品：

- **安全优先**：编辑与 Shell 命令一律审批，无 yolo 模式
- **中文优先**：全中文交互与反馈，降低使用门槛
- **低成本**：基于 DeepSeek API，Token 成本远低于同类产品
- **本地优先**：会话记录存储在本地，隐私可控

---

## 产品方向

**目标用户**：个人开发者、独立开发者、开源贡献者

**核心工作流**：
```bash
npm install -g @concertoai/cli
cd path/to/project
concertoai
```
### v2.0 已完成，核心能力包括：

CLI 交互（concertoai chat / concertoai run / concertoai init / concertoai plan）

DeepSeek 流式对话

5 个核心工具（读/搜/列/编辑/Shell）

审批流（编辑与命令一律审批）

会话持久化（JSONL）与 resume

Ink TUI 交互界面

项目规则加载（AGENTS.md / CARBON.md）

BPE 精确 Token 计数与缓存命中成本

智能摘要压缩（超预算优先摘要，失败回退裁剪）

子代理系统（explore / research）

技能系统（/skill，SKILL.md 规范 + 3 个内置技能）

MCP 动态管理（/mcp status / connect / disconnect）

### v2.1 已完成，核心能力包括：

子代理 MCP 工具支持（allowedMcpServers 声明加载：explore→filesystem、research→filesystem/github）

技能嵌套与技能市场（@skill / @agent 引用、/skill install / search / update）

轻量级知识图谱 + 双源记忆注入（JSONL + 内存邻接表索引 + LRU，按项目隔离；knowledge_* 5 工具）

Reviewer Agent 代码评审智能体（/review，9 维审查聚合 5 并行子代理 + 自动测试 npm run verify）

系统性性能优化（O_APPEND 会话追加 / chunk 一次 join / 工具定义缓存 / 关系邻接表 / 懒加载 / 流式节流）

## 技术栈
类别	技术选型
运行时	Node ≥22，ESM
语言	TypeScript (strict)
TUI 框架	Ink 7 + React 19
CLI 解析	Commander 12
参数校验	Zod
测试	Vitest 4
代码检查	Biome
打包	tsup

## 工程规范
### 代码风格
使用 Biome 进行代码检查和格式化（配置见 biome.json）

所有新增功能必须包含测试用例

类型检查必须通过（npm run typecheck 零错误）

提交前运行 npm run verify 确保全绿

### 测试要求
单元测试：纯逻辑模块必须覆盖

集成测试：关键链路（loop / 工具调用）必须有集成测试

UI 测试：Ink 组件需用 ink-testing-library 覆盖

测试目标：保持 409+ 用例全绿

边缘路径强制覆盖：任何新增命令/交互流，必须覆盖 ① 第一次运行（环境未初始化）② 失败后恢复 ③ 用户主动退出（Ctrl+C / Esc / 超时）④ 输出超长截断——「单元测试全绿 ≠ 端到端可用」，主路径测试覆盖不到边缘体验断裂（教训：v4.0 客户评价 5 问题中 4 个是边缘路径盲区：Missing script / F 假按钮 / 进度刷屏 / 输出淹没，见 09-踩坑记录/2026-08-15-体验打磨轮边缘路径盲区.md）

进程级全局状态隔离：测试必须显式钉死并复位模块级可变状态——① spawn / fork CLI 的用例，env 必须显式指定 `LUMEN_LOCALE`（不依赖开发机 shell），「locale 不受外部影响」是必须写出来的承诺，不是默认行为；② 在测试进程内调用过会写模块级状态的函数（`setLocale` / `configureHolidayCalendar` / `resolveApiKeyCached` / `installCrashHandlers`，**示例，非穷举；新增模块级状态函数时同步补充此处**）后，必须在 `afterEach` 复位，不能指望用例执行顺序；③ 改动启动期或全局状态相关代码后，必须换一个非默认环境跑一次全量验证（如 `LUMEN_LOCALE=en npm run verify`），本机默认环境全绿不构成证据——「我的环境没踩到」≠「没人会踩到」。教训：v5.0 T22 修 `--help` 不跟随 locale 后，4 个文件因全局 locale 泄漏而红，其中 1 个是进程内调命令改写全局状态（不在「传 `process.env`」的搜索范围内），只有换环境跑全量才暴露（详见 09-踩坑记录目录 2026-10-28 的 locale 踩坑记录）

注入 / 全局扰动类验证必须先自证「探针通电」：任何「改了 A 之后 B 会不会跟着坏」的验证（隔离 `HOME` 注入配置、替换全局日历、换环境变量跑全量），必须先跑一次断言「注入真的被读到了」（打印注入后的状态对象并断言其值），否则「全绿」只证明探针空转；扰动还必须落在**被测断言真正读取的取值范围内**（把「今天」标成节假日，对全部注入日期的计价断言等于没扰动）。教训：T22 实测校正中，初稿把 `holidays.ts` 标成「风险最高」，实测 2208 用例全绿证明不会踩——「未验证的推断」不能写成断言口吻（见 09-踩坑记录/2026-10-28-help不跟随locale.md §实测校正）

### it 规范
主分支：main

提交信息格式：<type>(<scope>): <subject>

示例：fix(loop): 达到最大轮数时返回 interrupted 状态

示例：feat(tools): 添加并行工具调度

每个任务完成后打标签（如 v1.0.0）

### 文档规范
所有文档放在 docs/ 目录下，编号规范（01-09）

新增功能需同步更新 ARCHITECTURE.md

重要决策记录在 DECISIONS.md 中（ADR 格式见 docs/06-会议与决策记录/DECISIONS.md）

踩坑记录：遇到 Bug 并修复后，立即在 docs/09-踩坑记录/ 新增 YYYY-MM-DD-问题简述.md（格式与维护规则见该目录 README.md）

测试报告：每次版本发布前，生成 docs/07.{版本号}-手工测试报告-v{版本号}.md（参考 07.1/07.2/07.3 格式，含测试日期/环境/通过失败项/已知问题）

执行日志：每次任务开始立即在 docs/ 下新建 execution-log-YYYYMMDD-HHMMSS.md，记录「任务交代 + 关键步骤（读文件/搜索/生成方案/编辑/测试）」，每步带时间戳，便于问题排查与回溯（v3.2 T5.5）

任务说明书：每次新版本（vX.Y）开发计划定稿后，**立即**生成 docs/03-开发计划与任务/vX.Y-dev-tasks.md 详细任务说明书（格式参考 v3.4-dev-tasks.md：每个任务含目标/用户故事/涉及文件/实现要点/验收标准/预估耗时/依赖 + 发布门检查清单 + 风险速查），作为 TASKS.md 看板与逐任务执行的唯一依据

**版本强制工作流（每次迭代必须严格遵守，任何一步未确认不得进入下一步）**：
1. **出计划**：先写 `docs/03-开发计划与任务/vX.Y-dev-plan.md`（设计哲学/定位/现状盘点/原则/用户故事任务拆解/里程碑/发布门/风险）→ **提示用户查看，等用户确认**（无确认不进入下一步；历史教训：v4.1 先出 tasks 后补 plan 被用户纠正，见 execution-log-20260815-160000.md）
2. **出任务书**：用户确认计划后，写 `vX.Y-dev-tasks.md`（任务含目标/用户故事/涉及文件/实现要点/验收标准/预估/依赖 + 发布门清单 + 风险速查）→ **提示用户查看，等用户确认**
3. **开发**：按任务书逐任务实现 + 测试（verify 全绿）
4. **完善文档**：开发完成后同步 CHANGELOG / ARCHITECTURE / TASKS.md / 用户手册等
5. **手工测试报告**：生成 `docs/07.{版本号}-手工测试报告-v{版本号}.md`（含用户视角场景实测）→ **提示用户查看，等用户确认**
6. **自审报告**：生成 `docs/08-审查记录/REVIEW-{版本号}-self-review-{日期}.md`，**必须从用户角度审查**（第一次就跑通？失败怎么办？退出是否体面？新手能否上手？）→ **提示用户查看，等用户确认或专家建议**
7. **补充完整 → 发布**：按确认/建议补充，然后才允许发布（npm + tag）+ 工作区归零

**核心纪律：任何关键产物（计划/任务书/测试报告/自审报告）落盘后，必须主动提示用户查看并等待确认，禁止静默进入下一步。**（用户明确要求，2026-08-15）

### 提交前自查（文档 vs 代码一致性）
每次提交前对照以下清单，防止「注释与代码不一致」「目录树遗漏」类问题（历史教训：MAX_LOOP_TURNS 注释写 10 实际 50；knowledge/、reviewer/ 目录树漏 index.ts）：

1. **常量/默认值**：修改代码常量（如 MAX_LOOP_TURNS）时，搜索该常量在 JSDoc / 注释 / 文档中的所有引用并同步更新
2. **目录树完整性**：更新 ARCHITECTURE.md 第 5 节目录树时，用 list_directory 逐目录核对实际文件；barrel（index.ts）最易漏
3. **数字与行为描述**：搜索文档中带数字的描述（如「≤10 轮」「5 个工具」），与实际代码常量 / 工具数量核对
4. **路径存在性**：docs/ 中引用的文件路径（如 src/xxx.ts）用 read_file 验证真实存在
5. **三处同步**：新增模块时，目录树（第 5 节）+ 决策表（D#）+ 模块说明（§4 / §8）同步更新
6. **文档落盘**：本次提交涉及「Bug 修复 / 版本发布 / 重要决策」时，核对三处是否落盘：踩坑记录（docs/09-踩坑记录/YYYY-MM-DD-*.md）、手工测试报告（docs/07.{版本号}-*）、DECISIONS.md（ADR 新条目）
7. **工作区干净才审查/发布**：生成审查报告或发布前，先 `git status` 确认无 modified/untracked——版本号等改动停留在工作区未提交，会让审查基于旧状态产生假阳性（历史教训：v3.1 审查报版本号 3.0.0，实际工作区已改 3.1.0 未提交）
8. **版本号多文件联动**：bump 版本 = package.json + package-lock.json（顶部 2 处）+ src/version.ts + tests/smoke.test.ts + 代码中硬编码的 `@concertoai/cli@x.y.z` 段标记（如 self-heal 测试）+ README 状态行，**一次改完立即提交**，不留半成品
9. **全景图与目录树双核对**：ARCHITECTURE 第 2 节（全景图）与第 5 节（目录树）独立维护，新增模块必须两处都更新，不能只更新一处
10. **解析类正则多平台样本**：解析第三方工具输出（Biome/tsc/vitest）的正则，必须用 Windows（反斜杠路径/盘符冒号）与 POSIX 两种样本验证，且覆盖类别/行列变体（教训：lint/ 前缀正则漏掉 format/assist 类别，见 09-踩坑记录/2026-08-11-Biome解析漏掉format与assist类别错误.md）
11. **执行日志落盘**：每次任务必须有 docs/execution-log-*.md 落盘，含任务交代 + 关键步骤（读文件/搜索/生成方案/编辑/测试）+ 时间戳；提交时随任务文件一并提交（v3.2 T5.5）
12. **发布前自我审查 + 对照 C 学习**：发布前，AI 先自我审查（独立完成，不参考 C 的审查报告），再与 C 的审查对比，学习差距（语义追问/边界模式/国际化盲区等），持续提升代码质量（v3.2 双视角审查经验，见 09-踩坑记录/2026-08-11-自我审查与C审查视角差距.md）
13. **发布后工作区立即归零**：发布 commit 落盘后立即 `git status` 确认无 modified/untracked；任何发布后发现的新修复（真实端到端 bug）须立即 commit + 补回归用例 + 踩坑记录 + 发 patch 版，严禁修复滞留在工作区（教训：v4.0.0 发布后 autofix reason / LSP 双 bug 滞留工作区，npm 包携带 bug，见 09-踩坑记录/2026-08-14-端到端测试暴露三处自动化未覆盖bug.md）
14. **生成物方向/箭头语义自查**：任何「边/依赖/指向」类结构（工作流 depends、插件权限 allowlist、快照回滚、LSP 编辑方向）在规则表/常量旁必须注释「from 依赖 to / to 是被依赖方」；面向用户的提示用「X 依赖 Y」措辞，禁止用「X → Y」箭头（会被误读为执行顺序）；测试须同时断言「有边」与「无反向边」（教训：workflow 依赖推断方向反了——lint→typecheck 写成 lint 依赖 typecheck，见 09-踩坑记录/2026-08-15-workflow依赖推断方向反了.md）
15. **自动生成模板/配置文件版本前瞻**：自动初始化/模板生成的配置文件（biome.json / tsconfig.json 等）不得绑定写死的旧工具版本假设（schema URL / 已废弃字段）；须用「npm install 最新版」的真实用户环境端到端验证「装完直接 run 能跑通」，存在性检查（依赖/scripts/配置文件）≠ 跑通（教训：preflight 自动初始化用 biome 1.9.4 schema 模板 + 不生成 tsconfig.json → 用户侧 biome 2.5.8 lint 必败 + tsc 打印 help，见 09-踩坑记录/2026-08-16-preflight自动初始化装好但跑不通.md）
16. **手工测试隔离目录验证**：手工测试必须在独立目录进行，切换目录后立即验证 cd 生效（跨盘符用 `cd /d` 或 `pushd`；Windows 下 `cd C:\tmp\xxx` 从 F: 盘切过去不生效，所有写操作会落到当前目录污染项目）。验证方式：`cd /d <测试目录>` 后 `cd`（或 pwd）确认路径正确；测试记录须记录「实际执行目录」而非仅命令（教训：v4.1.1 手工测试 cd 跨盘符未生效，package.json 被 mt44 模板整体覆盖导致 npm run dev 丢失，见 09-踩坑记录/2026-08-16-手工测试cd跨盘符未生效污染项目根目录.md）
17. **临时资源清理纪律**：任何脚本/命令/测试若创建外部资源（PTY、子进程、临时目录、临时文件、监听器、锁文件），释放逻辑必须写进 `try/finally`，并补 `process.on('exit')` + `SIGINT`/`SIGTERM` 兜底——末尾裸 `fs.rmSync` 在进程被硬杀（编辑器闪退 / Ctrl+C / taskkill）时 100% 失效；Windows 下杀 PTY/子进程必须补 `taskkill /pid <pid> /T /F`（`term.kill()` 只带走壳，POSIX 用进程组信号 `kill(-pid)`），且杀之前先探活（`process.kill(pid, 0)`）避免 pid 复用误伤；清理须幂等（flag 防重入）、先杀后删（`rmSync` 加 `maxRetries`/`retryDelay` 对付 Windows EBUSY）、失败时打印残留路径禁止静默；起真实资源的验证脚本必须自证清理（跑完自查残留目录/进程）。判据——「进程被硬杀时这段代码还会执行吗？」答否就必须兜底（教训：pty-drive-t13.mjs 把清理裸放在末尾，见 09-踩坑记录/2026-10-28-PTY清理未放finally导致孤儿进程.md）

18. **命令形态与长任务编排纪律**：**① 命令形态（防假死 / 假乱码）**——Windows `cmd.exe` 下禁止把「多动作串联 + 输出过滤 + 分页器」压进一条命令（`|` / `&&` / `&` 混搭 `findstr`、`| more`、`| find` 会因分页/交互等待与 GBK 转码**假死到超时 + 输出假乱码**，让人误判「文件被写坏」）；读文件/搜内容一律用 `read_file` / `search_content`（UTF-8 直读），需要过滤时单条 `findstr /c:"..." FILE`（不带分页器）或用 `node -e`；耗时命令（`npm run verify` / `biome check --write` / `npx vitest`）必须**单独一条**执行并显式给足超时（120~300s），不与任何管道/串联混用；**文件是否被写坏只以 `read_file` / `search_content` 回显为准，绝不用控制台回显下结论**（需要编码证据用 `node -e` 读 Buffer）；命令超时/无输出先停手拆解逐条定位，禁止原样重试加长超时。**② 长任务编排（防轮次耗尽）**——开工前给三阶段留预算：代码 ~50% / 测试 + 全量 verify ~30% / 文档 + 提交 ~20%，任何阶段不得挤占文档阶段份额；**代码与测试 verify 全绿后立即 commit（固化可信成果）再写文档**，禁止「代码未提交 + 文档半改」的混合半成品态跨会话存活；文档落盘就是 N 次 `edit_file`，按「一文件一编辑、先骨架后补写」直接做，大文档（ARCHITECTURE / DECISIONS / 任务书）只用 `search_content` 定位改点、**禁止整文读取**；**子代理只用于「不知道东西在哪」的定位型问题**（须给明确问题 + 限定范围 + 期望输出格式），禁止让子代理承担文档改写（它只读，结论回传后主会话还要再编辑一次 = 双倍轮次且拿不到精确原文）；轮次接近上限时先落盘已完成部分 + 在 `TASKS.md` 写清「文档 X/Y」进度留接续点（教训：同一任务两次熔断——CMD 管道串联假死导致 verify 未全量 + 文档半改；子代理滥用导致文档阶段轮次耗尽，见 09-踩坑记录/2026-10-28-Windows管道符串联导致假死与假乱码.md 与 09-踩坑记录/2026-10-28-长任务文档落盘轮次耗尽与子代理滥用.md）。**③ 内联脚本落文件（防 cmd 转义坑）**——脚本超过一行，或含引号 / 正则 / 中文 / 箭头函数 / 模板字符串任一项时，**禁止 `node -e` 内联**，一律写成临时 `.mjs` 再 `node file.mjs`（临时文件按第 17 条清理纪律处理）；同一条 `node -e` 因 cmd 转义（`\"` / `^` / `%` / 中文乱码）失败 **2 次即停手改落文件**，禁止换引号写法原样重试（与第 19 条「同一手段失败两次换手段」同源）。判据：本次会话里出现连续两条内容相似、仅转义写法不同的 `node -e` 即为违反。（证据来源：T22 期间内联 `node -e` 被 cmd 转义坑 ≥3 次，见 09-踩坑记录/2026-10-28-Windows管道符串联导致假死与假乱码.md）

19. **hook 依赖数组与 Biome unsafe fix 纪律**：**① 依赖数组双向核对**——给 `useCallback` / `useMemo` / `useEffect` 闭包新增外部变量（新增 prop / state / 参数）时，必须**全量扫描**该文件所有依赖数组逐个补齐（同一参数常被多个闭包消费，漏一处即 stale closure，且运行时往往不报错）；反向同样成立，闭包内**未使用**的变量禁止塞进依赖数组（多余依赖 = 无谓重算，Biome 会报性能告警）。**② Unsafe fix 果断放行，禁止反复重试撞墙**——Biome 诊断标题的 `FIXABLE` 只表示「有人能修」，不代表 `--write` 会修；当诊断末尾出现 `i Unsafe fix: …` 或 `--write` 输出 `Skipped N suggested fixes.`（附「use the command biome check --write --unsafe」提示）时，一次重试无效即**升级命令**为 `npx biome check --write --unsafe <文件>`，并补跑 `npm run verify` + 读 diff 兜住语义变化；同一手段失败两次仍无新信息必须停手换手段（读完整诊断 / 换命令 / 交人），禁止原样重跑（证据来源：加 `maxTurns` 参数漏 4 处 useCallback 依赖 + 一处 hint effect 多加依赖，反复重跑 `biome check --write` 无效，最终由单条 `--write --unsafe` 收尾，见 09-踩坑记录/2026-10-28-useCallback新增maxTurns触发依赖闭包地狱.md）
20. **React Hook 依赖与 Biome Unsafe Fix 纪律**：修改 `App.tsx` 等 React 组件时，新增的外部变量若被 `useCallback` / `useEffect` 闭包消费，必须立刻**全量扫描**该文件所有相关依赖数组逐个补齐（漏了 → stale closure，运行时往往不报错；多了 → 无谓重算，Biome 报性能警告）。遇到 biome 的 `Unsafe fix` 提示（诊断末尾 `i Unsafe fix: …` 或 `--write` 输出 `Skipped N suggested fixes.`）时，果断执行 `npx biome check --write --unsafe` 一次放行，随后读 diff + 跑 `npm run verify` 兜住语义变化；**严禁同一命令反复重试**（同一手段失败两次即停手换手段，见 09-踩坑记录/2026-10-28-useCallback新增maxTurns触发依赖闭包地狱.md）。**注：本条与第 19 条内容重叠，合并待办见 `docs/03-开发计划与任务/TASKS.md` §待办与已闭环「AGENTS 第 19 / 20 条内容重叠」**
21. **UI 状态与业务逻辑严格分离**：UI 层状态（提示开关、面板折叠、临时输入框等）与业务逻辑层（Agent 循环、文件读写、工具调用等）必须严格分离；业务逻辑**不得直接修改 UI 状态**，必须通过纯数据流转（如 Zustand store 或 React context）单向更新，保证业务逻辑可单测、UI 可替换，且避免「渲染副作用里改状态」导致的循环更新与闭包脏读

22. **开工第一步：查有没有别的 agent 在写这个仓库**：动笔前先查并行写入体——`tasklist | findstr /i codex`（同类外部编码 agent 进程名一并查）；有命中就**停手报告**，不在同一仓库并行改动。**判据是进程层，不是 git 历史**：本仓库多个提交 author 都是 `root`，`git log` / `--author` **区分不出**是谁写的，别把「摸 git 基线」当成发现并行体的手段。**证据来源**：`git show --stat 2c20945 aa97cef` —— `2c20945`（4 文件 +189/-45）与 `aa97cef`（3 文件 +3/-1）内容有交集不重叠，前者系外部编码 agent（Codex）在同一仓库并行写入，后者为补漏提交；两者 author 均为 `root`，`git log` / `--author` 无法区分。此类并行写入的根因与修法都在编排层（一个仓库只有一个写者），不在仓库内自查可解决的范围内；看板记录见 `docs/03-开发计划与任务/TASKS.md` §待办与已闭环「复盘归因错先查编排层有没有并行体」
23. **批量形态改造：范围词 → 范围清单 → 形态归零 → 行为验收**：指令含范围词（「全部 / 所有 / 各类 / 统一 / 描述 / 文案 / 这类」）时**禁止直接开工**——先给出**范围清单**（我理解为 N 处、涉及 M 个文件、含哪些语法形态、**明确不含**什么），等用户确认后再动手（范围词由谁解释，代价就由谁承担）。动手时按**语法形态**枚举而不是「我记得的写法」：如 `index.ts` 的描述类改造要逐个 `search_content` 统计 `program.command(` / `.option(` / `.argument(` / `.addCommand(` 的命中数，改造后**逐类命中归零**才算完；验收必须落到**真实产物**（跑 `--help` 数中文行 / 断言渲染内容），grep 计数只证明「我改过的样子没了」，证明不了「该改的都改了」。**证据来源**：`docs/03-开发计划与任务/TASKS.md` §待办与已闭环「`--help` 选项描述仍硬编码中文」行——39 处描述入 i18n 时漏了 `.argument(` 这一整类，最终由行为层验收（`LUMEN_LOCALE=en --help --all` 实测 65 行 / 0 行中文）暴露并补于 `aa97cef`
24. **断言 CLI 输出：先归一化，再反向自证**：用真实进程（`spawn` / `tsx`）断言命令行输出文本时，必须先**归一化空白与折行**（commander 按终端宽度折行、无 TTY 时按 80 列，长文案必被拆成两行，`toContain(整串)` 是**必然假失败**），且每条正向断言配一条**反向自证**（如「英文 help 全程零中文」必须同时断言「中文 help 确实含中文」），否则断言写反 / 恒真都会假绿。**证据来源**：归一化部分见 `docs/09-踩坑记录/2026-10-28-help不跟随locale.md` §教训 4（commander 折行导致 `toContain(整串)` 假失败）；反向自证部分见 `docs/03-开发计划与任务/TASKS.md` §待办与已闭环「`--help` 选项描述仍硬编码中文」行（护栏用例同时断言「英文零中文」与「中文必须有中文」防假绿）
25. **写编号引用前先回查存在性**：写 `ADR-0xx` / `Dxx` / 任务号等编号引用前，必须回查真实存在（`search_content` DECISIONS.md 与 ARCHITECTURE 决策表取当前最大编号），**禁止照抄别人注释里的编号**——引用一个不存在的编号比不写编号更糟；提交前扫一遍本次新增的全部编号引用与真实最大值核对。**证据来源**：`docs/09-踩坑记录/2026-10-28-help不跟随locale.md` §教训 5（`ADR-049` / `D86-D87` 引用不存在的编号，实际只到 ADR-047 / D82）+ `docs/03-开发计划与任务/TASKS.md` §待办与已闭环「决策条目 ADR-048/049 + D83+ 统一编」行
26. **「做完了」的判据是验收条目逐条取证，不是「文件改过了」**：任务收尾前把任务书的 N 条验收标准**逐条**对真实文件 / 真实产物取证（每条给出 `文件:行号` 或命令输出），空口「已达成」不算。文件存在、字段存在、字典键齐全，都**不等于**验收项达成——`en.ts` 有英文文案 ≠ 英文会被渲染（第 15 条是同一原则的「装好 ≠ 跑通」面，本条是「改了 ≠ 达成验收标准」面）。**证据来源**：`docs/execution-log-20261029-002025.md`（「本轮得到的判断方法」第 1 条：初始假设「T22 可能已完成」被 `package.json` 实际值证伪）+ `docs/03-开发计划与任务/TASKS.md` §待办与已闭环「holidays 全局状态「风险最高」的判断」行（未验证推断被实测校正）

27. **文档编辑后必须读回，并断言改点唯一**：用 `edit_file` / `search_content` 改 `ARCHITECTURE.md` / `DECISIONS.md` / `TASKS.md` / 任务书这类长文档后，必须读回改点，判据三条：① 被改小节标题（或改点锚句）在全文出现次数 **= 1**；② 该段**无重复块、无被截断的尾巴**；③ 行数变化与预期一致（改了什么就加减几行，对不上就查）。`edit_file` 返回的 diff 只能证明「这一次匹配到了」，证明不了「全文只有这一处、且没被写成两遍」。（证据来源：T22 文档阶段 `ARCHITECTURE.md` 出现 11 行重复块，落盘时无人读回）
28. **动手前声明改动的隐性约束清单**：开工前先列出本次改动会触碰的**隐性约束**，至少四类：① **既有测试断言**（我这一改会让哪几条红）；② **i18n 两侧差异**（zh/en 必须不同、en 不得含 CJK、键必须同构）；③ **长度 / 行数预算**（README 首屏 40 行、`--help` 首屏 ≤40 行、提交标题按显示宽度 ≤72）；④ **硬编码绑定**（`package.json` description、段标记字符串等与源码 / 测试硬绑的位置）。**每条约束必须配一个验证动作**（跑哪个测试 / 数哪段行数 / grep 哪个字面量），交付时逐条给结果。判据：交付回复里，N 类约束各有一条验证结论；未声明的约束被用户问出来即视为违反。（证据来源：T22 未主动声明折行断言、zh/en 必须不同、README 钉 40 行、description 硬绑定四项，被用户追问才补）
29. **越界「同类扩清」必须报量级，且按类别分开**：顺手清理同类问题时，必须在**交付回复**里给出三件套——「**发现 N** / **本次清 M** / **剩 K 未动 + 原因**」，且 **N / M / K 一律按类别分开列**（例：「纯 `ADR-049` 引用 3 处 + CHANGELOG 内 `D86-D87` 引用 1 处」，而不是笼统的「清了几处」），避免同一个数在不同口径下对不上（3 处 vs 5 处）。**`commit message` 不算报告**（没人会去翻），只写在 commit 里的量级视为没报。判据：交付回复中存在这三件、且每个数字都带类别限定。（证据来源：T22 清理 `ADR-049` 悬空引用只埋在 commit message，量级与类别未在交付里说明）

30. **提交必须带 agent 标识 trailer**：本仓库约定每条提交信息末尾带一行 `Agent: <id>`，由**版本库内**的 `.githooks/prepare-commit-msg` 自动追加（`core.hooksPath=.githooks`）。**① 我（concertoai-loop）每次提交必须显式声明身份**：Windows cmd 用 `set "CONCERTOAI_AGENT=concertoai-loop"&& git commit …`，POSIX 用 `CONCERTOAI_AGENT=concertoai-loop git commit …`；漏了会落成 `Agent: unmarked`（**提交时会打两行 stderr 告警**，不阻断），而 trailer **无法无痕补写**（补只能 amend 或改写历史）。**② 判读规则**：`Agent: concertoai-loop` = 我；`unmarked` 或**无该行** = 不是我（外部 agent 或手动提交）。**③ 为什么用 `prepare-commit-msg`**：实测 `--no-verify` 会绕过 `pre-commit` 与 `commit-msg`，但**不会**绕过 `prepare-commit-msg`——它是唯一逃不掉的钩子，换成 `commit-msg` 等于把「跑不掉」交给对方自觉。**④ 审计命令**：`git log --format="%h Agent=%(trailers:key=Agent,valueonly) %s"`。**⑤ 局限（必读，别指望它自动跨机器）**：`core.hooksPath` 是**本地配置、不进版本库**——新克隆 / 新机器必须手动执行 `git config core.hooksPath .githooks`，否则 hook **完全不生效且没有任何提示**（提交照常成功，trailer 静默缺失）；新克隆后的检查项见 `docs/03-开发计划与任务/TASKS.md` §待办与已闭环。**⑥ 三个 Windows 坑（均实测，不是推断）**：`chmod +x` 在 Windows 无效（`core.filemode=false`，NTFS 无 POSIX 执行位），但**索引必须记 `100755`**（`git update-index --chmod=+x`）否则 POSIX 上 hook 被静默忽略；hook 首行**必须有 shebang**，缺了报 `cannot spawn … No such file or directory`；`.gitattributes` 必须加 `.githooks/* text eol=lf`，否则 `core.autocrlf=true` 的机器检出成 CRLF（Windows 上侥幸能跑，POSIX 上直接坏）。**⑦ 刻意不采用进程链检测**：实测空 hook 基线 86ms / 只读 env 87ms / 进程链检测 **802ms**（8 倍开销），且本机多个 agent 都跑在 `node.exe` 下、按进程名无法区分「我」与外部 agent——用慢且含糊的自动识别，不如用「我一律显式声明 + 未声明即非我」这条确定规则。

## 命名与包
项目	内容
产品名	ConcertoAI
npm 包	@concertoai/cli（如被占用则备选 concertoai-cli）
主命令	concertoai
短命令	concertoai（不安装 cc，避免与 C 编译器冲突）

## 当前开发阶段
v2.0.0 已完成，全部 v2.0 任务已落地：

✅ BPE 精确 Token 计数（tiktoken / o200k_base，误差 <5%）与缓存命中成本

✅ 智能摘要压缩（超预算优先调模型生成摘要，失败回退旧裁剪策略）

✅ 子代理系统（explore / research，spawn_subagent 工具，独立上下文隔离）

✅ 技能系统（SKILL.md 规范 + code-review / explain / refactor 三个内置技能）

✅ MCP 动态管理（/mcp status / connect / disconnect + 状态条摘要）

✅ 子代理 / 技能 E2E 测试（13 个新用例，总计 337 用例全绿）

v2.1.0 已完成，全部 v2.1 任务已落地：

✅ 子代理 MCP 工具支持（allowedMcpServers 声明加载：explore→filesystem、research→filesystem/github，服务不可用降级）

✅ 技能嵌套与技能市场（@skill / @agent 引用递归展开 + /skill install / search / update）

✅ 轻量级知识图谱（JSONL + 内存邻接表索引 + LRU，按项目隔离；knowledge_* 5 工具 + 双源记忆注入）

✅ Reviewer Agent 代码评审智能体（/review：9 维审查聚合 5 并行子代理 + 自动测试 npm run verify）

✅ 系统性性能优化（O_APPEND / chunk join / 工具定义缓存 / 关系邻接表 / 懒加载 / 流式节流）

✅ v2.1 新增测试（knowledge/reviewer/mcp 等，总计 409 用例 / 42 文件全绿）

v2.2 规划方向：

- Reviewer Agent autoFix 落地（自动修正回滚）

- 多 Agent 协作（Orchestrator 模式）

- 插件市场、DAG 工作流引擎

- TypeScript 7（原生）评估

v3.0.0 已完成（多 Agent 协作 / Orchestrator）：

- ✅ 跨平台命令执行兼容体系（src/tools/shell.ts：getPlatformAdapter 平台检测 + npx→npx.cmd / cat→type / tail→Get-Content / grep→findstr / rm -rf→rmdir / mkdir -p / sed -i 命令映射）
- ✅ Orchestrator 中介模式 + 显式上下文（ADR-015/016 / AgentMessage / AgentDef / AgentRegistry / AgentContext）
- ✅ 4 角色 Agent 团队（Architect/Coder/Reviewer/QA）+ 对抗性闭环（MAX_LOOP_ATTEMPTS=5）
- ✅ 多文件事务回滚（SnapshotManager）+ Agent 市场（/agent）+ 可观测性（TraceStore/AuditLogger）
- ✅ 全量 24 任务落地 · 69 文件 750 用例全绿（v2.2/v3.1 预留功能已并入基线）· v3.0.0 tag 已打（7f477a5）

v3.1.0 已完成（AI 自我修复 + 日常体验，v2.2 版本归位 ADR-028）：

- ✅ Verify 分类器（self-heal）：npm run verify 四段输出统一解析（build/lint/type/test）+ 修复策略执行器（lint:fix 白名单 / 简单 type 错误模型修复审批 / MAX_SELF_HEAL_ATTEMPTS=2 超限转人工）
- ✅ 日常命令齐备：balance / doctor / self-heal / project / account / team / audit export（peak-time / model-switcher 智能成本控制随本版归位）
- ✅ 85 文件 / 937 用例全绿 · v3.1.0 tag 已打

v3.2.0 已完成（跨平台可靠 + 长任务可感知 + 代码可维护）：

- ✅ CI 三平台矩阵（ubuntu/windows/macos）+ spawn 命令适配审计（npx.cmd / type / Get-Content / findstr / rmdir）+ UNC 路径处理（ADR-031）+ EXDEV 跨盘回退 + 跨平台样本库
- ✅ team / /orchestrate 进度推送 + self-heal 阶段进度（SelfHealPhase）+ Agent 市场版本管理（/agent list 对比 / update --all）+ 启动期缓存（ADR-029）
- ✅ self-heal 模块化重构（classifier/repair/snapshot-guard，ADR-030）+ 增量 verify + audit export 损坏行统计 + 执行日志规范（T5.5）
- ✅ 88 文件 / 1014 用例全绿 · v3.2.0 tag 已打

v3.3.0 已完成（消化 v3.2 审查遗留 + 质量收尾）：

- ✅ W1 lint:fix 失败 break 语义显式化 + W2 全局正则常量去 g 标志（消除 lastIndex 陷阱）
- ✅ S1 self-heal 文案 i18n（--lang en 状态条/报告全英文）+ S2 存量解析测试迁移 platform-samples + S3 resolveApiKeyCached 缓存语义注释
- ✅ config.test.ts 环境变量隔离修复（T2.3 实测发现）+ 88 文件 / 1014 用例全绿 · v3.3.0 已发布 npm + tag

v3.4.0 已完成（审查建议闭环 + VS Code 崩溃防护）：

- ✅ S-C1 collectKeys maxDepth + I1 feedback 数据层 i18n（selfHeal.feedback* 键组）+ I2 正则常量去 g/gm 全项目复核 + I3 en 字典 CJK 校验
- ✅ `concertoai doctor --vscode`（src/cli/vscode-health.ts）：进程数 / 崩溃转储 / AI 扩展 / argv.json 四维只读诊断，argv.json 字段名复数 disable-extensions 校验（踩坑记录 §六）
- ✅ 89 文件 / 1044 用例全绿 · v3.4.0 已发布 npm + tag

v4.0 已完成（可扩展的插件化 AI 开发平台，2026-08-14 发布）：

- ✅ 插件市场（M4）：plugin install/search/list/remove/browse/recommend/popular + 六类权限（read/write/network/shell/knowledge/mcp）声明式拦截 + 4 内置示例插件 + 市场 plugins[] 向后兼容（ADR-033/036，D53/D56/D57）
- ✅ 多 Provider 切换（M3）：DeepSeek/OpenAI/Ollama 三实现 + ProviderRegistry/Router + --provider 切换 + provider auth（0600）+ config v3→v4 自动迁移（备份 + _migrated 幂等 + config restore）+ doctor 模型推荐（ADR-034，D54）
- ✅ 工作流引擎（M2）：concertoai workflow——4 内置模板 + 自然语言生成 YAML（失败人工兜底）+ DAG 执行 + 审批节点 + 失败恢复 R/S/F/A + SnapshotManager 整体回滚（ADR-035，D55）
- ✅ /review --fix 一键修复（M1）：A/B 类分批 + 批量审批 fail-closed + snapshot-guard 快照回滚 + 增量 verify + 修复报告（≤2 次交互）
- ✅ team --parallel（M5）：自然触发并行 + 依赖分层 + 冲突组串行化 + 每任务独立事务（D58）
- ✅ LSP 三来源诊断（M6）：concertoai lsp --stdio——biome/tsc/self-heal 诊断 + CodeAction 一键修复（D59；Web UI + VS Code 扩展骨架延后 v4.1）
- ✅ TS7 评估 NO-GO（M7）：锁定 TS 5.9 + v4.1 再评估（ADR-037 / D60）
- ✅ 112 文件 / 1334 用例全绿 · v4.0.0 已发布 npm + tag

v4.1.0 已完成（体验打磨轮——客户边缘路径修复 + 专家建议闭环 + 新手体验，2026-08-15）：

- ✅ 步骤输出截断 + 智能错误摘要（T1.1）：truncateMiddle / extractErrorSummary（tsc/biome/npm/vitest 四类关键行）+ workflow 步骤输出 4000 字符截断 + 失败先摘要后详情
- ✅ F 选项等待态闭环 + 60s 超时（T1.2）：promptLine 超时扩展 + promptRecoveryFix 等待循环（Enter 重试 / a 放弃 / 超时自动放弃 / 非 TTY fail-closed）
- ✅ 进度刷屏根因修复（T1.3）：executor maxRetries: 0（禁止内部静默重试）+ retry 字段语义重定义（恢复后重试上限，缺省不限向后兼容）
- ✅ preflight 环境预检 + 轻量自动初始化（T1.4）：脚本/依赖/配置三维预检 + Y/N 自动装 biome/tsc + 写 biome.json + 注入 scripts（test 仅提示，非 TTY fail-closed）
- ✅ 错误「下一步」指引 + CLI 风格统一（T2.1）：runFailed/fatalNextStep/workflowNotFound 等统一「💡 下一步：…」
- ✅ --help 分组 + 示例 + 新手三步 + 首次运行欢迎引导（T2.2）
- ✅ AGENTS.md 边缘路径强制覆盖规范（T3.1）+ 踩坑记录落盘
- ✅ 117 文件 / 1390 用例全绿 · v4.1.0 已发布 npm + tag

v4.2 规划方向：

- LSP Web UI + VS Code 扩展骨架
- 插件进程级隔离强化（插件可运行在独立子进程）
- TS7 再评估（三触发条件：正式版+工具链适配 / 性能瓶颈 / Node ≥22.6 用户占比）
- 动态 --version 环境探测 / 更多工具链错误识别（eslint/next/webpack）/ onboarding 交互向导 / Ink TUI 大改版
- **P1：workflow parser 支持 YAML 内联列表**（`depends: [lint]` / `files: [a, b]`）+ loadWorkflow 区分「文件不存在 vs 解析失败」并展示真实报错（v4.1 已知问题 #3，踩坑记录 2026-08-15-YAML内联列表不支持导致工作流不存在.md）

## 发布门检查清单
2.0.0 发布前已全部通过：

☑ 模型 ID 与定价经官方文档核实
☑ npm run verify 全绿（337 用例 / 37 测试文件）
☑ npm audit 无 high/critical
☑ 真实 API 冒烟通过
☑ Windows 冒烟通过（CRLF / 中文 / TTY）
☑ npm pack 预演通过
☑ 文档齐备（README / 用户手册 / 架构文档 / CHANGELOG）
☑ v2.0.0 tag 已打

v3.3.0 发布门检查（当前，2026-08-11）：

☑ npm run verify 全绿（88 文件 / 1014 用例，v3.3 基线）
☑ 版本号一致性核对（package.json / package-lock.json / src/version.ts / tests/smoke.test.ts = 3.3.0）
☑ W1/W2/S1/S2/S3 五项审查遗留全部落地；i18n en 键一致性断言覆盖 selfHeal 分组
☑ 手工测试报告 07.6 落盘；config.test.ts 环境变量隔离修复
☑ npm audit 0 漏洞；npm pack 预演通过（76 文件 / 392.1 kB）
☑ npm whoami 令牌有效（mmclqx）→ npm publish 成功（latest=3.3.0）
☑ v3.3.0 tag 已打

v3.4.0 发布门检查（当前，2026-08-12）：

☑ npm run verify 全绿（89 文件 / 1044 用例，v3.4 基线）
☑ 版本号一致性核对（package.json / package-lock.json / src/version.ts / tests/smoke.test.ts = 4.0.1；段标记样本 @concertoai/cli@4.0.1 同步）
☑ S-C1/I1/I2/I3 四项审查闭环 + doctor --vscode 四维诊断全部落地；en.test.ts maxDepth + CJK 断言覆盖
☑ 手工测试报告 07.7 + 自我审查报告落盘；执行日志补全
☑ npm audit 0 漏洞；npm whoami 令牌有效（mmclqx）→ npm publish 成功（latest=3.4.0）
☑ v3.4.0 tag 已打

发布门通用检查项（每次发布前必过，不论版本）：

☑ 自我审查报告已生成落盘：`docs/08-审查记录/REVIEW-{版本号}-self-review-{日期}.md`（独立完成，不参考其他审查者；对照 v3.2 方法论：i18n 文案层沿数据流追踪 / 全项目同类模式扫描 / 追问控制流语义 / 区分当前正确 vs 模式脆弱；v3.3 案例见 09-踩坑记录/2026-08-11-自我审查与C审查视角差距.md 与 docs/08-审查记录/v3.3-self-review-2026-08-11.md；v3.4 案例见 docs/08-审查记录/REVIEW-v3.4-self-review-2026-08-12.md）
☑ npm 令牌有效性验证：`npm whoami` 返回用户名（401/403 说明令牌过期，先 `npm login` 重新生成；教训见 09-踩坑记录/2026-08-11-npm-token-expired.md）

## 重要决策（已确定）
决策	说明
会话存储	JSONL 格式，存储在 ~/.concertoai/sessions/
审批流	fail-closed（默认拒绝），编辑与 Shell 一律审批
上下文管理	v2.0 采用智能摘要压缩（优先摘要，失败回退裁剪）
模型默认	deepseek-v4-flash，困难任务自动升级到 pro
配置系统	~/.concertoai/config.json，CLI > 环境变量 > 配置文件 > 默认值

## 跨平台兼容性规范

### 命令执行规则
1. 所有 `run_command` 执行的命令，在执行前必须检测操作系统
2. 手工测试时：测试目录必须与项目目录分离；进入测试目录后立即确认当前路径（Windows 跨盘符必须 `cd /d` 或 `pushd` + `cd` 验证；教训见 09-踩坑记录/2026-08-16-手工测试cd跨盘符未生效污染项目根目录.md）
3. 优先使用跨平台命令（如 `npm`、`node`），避免使用系统特有命令
4. 必须使用系统特有命令时，用 `process.platform` 判断并分别实现
5. Windows 下 spawn `.cmd`/`.bat` 文件必须 `shell: true`（或显式 `cmd.exe /c`），禁止 `shell: false` 直接执行（会 ENOENT；教训见 09-踩坑记录/2026-08-11-Windows下spawn执行npm.cmd报ENOENT.md）

### 路径处理规则
1. 使用 `path.join()` 和 `path.resolve()`，不使用硬编码分隔符
2. 用户输入路径时，自动转换 `\` 为 `/`（或反之）

### 换行符规则
1. 文件读取时使用 `\r?\n` 正则匹配
2. 文件写入时保持原文件的换行符风格（或统一为 LF，由 `.gitattributes` 控制）

### 验证方式
- 每个里程碑在 Windows 和 Linux（或 WSL）上分别验证
- CI 矩阵包含 `windows-latest` 和 `ubuntu-latest`

### 命令兼容层（src/tools/shell.ts）
`getPlatformAdapter()` 检测操作系统并转换命令，命令在 `run_command` 执行前自动适配：

| 通用命令 | Windows | macOS / Linux |
|---------|---------|---------------|
| `npx` | `npx.cmd` | `npx` |
| `tail -N` | `powershell Get-Content -Tail N` | `tail -N` |
| `head -N` | `powershell Get-Content -Head N` | `head -N` |
| `grep PATTERN` | `findstr PATTERN` | `grep PATTERN` |
| `cat FILE` | `type FILE` | `cat FILE` |
| `rm -rf DIR` | `rmdir /s /q DIR` | `rm -rf DIR` |
| `mkdir -p DIR` | `mkdir DIR 2>nul` | `mkdir -p DIR` |
| `sed -i`（macOS） | — | `sed -i ''`（BSD 需备份后缀） |

## TypeScript 类型安全规范

### 函数参数空值检查
- 所有可能为 `undefined` 的参数，在访问其属性前必须进行空值检查
- 模式：
  - `if (!param) return;` 或 `if (!param) throw new Error('...')`
  - 使用可选链：`param?.property ?? defaultValue`

### 数组/对象解构安全
- 从可能为 `undefined` 的对象中解构属性时，使用可选链和默认值
- 模式：`const { key } = obj ?? {}` 或 `obj?.key ?? ''`

### 数组访问安全
- `noUncheckedIndexedAccess` 开启时，数组下标访问返回 `T | undefined`，使用前必须空值检查
- 模式：`const item = arr[i]; if (item === undefined) break;`（或 `continue;`）
- 禁止用非空断言 `!` 绕过检查；循环内越界时 `break`（游标）或 `continue`（跳过）

### 模块与全局变量
- 项目为 ESM（`"type": "module"`），禁止裸引用 CJS 全局 `__dirname` / `__filename`（运行时 `ReferenceError`）；相对路径定位用 `import.meta.url` 或由调用方传入 cwd（教训见 09-踩坑记录/2026-08-11-ESM模块误用__dirname导致team命令崩溃.md）

### 检查标准
- 新增代码必须通过 `npm run typecheck`（零类型错误）
- 禁止使用 `any` 类型绕过检查
- 禁止用 `_` 前缀参数忽略 Agent.execute 的 context：要么使用（传递给依赖），要么从签名删除（历史教训：TeamReviewerAgent 忽略 _context 导致显式上下文丢失）

## 代码格式规范

### Biome 格式检查
- ConcertoAI 使用 Biome 进行代码检查和格式化
- 常见可自动修复的问题：
  - `organizeImports`：import 语句排序问题 → 执行 `npx.cmd biome check --write <文件路径>`
  - `format`：缩进/空格/换行问题 → 执行 `npx.cmd biome format --write <文件路径>`
  - `lint/style`：代码风格问题 → 执行 `npx.cmd biome check --write <文件路径>`

### 处理策略
- 当 `npm run verify` 因 `FIXABLE` 错误失败时，优先执行 `npm run lint:fix` 自动修复
- 如果 `lint:fix` 无法修复，再分析具体错误内容
- **`FIXABLE` ≠ `--write` 会修**：`lint:fix` / `biome check --write` 只应用**安全修复**。若命令输出 `Skipped N suggested fixes.`，或诊断末尾有 `i Unsafe fix: …`（如 `useExhaustiveDependencies` 增删依赖数组，两类都属 unsafe），改用 `npx biome check --write --unsafe <文件路径>` 一次放行；随后必须读 diff + 跑 `npm run verify` 确认语义没被改坏。**同一条命令重试两次仍失败即停手换手段，禁止原样重跑**（教训见 09-踩坑记录/2026-10-28-useCallback新增maxTurns触发依赖闭包地狱.md）

## 开发原则
单会话串行：一次只做一个任务，不并行

检查点提交：每完成一个里程碑做一次 Git 提交

测试先行：新增功能必须包含测试

文档同步：代码修改后同步更新相关文档（ARCHITECTURE.md 目录树 / 决策表 / JSDoc 中的数字与常量）

踩坑落盘：修复 Bug 后立即写入 docs/09-踩坑记录/（问题/根因/方案/教训，格式见该目录 README）

执行日志：每次任务开始立即创建 docs/execution-log-YYYYMMDD-HHMMSS.md，随任务推进逐条记录关键步骤（读文件/搜索/生成方案/编辑/测试）+ 时间戳（v3.2 T5.5）

测试问题先落盘：用户（或测试）发现的问题，必须先写入执行日志/问题清单（现象 + 分析 + 修复计划）落盘后再动手解决——防止对话中断后问题被忽略（教训见 09-踩坑记录/2026-08-15-Ctrl+C误判崩溃与测试问题未落盘.md）

计划定稿先出任务书：新版本计划终稿落盘后，必须先同步生成 docs/03-开发计划与任务/vX.Y-dev-tasks.md（与终稿同批提交），再开工首个里程碑（v3.4 起固化流程）

发布前测试报告：版本发布前生成 docs/07.{版本号}-手工测试报告-v{版本号}.md 并落盘

提交前自查：提交前按「工程规范 → 提交前自查」核对文档 vs 代码一致性，全绿后再提交

转换函数边界：任何 A → B 转换函数必须显式处理空集合边界语义（「空」可能表示「无数据」或「解析失败」，失败场景兜底不返回误导性空数组；教训见 09-踩坑记录/2026-08-11-QA失败无失败项导致Coder误判实现模式.md）

安全第一：所有危险操作必须走审批流

## 参考文档
- 产品定位与范围

- 架构设计

- 开发计划与任务

- 发布流程

- 用户指南

- 会议与决策记录

- 测试报告

- 踩坑记录