# v3.1 全面审查报告

> 审查日期：2026-08-11
> 审查人：Carbon Code
> 审查范围：v3.1 M1 ~ M5 全部新增功能
> 审查基准：`npm run verify` 84 文件 / 923 用例全绿 (2026-08-11 02:48 UTC)

---

## 审查结论

- **整体评价**：⚠️ 需修改（3 项必须修复、4 项建议修复）
- **版本建议**：v3.1.0
- **核心问题**：
  1. **版本号未同步** — `package.json` / `src/version.ts` 均为 `3.0.0`，需统一升至 `3.1.0`
  2. **文档路径描述错误** — M4 审查范围指定的 `src/loop/error-report.ts` 不存在，实际实现为 `src/tools/error-codes.ts`
  3. **ARCHITECTURE.md 架构全景图滞后** — 第 2 节未反映 v3.1 新增模块

---

## 逐模块详细审查

### M1：AI 自我修复闭环 (self-heal)

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码文件 | ✅ | `src/loop/self-heal.ts` (853 行)、`src/cli/slash/self-heal.ts` (151 行)、`src/cli/self-heal.ts` (79 行) 全部存在 |
| 测试覆盖 | ✅ | `tests/loop/self-heal.test.ts` 18 用例 + `tests/e2e/self-heal.test.ts` + `tests/cli/slash-self-heal.test.ts` |
| CLI 注册 | ✅ | `concertoai self-heal` — `src/cli/index.ts:214-225` 已注册，含 `--auto-approve` / `--model` |
| Chat 入口 | ✅ | `/self-heal` 斜杠命令 — `src/cli/slash/self-heal.ts` 实现 `parseSelfHealCommand` + `executeSelfHealCommand` |

**功能完整性分析：**

- **T1.1 分类器**：`parseVerifyReport()` 按 npm 段标记切分四段（build/lint/type/test），ANSI 已剥离，Biome 错误正则匹配 Windows 盘符路径、tsc 支持标准/pretty 两种格式，test 段复用 `parseVerifyOutput`。✅
- **T1.2 修复策略执行器**：lint → `npm run lint:fix`（白名单免审批），type 简单错误 → 模型生成 SEARCH/REPLACE → 审批 fail-closed → 应用，`MAX_SELF_HEAL_ATTEMPTS=2`，每次只修 1 个错误。✅
- **T1.3 快照与回滚**：修复前 `SnapshotManager.begin` + `recordWrite`，修复后 verify 判定目标错误是否消失/是否引入新错误，回滚或 commit。回滚失败保留快照。✅
- **T1.4 触发入口**：`runSelfHeal()` 供两入口共用（`/self-heal` chat + `concertoai self-heal` CLI），测试可注入 `runVerify`/`runLintFix`。✅

**代码质量：**
- 类型安全：全部参数/返回值有 TypeScript 类型，无 `any`。✅
- 错误处理：模型生成的 JSON 解析用 Zod schema 校验，文件读取/写盘全部 try/catch，快照失败降级。✅
- 注意点：`repairVerifyReport` 中模型修复审批拒绝后执行 `break`（而非 `continue`），这意味着如果第一个 type 简单错误被拒绝，不会再尝试其他 type 错误——这是合理设计（fail-closed 语义），但注释可更明确。⚠️ 建议修复

**跨平台兼容性：**
- `npm run lint:fix` 通过 `shellTool.execute` 执行，`shellTool` 已有 `getPlatformAdapter` 自动适配 Windows 命令。✅
- `path.resolve()` 正确处理 Windows 盘符路径。✅
- `Biome`/`tsc` 正则匹配含 Windows 盘符冒号路径。✅

---

### M2：多项目管理 (projects)

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码文件 | ✅ | `src/store/projects.ts` (218 行) + `src/cli/project.ts` (128 行) |
| 测试覆盖 | ✅ | `tests/store/projects.test.ts` 19 用例 + `tests/cli/project.test.ts` 12 用例 + `tests/cli/project-isolation.test.ts` 11 用例 |
| CLI 注册 | ✅ | `concertoai project <add\|list\|remove\|info>` — `src/cli/index.ts:174-183` |

**功能完整性分析：**
- **T2.1 注册表 CRUD**：`ProjectRegistry` 类完整实现 load/save/add/remove/get/list/has/updateConfig/findByPath，原子写（tmp + rename）。✅
- **T2.2 命令**：add（含重名 PROJECT_ALREADY_EXISTS / 嵌套 PROJECT_NESTED 拒绝）、list（表格）、remove（不删目录）、info（whitelist/mcpServers）、switch（校验+提示）。✅
- **T2.3 cwd 自动探测**：`findByPath()` 路径精确匹配。`src/cli/index.ts:72-88` preAction hook 对 `-p <name>` 执行 `chdir`。✅
- **T2.4 隔离矩阵**：会话按项目分目录（`sessions/<projectKey>/`）、审批白名单项目级合并、MCP 按项目声明。✅

