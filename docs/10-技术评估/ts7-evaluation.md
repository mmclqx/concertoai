# TypeScript 7 评估报告（v4.0 M7 / T7.1）

> 日期：2026-08-14
> 状态：✅ 已定稿（go/no-go 决策门：**NO-GO**，锁定 TS 5.9 + v4.1 再评估）
> 对应决策：ADR-037 / ARCHITECTURE 决策表 D60
> 依据：v4.0-dev-tasks.md M7（TS7 调研 → go/no-go 决策门）

---

## 1. 背景

TypeScript 7 是微软「原生编译器」（Go 实现，内部代号 Corsa，2025-03 宣布），核心目标是 **10 倍编译提速**。路线图：TS 5.x（稳定）→ TS 6.0（过渡版，默认 `erasableSyntaxOnly` 友好）→ TS 7.0（原生编译器）。两个关键概念：

- **原生 type stripping**：Node 直接运行 .ts（擦除类型注解），不再需要 tsc 编译产物。Node 22.6+（`--experimental-strip-types`）/ 23.6+（默认启用）/ 24（稳定）。
- **erasableSyntaxOnly**：TS 5.8 引入的 tsconfig 选项——只允许「类型可擦除」语法（禁止 `enum`、`namespace`、参数属性 `constructor(private x)`、`import =` 等运行时语义语法），保证 type stripping 后代码等价运行。

## 2. 项目实证数据（2026-08-14 采集）

| 维度 | 现状 |
|------|------|
| TypeScript 版本 | `^5.9.3`（devDependencies），`npx tsc --version` = 5.9.3 |
| tsconfig | `noEmit: true`（tsc 仅类型检查）+ `verbatimModuleSyntax` + `isolatedModules`（接近 erasable 语义，但未开 `erasableSyntaxOnly`） |
| 构建链路 | tsup（esbuild 转译，**不依赖 tsc 编译产物**）；build 耗时 ~71ms |
| dev / test | tsx（esbuild）/ vitest（vite/esbuild）——均不依赖 tsc 产物 |
| typecheck | `tsc --noEmit`（纯类型检查） |
| **enum** | **1 处**：`src/lsp/protocol.ts` 的 `LspSeverity`（v4.0 M6 引入） |
| **参数属性** | **11 处**：`knowledge/search.ts`、`loop/memory-injector.ts`、`market/installer.ts`、`mcp/client.ts`、`mcp/manager.ts`、`model/router.ts`、`plugin/installer.ts`、`plugin/permissions.ts`、`reviewer/engine.ts`、`store/projects.ts`、`store/session.ts` |
| namespace / const enum | 0 处 |
| engines.node | `>=22` |

## 3. 四维度调研

### 3.1 原生 type stripping

- Node 22.6+ 才支持；本项目 `engines.node >=22` 满足下限，但 22.0–22.5 小版本不支持（type stripping 在 22.6 以 flag 引入）。
- **对本项目影响 = 无**：运行时产物是 tsup 打包的 JS，不需要 Node 原生跑 .ts；dev/test 走 tsx/vitest（esbuild），与 Node 原生 type stripping 无关。
- 若切 TS7：`tsc --noEmit` 类型检查语义保留（类型检查是 TS 核心功能，不会移除）。

### 3.2 erasableSyntaxOnly

- **1 enum + 11 参数属性** 是不可擦除语法的全部存量（namespace/const enum = 0）。
- TS 5.8+ 已可显式开启 `erasableSyntaxOnly` 提前暴露；当前未开（无强制约束）。
- 若 TS 6/7 默认开启 → 需改造 12 处：`LspSeverity` enum → 字面量联合类型；11 处 `constructor(private x)` → 显式字段声明 + 赋值。
- 改造量小，但属「运行时语义语法」迁移：每处都要改声明 + 构造体，引入回归风险；`LspSeverity` 是 LSP 协议常量（数值 1/2/3/4），改字面量联合需同步协议序列化点。

### 3.3 工具链兼容性

| 工具 | 解析/转译器 | TS7 影响 |
|------|------------|---------|
| tsup | esbuild | 不依赖 tsc 产物；TS7 语法面若与 TS5 兼容则无影响 |
| vitest | vite/esbuild | 同上 |
| biome | 自研 parser（非 tsc） | 当前对 enum/namespace/参数属性均支持（lint 全绿）；TS7 语法面未验证 |
| tsc --noEmit | TS7 原生编译器 | 类型检查保留；但 1.0 与 esbuild/biome 的语法面**可能有细微分歧**（历史：TS 5.x 与 esbuild 亦偶有分歧） |

风险点：TS7 原生编译器 1.0 发布后，tsup/vitest/biome 官方对 TS7 的适配声明（peer 支持矩阵 / 语法面差异）**未在 v4.0 时间窗内验证**。

### 3.4 Node 运行时要求

- type stripping 需要 Node 22.6+（实验）/ 23.6+（默认）/ 24（稳定）。
- 本项目发布物是编译后 JS，**运行时不需要 type stripping**；LSP 子进程（biome/tsc via npx）已是现状，与 TS7 无关。

## 4. go/no-go 决策门：**NO-GO**

| 维度 | 评估 |
|------|------|
| 收益 | **趋近于 0**：构建走 esbuild 不依赖 tsc 产物，TS7 的 10 倍编译加速对本项目无感（build 71ms / typecheck 秒级） |
| 成本 | **12 处不可擦除语法改造**（1 enum + 11 参数属性）+ 潜在回归 + LSP 协议序列化点同步 |
| 风险 | TS7 正式版状态、tsup/vitest/biome 适配、与 esbuild 语法面分歧——均未在 v4.0 时间窗验证 |
| 风险不对称 | 收益 ≈ 0，风险真实存在 → **不值得在 v4.0 迁移** |

**结论**：v4.0 **不迁移 TS7**。锁定 TS 5.9.x（当前 `^5.9.3`），v4.1 再评估。

**影响面**：
- package.json 保持 `typescript: ^5.9.3`（不升 6/7）；
- tsconfig 保持现状（不强制开启 `erasableSyntaxOnly`——存量 12 处会立刻报错，无收益）；
- **渐进准备（低成本高价值）**：新代码避免引入 `enum` / 参数属性 / `namespace`，优先字面量联合类型 + 显式字段声明（`LspSeverity` 在 v4.1 迁移时一并改造）；
- LSP 的 `LspSeverity` enum 记入 v4.1 迁移清单。

## 5. v4.1 再评估触发条件（满足任一即启动）

1. TS7 正式版发布 + tsup/vitest/biome 官方适配声明（peer 支持矩阵含 TS7）；
2. 构建或 typecheck 成为可感知瓶颈（当前 ~71ms / 秒级，远未到）；
3. Node 最低支持版本明确 ≥ 22.6（用户环境调查）。

## 6. 与 M7 验收标准对照

- [x] 调研报告覆盖四维度（type stripping §3.1 / erasableSyntaxOnly §3.2 / 工具链 §3.3 / Node 运行时 §3.4）
- [x] go/no-go 决策明确（NO-GO + 理由 + 影响面）
- [x] 决策后不再接触 TS7（v4.0 后续里程碑不涉及 TS7；v4.1 按 §5 触发条件再评估）
