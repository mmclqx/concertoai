# [2026-08-11] self-heal 误判 stderr 中的 tsc 错误为「verify 通过」

## 问题描述
- 现象：手工测试在项目中故意引入 `undefinedVariable` 类型错误后运行 `concertoai self-heal`，报告「✅ npm run verify 全部通过，无需修复」——TS2304 错误**未被检测**，自我修复闭环失效。
- 环境：Windows x64（tsc 错误输出到 stderr；段标记由 npm 输出到 stdout）

## 根因分析
- 直接原因：`src/loop/self-heal/classifier.ts` 的 `splitStages` 用 `stdout + '\n' + stderr` **简单拼接**两流。真实 `npm run verify` 中：段标记（`> @concertoai/cli@3.2.0 typecheck`）由 npm 打印到 **stdout**，而 tsc 错误写入 **stderr**（且 stderr 无段标记）。拼接后 stderr 的 tsc 错误被追加到 stdout 最后一个段（test）之后 → **type 段为空** → `parseTypeErrors` 返回 0 错误 → `errors=[]` + 各段均有输出 → `passed=true`（用 tsx 复现：stdout 4 段正常 + stderr 含 `src\foo.ts(2,10): error TS2304` → 修复前 `passed: true, errors: []`）。
- 深层原因：① 测试全部把错误放在 **stdout**（`verifyOutput` 辅助函数 `stderr: ''`），从未覆盖「错误在 stderr」的真实输出形态，形成测试盲区；② `splitStages` 假设两流可拼接，忽略了 npm 串行执行下 stdout/stderr 的**时序交错**语义（段标记只出现在 stdout）。

## 解决方案
- 修复方式：`splitStages` 增加 **stderr 防御归段**——stdout 按段标记切分后，stderr 行按内容特征归入对应阶段（`inferStageFromLine`：`error TSxxxx` → type、`lint|assist/规则` / `format` → lint、`RollupError/Build error` → build、vitest `FAIL/❯/✗/×/AssertionError` → test），无特征行归入 stdout 最后出现的段（保留上下文不丢弃）。
- 涉及文件：`src/loop/self-heal/classifier.ts`（splitStages + inferStageFromLine）、`tests/loop/self-heal.test.ts`（新增 2 用例：tsc 错误在 stderr 识别为 type / stderr 混合三阶段错误各自归段）

## 经验教训
- 如何避免同类问题：**分类器/解析器的测试必须覆盖真实进程的 stdout/stderr 分离形态**——段标记在 stdout、工具错误在 stderr 是 npm 的默认行为，单测辅助函数把错误全放 stdout 会掩盖归段 bug；解析纯函数应显式处理「stderr 无段标记」的防御归段。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md` 提交前自查第 10 条（解析类正则多平台样本）可扩展为「分类器测试需覆盖 stdout/stderr 分离形态」

## 相关链接
- 对话记录：v3.2 手工测试 T6.5 修复
- 相关 PR/Commit：（本次提交）
