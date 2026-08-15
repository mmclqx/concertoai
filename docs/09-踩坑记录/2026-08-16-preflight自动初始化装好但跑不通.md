# [2026-08-16] preflight 自动初始化「装好了但跑不通」（biome 2.x 不兼容 + tsc 无 tsconfig 打印 help）

## 问题描述
- 现象：`concertoai workflow run precommit` 在裸项目上走 preflight 自动初始化（y → 计划 → y → 真实 `npm install -D @biomejs/biome typescript` + 写 biome.json + 注入 scripts）后，**lint 与 typecheck 两步必然失败**：
  - lint 报 `biome.json:2:14 deserialize`——`$schema` 指向 1.9.4，而实际安装的 biome CLI 是 2.5.8（`The configuration schema version does not match the CLI version 2.5.8`）+ `linter.rules.recommended` 字段 DEPRECATED（改 `preset`）；
  - typecheck 报 tsc 打印整页帮助（`tsc: The TypeScript Compiler - Version 7.0.2` + `COMMON COMMANDS`）而非检查文件，exit 1；
  - 用户只能手动 `npx biome migrate --write` + `npx tsc --init` 补救后才跑通——「装完直接 run」承诺被打破。
- 复现路径：`mkdir mt43 && cd mt43` → 手写 package.json（scripts 空）+ index.ts → `concertoai workflow init`（precommit 模板，确认依赖推断）→ `concertoai workflow run precommit` → 预检 6 项缺失 → y 自动初始化 → lint 失败（schema）→ 放弃 → `npx biome migrate --write` + `npx biome check --write .` → 重跑 → typecheck 失败（tsc help）。
- 环境：Windows x64 / Node v22 / @concertoai/cli 4.1.0 / biome 2.5.8 / typescript 7.0.2（专家手工测试 mt43，证据 `docs/11-手工测试结果/v4.1.1-test-result.md`）

## 根因分析
- 直接原因 1：`defaultBiomeJson()` 模板**写死 biome 1.9.4 的 schema URL + `linter.rules.recommended: true`**——biome 2.x 起对配置 schema 做版本校验（Expected CLI 版本 / Found schema 版本），1.9.4 模板在 2.x CLI 下直接 deserialize 失败；且 `recommended` 字段已 deprecated 改为 `preset`。而 preflight 安装 `@biomejs/biome` **不带版本上限** → npm 解析到最新 2.x → 模板必然失效。
- 直接原因 2：`autoInitForScript('typecheck')` 只装 typescript + 注入 `tsc --noEmit`，**不生成 tsconfig.json**——tsc 在无 tsconfig 的项目中不检查文件而是打印帮助并 exit 1（v4.1 文档里写「`tsc --init`」但实现只 addScript，`tsc --init` 是交互命令不能静默跑）。
- 深层原因：preflight 自动初始化只验证「依赖已装 + scripts 已写 + 配置文件存在」，**没有验证「装完真实命令能跑通」**；模板对工具链版本做「1.9.4 时代」的假设，而验证脚本（pty-drive.mjs C1）复用的是当时仓库 node_modules 里的 biome（1.x），未模拟用户环境「npm install 最新版」——版本漂移导致发布门绿、用户侧红。
- 附带暴露：tsc 打印 help 的失败模式（exit 1 + 无 `error TS…` 行）落入 error-summary 兜底 → 摘要只显示最无用的 npm 包装首行 `> mt43@1.0.0 typecheck`，用户不知道怎么办。

## 解决方案
- 修复方式：
  1. `src/workflow/preflight.ts` `defaultBiomeJson()`：schema 升到 2.x（2.5.8）+ `linter.rules.preset: 'recommended'`（替代 deprecated 的 `recommended: true`），保留保守格式（空格缩进 + LF 防 CRLF 误报）。
  2. 新增 `defaultTsconfigJson()`（target esnext / module nodenext / strict / noEmit / skipLibCheck / verbatimModuleSyntax / include `**/*.ts`）；`autoInitForScript('typecheck')` 增加 `writeFile: tsconfig.json`；`checkPrerequisites` 对需要 typecheck 的工作流检测 tsconfig.json 缺失（可自动修复）。
  3. `src/utils/error-summary.ts`：识别 tsc help 特征（`tsc: The TypeScript Compiler - Version` + `COMMON COMMANDS`/`tsc --init`）→ 返回「缺少 tsconfig.json，请运行 npx tsc --init 生成后重试」；biome format/lint 摘要由「整行 ━ 标题」改为「文件名 + 需要格式化/存在 lint 问题 + biome check --write .」。
  4. 新增 `scripts/pty-drive-p0.mjs` 端到端 TTY 驱动：裸项目 → preflight 自动初始化（y→y 真实 npm install 最新版）→ 断言 `✅ 工作流 precommit 执行成功`，failIf `schema version does not match` / `tsc: The TypeScript Compiler - Version`。
  5. 顺手修复：仓库自身 `biome.json` $schema 2.5.7 → 2.5.8（与本地 CLI 一致，消除 deserialize 噪音）。
- 涉及文件：`src/workflow/preflight.ts` / `src/utils/error-summary.ts` / `tests/workflow/preflight.test.ts` / `tests/utils/error-summary.test.ts` / `scripts/pty-drive-p0.mjs` / `scripts/_ts7-check.mjs`（TS7 行为验证）/ `biome.json` / `docs/11-手工测试结果/v4.1.1-test-result.md`（本证据）

## 经验教训
- 如何避免同类问题：
  1. **自动生成的配置文件模板不得绑定写死的工具版本假设**：模板 schema/字段要跟随「安装的最新版」验证（生成后校验，或用 `biome migrate` 兜底），不能拿 N 个月前的版本格式应付最新 CLI。
  2. **自动初始化承诺「装完直接 run」，必须端到端验证真实命令**：存在性检查（依赖/scripts/配置文件）≠ 跑通；验证脚本要模拟用户环境（npm install 最新版），不能复用仓库内 node_modules 的旧版本——发布门绿 ≠ 用户侧绿。
  3. **工具的「静默帮助」失败模式要进解析器**：tsc 无 tsconfig 打印帮助并 exit 1、无 error 行——这类输出要显式识别并给可操作提示，否则兜底摘要拿到 npm 包装首行毫无价值。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md` 提交前自查清单——新增「自动生成模板/配置文件时，用最新版工具链端到端验证（不锁定旧版本假设；存在性检查 ≠ 跑通）」条目。

## 相关链接
- 对话记录：专家手工测试 mt43（f:\tmp\concertoai-mt43）完整复现输出归档 `docs/11-手工测试结果/v4.1.1-test-result.md`
- 相关 Commit：本轮 v4.1.1 P0 修复提交（preflight.ts / error-summary.ts / 测试 / pty-drive-p0.mjs）
