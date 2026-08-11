# [2026-08-11] qa parseVerifyOutput 漏解析 Windows 盘符路径失败文件

## 问题描述
- 现象：v3.2 M1 跨平台样本库回归测试暴露——vitest 失败输出 `❯ C:\work\demo\tests\foo.test.ts (3 tests | 1 failed)` 时，`parseVerifyOutput` 的 `FAIL_FILE_RE` 解析不出失败文件段 → `failedItems` 为空 → QA 报告 passed=false 但无失败详情，Coder 无法定位修复目标（与「QA 空失败项」同类风险）。
- 环境：Windows x64（失败文件为盘符绝对路径 `C:\...`）；POSIX 相对/绝对路径正常

## 根因分析
- 直接原因：`FAIL_FILE_RE = /(?:❯|FAIL)\s+([^\s(:]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))(?!:)/` 中 `[^\s(:]+` **排除了冒号** `:`——Windows 盘符 `C:` 的第一个 `:` 使匹配在 `C` 处停止（只匹配到 `C`），后续 `\.(?:test|spec)` 无法满足 → 整条正则不命中。
- 深层原因：v3.1.1 修复 Biome 解析时只针对 self-heal 的 lint 段补了 Windows 反斜杠样本，但 **qa 的 vitest 解析（test 段）没有 Windows 盘符样本**——`C:` 的冒号与 POSIX 路径的差异（错误定位行 `path.ts:10:5` 的冒号）混在同一正则里，负向前瞻 `(?!:)` 只解决了定位行，没解决盘符前缀。

## 解决方案
- 修复方式：`FAIL_FILE_RE` 增加可选盘符前缀 `(?:[A-Za-z]:)?`：`/(?:❯|FAIL)\s+((?:[A-Za-z]:)?[^\s(:]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))(?!:)/`——盘符冒号先被前缀吞掉，其余路径不含冒号；负向前瞻 `(?!:)` 继续排除错误定位行。
- 涉及文件：`src/agents/qa.ts`（正则）、`tests/agents/qa.test.ts`（新增 4 用例：Windows 盘符失败 / POSIX 失败 / Windows 全绿 / FAIL 前缀形态）、`tests/fixtures/platform-samples.ts`（样本库：VITEST_FAIL_WIN / VITEST_FAIL_POSIX / VITEST_FAIL_PREFIX_WIN / VITEST_PASS_WIN）

## 经验教训
- 如何避免同类问题：所有解析第三方工具输出的正则，必须用 **Windows（反斜杠 + 盘符冒号）与 POSIX 双样本**覆盖——盘符冒号是「含冒号定位行」之外的第二类冒号陷阱；把样本集中到 `tests/fixtures/platform-samples.ts`（v3.2 T1.5）强制复用，新解析器必须过样本库回归。
- 是否需要更新规范：✅（已有规范 AGENTS.md 自查第 10 条；本次为执行层面的样本库落地）

## 相关链接
- 对话记录：v3.2 M1 / T1.5 跨平台样本库回归
- 相关 PR/Commit：（待提交）
