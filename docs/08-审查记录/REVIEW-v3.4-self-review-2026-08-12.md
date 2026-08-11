# REVIEW v3.4 自我审查报告（self-review）

> 审查版本：v3.4.0（工作区基线：M1+M3+M2 全部落地，89 文件 / 1044 用例全绿）
> 审查日期：2026-08-12 · 审查人：AI 自我审查（独立完成，不参考其他审查者）
> 方法论（v3.2/v3.3 固化）：i18n 文案层沿数据流追踪 / 全项目同类模式扫描 / 追问控制流语义 / 区分「当前正确 vs 模式脆弱」/ 边界与国际化盲区扫描

---

## 一、审查范围

| 模块 | 变更 | 审查重点 |
|------|------|----------|
| M1：collectKeys maxDepth（en.test.ts） | 深度防护 | 递归边界 / 现有字典误伤 |
| M1：feedback i18n（model/snapshot-guard + i18n 字典） | 8 键新增 + 5+3 处替换 | 键同构 / en 全路径无中文 / 占位符完整性 |
| M1：正则去 gm（classifier/edit/read/tokenizer/planner） | 5 文件 | lastIndex 语义 / 行为等价 / 变体复核盲区 |
| M1：en CJK 校验（en.test.ts） | 断言增强 | 误伤场景 / 负面测试有效性 |
| M3：doctor --vscode（vscode-health.ts + doctor.ts + index.ts） | 新模块 559 行 | 平台路径 / 解析健壮性 / 降级路径 / i18n / 权限 |
| M2：文档同步（CHANGELOG/ARCHITECTURE/TASKS/AGENTS/07.7） | 5 文件 | 数字一致性 / 目录树 / 版本号联动 |

## 二、逐项审查发现

### 2.1 S-C1 collectKeys maxDepth —— ✅ 无问题

- 深度参数 `depth = 0, maxDepth = 5`，`depth >= maxDepth` 在**进入下一层前**判断：根对象 depth=0 不抛，6 层嵌套抛（depth=6 ≥ 5）✓
- 现有字典最深 2 层（selfHeal.phaseVerify），远低于 5 ✓
- 错误信息含 maxDepth 值与路径，可定位 ✓
- **边界追问**：maxDepth=5 是否够？en/zh 字典未来新增 doctor.vscode 28 键（2 层）+ selfHeal.feedback（2 层），均 ≤2 层，5 层余量充足 ✓

### 2.2 I1 feedback i18n —— ✅ 通过，但有一个可改进点（非阻塞）

- `suggestionFor` 5 个 stage 全走 `t()`：build/test/type/lint/default ✓
- `type` 分支用 `fmt(d.feedbackTypeError, { code })`，占位符 `{code}` 与 zh/en 模板一致 ✓
- snapshot-guard 3 处：denied / writeFailedRolledBack / writeFailed 走 `t()` ✓
- **沿数据流追踪**：`repair.ts` 第 3 类（复杂错误）`suggestionFor(e)` → `feedback[]` → `slash/self-heal.ts` `fmt(d.notFixed, { suggestion })` 展示。en 下 suggestion 为英文 ✓；`notFixed` 模板本身 v3.3 已 i18n ✓
- **可改进点（非阻塞）**：`repair.ts` 的 `log()` 调试日志仍有中文（如「剩余错误不可自动修复，转人工」），但属调试输出非用户可见报告，与 v3.3 I4 判定一致（日志语言化另立专题），不在本任务范围
- **边界**：`generateModelFixPlan` 失败路径 `suggestionFor(error)` 也走 i18n ✓

### 2.3 I2 正则去 gm + 全项目复核 —— ✅ 通过，有一处需说明

- `TSC_ERROR_RE`/`TSC_ERROR_PRETTY_RE` 去 gm，使用处 `new RegExp(source,'gm')` 行为等价（matchAll 需要 g）✓
- **同类模式扫描（关键）**：用 `const X = /…/[gimy]` 全量扫描 src+tests，命中 9 处 → 处理 5 处带 g/u（ANSI_RE / SECRET_PATTERN / CJK_RE / FILE_REF_RE / mapOffset `\r\n`）→ 剩 4 处 `/i` 单独（qa timedOut、common prefix、BUILD_FAIL_RE、DEPENDS_ON_RE），均 `.test()` 无 lastIndex 陷阱 ✓
- **追问控制流**：`FILE_REF_RE` 原为 `gim` 常量跨步骤 exec 循环（planner/deps.ts extractSteps 内多个 step.description 复用同一常量）——这是**潜在 lastIndex 残留 bug**（step 间 exec 会从上次 lastIndex 继续），本次改为每 step `new RegExp(source,'gim')` 实为修复而非纯风格；但**无测试断言该行为差异**（现有 deps 测试恰好未触发跨 step 残留，因为每个 step 都恰好匹配完整）。已加注释说明。**风险评估**：低（行为等价于「每 step 新建」，消除了原跨 step 残留隐患）
- `mapOffset` 用 `matchAll` 内联字面量（Biome 要求字面量而非 new RegExp）——`matchAll` 返回迭代器，`m.index` 可用 ✓，行为与原 exec 循环等价（都是全局推进）

