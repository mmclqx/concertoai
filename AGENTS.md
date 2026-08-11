# AGENTS.md - ConcertoAI 项目开发规范

> 最后更新：2026-08-11
> 版本：v3.1.0

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

v3.0.0 发布门检查（当前）：

☑ npm run verify 全绿（750 用例 / 69 测试文件，v3.0 基线校准 T0.1）
☑ 版本号一致性核对（package.json / src/version.ts / tests/smoke.test.ts = 3.0.0）
☑ 踩坑记录已归档（docs/09-踩坑记录/：I1 版本号不同步、I2 Reviewer 上下文丢失）
☑ v3.0.0 tag 已打（7f477a5）

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
2. 优先使用跨平台命令（如 `npm`、`node`），避免使用系统特有命令
3. 必须使用系统特有命令时，用 `process.platform` 判断并分别实现
4. Windows 下 spawn `.cmd`/`.bat` 文件必须 `shell: true`（或显式 `cmd.exe /c`），禁止 `shell: false` 直接执行（会 ENOENT；教训见 09-踩坑记录/2026-08-11-Windows下spawn执行npm.cmd报ENOENT.md）

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

## 开发原则
单会话串行：一次只做一个任务，不并行

检查点提交：每完成一个里程碑做一次 Git 提交

测试先行：新增功能必须包含测试

文档同步：代码修改后同步更新相关文档（ARCHITECTURE.md 目录树 / 决策表 / JSDoc 中的数字与常量）

踩坑落盘：修复 Bug 后立即写入 docs/09-踩坑记录/（问题/根因/方案/教训，格式见该目录 README）

执行日志：每次任务开始立即创建 docs/execution-log-YYYYMMDD-HHMMSS.md，随任务推进逐条记录关键步骤（读文件/搜索/生成方案/编辑/测试）+ 时间戳（v3.2 T5.5）

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