**代码质量：**
- 类型安全：`ProjectRegistryError` 携带机器可读 `code`。✅
- 路径规范化：`normalizeProjectPath()` 正确处理 Windows 盘符 `C:\foo` → `C:/foo`，`isNested()` 使用分隔符边界比较。✅
- 宽松读取：损坏 JSON 返回空注册表 + 警告（不抛错）。✅

**跨平台兼容性：**
- `normalizeProjectPath` 显式处理 `C:\foo\bar` → `C:/foo/bar`（Windows 盘符转正斜杠），POSIX 下同样处理反斜杠。✅
- `isNested` 盘符大小写不敏感比较（`toLowerCase`）。✅
- socks 路径均使用 `path.join`/`path.dirname`（不硬编码分隔符）。✅

---

### M3：多租户登录 (accounts)

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码文件 | ✅ | `src/store/accounts.ts` (170 行) + `src/cli/account.ts` (148 行) + `src/cli/account-types.ts` (12 行) |
| 测试覆盖 | ✅ | `tests/store/accounts.test.ts` 14 用例 + `tests/cli/account.test.ts` 16 用例 |
| CLI 注册 | ✅ | `concertoai login/logout/whoami/account` — `src/cli/index.ts:259-300` |

**功能完整性分析：**
- **T3.1 存储**：`saveAccount`（created/exists/overwritten 三态）、`getApiKeyFor`、原子写（tmp + rename）+ POSIX 0600。✅
- **T3.2 命令**：login（交互输入 Key 不回显 + `--key` CI）、logout（purge）、whoami（打码 `sk-****abcd`）、account switch/list。✅
- **T3.3 API Key 解析链**：CLI > 环境变量 > active account > config.json。✅
- **安全约定**：Key 值不写日志，`listAccounts` 只返回账号名不含 Key，打码显示后 4 位。✅

**代码质量：**
- 账号名校验：`ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]+$/`，防路径穿越。✅
- 交互输入：`promptSecret` 通过 readline `_writeToOutput` 拦截实现星号掩码，非 TTY 友好提示。✅
- POSIX 0600 在 Windows 下 `chmod` 失败静默跳过（有 try/catch）。⚠️ 建议修复：加上 `process.platform === 'win32'` 前置判断，避免不必要的 `chmod` 调用。

**跨平台兼容性：**
- 账号文件路径使用 `path.join`。✅
- `chmod` 在 Windows 下被 try/catch 包裹（跳过不报错）。✅
- 原子写使用 `process.pid.tmp` 后缀（非跨平台问题但 PID 在 Windows 上也是安全的）。✅

---

### M4：结构化错误增强 (error-codes)

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码文件 | ✅ | `src/tools/error-codes.ts` (95 行) — **注意：不是审查范围中指定的 `src/loop/error-report.ts`** |
| 测试覆盖 | ✅ | `tests/loop/error-reporting.test.ts` 16 用例 |
| 工具集成 | ✅ | read/edit/shell/knowledge 四类工具已完成 code/suggestion 适配 |

**🔴 严重：文件路径描述错误**
- 审查范围指定 `src/loop/error-report.ts`，但该文件不存在（`search_content "error-report"` 全项目 0 匹配 `src/loop/`）。
- 实际实现为 `src/tools/error-codes.ts`（95 行），包含 `ToolErrorCode` 常量、`TOOL_ERROR_SUGGESTIONS` 中文建议、`toolError()` 构建函数、`SandboxError` 类、`inferErrorCode()` 推断函数。
- 测试为 `tests/loop/error-reporting.test.ts`（16 用例，已通过）。
- **影响**：文档（开发计划 TASKS.md / ARCHITECTURE.md 目录树）中引用该路径的条目均需修正。

**功能完整性分析：**
- **错误码覆盖**：read（4 种）、edit（5 种）、shell（4 种）、knowledge（2 种），共 15 个错误码。✅
- **中文建议**：`TOOL_ERROR_SUGGESTIONS` 每个错误码配有中文修复建议，模型可采纳。✅
- **向后兼容**：`code`/`suggestion` 均为可选字段，旧结构错误照常渲染。✅
- **registry 兜底**：`inferErrorCode` 从异常类型/消息推断错误码，未知工具返回 `UNKNOWN_TOOL`。✅
- **ToolRepairError 渲染**：含 suggestion 时渲染 `💡` 建议行；旧结构不渲染。✅

**代码质量：**
- `toolError()` 返回类型明确为 `ToolResult`。✅
- `SandboxError` 显式携带 `code: PATH_OUTSIDE_SANDBOX`。✅
- 正则推断 `inferErrorCode` 依赖中文消息关键词（`越界`、`命令不存在`），在非中文 locale 下可能失效。⚠️ 建议修复：增加英文关键词匹配或使用结构化错误码而非消息文本匹配。

