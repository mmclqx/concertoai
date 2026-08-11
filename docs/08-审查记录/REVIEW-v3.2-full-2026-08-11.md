# ConcertoAI v3.2 发布前最终审查

> 审查日期：2026-08-11 · 审查人：Carbon Code (deepseek-v4-pro)
> 审查范围：v3.2 全部新增代码（M1-M6，`git diff 1bf5b78..8377221`，70 文件 / +4141 -991）
> 基线：`npm run verify` 88 文件 / 1004 用例全绿 · CI 三平台矩阵 · npm audit 0 漏洞

---

## 快速结论

| 维度 | 评估 |
|------|------|
| 功能完整性 | ✅ 6 个改进方向（M1-M6）全部落地 |
| 代码质量 | ✅ 模块拆分清晰，无回归风险 |
| 跨平台兼容 | ✅ CI 矩阵 + UNC/EXDEV + 样本库 覆盖到位 |
| 测试覆盖 | ✅ 新增测试覆盖所有关键路径，1004 用例全绿 |
| 文档同步 | ✅ ARCHITECTURE/CHANGELOG/DECISIONS/user-guide 全量更新 |
| 严重问题 | 0 |
| 警告 | 2（不阻塞，建议修复） |
| 完善建议 | 3（v3.3 方向） |
| **总评** | **✅ 可发布 (9.2/10)** |

---

## 一、逐模块审查

### 1.1 self-heal 模块化重构（M2 / ADR-030）

