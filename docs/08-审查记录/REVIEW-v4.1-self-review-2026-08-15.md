# REVIEW v4.1 自我审查报告（self-review）

> 审查版本：v4.1.0（体验打磨轮 T1.1~T3.2，117 文件 / 1386 用例全绿）
> 审查日期：2026-08-15 · 审查人：AI 自我审查（独立完成，不参考其他审查者；专家评审 07.9 已确认 9.5/10，4 条建议已落实）
> 方法论（v3.2~v4.0 固化）：**用户角度四问（第一次就跑通？失败怎么办？退出体面？新手上手？）** + 沿数据流追踪（i18n / 超时链路 / 审批流）+ 全项目同类模式扫描（截断 / 错误指引 / 超时 / catch 吞错误）+ 追问控制流语义 + 区分「当前正确 vs 模式脆弱」+ 安全模型完整性 + 国际化盲区

---

## 〇、审查范围

| 模块 | 变更 | 审查重点 |
|------|------|----------|
| utils/（truncate + error-summary） | 新模块 | 截断边界 / 摘要提取准确性 / ANSI 剥离 |
| cli/workflow.ts（摘要+详情 + F 等待 + preflight 接线 + 下一步指引） | 大改 | 失败恢复状态机 / 超时语义 / 审批流 |
| cli/prompt.ts（timeoutMs 扩展） | 小改 | 超时 vs Ctrl+C 语义重叠 / 现有调用回归 |
| workflow/executor.ts（maxRetries: 0 + retry 语义） | 中改 | 内部重试归零边界 / 向后兼容 |
| workflow/preflight.ts | 新模块 | 三维预检 / 原子写 / 失败回滚 / 非 TTY fail-closed |
| workflow/types.ts（retry 语义注释） | 小改 | 文档与代码一致性 |
| cli/index.ts（safeAction fatalNextStep + addHelpText） | 小改 | 帮助文本 / 兜底错误指引 |
| cli/chat.tsx（welcome 引导） | 小改 | 首次标记 / mkdirSync 兜底 |
| i18n zh/en（preflight* / failure* / help* / welcome* 键组） | 中改 | 键同构 / en 无 CJK / 数据流覆盖 |

## 一、用户角度四问（本版核心验收标准）

### 1.1 第一次就跑通？—— ✅ 通过（客户问题 1）

**追问链**：
- 用户装完 precommit 模板直接 `workflow run precommit` → preflight 预检 5 项缺失 → 报告每项标注「可自动初始化」→ 非 TTY fail-closed 停止（不裸失败）✓
- **追问**：交互 TTY 下 y 分支的「操作计划 → 二次确认 → 执行」是否完整？→ preflight.test.ts 10 用例覆盖（含 package.json 原子写失败返回错误不落盘）✓；**发布门已补 node-pty ConPTY 真 TTY 验证**（`scripts/pty-drive.mjs` C1 全 PASS：y → 计划 → y → 真实 `npm install -D @biomejs/biome` → lint 跑通）✓
- **追问**：半完成状态（scripts 已配、依赖未装）重复 run 是否重复安装？→ checkPrerequisites 的「专家细节 1」裁剪：依赖已装 → 裁掉 install；配置已存在 → 裁掉 writeFile ✓（精确到缺失维度）
- **追问**：`npm install -D` 失败（网络/磁盘）会怎样？→ preflightInitFailed 打印真实错误 + return false（停止执行，不半途落盘）✓
- **边界**：自动初始化只做事实标准（lint→biome、typecheck→tsc），test 无法猜框架仅提示——不做激进猜测 ✓（D63 保守边界）

### 1.2 失败怎么办？—— ✅ 通过（客户问题 2/3/5 + 用户反馈 1）