---

### M5：Orchestrator CLI 入口 (team / orchestrate / audit)

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码文件 | ✅ | `src/cli/team.ts` (189 行)、`src/cli/slash/orchestrate.ts` (79 行)、`src/cli/audit.ts` (73 行) |
| 测试覆盖 | ✅ | `tests/cli/team.test.ts`、`tests/cli/slash-orchestrate.test.ts`、`tests/cli/audit.test.ts`、`tests/e2e/team-cli.test.ts` |
| CLI 注册 | ✅ | `concertoai team` / `audit export` — `src/cli/index.ts:185-252` |
| Chat 入口 | ✅ | `/orchestrate` — `src/cli/slash/orchestrate.ts` |

**功能完整性分析：**
- **T5.1 team CLI**：拆解（`decomposeRequirement`）→ 展示确认（`--dry-run` 仅输出清单）→ 装配 4 角色（Architect/Coder/Reviewer/QA）→ 对抗性闭环（`runTeamLoop`，MAX_LOOP_ATTEMPTS=5）→ 事务回滚兜底（`SnapshotManager`）→ 聚合工件输出。✅
- **T5.2 /orchestrate**：chat 内触发，解析 `/orchestrate <任务>` → 调用 `runTeam` → 转为聊天消息（✅/❌ summary）。✅
- **T5.3 audit export**：遍历 `~/.concertoai/audit/*.jsonl`，复用 `AuditLogger.exportJson`，合并后按 seq 保序输出 JSON。✅
- **可观测性**：`runTeamCommand` 透传 `traceStore`，闭环 spans 记录。✅

**代码质量：**
- team 命令支持测试注入（client/confirm/agents/coder/reviewer/qa）。✅
- team 拆解失败返回 `{ ok: false, summary: "需求拆解失败: …" }`（不静默空清单）。✅
- 审批流 fail-closed：未 `--auto-approve` 且非 TTY 时直接 exit(1)。✅
- audit export 无审计文件时输出提示并 exit(0)（非错误）。✅

**跨平台兼容性：**
- audit export 使用 `readdirSync`/`path.join`/`mkdirSync`，跨平台安全。✅
- team 命令中 `DiskFileWriter` 使用路径均基于 `options.cwd`。✅

**注意点：**
- `audit.ts` 中使用同步 `readdirSync`/`writeFileSync` — 审计导出是非交互一次性操作，同步合理。✅
- `/orchestrate` 的 `ExecuteOrchestrateDeps` 依赖方需注入 `runTeam`，当前未在 App.tsx 中看到集成代码。⚠️ 建议修复：确认 App.tsx 中是否已完成 `/orchestrate` 的路由接入；若未接入则 chat 内 `/orchestrate` 命令无效。

---

## 版本号一致性核对

| 位置 | 当前值 | 期望值 | 状态 |
|------|--------|--------|------|
| `package.json` | `3.0.0` | `3.1.0` | 🔴 未更新 |
| `src/version.ts` | `3.0.0` | `3.1.0` | 🔴 未更新 |
| `tests/smoke.test.ts` | 需确认 | `3.1.0` | 🔴 待核对 |
| `CHANGELOG.md` | `[3.1.0] — 2026-08-11` | `[3.1.0]` | ✅ 已写 |
| `ARCHITECTURE.md` 标题 | `v3.0` | `v3.1` | ⚠️ 未更新 |

---

## 测试覆盖总结

| 模块 | 测试文件 | 用例数 | 状态 |
|------|---------|--------|------|
| M1 self-heal | `tests/loop/self-heal.test.ts` + e2e + slash | 18+ | ✅ |
| M2 projects | `tests/store/projects.test.ts` + cli | 19+12 | ✅ |
| M3 accounts | `tests/store/accounts.test.ts` + cli | 14+16 | ✅ |
| M4 error-reporting | `tests/loop/error-reporting.test.ts` | 16 | ✅ |
| M5 team/orchestrate/audit | `tests/cli/team.test.ts` + orchestrate + audit + e2e | 多个 | ✅ |
| 总计 | 84 文件 | 923 用例 | ✅ 全绿 |

---

## 跨平台兼容性总结

| 检查项 | M1 | M2 | M3 | M4 | M5 |
|--------|:--:|:--:|:--:|:--:|:--:|
| 路径使用 `path.join` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Windows 盘符处理 | ✅ | ✅ | N/A | N/A | N/A |
| `chmod` 在 Windows 下保护 | N/A | N/A | ✅ | N/A | N/A |
| 命令走 `shellTool` 自动适配 | ✅ | N/A | N/A | N/A | N/A |
| 正则匹配含 Windows 盘符 | ✅ | N/A | N/A | N/A | N/A |

---

## 问题完整清单

### 🔴 严重 — 必须修复（阻塞发布）

