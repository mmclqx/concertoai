# ConcertoAI v3.3 发布前最终审查

> 审查日期：2026-08-11 · 审查人：Carbon Code (deepseek-v4-pro)
> 审查范围：v3.3 全部改动（M1 五项修复 + M2 文档同步 + T6.5 手工测试回归修复，`git diff 8377221..HEAD`，49 文件 / +2274 -172）
> 基线：`npm run verify` 88 文件 / 1014 用例全绿 · npm audit 0 漏洞

---

## 快速结论

| 维度 | 评估 |
|------|------|
| v3.2 审查遗留消化 | ✅ W1/W2 + S1/S2/S3 全部落地 |
| T6.5 手工测试回归 | ✅ stderr 归段 / registerWrite / killTree 三项修复 |
| 代码质量 | ✅ 无新增问题，所有修复行为等价/增强 |
| i18n 完整性 | ✅ zh/en 同构，en.test.ts 断言通过 |
| 测试覆盖 | ✅ 1014 用例全绿，用例数不减，新增覆盖 T6.5 回归 |
| 文档同步 | ✅ CHANGELOG/ARCHITECTURE/TASKS/AGENTS/README 全量更新 |
| 严重问题 | 0 |
| 警告 | 0 |
| 完善建议 | 1（v3.4 方向） |
| **总评** | **✅ 可发布 (9.5/10)** |

---

## 一、审查遗留消化（M1：W1/W2 + S1-S3）

### 1.1 W1：lint:fix 失败 break 语义显式化

**位置**：[repair.ts](src/loop/self-heal/repair.ts:105-111)

**变更**：`if (!fix.ok)` 分支新增 3 行注释 + log 改为：

```
[self-heal] lint:fix 执行失败，剩余 type 错误已跳过（环境问题），转人工
```

**评估**：✅ 行为不变（仍 break），语义大幅提升——审查者/维护者不再困惑为何跳过 type 错误。注释说明了「report 已更新为 fresh」供人工查看，减少理解成本。

### 1.2 W2：全局正则常量去 `g` 标志

**位置**：[classifier.ts](src/loop/self-heal/classifier.ts:141-151)

**变更**：
- `BIOME_RULE_ERROR_RE` 从 `/.../g` → `/.../`（去 `g`）
- `BIOME_FORMAT_ERROR_RE` 从 `/.../g` → `/.../`（去 `g`）
- 注释新增 W2 说明

**全项目复核**：搜索 `RE = /.*/g` 无其他「带 g 标志的全局正则常量」残留。所有使用处均通过 `new RegExp(SOURCE, 'g')` 创建带状态实例，行为等价且安全。

**评估**：✅ 消除了 `lastIndex` 陷阱的脆弱模式，当前行为完全等价。

### 1.3 S1：self-heal 文案 i18n

**位置**：[self-heal.ts](src/cli/slash/self-heal.ts) + [zh.ts](src/i18n/zh.ts:133-164) + [en.ts](src/i18n/en.ts:135-166)

**变更**：
- 新增 `selfHeal` i18n 分组（24 键：阶段 6 + 动作 3 + 报告 15），zh/en 同构
- `selfHealPhaseLabel`（公共签名不变）→ `t().selfHeal.phaseVerify` 等
- `actionLabel` → `t().selfHeal.actionLintFix` 等
- `formatSelfHealReport` 全文案走 `t()`/`fmt()`（含模板变量 `{reason}`/`{suggestion}`/`{n}` 等）
- `formatAttempts` 的 `attemptLine` 使用 `fmt` 模板化，`{n}`/`{attempt}`/`{action}`/`{fixes}`/`{outcome}` 可灵活排列

**i18n 键完整性**：✅ `tests/i18n/en.test.ts` 使用递归 `collectKeys` 断言 zh/en 叶节点一一对应，覆盖新分组。手工测试报告 07.6 记录 `LUMEN_LOCALE=en` 实测全英文通过。

**评估**：✅ 实现干净——模板变量设计合理（`{reason}`/`{suggestion}` 可替换），两语言翻译准确，公共签名不变保证零回归。

### 1.4 S2：存量解析测试迁移

**位置**：[qa.test.ts](tests/agents/qa.test.ts:72-238) + [platform-samples.ts](tests/fixtures/platform-samples.ts:90-108)

**变更**：
- `qa.test.ts` 内联 `PASS_OUTPUT`（9 行）→ 迁移到样本库 `VITEST_PASS_WIN`
- `qa.test.ts` 内联 `FAIL_OUTPUT`（14 行）→ 迁移到样本库新增 `VITEST_FAIL_MIXED_POSIX`（POSIX 双失败文件 + ❯/× 混合形态）
- 样本库新增 1 个样本常量（与已有 Windows 样本形成双平台覆盖）
- 22 用例断言语义不变、用例数不减

**评估**：✅ 干净迁移——消除了 qa.test.ts 的内联样本散落，测试覆盖率不减反增（样本库覆盖了 Windows 盘符 + POSIX 双形态）。

### 1.5 S3：缓存注释

**位置**：[common.ts](src/cli/common.ts:130-134)