### 2.4 I3 en CJK 校验 —— ✅ 无问题

- 断言 `not.toMatch(/[\u4e00-\u9fff]/)`：CJK 统一表意文字区，英文文案中不会出现 ✓
- **误伤扫描**：en 字典是否有 CJK 标点（`。`/`，`/`「」`）？不在 \u4e00-\u9fff 区间（标点在 \u3000-\u303F / \uFF00-\uFFEF），本次新增 en 键无 CJK 标点 ✓
- 负面测试用 `expect().toThrowError` 包裹循环，断言会因 mock 含中文而失败 → 测试红 ✓

### 2.5 M3 doctor --vscode —— ✅ 通过，发现并修复 3 个实现期问题

审查中发现的关键问题（均已在实现期修复并补测试）：

1. **平台路径 `path.join` 在 Windows 测试环境用反斜杠** → 修复：`platformPath()` 按 `env.platform` 选 `path.win32/path.posix`，测试注入 POSIX 平台时路径正确（修复后 crashpadDirFor/argvJsonPathFor 三平台样本通过）
2. **`checkArgvJson` 用 `raw.includes('disable-extension')` 会把复数键误判为单数子串** → 修复：正则完整 JSON 键匹配 `["']disable-extension["']\s*:`，复数键不再误报单数；兼容单/双引号 jsonc 方言
3. **进程数诊断对 `exitCode !== 0` 未降级**（解析空输出得 0 误报正常）→ 修复：非 0 退出 → 「无法检测」

**架构追问**：
- 依赖注入（exec/readFile/scanDir）覆盖所有外部 IO，测试不真跑 tasklist/ps/code ✓
- `defaultExec` 用 `shell: true`（Windows）满足跨平台 .cmd 执行 ✓；5s 超时 + kill 降级 ✓
- **权限边界**：诊断只读，破坏性动作（del / rm / code --disable-extension）仅作为**建议命令字符串**输出，不代执行 ✓（符合 §3.5 环境健康可观测原则）
- **i18n**：doctor.vscode 28 键 zh/en 同构，en 全英文过 CJK 断言 ✓
- **无效位置检测**：`verifyArgvJson` 先查 `%APPDATA%\Code\argv.json` 再查实际位置，两者独立 try/catch ✓
- **边界**：`detectAiExtensions` 读取 argv.json 失败时 `disabledIds=[]` → 所有已装 AI 扩展都报「未禁用」→ 这是**保守正确**（无法确认已禁用时报告警，fail-safe）✓

### 2.6 M2 文档同步 —— ✅ 通过（自查第 7/8/11 条）

- 数字一致性：CHANGELOG/ARCHITECTURE/TASKS/AGENTS/07.7 全部 89 文件 / 1044 用例一致 ✓
- 版本号：CHANGELOG [3.4.0]、ARCHITECTURE v3.4、AGENTS v3.4.0、TASKS v3.4 ✓（发布动作 T2.4 前 src/version.ts 仍为 3.3.0，属预期——发布时统一 bump）
- 目录树：ARCHITECTURE §5 新增 vscode-health.ts 行 + 全景图 doctor.ts 行 ✓
- 执行日志：execution-log-20260812-003206.md（文档任务）+ 本次 M1/M2/M3 日志待补——**发现遗漏**：本次 M1/M3 编码执行日志未单独落盘（仅有文档任务日志），将在提交前补 execution-log（见下方「待办」）

## 三、结论

| 项 | 结果 |
|----|------|
| 阻断问题 | 0 |
| 非阻塞建议 | 2（repair.ts 调试日志中文——与 v3.3 I4 一致，另立专题；FILE_REF_RE 跨 step lastIndex 无回归测试——已注释说明，风险低） |
| 一致性 | 89 文件 / 1044 用例全绿，npm audit 0 漏洞 |
| 发布建议 | ✅ 可发布（T2.4 前补执行日志 + 版本号联动） |

## 四、待办（T2.4 发布前）

1. 补 M1/M3 编码执行日志落盘（execution-log-20260812-*.md）
2. 版本号联动：package.json + package-lock.json + src/version.ts + tests/smoke.test.ts → 3.4.0
3. `npm whoami` 验证令牌 → `npm publish` → `git tag v3.4.0`

---

*自我审查完成：独立于 C 审查视角，聚焦 i18n 数据流、正则变体盲区、平台路径语义、降级路径与文档一致性。*