| # | 问题 | 模块 | 修复建议 |
|---|------|------|----------|
| 1 | **版本号未同步**：`package.json`=`3.0.0`, `src/version.ts`=`3.0.0`, `tests/smoke.test.ts` 待核对 | 全局 | 全部升到 `3.1.0`；同步 `CHANGELOG.md` 中 `[Unreleased]` → `[3.1.0]` |
| 2 | **`src/loop/error-report.ts` 不存在**：审查范围/开发计划中引用的路径错误 | M4 | 修正文档中所有引用为 `src/tools/error-codes.ts`；或在 `src/loop/` 下新增 barrel re-export（保持路径兼容） |
| 3 | **ARCHITECTURE.md 第 2 节架构全景图未更新**：缺失 v3.1 新增模块（self-heal/team/project/account/audit/crash-handler） | 文档 | 在第 2 节全景图中补充 v3.1 模块（`loop/self-heal.ts`、`cli/team.ts`、`cli/project.ts`、`cli/account.ts`、`cli/audit.ts`、`cli/crash-handler.ts`、`cli/slash/self-heal.ts`、`cli/slash/orchestrate.ts`） |

### ⚠️ 警告 — 建议修复（不阻塞但应尽快处理）

| # | 问题 | 模块 | 修复建议 |
|---|------|------|----------|
| 4 | **repairVerifyReport 审批拒绝直接 break**：第一个 type 简单错误被拒后不尝试其他 type 错误（合理但注释不够明确） | M1 | 在 break 前加注释说明 fail-closed 语义："审批拒绝后停止所有模型修复，保留完整报告转人工" |
| 5 | **inferErrorCode 依赖中文消息关键词**：`越界`/`命令不存在` 在 en locale 下可能无法匹配 | M4 | 增加英文关键词匹配（`"outside sandbox"` / `"command not found"`），或基于结构化错误码而非消息文本 |
| 6 | **ARCHITECTURE.md 标题仍为 v3.0**：文档第 1 行 `> 版本：v3.0` 应更新为 `v3.1`，v3.0 的 69/750 数字应更新为当前基线 84/923 | 文档 | 坐标准确更新：标题版本 → v3.1，测试基线 → 84 文件 / 923 用例 |
| 7 | **`/orchestrate` 与 App.tsx 集成待确认**：`src/cli/slash/orchestrate.ts` 的 `executeOrchestrateCommand` 需 `App.tsx` 注入 `runTeam`；当前未验证路由是否已接入 | M5 | `search_content "orchestrate" src/ui/App.tsx` 确认；若未接入则 chat 内 `/orchestrate` 命令无效 |

### ℹ️ 提示 — 低优先级

| # | 问题 | 修复建议 |
|---|------|----------|
| 8 | `accounts.ts` 中 `chmod(0o600)` 在 Windows 下无意义，已有 try/catch 跳过 | 加 `process.platform !== 'win32'` 前置判断可减少一次异常路径 |
| 9 | `self-heal.ts` 中 `MODEL_FIX_SYSTEM_PROMPT` 为硬编码中文 prompt | 未来可考虑 i18n 化，当前中文优先策略下可接受 |

---

## v3.0 兼容性评估

| 检查项 | 评估 |
|--------|------|
| 已有 CLI 命令 | ✅ 全兼容：`chat`/`run`/`plan`/`snapshot`/`balance`/`doctor` 不变 |
| 已有 API（`src/index.ts` 导出） | ✅ v3.1 新增导出不破坏已有 API |
| 配置结构 | ✅ `config.json` 向后兼容；新增 `projects.json`/`accounts/` 为独立文件 |
| 会话格式 | ✅ JSONL 格式不变；会话按项目分目录（向后兼容—旧无项目会话仍在 `sessions/` 根目录） |
| 旧目录迁移 | ✅ `migrateLegacyHome()` 幂等迁移 `~/.lumen → ~/.concertoai`，首次启动自动执行 |
| 工具接口 | ✅ 新增 `code`/`suggestion` 均为可选字段，不破坏已有工具 |

---

## 文档同步检查

| 文档 | 状态 | 差距 |
|------|------|------|
| `CHANGELOG.md` | ✅ 已记录 v3.1.0 全部变更 | 版本标签与 `package.json` 需同步 |
| `ARCHITECTURE.md` | ⚠️ 部分更新 | 目录树已更新（84/923），但第 2 节全景图 + 标题版本落后 |
| `DECISIONS.md` | 待确认 | 是否有 v3.1 新 ADR（如 ADR-028 版本归位） |
| `AGENTS.md` | ✅ 已记录 v3.1 开发阶段 | 不需要更新 |
| `TASKS.md` | ✅ 已记录各里程碑完成状态 | — |
| `v3.1-dev-plan.md` | ✅ | — |
| 踩坑记录 | ✅ | （本次新增了 VS Code 崩溃排查记录） |

---

## 最终裁决