**变更**：`resolveApiKeyCached` 的 JSDoc 新增 3 段说明：
1. 缓存永不过期
2. 仅适用 CLI 一次性进程
3. 长驻进程应 `clearApiKeyCache()` 或直接 `resolveApiKey()`

**评估**：✅ 准确的语义说明，消除了「长驻进程该如何使用」的歧义。

---

## 二、T6.5 手工测试回归修复（超出 v3.2 审查范围的实际发现）

v3.2 发布后手工测试中发现的 3 个真实 bug，在 v3.3 一并修复：

### 2.1 stderr 防御归段（classifier.ts）

**问题**：真实 `npm run verify` 中 tsc/Biome 错误写入 stderr。旧代码简单拼接 `stdout+stderr` → stderr 错误追加到 stdout 最后一段（test）→ type/lint 段为空 → 误判 `passed=true`（undefinedVariable 未被检测）。

**修复**：
- 新增 `inferStageFromLine()`：按内容特征将 stderr 行归入对应阶段（tsc→type、Biome→lint、tsup→build、vitest→test）
- `splitStages()` 改为单独处理 stdout/stderr，stderr 行先归段再无特征归入当前段
- 新增 2 个测试用例（tsc 在 stderr 单独归段 + stderr 混合三段错误分别归段）

**评估**：✅ 关键的 bug 修复——消除了 `passed=true` 误判的假阴性风险。

### 2.2 team 事务 writer + registerWrite（team.ts + transaction.ts）

**问题**：`begin()` 只快照预登记文件（拆解清单），Agent 实际写盘路径可能超出清单 → 未登记文件在 `rollback` 时被判「外部修改」拒绝覆盖 → 快照保护失效。

**修复**：
- `transaction.ts` 新增 `registerWrite()`：文件未在快照清单时先动态快照（存在→保存原内容，不存在→标记新增），再记录写入
- `team.ts` 装配 `txnWriter`（`CoderFileWriter` 实现）：写盘前 `registerWrite` → 写盘，rollback 不再依赖预登记清单完整性
- 新增 4 个测试用例（动态登记已有文件、新增文件、重复幂等、未 begin 抛错）

**评估**：✅ 弥补了快照保护的关键设计盲区——Agent 实际写盘路径不可预知，动态登记消除了依赖预登记清单的假设。

### 2.3 killTree 等待退出（qa.ts + shell.ts）

**问题**：旧 `killTree` 在 Windows 下 spawn `taskkill` 后不等待其退出 → npm/node 子进程残留需手动清理。

**修复**：
- `killTree` 改为返回 `Promise<void>`：Windows 下等待 taskkill close/error 后 resolve
- `qa.ts` 的 `ChildProcessQaRunner` 超时处理改为 `settle` 模式（防二次 resolve）+ killTree 完成后的 1.5s 宽限兜底
- `shell.ts` 的 `runShellCommand` 超时处理改为 `void killTree(child)`（不阻塞 finish，进程树后台等待清理）
- 新增 3 个测试用例（Windows taskkill 等待/ POSIX SIGKILL/ pid 缺失）

**评估**：✅ 消除了超时后进程残留的资源泄露。

### 2.4 config.test.ts 环境变量隔离

**问题**：shell 预设 `LUMEN_LOCALE=en` 时 `config.test.ts` 的「全部缺省→zh」断言失败（测试期望 zh，实际读环境变量 en）。

**修复**：保存/恢复 `process.env.LUMEN_LOCALE`，测试用 `vi.stubEnv` 隔离。

**评估**：✅ 小修复，消除本地开发环境变量对测试的影响。

---

## 三、版本号一致性核对

| 位置 | 版本 | 状态 |
|------|------|------|
| `package.json` | 3.3.0 | ✅ |
| `package-lock.json` | 3.3.0 | ✅ |
| `src/version.ts` | 3.3.0 | ✅ |
| `tests/smoke.test.ts` | 3.3.0 | ✅ |
| `tests/loop/self-heal.test.ts` 段标记样本 | `@concertoai/cli@3.3.0` | ✅ |
| `src/loop/self-heal/classifier.ts` 注释 | `@concertoai/cli@3.3.0` | ✅ |
| `docs/02-架构设计/ARCHITECTURE.md` | v3.3 | ✅ |
| `CHANGELOG.md` | [3.3.0] | ✅ |
| `README.md` | 1014 用例 / 88 测试文件 | ✅ |
| `AGENTS.md` | v3.3.0 | ✅ |

**无版本号不一致问题。**

---

## 四、文档同步完整性