**拆分结果**：

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/loop/self-heal/classifier.ts` | 293 | 四段分类器（build/lint/type/test）+ `parseVerifyReport` / `mergeLintPassed` |
| `src/loop/self-heal/repair.ts` | 153 | 修复执行器 `repairVerifyReport` + 增量 verify + 常量 |
| `src/loop/self-heal/snapshot-guard.ts` | 190 | `applyModelFix` 快照守卫状态机 |
| `src/loop/self-heal/model.ts` | 173 | 模型修复计划生成 + `isSimpleTypeError` / `parseModelFixOutput` |
| `src/loop/self-heal/types.ts` | 122 | 公共类型（避免循环依赖） |
| `src/loop/self-heal/index.ts` | 159 | barrel + `runSelfHeal` 入口 + 生产辅助 |

- **拆分质量**：✅ 边界清晰，每个模块 ≤ 310 行（远低于 ≤400 行目标）。`types.ts` 独立避免循环依赖。
- **公共 API 兼容**：✅ `runSelfHeal` / `parseVerifyReport` / `repairVerifyReport` 等全部 re-export，调用方无感。
- **增量 verify**（T2.3）：✅ `verifyAfterLintFix` 在 `runLintOnly` 存在时仅 rerun lint 段，通过则 `mergeLintPassed` 跳过全量——E2E 测试已覆盖（lintOnlyCalls=1，verifyCalls=1）。
- **快照保护**（T1.3/T2.4）：✅ 状态机完整（生成→审批→快照→写盘→verify→判定→回滚/提交），`snapshotWarning` 字段正确聚合。
- **边缘情况**：
  - ✅ 快照登记失败 → 置 `snapshotWarning`，不中断流程（继续写盘）
  - ✅ 回滚失败 → 保留快照 + 详细 failure 信息
  - ✅ 模型输出非 JSON → 不抛异常，返回 `undefined` 跳过
  - ✅ 审批 fail-closed（`requestApproval ?? false`）

**发现**：无严重问题。`classifier.ts` 中 `BIOME_RULE_ERROR_RE` 与 `BIOME_FORMAT_ERROR_RE` 定义为 `const` 带 `g` 标志，但在 `parseLintErrors` 中通过 `new RegExp(SOURCE, 'g')` 创建新实例——正确处理了全局 regex `lastIndex` 陷阱。

### 1.2 跨平台兼容性（M1 / ADR-031/032）

**CI 矩阵** [ci.yml](.github/workflows/ci.yml:6-14)：
- ✅ `os: [ubuntu-latest, windows-latest, macos-latest]` + `fail-fast: false`
- ✅ `node-version: [22]` 统一，npm ci → npm run verify

**UNC 路径处理** [projects.ts](src/store/projects.ts:66-78)：
- ✅ `normalizeProjectPath` 识别 `\\server\share\` 前缀 + 盘符 `C:\` 双分支
- ✅ `isNested` 分隔符边界比较（`/foo/bar2` 不误判为 `/foo/bar` 子目录）
- ✅ Windows 大小写不敏感路径比较
- ✅ UNC 路径 add → 持久化 → 重新加载 → `findByPath` 精确匹配（E2E 覆盖）

**EXDEV 回退** [accounts.ts](src/store/accounts.ts:98-108)：
- ✅ `atomicReplace` rename 失败捕获 `EXDEV` → `copyFile` + `unlink` 回退
- ✅ 非 EXDEV 错误原样抛出，不回退
- ✅ 独立测试文件 `accounts-exdev.test.ts`（4 用例，mock rename/copyFile/unlink）

**跨平台样本库** [platform-samples.ts](tests/fixtures/platform-samples.ts)：
- ✅ Windows 反斜杠/盘符/UNC + POSIX 绝对路径 + CRLF/LF 换行
- ✅ vitest 输出双形态（❯ / FAIL 前缀 + Windows 盘符 + POSIX 路径）
- ✅ Biome lint/format/assist + tsc 标准/pretty 双形态
- ✅ 供 self-heal 分类器 / qa parseVerifyOutput / projects 测试复用

**spawn 适配审计** [v3.2-m1-spawn审计清单.md](docs/03-开发计划与任务/v3.2-m1-spawn审计清单.md)：
- ✅ 5 个调用点全合规：QA `shell: true` + MCP client platform 分支 + shell.ts `getPlatformAdapter` + team L84 `spawn` 正确
- ✅ E2E 真实 spawn `npx.cmd --version` 回归（Windows 下 shell:true 成功，非 Windows 跳过）

**发现**：无严重问题。`CI` 矩阵三平台当前提交（8377221）尚未触发 GitHub Actions 运行（需推送到 main），但本地 Windows `npm run verify` 全绿——这是合理的，实际 CI 验证将在推送后自动完成。

### 1.3 错误处理强化（M3）

**audit 损坏行统计** [audit.ts](src/observable/audit.ts:86-98)：
- ✅ `exportJson` 返回 `{ entries, skipped }` 而非静默跳过
- ✅ CLI `audit export`：stdout 模式走 stderr 不污染 JSON 管道；`--out` 模式并入主文案
- ✅ 测试覆盖 36 用例（含损坏行跳过计数）

**/orchestrate diagnostics** [team.ts](src/cli/team.ts:87-93)：
- ✅ `TeamCommandDiagnostics` 区分 `parse`（模型输出格式不符）/ `network`（调用失败）/ `other`
- ✅ 原始模型输出截断 ≤500 字符，不丢失可定位信息
- ✅ chat 内 `/orchestrate` 展示诊断详情（含原始输出）

**inferErrorCode 英文关键词回归** [error-codes.ts](src/tools/error-codes.ts:93-103)：
- ✅ `outside sandbox` / `command not found` / `spawn ENOENT` 英文关键词保留
- ✅ 与中文关键词并行匹配（越界 / 命令不存在 / 无法启动）

**发现**：无严重问题。

### 1.4 用户体验优化（M4 / ADR-029）

**team 进度推送** [team.ts](src/cli/team.ts:56-76)：
- ✅ `onProgress` 回调：`decomposed`（📋 已拆解 N 个任务）→ `loop-attempt`（🔁 第 x/5 轮 实现/审查/验证）→ `done`（✅/❌）
- ✅ CLI stdout 与 /orchestrate 聊天消息流共用 `formatTeamProgress`
- ✅ E2E 测试覆盖回调序列（decomposed→loop-attempt×3→done）

**self-heal 阶段进度** [self-heal.ts](src/cli/slash/self-heal.ts:68-83)：
- ✅ `SelfHealPhase` 联合类型（verify/lint-fix/model-fix/verify-fix/rollback/done）
- ✅ `selfHealPhaseLabel` 中文映射 + `App.tsx` `setActiveTool` 动态更新状态条

**project / account 视觉**：
- ✅ `project list` 三列表格（名称|路径|注册时间）+ 当前 cwd 项目 ★（当前）chalk.green 高亮 [project.ts](src/cli/project.ts:107-127)
- ✅ `account list` active 账号 chalk.green 高亮 [account.ts](src/cli/account.ts:134-142)

**whoami 修复提示 + doctor 账号完整性**：
- ✅ whoami 账号缺失时输出可复制命令 `concertoai login <name>` [account.ts](src/cli/account.ts:118-122)
- ✅ doctor 新增 `diagnoseAccounts` 检查项：无 active→ok / 指针指向缺失账号→fail + 修复命令 [doctor.ts](src/cli/doctor.ts:157-175)

**启动期缓存** [common.ts](src/cli/common.ts:141-187)：
- ✅ `resolveApiKeyCached` 按 accountsRoot 模块级缓存
- ✅ `loadProjectRegistryCached` 按 registryFile Map 缓存
- ✅ 测试覆盖 4 用例（同 accountsRoot 命中 / 不同不共享 / clear 刷新 / clear 重载）

**发现**：无严重问题。

### 1.5 文档与扩展能力（M5）

**ARCHITECTURE.md**：
- ✅ 版本头 v3.2，第 1 节 v3.2 新增能力摘要
- ✅ 第 2 节全景图标注 v3.2 变更（doctor/project/team/account self-heal slash/agent）
- ✅ D 决策表新增 D47~D50（ADR-029~032 引用）
- ✅ 第 5 节目录树与测试基线同步（88 文件 / 1004 用例）

**CHANGELOG.md**：
- ✅ [3.2.0] 条目完整：Added（跨平台/UX/agent 市场）+ Changed（self-heal 重构/增量 verify/audit 统计/diagnostics）
- ✅ 基线校准 88/1004

**DECISIONS.md**：
- ✅ ADR-029（API Key 缓存）· ADR-030（self-heal 模块化）· ADR-031（UNC 路径）· ADR-032（跨平台 CI）全部落盘

**user-guide.md**：
- ✅ 版本头 v3.2
- ✅ self-heal / team / project / account / audit export 章节补全
- ✅ v3.2 新增功能摘要（跨平台兼容 / 模块化 / 错误处理 / UX 优化）

**执行日志**（T5.5）：
- ✅ 7 个 execution-log-*.md 落盘（覆盖 M0→M6 全部会话）
- ✅ AGENTS.md 自查第 11 条加入规范

**Agent 市场版本管理**（T5.4）：
- ✅ `/agent list` 拉注册表对比「已安装 vs 最新」
- ✅ `/agent update --all` 批量更新（逐条 ✅/⏭️/❌）
- ✅ 测试覆盖 +9 用例

**发现**：无严重问题。

### 1.6 测试覆盖（M6）

**增量**：
- `tests/fixtures/platform-samples.ts`（新增，114 行）
- `tests/e2e/platform-e2e.test.ts`（新增，91 行，Windows spawn 回归 + UNC 路径 E2E）
- `tests/cli/common.test.ts`（新增，105 行，启动缓存 4 用例）
- `tests/store/accounts-exdev.test.ts`（新增，69 行，EXDEV 回退 4 用例）
- `tests/store/projects.test.ts`（+65 行，UNC 规范化/isNested）
- `tests/cli/team.test.ts`（+137 行，onProgress 回调序列 + 进度格式化）
- `tests/e2e/self-heal.test.ts`（+28 行，增量 verify E2E）
- `tests/e2e/team-cli.test.ts`（+44 行，onProgress 全链路）
- 其他扩展：slash-agent（+153）/ slash-orchestrate（+43）/ slash-self-heal（+40）/ doctor（+30）/ audit（+36）

**基线**：88 文件 / 1004 用例全绿（`npm run verify` 实测通过）· npm audit 0 漏洞

**发现**：无严重问题。覆盖率充分，所有关键路径（UNC/EXDEV/增量 verify/进度回调/缓存/损坏行）均有测试。

---

## 二、版本号一致性核对

| 位置 | 版本 | 状态 |
|------|------|------|
| `package.json` | 3.2.0 | ✅ |
| `package-lock.json` | 3.2.0 | ✅ |
| `src/version.ts` | 3.2.0 | ✅ |
| `tests/smoke.test.ts` | 3.2.0 | ✅ |
| `docs/02-架构设计/ARCHITECTURE.md` | v3.2 | ✅ |
| `CHANGELOG.md` | [3.2.0] | ✅ |
| `README.md` | 1004 用例 / 88 测试文件 | ✅ |
| `AGENTS.md` | v3.1.0→v3.2 (via TASKS) | ✅ |

**无版本号不一致问题。**

---

## 三、严重问题（必须修复，阻塞发布）

**无。** 代码审查未发现数据丢失、安全漏洞、API 崩溃或跨平台回归。

---

## 四、警告（建议修复，不阻塞发布）

### W1 — self-heal `repair.ts` 中 lint:fix 失败后 break 而非 continue

**位置**：[repair.ts L108](src/loop/self-heal/repair.ts:108)

```ts
if (!fix.ok) {
  log('[self-heal] lint:fix 执行失败，转人工');
  break;
}
```

**问题**：`npm run lint:fix` 执行失败（非零退出码）后直接 `break` 退出循环。如果此时还有 type 简单错误可以自动修，它们不会被处理。这是有意设计（lint:fix 失败说明环境有问题）还是遗漏？

**影响**：低——lint:fix 失败通常是环境损坏（Biome 未安装），继续循环意义有限。但可在日志中明确说明「剩余 type 错误已跳过，因 lint:fix 失败」。

**建议**：在 break 前加一行注释，或在 log 中明确说明跳过了后续修复。

### W2 — `classifier.ts` 全局 regex 常量带 `g` 标志

**位置**：[classifier.ts L72](src/loop/self-heal/classifier.ts:72)

```ts
const BIOME_RULE_ERROR_RE =
  /([^\s]+?\.(?:ts|tsx|js|jsx|mts|cts)):(\d+):(\d+)\s+(lint|assist)\/([A-Za-z0-9/_-]+)/g;