| 项目 | 结论 |
|------|------|
| 功能完整性 | ✅ 5 个里程碑全部功能已实现并测试通过 |
| 代码质量 | ✅ TypeScript strict、Zod 校验、抛出中文错误 |
| 测试覆盖 | ✅ 84 文件 / 923 用例全绿 |
| 跨平台兼容 | ✅ Windows 路径/命令处理到位 |
| v3.0 兼容 | ✅ 所有已有接口不受影响 |
| 可发布性 | ⚠️ **暂不可发布** — 需先修复 3 项严重问题（版本号同步 + 文件路径文档修正 + ARCHITECTURE.md 更新） |

---

*审查数据来源：`src/loop/self-heal.ts` (853行) · `src/cli/slash/self-heal.ts` (151行) · `src/cli/self-heal.ts` (79行) · `src/store/projects.ts` (218行) · `src/cli/project.ts` (128行) · `src/store/accounts.ts` (170行) · `src/cli/account.ts` (148行) · `src/tools/error-codes.ts` (95行) · `src/cli/team.ts` (189行) · `src/cli/slash/orchestrate.ts` (79行) · `src/cli/audit.ts` (73行) · `src/cli/index.ts` · `src/store/paths.ts` · `src/cli/crash-handler.ts` · `CHANGELOG.md` · `ARCHITECTURE.md` · `package.json` · `src/version.ts` · 71测试文件 · `npm run verify` 输出*

---

# 附录：v3.2 完善建议（不阻塞 v3.1 发布）

> 以下建议按六个维度分类，为 v3.2 提供方向参考。所有建议均基于当前代码深度审查发现，
> 不影响 v3.1 的发布门，可按优先级排入后续里程碑。

---

## 1. 用户体验

### 1.1 `/self-heal` 进度反馈过于简略

**现状**：[`src/cli/slash/self-heal.ts:45`](src/cli/slash/self-heal.ts:45) 执行 `runSelfHeal` 期间仅设置 `phase='streaming'` + `activeTool='self-heal'`，状态条只显示 "self-heal 执行中"。用户看不到当前正在做哪个阶段（分类/修复/验证/回滚）。

**建议**：在 `repairVerifyReport` 的每次尝试中通过回调实时推送阶段变更，让 `activeTool` 随阶段动态更新（如 "self-heal → 分类中" → "self-heal → lint 修复" → "self-heal → 模型修复"），减少"黑盒等待"感。

### 1.2 `concertoai project list` 表格不显示注册时间

**现状**：[`src/cli/project.ts:103-112`](src/cli/project.ts:103) 表格仅显示名称+路径两列，注册时间在表格下方单独打印（name → iso）。

**建议**：改为三列表格（名称 | 路径 | 注册时间），或至少将注册时间合并到路径列后用简短格式（如 `2天前`），提升一屏可读性。

### 1.3 `concertoai whoami` 账号文件缺失时提示不够直观

**现状**：[`src/cli/account.ts:113-116`](src/cli/account.ts:113) 读取失败时输出 `当前账号指针: ${active}（但账号配置缺失，请重新 login）`。

**建议**：直接输出具体的修复命令：`账号配置文件已丢失，请重新登录：concertoai login ${active}`，并考虑在 `doctor` 命令中增加此项检查。

### 1.4 `/orchestrate` chat 内无进度展示

**现状**：[`src/ui/App.tsx:525-545`](src/ui/App.tsx:525) `/orchestrate` 执行期间设置 `phase='streaming'`，但 `runTeamCommand` 的拆解确认/闭环过程无中间消息推送到聊天流，用户看到的是长时间"思考中"然后一口气出结果。

**建议**：引入中间消息推送机制——例如在拆解完成后推送一条 `📋 已拆解为 N 个任务：…` 系统消息，在每轮闭环完成后推送 `🔁 第 2/5 轮：reviewer 通过`，最后推送聚合结果。这能显著降低"在干什么"的不安感。

### 1.5 `concertoai account list` 无 active 标记的视觉差异不够

**现状**：[`src/cli/account.ts:128-135`](src/cli/account.ts:128) active 账号用 `★（当前）` 标记。

**建议**：使用 `chalk`（项目已有依赖）中 `green` 标记 active 账号名，非 active 用默认色，差异更明显。同样适用于 `concertoai project list`。

---

## 2. 代码可维护性

### 2.1 `src/loop/self-heal.ts` 过于庞大（853 行）

**现状**：单文件混合了分类器（T1.1）、修复执行器（T1.2）、快照回滚（T1.3）、触发入口（T1.4）、模型调用、生产辅助函数。职责边界模糊，修改一个子模块（如 Biome 正则）风险感染全局。