**追问链**：
- 失败界面顺序：`💡 摘要`（tsc/biome/npm/vitest 关键行）→ 截断详情（≤2000 字符）→ R/S/F/A → 摘要提取不准由「兜底首行非空」兜住 ✓
- **追问**：摘要展示与详情截断是否「只展示不丢信息」？→ 摘要仅作首行提示，详情截断仍在下方展示（truncateMiddle 头尾保留），用户仍可看完整失败段（≤4000 字符上限）✓
- F 等待态：Enter 重试 / a 放弃 / 60s 超时自动放弃 → 不挂起 ✓；非 TTY / Ctrl+C → abort（fail-closed）✓；**发布门已补 node-pty 真 TTY 验证**（C2 Enter 重试 / C3 a 放弃回滚 / C4 真实 60s 超时自动放弃，全 PASS）✓
- **追问**：F 等待 60s 超时与用户「正在改代码忘了按 Enter」边界——超时是否误伤？→ 超时前有明确文案「60s 超时自动放弃回滚」；超时走 abort 是安全侧（宁可放弃也不挂起）；用户在超时前可随时按任意键打断等待 ✓
- 进度刷屏根因：executor maxRetries: 0（内部不再静默重试）+ retry 语义重定义（恢复后重试上限，缺省不限 = 旧行为向后兼容）✓
- **追问**：orchestrator 是否受 maxRetries: 0 影响？→ 独立 scheduler 实例（只改 workflow executor 实例化参数），orchestrator 133 用例全绿 ✓
- 失败后「下一步」：`💡 下一步：修复失败步骤后重跑：concertoai workflow run precommit`（runFailedNext）+ safeAction 兜底 fatalNextStep ✓

### 1.3 退出体面？—— ✅ 通过（客户问题 4，v4.0.1 回归）

- workflow/plugin/provider 三处 promptLine 捕获 AbortError → undefined（Ctrl+C 视为正常取消，不写 crash.log、退出码 130 语义）✓（crash-handler.test.ts + prompt.test.ts 回归）
- F 等待态 Ctrl+C → abort（回滚），不残留半状态 ✓
- **追问**：promptLine 超时（undefined）与 Ctrl+C（AbortError → undefined）语义重叠——调用方如何区分？→ 不区分，两者都按「用户未确认 → fail-closed」处理（安全侧）；超时场景调用方（F 等待）本就期望 undefined=放弃 ✓

### 1.4 新手能上手？—— ✅ 通过（用户反馈 2/3）

- `--help`：新手三步（doctor → chat → workflow）+ 命令分组示例（对话/项目/团队/运维/市场）实测 ✓
- 首次 chat 启动欢迎（`.welcome-seen` 标记仅一次，mkdirSync 兜底防全局目录首启不存在崩溃——测试暴露的真实 bug）✓
- **追问**：欢迎是否打扰老用户？→ 仅首次（标记文件），后续不打印 ✓

## 二、数据流追踪

### 2.1 i18n 数据流（zh/en 同构 317/317）

- 新增键组：`workflow.failureSummary/failureStep/failureOptions/failurePrompt/failureFixWait/failureFixPrompt/failureFixInvalid/runFailedNext/preflight*` + `cli.fatalNextStep` + `help.*` + `welcome.*`
- en.test.ts 断言：键同构 + 非空 + 不含 CJK ✓
- **追问**：旧键 `failureFixHint` 是否残留？→ v4.1 键重构为 failureFixWait/Prompt/Invalid，en/zh 双删（i18n 键一致断言覆盖）✓
- **追问**：`fatalNextStep` 曾发现 en 漏键（执行日志 16:14）→ 已补，317/317 一致 ✓

### 2.2 promptLine 超时链路

```
promptLine(prompt, { timeoutMs }) → AbortController 竞速
  ├─ 用户输入 → resolve(input)
  ├─ 超时 → reject(TimeoutError) → 返回 undefined（与 Ctrl+C 同语义）
  └─ Ctrl+C → AbortError → 返回 undefined
调用方：F 等待态显式传 60s；其余调用缺省不超时（行为不变）
```
- **追问**：AbortController 竞速是否泄漏定时器？→ 竞速胜出后 clearTimeout/abort 清理（prompt.test.ts 断言）✓
- **追问**：缺省不超时是否保证现有调用零回归？→ prompt.test.ts 4 用例全过 + workflow/plugin/provider 三处调用未传 timeoutMs ✓

### 2.3 preflight 审批流

```
checkPrerequisites → 无缺失直接通过
有缺失 → 打印报告（每项标注可自动初始化/需手动）
  → autoActions 为空（如仅 test 缺失）→ 询问是否继续
  → 有可自动项 → promptLine(preflightAskInit) → y → 展示计划（安装命令+写文件+scripts）→ 二次确认 → 执行
  → 非 TTY / Ctrl+C → preflightNoTty + return false（fail-closed 停止）
```
- **追问**：用户显式拒绝（n）后继续执行（可能失败）是否违背 fail-closed？→ 不违背：用户是知情拒绝（报告已展示缺失），选择继续是用户显式授权；与「编辑/命令一律审批」基线一致（preflightSkipped 文案明确）✓
- **追问**：安装命令执行顺序（先 install 后 write）失败原子性？→ install 失败 return false 不写文件；write 失败 applyAutoInitWrites 返回错误不落盘（JSON 读写先合并后一次写）✓

