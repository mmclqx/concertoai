# [2026-08-11] self-heal 分类器漏解析 Biome format 与 assist 类别错误

## 问题描述
- 现象：v3.1.0 发布后，`concertoai self-heal` / `/self-heal` 在 Windows 上遇到 Biome **format 错误**（`src\version.ts:9:1 format  FIXABLE  ━━━`）或 **assist 类别**（`assist/source/organizeImports`）时，lint 段解析不出任何错误 → `parseFailed.lint = true` → 自我修复无法定位 lint 问题，闭环退化为「无法解析」而非自动 `lint:fix`。
- 环境：Windows x64（路径用反斜杠）；assist 类别全平台同现

## 根因分析
- 直接原因：`BIOME_ERROR_RE` 只匹配 `lint/` 前缀（`\\s+lint\\/([A-Za-z0-9/_-]+)`）：format 错误行无 `lint/` 前缀（直接是 `format`），assist 类别是 `assist/` 前缀——两类都不命中。
- 深层原因：解析正则按「Biome 2.x 规则错误行」一种格式设计（先入为主只考虑 `lint/xxx`），未覆盖 Biome 实际输出的两种变体：format 错误（无类别前缀 + 行列可选：整文件格式化无行列）与 assist 类别（organizeImports 等）；Windows 反斜杠路径进一步暴露了路径匹配的脆弱性。

## 解决方案
- 修复方式：拆成两条正则并行匹配——`BIOME_RULE_ERROR_RE`（`(lint|assist)/规则名`，必带行列）+ `BIOME_FORMAT_ERROR_RE`（`format`，行列可选，兼容整文件无行列行）；Windows 反斜杠路径由 `[^\\s]+?` 非贪婪 + `.ts` 后缀限定兼容；匹配到 format 错误时 code 归一为 `format`。
- 涉及文件：`src/loop/self-heal.ts`、`tests/loop/self-heal.test.ts`（新增 4 个用例：Windows 路径 format 错误 / assist 类别 / 整文件无行列 format / 三类混合全识别）

## 经验教训
- 如何避免同类问题：解析「第三方工具输出」的正则必须用真实样本覆盖多种变体（类别前缀、行列有无、路径分隔符），不能按单一格式假设；Windows 路径（反斜杠 + 盘符冒号）是正则最容易漏的点，写解析器时主动准备 Windows 样本。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md`（提交前自查第 3 条「数字与行为描述」可扩展：解析类正则需多平台样本验证）

## 相关链接
- 对话记录：v3.1.1 回归修复
- 相关 PR/Commit：（待提交）