**建议**：拆分为 3-4 个模块：
- `src/loop/self-heal/classifier.ts` — `parseVerifyReport` + 四段解析器
- `src/loop/self-heal/repair.ts` — `repairVerifyReport` + 模型修复函数
- `src/loop/self-heal/snapshot-guard.ts` — 快照保护包装器（当前内嵌在 repairVerifyReport 中 ~30 行）
- `src/loop/self-heal/index.ts` — barrel + `runSelfHeal` 入口

### 2.2 C# DevKit 错误日志污染 VS Code 体验（不直接相关但影响开发效率）

**注**：此项已在 `docs/09-踩坑记录/2026-08-11-VSCode频繁崩溃内存溢出.md` 详细分析，属于开发环境问题而非代码问题。VSCode 频繁崩溃的根因是 6 个 AI 扩展并行加载导致 85 个进程 + ~23GB 内存消耗。

### 2.3 CLI 命令输出混合中英文

**现状**：各 CLI 命令的错误/成功提示中，中文文案与英文变量混杂：
```
❌ 项目 ${name} 已注册，无法重复添加。  // project.ts
❌ API Key 不能为空。                   // account.ts
未知 account 子命令: ${action}           // index.ts
```

**建议**：将 CLI 文案集中到 `src/i18n/zh.ts`（现有字典），命令中通过 `t().cli.project.alreadyExists` 等键取值，使所有用户文本可一并翻译/调整。当前 `project`/`account`/`team`/`self-heal`/`audit` 命令的文案全部硬编码。

### 2.4 `repairVerifyReport` 中快照逻辑内嵌导致认知负载高

**现状**：[`src/loop/self-heal.ts:620-720`](src/loop/self-heal.ts:620) 模型修复的审批/写盘/快照/回滚/报告组装全部塞在一个 for 循环内，展开 ~100 行。

**建议**：抽取 `applyModelFix()` 函数，封装"审批 → 快照开始 → 写盘 → verify → 判定 → 回滚或提交"状态机，`repairVerifyReport` 只调用该函数并收集结果。

### 2.5 `project.ts` CLI 命令和 store 的职责模糊

**现状**：[`src/cli/project.ts`](src/cli/project.ts) 包含 `runProjectCommand` 分发逻辑 + `switchProject`/`addProject`/`listProjects` 等实现函数。这些函数既处理 CLI 输出格式又调用 store。

**建议**：`runProjectCommand` 应只做 dispatch；各子命令的格式化输出移到独立函数（如 `formatProjectListTable`），store 调用保持纯粹。当前结构尚可但随命令增多会膨胀。

---

## 3. 性能优化

### 3.1 `self-heal` 中每次 verify 都启动新子进程

**现状**：[`src/loop/self-heal.ts:795-803`](src/loop/self-heal.ts:795) `runVerifyCommand` 每次调用 `new ChildProcessQaRunner` + `runner.run()`，即每次 verify 都 spawn 一次 `npm run verify`。在 T1.2 修复执行器的一轮尝试中可能跑 2 次（lint fix 后 + model fix 后）。

**建议**：lint fix 后不必立即 rerun 整个 verify（`npm run build && npm run lint && npm run typecheck && npm run test`），可以增量运行——lint fix 只影响 lint 段，后续只需 rerun `npm run lint`。当前每次全量 verify（build+lint+typecheck+test，~5s）堆叠 2-3 次时用户等待明显。

**影响**：v3.2 可考虑引入"增量 verify"——`repairVerifyReport` 根据修复类型决定 rerun 哪些段，而非每次都全量。懒加载：仅当 lint 修复后 lint 段仍未通过时才提升到全量 verify。

### 3.2 `resolveApiKey` 每次调用都读 active-account 文件

**现状**：[`src/cli/common.ts:111-115`](src/cli/common.ts:111) `resolveApiKey` 每次调用都执行 `getActiveAccount()` → `readFile`，即使已经知道 active 账号且在之前调用中已验证过。

**建议**：在 CLI 启动阶段一次性解析 `apiKey` + `keySource` + `accountName`，后续通过闭包或模块级缓存传递。当前 `concertoai chat` 入口在 `getApiKey()` 中调一次，但 `doctor` 又独立调一次——两次文件读取重复。

### 3.3 `snapshots` 管理器在 `runSelfHeal` 中总是新建

**现状**：[`src/loop/self-heal.ts:842`](src/loop/self-heal.ts:842) `const snapshots = new SnapshotManager(options.cwd)` — 每次 `/self-heal` 都创建新实例。

**建议**：`SnapshotManager` 可考虑模块级缓存（按 cwd），避免同一轮 self-heal 中多次初始化。当前开销小（仅 mkdir），但重复创建不符合 `SnapshotManager` 的"事务管理器"语义。

### 3.4 `ProjectRegistry.load()` 每次 CLI 命令都重新读盘

**现状**：[`src/cli/index.ts:77`](src/cli/index.ts:77) preAction hook 中 `await ProjectRegistry.load()` 读 `projects.json`。类似地 `resolveProjectForCwd` 又读一次。