## 三、全项目同类模式扫描

### 3.1 截断模式一致性
| 位置 | 上限 | 语义 |
|------|------|------|
| workflow 步骤输出 | 4000 字符（defaultRunCommand） | stdout/stderr 各截断 + truncated 标记 |
| 失败恢复详情 | 2000 字符（truncateMiddle 头尾保留） | 摘要后展示 |
| shell 工具输出 | 20000 字符（既有 D8） | 工具层 |
| read_file | 50000 字符（既有 D8） | 工具层 |

**追问**：工作流链路是否有「未截断」路径？→ defaultRunCommand 是 workflow run 唯一命令执行器（exec 包装），全部经 4000 上限 ✓；truncateMiddle 对 ANSI 剥离（stripAnsi）后再算长度（防中文/ANSI 破坏截断边界）✓

### 3.2 错误「下一步」指引覆盖度
| 错误路径 | 指引 | 状态 |
|----------|------|------|
| workflow run 失败 | runFailedNext（重跑命令） | ✅ |
| workflow 未找到 | workflowNotFound（init/import 提示） | ✅（既有） |
| safeAction 未知异常 | fatalNextStep（doctor/issue） | ✅ |
| plugin 安装失败 | 既有提示（v4.0） | ✅（未改） |
| provider auth 失败 | 既有提示（v4.0.1） | ✅（未改） |

**扫描结论**：v4.1 新增两条指引（runFailedNext / fatalNextStep），与既有指引共同覆盖「用户能看到的错误面」；plugin/provider 未在 v4.1 范围（任务书 T2.1 明确 5 处，其中 3 处既有已覆盖）✓

### 3.3 catch 吞错误模式扫描（踩坑记录 #3 同类）
- **发现**：`loadWorkflow()` `try { parseWorkflowYaml } catch { return undefined }` 吞掉解析错误 → 「工作流不存在」误导（本版手工测试踩坑，已记 2026-08-15-YAML内联列表不支持导致工作流不存在.md）
- **处置（专家评审建议 1 提升，发布前已修复）**：新增 `loadWorkflowResult` 区分「文件不存在（ENOENT → not-found）」vs「解析失败（parse-error + 真实错误含行号）」，CLI run/export + `/workflow` run/export 全部改用；实测 `depends: [lint]` → `工作流 precommit 解析失败：第 7 行：depends 必须是列表…💡 请检查 YAML 语法（块状列表）`；文件不存在 → 仍「工作流不存在」。新增 3 测试（not-found / parse-error / ok）✓
- **同类扫描**：`listWorkflows` catch 返回 []（目录不存在，合理）；`readPackageJson` catch 返回 undefined（预检时缺失=需初始化，语义正确）；`loadWorkflow` 是**唯一**「文件不存在与解析失败混为一谈」的点——**已修复**；parser 直接支持内联列表仍留 v4.2 P1（治本）✓

## 四、边界追问

### 4.1 retry 语义变更的向后兼容
- types.ts 注释更新：`retry = 用户通过 R/S/F/A 恢复后的重试次数上限（缺省不限；0 = 不允许重试；N = 第 N+1 次恢复强制转 abort）`
- **追问**：既有 YAML 里 `retry: 2`（v4.0 语义 = 内部自动重试 2 次）→ v4.1 语义 = 恢复 2 次后强制 abort——行为变化是否可接受？→ 是：v4.0 的 retry 语义从未真正生效（executor 硬编码内部重试，字段被忽略），v4.1 是**首次让字段语义落地**；缺省（无 retry 字段）= 不限 = 与 v4.0 用户可无限 R 的行为一致 ✓（执行日志 16:10 已确认「types 声明 retry 但 executor 硬编码忽略」）
- serializeWorkflowYaml：此前 `retry > 0` 才输出（retry: 0 序列化省略，语义 = 不允许恢复）——**追问**：retry: 0 序列化丢失是否破坏 roundtrip？→ parser 读到缺省 = 不限 ≠ 0 不允许，roundtrip 不等价，静默行为变更。**处置（专家评审建议 2，发布前已修复）**：`serializeWorkflowYaml` 保留 `retry: 0` 输出，roundtrip 等价；新增测试断言 `retry: 0` 保留 ✓