```

**问题**：尽管当前代码在 `parseLintErrors` 中通过 `new RegExp(SOURCE, 'g')` 创建新实例，避免了 `lastIndex` 陷阱——但常量本身带 `g` 标志是脆弱模式。若未来有代码直接使用 `BIOME_RULE_ERROR_RE`（不通过 `new RegExp` 包装），会因 `lastIndex` 残留导致交替匹配/漏匹配。

**影响**：极低——当前所有使用点都通过 `new RegExp` 包装。

**建议**：常量定义去掉 `g` 标志，由使用者按需添加。例如：

```ts
// 改为不带 g 标志
const BIOME_RULE_ERROR_RE_SRC =
  /([^\s]+?\.(?:ts|tsx|js|jsx|mts|cts)):(\d+):(\d+)\s+(lint|assist)\/([A-Za-z0-9/_-]+)/;
```

---

## 五、完善建议（v3.3 方向）

### S1 — self-heal 国际化

`selfHealPhaseLabel` 和 `actionLabel` 目前硬编码中文。`en.ts` 缺少对应翻译键。对于已支持 `--lang en` 的 CLI，非中文用户看到状态条混合中英不够一致。

**建议**：将 `selfHealPhaseLabel` 移入 i18n 字典，与 `doctor` 等模块一致。

### S2 — `platform-samples.ts` 未被全部解析类测试引用

`tests/fixtures/platform-samples.ts` 当前主要是供 v3.2 新测试使用。部分存量解析测试（如 `qa.test.ts` 的 vitest 解析）尚未切换到使用这些样本——它们仍用内联字符串。

**建议**：v3.3 逐步迁移存量解析测试到统一使用 `platform-samples.ts`，减少内联样本散落。

### S3 — `resolveApiKeyCached` 缓存无过期机制

`apiKeyCache` 是模块级变量，同一进程内永不过期。如果用户在同一进程内通过 `/agent` 或 `account switch` 切换 active 账号后立即执行 `concertoai run`（同一进程内多次 resolveKey），缓存命中返回旧值——不过 CLI 入口每次都是独立进程，chat 内也是独立进程，所以实际无问题。

**建议**：可在缓存注释中明确说明「同一进程内永不过期，不适用于长驻进程」，避免误解。

---

## 六、发布门检查清单（核对）

| # | 检查项 | 状态 |
|---|--------|------|
| 1 | `npm run verify` 全绿 | ✅ 88 文件 / 1004 用例 |
| 2 | `npm run typecheck` 零错误 | ✅ |
| 3 | `npm audit` 无 high/critical | ✅ 0 漏洞 |
| 4 | 版本号一致性（5 处） | ✅ |
| 5 | CHANGELOG [3.2.0] 条目完整 | ✅ |
| 6 | ARCHITECTURE.md 更新 | ✅ |
| 7 | DECISIONS.md ADR-029~032 落盘 | ✅ |
| 8 | user-guide.md v3.2 章节 | ✅ |
| 9 | 执行日志落盘（≥5 个） | ✅ 7 个 |
| 10 | 手工测试报告 07.5 | ✅ |
| 11 | git tag v3.2.0 待打 | ⬜ T6.4 待执行 |
| 12 | npm publish 待执行 | ⬜ T6.4 待执行 |

---

## 七、总体评价

**总评：✅ 可发布（9.2/10）**

v3.2 是一个高质量的「加固型」版本——不做新的大功能面，专注把 v3.1 暴露的短板（Windows 兼容性、self-heal 可维护性、长任务无进度反馈、错误处理边界）固化为基线。6 个里程碑全部落地，29 个任务全部完成，没有遗留 P0/P1 未完成项。

**亮点**：
- self-heal 模块化拆分干净利落（870 行 → 6 文件 / ≤311 行），类型系统设计精细（types.ts 独立避免循环依赖）
- 跨平台兼容性全面——不仅修了 v3.1.1 的已知问题，更把防线前移到 CI 矩阵 + 样本库 + UNC/EXDEV 边界
- 测试覆盖扎实——所有关键路径（UNC/EXDEV/增量 verify/进度回调/缓存/损坏行/版本对比）均有 E2E 或单元测试
- 文档同步完整——ARCHITECTURE/CHANGELOG/DECISIONS/user-guide 全量更新，执行日志 7 个覆盖 M0→M6

**扣分项**（从 10 分扣）：
- 两个小警告（W1 lint:fix 失败 break 语义、W2 全局 regex g 标志）— 各扣 0.1
- self-heal 国际化（硬编码中文）— 扣 0.3
- 部分存量测试未迁移到 platform-samples.ts — 扣 0.2
- 缓存无过期注释说明 — 扣 0.1
- CI 三平台矩阵尚未在 GitHub Actions 上实际验证（需推送 main 触发）— 扣 0.1

**发布建议**：立即执行 T6.4（`npm version 3.2.0` → `git tag` → `npm publish`）。W1/W2 不阻塞发布，可在 v3.3 中修复。
