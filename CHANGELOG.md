# 变更日志（Changelog）

## 维护约定

- 每个未发布变更先追加到 `## [Unreleased]`，发布时移动到对应版本小节；
- 条目按类型分组：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）；
- 版本号由 `npm version <patch|minor|major>` 管理（自动 bump + 同步 `src/index.ts` 的 VERSION + git tag）。

## [Unreleased]（v4.0 规划，见 v4.0-dev-plan-final.md）

> v4.0 定位：**可扩展的插件化 AI 开发平台**——架构拐点（major），破坏性变更集中在新增面（config 格式 / CLI --provider / Plugin 接口），旧命令 / 会话 / 技能平滑迁移。以下为 M0 T0.3 破坏性变更清单（≥6 项），随里程碑实施逐项落地。

### Breaking Changes — v4.0（规划）

- **config.json 格式升级**（v3 → v4）：`model` 字段 → `defaultProvider` + `providers` 字典。启动时自动迁移（备份 `config.v3.bak` + `_migrated` 幂等标记），`-m` CLI 参数保持兼容（映射到 defaultProvider.model）；`concertoai config restore` 一键回滚
- **CLI 新增 `--provider`**：临时切换 Provider（`concertoai --provider openai`）；`concertoai provider list / auth` 子命令（Provider 认证 Key 安全存储）
- **工具与 Agent 注册改 Plugin 接口**：v4.0 起 Plugin 是公共 API（semver），内置 Provider / 工具 / 技能 / Agent 统一实现 Plugin 接口；旧注册方式保留兼容层
- **插件必须 ESM**：与 ConcertoAI 运行时（ESM）一致；CJS 插件在 v4.0 拒绝加载（明确报错提示迁移）
- **市场 schema 扩展 `plugins[]`**：兼容旧 `skills[]` / `agents[]`（installer 按 type 分派，零破坏）；`concertoai plugin` 命令族（install/list/remove/browse/recommend）
- **`concertoai workflow` 命令族新增**：工作流 YAML（steps/depends/retry/rollback/require:approval）+ 4 内置模板 + `workflow run <name>`（DAG 依赖排序 + SnapshotManager 整体回滚）
- **会话格式兼容**：JSONL 不变，新增 `session.version: 4` 字段（v3 会话可继续读取）

### Added — v4.0（规划）

- ✅ **`/review --fix`（M1 已落地）**：审查后一键自动修复——A/B 类分批（🟢 suggestion 可定位文件 → A 类尝试模型补丁；🔴 critical / 🟡 medium / 无文件 → B 类需人工判断）+ 一次批量审批 diff 摘要（fail-closed）+ snapshot-guard 快照回滚 + 增量 verify（lint+type 段）+ 报告底部「修复结果」区块（✅已修复 / ⚠需人工 / ❌自动回滚，每条带 diff 摘要），≤2 次交互；`reviewer/autofix.ts` 复用 self-heal snapshot-guard 状态机
- ✅ **`concertoai workflow`（M2 已落地）**：DAG 工作流引擎——4 内置模板（init-ts / upgrade-deps / release 含审批节点 / precommit）+ `workflow init` 交互选模板生成 `.concertoai/workflows/<name>.yml` + `workflow run <name>`（TaskScheduler 拓扑排序/并行/重试 + 审批节点 require:approval 暂停 + 失败恢复 R/S/F/A + SnapshotManager 整体回滚 + onProgress 进度推送）+ `workflow export/import` 分享（YAML 可提交 Git）+ `workflow create "<自然语言>"` 模型生成（非法降级人工编辑）+ 依赖推断提示确认（不静默写入）+ chat 内 `/workflow`；`src/workflow/` 复用 orchestrator/scheduler + transaction
- ✅ **多 Provider 切换（M3 已落地）**：DeepSeek / OpenAI（兼容协议，baseUrl 可配）/ Ollama（本地探测 /api/tags）任意切换——`concertoai --provider openai` 临时切换 / `config set provider openai` 持久化 / `provider list` 状态（🟢/🔴/🟡）+ `provider auth <name>` Key 安全存储（0600）+ config v3→v4 自动迁移（备份 + `_migrated` 幂等 + `config restore` 回滚）+ doctor 模型推荐（复杂度×预算×本地 Ollama + 月成本预估）+ 启动 fallback（主 Provider 故障自动切备选 ≤1 次）+ StatusBar 成本对比/会话结束 vs DeepSeek 估算
- 插件系统：Plugin 接口 + 生命周期钩子 + 六类权限（read/write/network/shell/knowledge/mcp）安装审批 + 运行时 enforce
- 插件市场：registry `plugins[]` + browse/recommend/popular + sha256 校验 + `plugin audit` 安全审计
- LSP 诊断（P2）：`concertoai lsp --stdio` 三来源诊断（lint/type/self-heal）+ CodeAction（Web UI / VS Code 扩展骨架延后 v4.1）
- team --parallel（P2）：自然触发并行 + 结果汇总 + 文件冲突提示

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