### 4.2 F 等待态超时误伤边界
- 60s 固定值（FIX_WAIT_TIMEOUT_SECONDS）：短任务用户可能刚好 60s 内改完——超时前有明确文案提示，且 abort 是安全侧（回滚不产生半状态）✓
- 不提供配置项（v4.1 不做配置面扩张）——v4.2 可考虑 `workflow.fixTimeoutSeconds` 配置 ✓

### 4.3 welcome 标记文件
- `~/.concertoai/.welcome-seen`：并发启动 chat（两个进程）可能重复打印欢迎（标记写非原子）——影响极低（仅首次打印多一行），不阻塞 ✓
- mkdirSync 兜底：全局目录首启不存在（chat 前无任何命令创建过）——测试暴露并修复 ✓

## 五、安全模型完整性

| 安全基线 | v4.1 落实 |
|----------|-----------|
| 编辑与命令一律审批 | preflight 自动初始化安装命令走 execAsync（经 preflightAskInit + preflightConfirm 二次 y/N 审批）；writeFile 写 package.json/biome.json 走二次确认后执行 ✓ |
| fail-closed | 非 TTY preflight → 停止执行；F 等待非 TTY/Ctrl+C/超时 → abort；promptLine undefined → 拒绝 ✓ |
| 路径沙箱 | preflight 写文件限定 cwd 内相对路径（biome.json/package.json），无 `..` 逃逸面 ✓ |
| 审批拒绝不自动重试 | 自动初始化拒绝后 return true（用户选择继续）或 false（停止），无自动重试 ✓ |
| 不落半状态 | applyAutoInitWrites 先合并 scripts 一次写 + 写后无校验需回滚时返回错误不落盘 ✓ |
| 输出敏感信息管控 | 智能错误摘要只匹配工具链固定格式行（tsc `error TS…` / biome `× Found N errors` / npm `npm error` / vitest `FAIL`），**不展示 stderr 任意首行**（避免路径/用户名/环境变量被摘要带出）；详情截断保留但由用户主动查看；provider auth Key 输入不回显（v4.0.1 已确保）——当前实现已满足，审查报告明确此边界 ✓ |

## 六、结论

| 项 | 结果 |
|----|------|
| 阻断问题 | 0 |
| 非阻塞建议（v4.2） | ① parser 内联列表支持（报错传播已修，治本留 v4.2 P1）② F 等待超时可配置化 ③ welcome 标记原子化 |
| 一致性 | 117 文件 / 1390 用例全绿，npm audit 0 漏洞；文档（CHANGELOG/ARCHITECTURE/TASKS/AGENTS/README/07.9）数字全部一致 |
| 专家建议落实 | 07.9 评审 4 条（复现命令 / 踩坑记录 / verify 耗时 / 测试文件路径）+ 自审评审 4 条（loadWorkflow 错误传播发布前修复 / retry:0 roundtrip 发布前修复 / 安全模型补输出敏感信息管控 / 待办补 CHANGELOG 确认）全部落实 |
| 发布建议 | ✅ 可发布（剩余：版本号已联动 4.1.0 → npm publish + tag → 工作区归零） |

## 七、发布前待办

1. `npm whoami` 验证令牌 → `npm publish`（prepublishOnly=verify 全绿）→ `git tag v4.1.0` + push
2. 发布后 `git status` 确认工作区归零（自查 #13）
3. TASKS.md 看板已更新（v4.1 M1/M2/M3 完成）
4. **CHANGELOG [4.1.0] 条目确认**（专家建议 4）：Added（摘要截断 / preflight / 下一步指引 / help+欢迎）+ Changed（F 等待态 / maxRetries 归零 + retry 语义 / i18n 键重构 + **发布前修复：loadWorkflow 错误传播 + retry:0 roundtrip**）+ 测试基线 117/1390——与 07.9 手工测试报告数字一致

---

*自我审查完成：聚焦用户角度四问（第一次跑通 / 失败怎么办 / 退出体面 / 新手能上手）、promptLine 超时 vs Ctrl+C 语义重叠、retry 语义变更向后兼容、preflight 审批流 fail-closed、全项目 catch 吞错误模式扫描（发现 loadWorkflow 误导并如实列入 v4.2）、ANSI 剥离截断边界。*