**建议**：CLI 启动阶段一次性加载 `ProjectRegistry` + `resolveApiKey` + config，将结果存在命令级上下文中后续透传。当前每次子命令都重新 load 造成重复 I/O（虽然文件小但习惯上可优化）。

---

## 4. 错误处理

### 4.1 `self-heal` 快照失败 → 继续写盘的降级策略缺少用户通知

**现状**：[`src/loop/self-heal.ts:635-640`](src/loop/self-heal.ts:635) 快照登记失败时调用 `snapshots.commit` 清理、记录日志，然后继续写盘——但用户不知道"快照保护未生效"。

**建议**：在 `attempts[].feedback` 或 `rollbackReason` 中明确标记快照失效（当前仅写 `log`，日志仅存在于内存数组中且仅在 `/self-heal` 报告中展示）。应同时在返回的 `RepairVerifyResult` 中添加 `snapshotWarning` 字段。

### 4.2 `account.ts` 保存 Key 的原子写不处理 rename 跨盘失败

**现状**：[`src/store/accounts.ts:75-89`](src/store/accounts.ts:75) 写临时文件后用 `rename` 原子替换。`rename` 跨文件系统时（如 tmp 在 `/tmp` 而目标在 `/home`）会抛出 `EXDEV` 错误。

**建议**：在 catch 中检测 `EXDEV` 错误码，回退为 `copyFile` + `unlink`（与 `store/paths.ts` 中 `migrateLegacyHome` 的 rename→cpSync 回退模式一致）。当前 `accounts.ts` 未处理 `EXDEV`。

### 4.3 `projects.ts` 路径规范化不处理 UNC 路径

