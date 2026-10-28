# useCallback 新增外部变量漏依赖 + Biome unsafe fix 未放行，连续重试撞墙到熔断

> 日期：2026-10-28　版本：v5.0（工具循环轮数上限可配置：`-t/--max-turns` + `config.maxTurns`，commit `8cf567c`）　严重度：中高（任务在「代码几乎写完、只差 lint 全绿」的位置熔断，最后由人类一条命令收尾）
> 触发场景：给核心命令加 `maxTurns` 参数 → 该参数进入 `src/ui/App.tsx` 的 4 个 `useCallback` 闭包 + 1 个提示判定 `useEffect` → Biome `useExhaustiveDependencies` 报红 → AI 反复执行同一条 `npx biome check --write src/ui/App.tsx` 无效 → 熔断

## 现象

1. **加参数本身很顺**：`maxTurns` 从 `resolveConfig()` 一路传到 `runLoop({ ..., maxTurns })`，业务链路一次改对（4 个调用点：`/plan` 出计划、计划执行、技能循环、主对话循环）。
2. **Biome 两类报错同时出现**（同一文件、同一规则、方向相反）：
   - `executePlan`（以及同型的 `runPlan` / `send`）**漏了** `maxTurns` → `This hook does not specify its dependency on maxTurns`（stale closure 风险）；
   - 提示判定的 `useEffect` 依赖数组里**多加了** `maxTurns`（顺手一起加，实际闭包没用到）→ `This hook specifies more dependencies than necessary`（无谓重算 / 性能告警）。
3. **AI 连续重试无效**：反复跑 `npx biome check --write src/ui/App.tsx`，每次都只见
   ```
   Skipped 1 suggested fixes.
   If you wish to apply the suggested (unsafe) fixes, use the command biome check --write --unsafe
   ...
   Found 1 error.
   ```
   退出码始终 1；中间还出现「手工改了 deps 顺序 / 手工补一处又漏另一处」的抖动（4 处闭包 + 1 处多余依赖，改一处修不好）。
4. **熔断**：连续失败后 AI 停手，任务挂在「代码已落盘、lint 未全绿」的三态现场。
5. **人类一句话解决**：
   ```
   npx biome check --write --unsafe src/ui/App.tsx
   ```
   一次通过，无残留诊断。

## 根因分析

- **直接原因 A（漏依赖）**：React 的依赖数组是**手工维护的清单**，不是自动推导的。给 `useCallback` 闭包新增一个外部变量（`maxTurns`），必须在**每一个**用到它的闭包的依赖数组里同步补上；本次共 4 处（`runPlan` / `executePlan` / `send` 内技能循环 / `send` 内主循环），漏任何一处都是 stale closure，且**运行时不一定立刻暴露**（`maxTurns` 只在达到上限或报错文案里用到，典型「跑起来好像也没事」的静默 bug）。
- **直接原因 B（多依赖）**：同一个参数被「顺手」加进了不相关的 `useEffect` 依赖数组 → Biome 反向报「多余依赖」。所以「闭包地狱」是**双向**的：漏了 = 读到旧值；多了 = 每次渲染都重建，白重算（本例影响提示判定 effect）。
- **直接原因 C（工具使用，真正的熔断点）**：Biome 对 `useExhaustiveDependencies` 的修复**全部是 unsafe 修复**（增、删依赖都会改变重算语义，工具不敢默认替你做）。`biome check --write` 只应用 safe 修复，于是：
  1. 诊断标题只写 `FIXABLE`，`Unsafe fix: …` 只出现在**诊断末尾的 note**里（`i Unsafe fix: Add the missing dependency maxTurns to the list.`）；
  2. `--write` 的 stdout 只有一行 `Skipped 1 suggested fixes.`，**不报错、不失败、不说明为什么跳过**；
  3. 结果：AI 把「命令成功执行了但问题没消失」误读成「我数据/写法不对，再试一次」，于是**同一条命令重跑 N 次**，没有一次带来新信息。
- **深层原因**：缺两条纪律——①「改 hook 闭包变量必须全量扫依赖数组」（代码层）；②「读到 `Skipped N suggested fixes` + `Unsafe fix:` 就该**升级命令手段**，而不是重跑同一条命令」（工具层）。项目规范里「Biome 处理策略」只写了「FIXABLE → 优先 `npm run lint:fix`」，**从未说明不安全修复怎么放行**。

### 实测证据（本次现场复现，临时探针文件已删除）

漏依赖（unsafe：新增）：