| 文档 | v3.3 状态 | 评估 |
|------|-----------|------|
| `CHANGELOG.md` | [3.3.0] 条目（Fixed W1/W2 + Changed S1-S3 + 测试基线） | ✅ |
| `ARCHITECTURE.md` | 版本头 v3.3 + 新增能力摘要 + 测试现状 1014/88 + transaction.ts 标注 | ✅ |
| `TASKS.md` | 里程碑 M1/M2 完成条 + 9 任务完成记录 + 161 总任务 / 0 待开始 | ✅ |
| `AGENTS.md` | 版本头 v3.3.0 + 自查第 12 条 + v3.1/3.2/3.3 完成记录 + 发布门基线 | ✅ |
| `README.md` | 状态行 v3.3.0 + 1014/88 + v3.3 新增说明 | ✅ |
| `v3.3-dev-plan.md` | 开发计划定稿 | ✅ |
| `v3.3-dev-tasks.md` | 任务说明书 | ✅ |
| `07.6-手工测试报告-v3.3.md` | 5 项修复 + 10 回归 + config.test.ts 修复 | ✅ |
| `v3.3-self-review-2026-08-11.md` | 自我审查报告 | ✅ |
| 执行日志 | 5 个新日志（190227/195300/225201/233000/235300） | ✅ |
| 踩坑记录 | 4 个新增（config 环境变量 / npm token / 进程残留 / 审查视角差距 + self-heal stderr / team 快照失效） | ✅ |

**文档覆盖完整，无遗漏。**

---

## 五、严重问题

**无。** 代码审查未发现数据丢失、安全漏洞、API 崩溃或跨平台回归。

---

## 六、警告

**无。** v3.2 审查报告的 2 个警告（W1/W2）在本次已完全修复。

---

## 七、完善建议（v3.4 方向）

### S1 — `collectKeys` 深度限制

**位置**：[en.test.ts](tests/i18n/en.test.ts:7-20)

当前 `collectKeys` 使用递归无深度限制。目前字典最深 2 层（`selfHeal.phaseVerify`），但若未来新增 3 层嵌套分组（如 `selfHeal.report.attempt.xxx`），递归无防护可能栈溢出。概率极低，但可加 `maxDepth=5` 兜底。

**建议**：加 `maxDepth` 参数，超过时抛清晰错误。

---

## 八、发布门检查清单

| # | 检查项 | 状态 |
|---|--------|------|
| 1 | `npm run verify` 全绿 | ✅ 88 文件 / 1014 用例 |
| 2 | `npm run typecheck` 零错误 | ✅ |
| 3 | `npm run lint` (Biome) 零错误 | ✅ |
| 4 | `npm audit` 无 high/critical | ✅ 0 漏洞 |
| 5 | 版本号一致性（package.json / version.ts / smoke.test.ts / 段标记样本） | ✅ |
| 6 | W1/W2/S1/S2/S3 五项审查遗留全部落地 | ✅ |
| 7 | i18n en 键一致性断言覆盖 selfHeal 分组 | ✅ |
| 8 | CHANGELOG [3.3.0] 条目完整 | ✅ |
| 9 | ARCHITECTURE.md v3.3 更新 | ✅ |
| 10 | TASKS.md v3.3 已完成 | ✅ |
| 11 | AGENTS.md v3.3.0 + 发布门基线 | ✅ |
| 12 | README.md 状态行 v3.3.0 | ✅ |
| 13 | 手工测试报告 07.6 落盘 | ✅ |
| 14 | 自我审查报告落盘 | ✅ |
| 15 | 执行日志 ≥3 个 | ✅ 5 个 |
| 16 | 踩坑记录归档 | ✅ 4 个新增 |
| 17 | npm whoami 令牌有效 | ✅ (已发布 npm, latest=3.3.0) |
| 18 | npm pack 预演（76 文件 / 392.1 kB） | ✅ |
| 19 | git tag v3.3.0 已打 | ✅ |

---

## 九、总体评价

**总评：✅ 可发布（9.5/10）**

v3.3 是一个教科书级的「小版本收尾」——精准消化审查遗留（5 项全部落地），无范围蔓延，并在手工测试中主动发现并修复了 3 个真实 bug（stderr 归段 / registerWrite / killTree）。

**亮点**：
- **审查闭环速度**：v3.2 审查当天的 5 项建议全部消化，不留技术债
- **i18n 实现质量**：`selfHeal` 分组 24 键全模板化（`fmt` + `{reason}` 等变量），zh/en 同构断言自动验证，`--lang en` 实测全英文通过
- **T6.5 回归修复扎实**：stderr 归段消除了假阴性风险（passed=true 误判）；registerWrite 彻底修复了快照保护的预登记假设缺陷；killTree 等待消除了进程残留资源泄露——三个修复都是实际暴露的 bug，非理论推演
- **测试覆盖不减反增**：1014 用例（v3.2 1004 → v3.3 1014，+10），新增覆盖 stderr 归段 / 动态登记 / killTree 等待
- **文档零遗漏**：新增 4 个踩坑记录（stderr 误判 / team 快照失效 / config 环境变量 / killTree 残留），所有已知问题有记录可追溯

**评分递进**：v3.1 (8.5) → v3.2 (9.2) → **v3.3 (9.5)**。评分提升来自：审查遗留消化 0 遗留 / T6.5 真实 bug 修复 / i18n 基线确立 / 发布前自审机制固化。

**发布建议**：v3.3.0 已由开发者发布到 npm（`@concertoai/cli@3.3.0`，tag 已打），审查确认可发布。建议直接进入 v3.4 循环。