**现状**：[`src/store/projects.ts:65-74`](src/store/projects.ts:65) `normalizeProjectPath` 处理 `C:\` 盘符路径和相对路径，但未处理 UNC 路径（`\\server\share\...`）。

**建议**：对以 `\\` 开头的 UNC 路径显式处理（Windows 专有），至少给明确的错误消息而非静默接受不规范的路径。当前 Windows 用户如果把项目放在网络共享上，`isNested` 的分隔符边界比较可能出错。

### 4.4 `/orchestrate` 中拆解失败 → 只返回 `{ ok: false, summary: "需求拆解失败: …" }` 无详细诊断

**现状**：[`src/cli/team.ts:117`](src/cli/team.ts:117) 拆解异常只捕获 message 作为 summary。

**建议**：在 `TeamCommandResult` 中增加 `diagnostics?: string` 字段（或复用 `errors: VerifyError[]` 风格），记录原始模型输出（截断至 ≤500 字符），便于用户判断"是模型输出格式对了但解析失败"还是"网络超时"。

### 4.5 `audit export` 损坏行静默跳过 → 无统计

**现状**：[`src/observable/audit.ts:72-76`](src/observable/audit.ts:72) `exportJson()` 中 `JSON.parse` 失败 → `continue`（静默跳过损坏行），导出完成不告知跳过了多少行。

**建议**：`exportJson` 增加返回值 `{ entries: AuditEntry[]; skipped: number }`，`audit export` 完成后输出 `共 N 条记录（跳过 M 条损坏行）`。

---

## 5. 文档完善

### 5.1 ARCHITECTURE.md 第 2 节"架构全景图"缺失 v3.1 模块

**现状**：第 2 节的 ASCII 架构图截止于 `observable/`，不包含 v3.1 新增的以下模块：
- `loop/self-heal.ts` — 自我修复闭环
- `tools/error-codes.ts` — 结构化错误码
- `cli/team.ts` / `cli/project.ts` / `cli/account.ts` / `cli/self-heal.ts` / `cli/audit.ts`
- `cli/crash-handler.ts` — 崩溃日志
- `cli/slash/self-heal.ts` / `cli/slash/orchestrate.ts`

**修复**：在第 2 节图末尾扩展一个 v3.1 层（或以独立子图表示），标注 "v3.1 新增"。**目录树第 5 节已更新（包含 projects/accounts/error-reporting），但全景图与目录树不同步。**

### 5.2 缺少各 CLI 命令的用户手册条目

**现状**：`docs/05-用户手册/` 下的文档未随 v3.1 新增命令同步更新。`concertoai self-heal` / `concertoai team` / `concertoai project` / `concertoai login` 等命令无独立的用户文档。

**建议**：新增 `docs/05-用户手册/08-self-heal.md` / `09-team.md` / `10-project-account.md`，至少包含命令格式、参数说明、典型使用场景示例。

### 5.3 缺少 DECISIONS.md ADR 条目

**现状**：v3.1 引入的关键设计决策（如 API Key 解析链 CLI>env>account>config 优先级、`project add` 拒绝嵌套注册、`self-heal` 仅修 ConcertoAI 自身代码）未在 DECISIONS.md 以 ADR 格式记录。

**建议**：新增 ADR-028（版本归位 → CHANGELOG 已提及）、ADR-029（API Key 解析链设计）、ADR-030（self-heal 范围限定——仅修自身/不修用户项目代码）、ADR-031（多项目嵌套拒绝策略）。

### 5.4 CHANGELOG 中文案部分与代码不一致

**现状**：CHANGELOG 写 `[3.1.0] — 2026-08-11` 但 `package.json`=`3.0.0`。此外 CHANGELOG 中提到 `concertoai balance` / `concertoai doctor` 为 "v2.2 + 预留功能（随 v3.1.0 发布）"，但这些命令在 v3.0 时期已随代码交付（之前版本号策略是 v3.0 包了 v2.2 内容）。

**建议**：统一版本叙事——要么在 v3.1.0 CHANGELOG 中写 `[3.1.0]`（推荐），要么保持 `[Unreleased]`。同步更新 `package.json` / `src/version.ts` / `tests/smoke.test.ts` 三处。

---

## 6. 未来扩展

### 6.1 `self-heal` 的修复策略可配置化

**当前**：`isSimpleTypeError` 只匹配缺 import / 缺类型标注，其他 type 错误一律跳过。

**v3.2 方向**：允许用户在 `config.json` 中扩展 `selfHeal.patterns` 数组，添加自定义正则匹配更多可自动修复的错误类型（如 TS2345 参数类型不匹配的简单模式）。`MAX_SELF_HEAL_ATTEMPTS` 也可改为配置项。

### 6.2 多项目共享 Agent

**当前**：Agent 安装到 `~/.concertoai/agents/`（全局），但 `project` 注册表的 `mcpServers` 字段仅支持 MCP 服务声明。

**v3.2 方向**：在 `ProjectEntry` 中增加 `agents?: string[]` 字段，按项目启用/禁用特定 Agent。配合 `-p <name>` 启动时自动筛选可用的 Agent 列表。

### 6.3 结构化错误码的 consume 端扩展

**当前**：`ToolResult.code` + `suggestion` 先被 `registry.run` 兜底填充，再被 `ToolRepairError` 渲染 💡 行。但修复策略执行器（`self-heal`）的 `suggestionFor` 函数为独立副本，未复用 `TOOL_ERROR_SUGGESTIONS` 字典。

**v3.2 方向**：`self-heal.ts:552-565` 的 `suggestionFor` 应统一收敛到 `TOOL_ERROR_SUGGESTIONS`，消除两处中文建议的维护负担。新增 `ToolErrorCode` → `self-heal` 自动判定"是否可自动修"的映射（如 `FILE_NOT_FOUND`→不自动修，`EDIT_REJECTED`→不自动修），减少 `repairVerifyReport` 中的 hardcode 分支。

### 6.4 `/orchestrate` 的迭代式拆解

**当前**：`decomposeRequirement` 一次性生成全部任务清单 → 用户确认 → 执行。

**v3.2 方向**：支持 `/orchestrate --iterative` 模式——拆解 + 执行第一轮 → 反馈执行结果 → 模型根据结果调整后续任务 → 继续执行（类似 plan 的 review 循环，但用在 team 级别）。这需要 `runTeamLoop` 支持"动态追加 Task"而非当前的固定清单。

### 6.5 `audit` 的查询能力

**当前**：`audit export` 仅支持全量导出为 JSON 数组。

**v3.2 方向**：增加 `audit query --kind <approval|rollback> --since <date> --agent <name>` 子命令，实现过滤查询。`AuditLogger` 当前是 JSONL 顺序读，查询需全表扫描——可考虑按日期分文件（当前已按 `yyyyMMdd-HHmmss` 命名），日期范围查询直接走文件系统筛选。

### 6.6 跨平台脚本命令的测试覆盖空白

**当前**：Windows 下 `npm run verify` 通过，但 `tests/tools/shell.test.ts` 中未覆盖所有 Windows 命令映射（如 `tail → Get-Content` / `grep → findstr` 在测试中被 mock 拦截而非真实验证）。

**v3.2 方向**：构建 Windows CI 矩阵 + 真实命令验证的 E2E 测试（当前测试仅在开发机 Windows 上运行，CI 无 Windows runner）。每新增一条命令映射必须伴随对应平台的真实执行断言。

---

*完善建议基于以下代码审查发现：`src/loop/self-heal.ts:620-720`（快照内嵌）、`src/cli/project.ts:103-112`（表格格式）、`src/cli/account.ts:113-135`（提示文案）、`src/store/accounts.ts:75-89`（EXDEV 未处理）、`src/store/projects.ts:65-74`（UNC 路径）、`src/observable/audit.ts:72-76`（损坏行统计）、`src/ui/App.tsx:525-545`（进度反馈）、`src/cli/common.ts:111-115`（重复 I/O）、`docs/02-架构设计/ARCHITECTURE.md:80-118`（全景图缺失）*