```
lint/correctness/useExhaustiveDependencies  FIXABLE
  × This hook does not specify its dependency on b.
  i Unsafe fix: Add the missing dependency b to the list.
  → npx biome check --write probe.tsx：Skipped 1 suggested fixes. / Found 1 error.（退出码 1）
```

多依赖（unsafe：删除）：

```
  × This hook specifies more dependencies than necessary: b.
  i React relies on hook dependencies ... Specifying more dependencies than required can lead to unnecessary re-rendering and degraded performance.
  i Unsafe fix: Remove the extra dependencies from the list.
```

即：**这条规则的两类错误都不是 safe 修复**，`--write` 永远不会自动改，必须 `--unsafe`。

## 解决方案

- **修复方式**（人类一条命令）：
  ```
  npx biome check --write --unsafe src/ui/App.tsx
  ```
  本次 unsafe 放行的风险是可控且可解释的：改动**仅为依赖数组的增删**（无逻辑改写），增 = 让闭包读到新值，删 = 去掉多余重算；放行后照常跑 `npm run verify` 兜住行为回归。
- **最终形态**（`src/ui/App.tsx`，4 处闭包依赖数组都含 `maxTurns`）：
  | 闭包 | 依赖数组收尾处 | 说明 |
  |---|---|---|
  | `runPlan`（`/plan` 出计划） | 约 843 行 | `runLoop({ ...maxTurns })` + 上限文案用真实值 |
  | `executePlan`（计划执行） | 约 917 行 | 同上 |
  | `send`（技能循环 / 主循环） | 约 1661 行 | 内部两处 `runLoop` 都用 `maxTurns` |
  | 提示判定 `useEffect`（T13） | 约 600 行 | **不含** `maxTurns`（闭包未使用；曾多加，biome 报性能告警） |
- **涉及文件**：`src/ui/App.tsx`、`AGENTS.md`（规范联动）、本记录。

## 经验教训

1. **`useCallback` / `useMemo` / `useEffect` 新增外部变量，必须同步更新依赖数组——而且要「全量扫一遍」，不是改一处就完事。** 同一个新参数往往被多个闭包消费（本例 4 处），漏一处就是 stale closure；靠「跑起来没报错」验收不住，只能靠 lint 规则 + 逐个依赖数组核对。反向同样成立：**闭包里没用到的变量不许塞进依赖数组**，那是白重算（本例把 `maxTurns` 塞进提示 effect，被 biome 抓出来）。
2. **遇到 Biome 的 Unsafe fix，果断用 `--unsafe`，切勿反复重试撞墙。** 判据很明确：诊断里出现 `i Unsafe fix: …`，或 `--write` 输出 `Skipped N suggested fixes.`（并附「use the command biome check --write --unsafe」提示），就该**升级命令**，而不是再跑一次同样的 `--write`。同一手段失败两次仍无新信息 → 停手换手段（读完整诊断 / 换命令 / 交人），禁止原样重跑。
3. **`--unsafe` 不是盲用**：只对「语义可解释、范围可枚举」的 unsafe 修复放行（如纯依赖数组增删、import 排序）；放行后必须读 diff + 跑 `npm run verify`，因为 unsafe 的含义正是「可能改变运行时语义」。
4. **诊断标题不够看，要看 note**：`FIXABLE` 只代表「有人能修」，不代表「`--write` 会修」。读 Biome 输出要一路读到 `i`/`⚠` 提示行。
5. **是否需要更新规范**：✅（根因含「规范未说明 unsafe 修复如何放行」「未要求新增 hook 变量时全量核对依赖数组」）
6. **规范更新位置**：`AGENTS.md` → 提交前自查清单**新增第 19 条** + 「代码格式规范 / Biome 处理策略」补充 unsafe 修复处置。

## 相关链接

- 修复提交：`8cf567c`（feat(v5.0): 工具循环轮数上限可配置 + 修 hintsEnabled 假开关）
- 规范位置：`AGENTS.md` 提交前自查清单第 19 条；「代码格式规范 → Biome 处理策略」
- 同型前案（AI 重复无效重试 / 手段不升级导致熔断）：`docs/09-踩坑记录/2026-10-28-Windows管道符串联导致假死与假乱码.md`、`docs/09-踩坑记录/2026-10-28-长任务文档落盘轮次耗尽与子代理滥用.md`
- 规则配置：`biome.json`（Biome 2.5.8，`linter.rules.preset = recommended`，`useExhaustiveDependencies` 由此启用）
