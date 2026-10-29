# REVIEW v5.0 自我审查报告（用户视角）

> 审查版本：v5.0.0（4 动词 check / commit / review / init + 场景提示 + 审批透明化 + K16/K7 假绿修复）
> 审查日期：2026-10-30 · 审查人：concertoai-loop（AI 自我审查，独立完成）
> 审查视角：**用户视角四问**（任务书 T23.4 要求）——① 第一次就跑通？② 失败怎么办？③ 退出是否体面？④ 新手能否上手？
> 方法论：**真实进程探针**（隔离 HOME + 删除 `DEEPSEEK_API_KEY` + 空目录 + 无 TTY），不是读代码推断。下文每条结论都附实测输出。

---

## 〇、审查范围与方法

### 0.1 覆盖的命令（13 个探针）

| # | 场景 | 为什么测这个 |
|---|---|---|
| A1 | 空目录裸跑 `concertoai` | 新用户的第一脚 |
| A2 | 空目录 `doctor` | 「我环境到底行不行」 |
| A3 | 空目录（非 git）`review` | v5.0 新动词在错误目录的表现 |
| A4 | 未知命令 `bogus-xyz` | 敲错字 = 最高频的失败 |
| A5 | 无 `verify` 脚本的 `check` | K7 修复的场景 |
| A6 | `--help` | 首屏能否让人上手 |
| A7 | `--version` | 版本联动是否生效 |
| A8 | 空目录 `chat` | 缺 Key 时的主路径 |
| A9 | 空目录 `run hello` | 非交互路径 |
| B1 | 未知选项 `--bogus-opt` | 同 A4，另一种形态 |
| B2 | 非 git 目录 `commit` | v5.0 新动词 + 失败引导 |
| B3 | `review --help` | 子命令自解释能力 |
| B4 | 非 Node 项目 `check` | 生态不匹配时的说法 |

### 0.2 探针环境（可复现）

```js
// 隔离 HOME：不读开发机真实配置（否则「第一次跑」被我的既有配置污染）
const env = { ...process.env, USERPROFILE: home, HOME: home, LUMEN_LOCALE: 'zh' };
delete env.DEEPSEEK_API_KEY;   // 新用户没配 Key 的真实状态
// cwd = 空目录（不是 git 仓库、没有 package.json）
```

> **为什么必须隔离**：我本机有 `~/.concertoai/config.json` 和有效 Key。直接在项目根跑探针，看到的是「一个用了半年的人」的体验，不是「今天刚装上的人」的体验。

---

## 一、第一次就跑通？—— **基本跑通，有一处英文漏窗**

### 1.1 裸跑 `concertoai`（空目录、无 Key）✅ 好

```
⚠️  未检测到 DeepSeek API Key —— ConcertoAI 需要它来调用模型

任选一种方式配置（推荐方式 1，当前终端立即生效）：

  1. 设置环境变量
     PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."
     cmd.exe:     set DEEPSEEK_API_KEY=sk-...
     bash/zsh:    export DEEPSEEK_API_KEY=sk-...

  2. 登录账号（保存到本地，之后无需重复配置）
     concertoai login myname --key sk-...
     （交互式输入不回显：concertoai login myname）

  3. 写入配置文件（目录不存在时需先创建）
```

**评价**：这是全项目最好的一个失败文案。三件事做得对——
1. **按终端分语法**（PowerShell / cmd / bash 三份，不要求用户自己翻译）；
2. **给了推荐顺序**（「推荐方式 1，当前终端立即生效」——解释了为什么推荐，不只是「推荐」）；
3. **提前回答安全问题**（「交互式输入不回显」）。

exit = 1 ✅（缺 Key 就是没跑成，不该退 0）。

### 1.2 `concertoai doctor`（空目录、无 Key）✅ 好

```
ConcertoAI 环境诊断
✅ Node.js: v22.23.2
✅ 平台: win32
❌ API Key: 未设置（无法查询余额）
✅ 配置文件: ...\home\.concertoai\config.json（不存在，使用默认配置）
✅ 会话目录: ...（可写）
✅ 模型表: 2 个模型（deepseek-v4-flash / deepseek-v4-pro）
✅ 账号完整性: 无 active 账号（可运行 concertoai login <name> 登录）
❌ 账户余额: 未查询（未配置 API Key：环境变量 / concertoai login / 写 config.json 任一方式即可）
💰 模型推荐: 推荐 deepseek/deepseek-v4-flash（月成本预估 ¥5.69）——默认组合，成本/质量均衡
  本地 Ollama 探测失败（未推荐本地模型）
✅ 配置迁移完整性: 配置仍为 v3 格式（schema v1），启动时将自动迁移
```

**评价**：每一项 ❌ 后面都跟了「怎么办」，不是只报状态。`💰 模型推荐` 给了**具体金额**（¥5.69）而不是「很便宜」——这正是「低成本」定位该有的证据。

### 1.3 `--help` 首屏 ✅ 好（有一处混排，见 §6-C2）

```
Usage: concertoai [options] [command]
ConcertoAI —— 敢让你用来改生产代码的个人超级 CLI
Options:
  -V, --version         output the version number
  -h, --help            display help for command
快速开始（3 步）
  ① 检查环境    concertoai doctor
  ② 生成规则    concertoai init
  ③ 开始对话    concertoai chat
```

**评价**：「快速开始（3 步）」放在首屏，新手不用读完整 help。

### 1.4 `concertoai review`（有 Key、401 无效 Key）✅ 本轮已修好

见 §5 探针通电证明。修复前是 `TypeError` 崩溃（连报告都出不来），修复后是完整的「0/9 维已审 + 原因 + 下一步」。

### 1.5 `--version` ⏳ 仍是 `4.1.1`

符合约定——版本联动 6 处等 publish 前统一改，不在自审阶段做。**发布前必须复核这一条。**

---

## 二、失败怎么办？—— **四个失败面全部体面，一个不体面**

| # | 失败场景 | 用户看到什么 | 是否给下一步 | 评价 |
|---|---|---|---|---|
| 1 | 缺 Key | 三种配置方式 + 终端分语法 | ✅ 给了 3 条路 | ✅ 好 |
| 2 | 非 git 目录 `commit` | `❌ 当前目录不是 git 仓库（找不到 .git）` + `git init` 具体命令 | ✅ | ✅ 好 |
| 3 | 非 Node 项目 `check` | `⚠️ 当前目录没有可读取的 package.json —— 这里不是 Node 项目` + 建议 pytest/cargo test | ✅ | ✅ 好 |
| 4 | 审查子代理全失败（K16） | `本次审查未完成（0/9 维已审）` + 原因 + 下一步 | ✅ | ✅ 本轮修好 |
| 5 | **敲错命令** | `error: too many arguments. Expected 0 arguments but got 1: bogus-xyz.` | ❌ | 🟡 **不体面** |
| 6 | **敲错选项** | `error: unknown option '--bogus-opt'` | ❌ | 🟡 **不体面** |

### 2.1 非 git 目录 `commit`（实测）✅

```
📝 准备提交
❌ 当前目录不是 git 仓库（找不到 .git）。
💡 先初始化仓库：`git init`，然后 `git add` 你的改动，再运行 `concertoai commit`。
```

**评价**：说清了「为什么」，并把完整的三步命令给了出来（不是只说 `git init`，还说了 `git add` 和「然后再跑我」）。新手照抄能走通。

### 2.2 非 Node 项目 `check`（实测，同时验证 K7 场景）✅

```
🔍 提交前体检
⏸️ build  未配置检测脚本
⏸️ lint   未配置检测脚本
⏸️ type   未配置检测脚本
⏸️ test   未配置检测脚本

⚠️  当前目录没有可读取的 package.json —— 这里不是 Node 项目，无法体检。
💡 请在项目根目录运行；非 Node 项目请用对应生态的工具（如 pytest / cargo test）。
```

**评价**：`⏸️ 未配置检测脚本` 用的是「暂停」而不是「失败」——**这正是 K7 的同一个思路**（没脚本 ≠ 测试挂了）。文案还给了其它生态的替代工具，没有把非 Node 用户晾在原地。

### 2.3 🟡 敲错命令 —— **唯一的真缺口**

```
$ concertoai bogus-xyz
error: too many arguments. Expected 0 arguments but got 1: bogus-xyz.

$ concertoai --bogus-opt
error: unknown option '--bogus-opt'
```

**问题（三点，都是「中文优先」定位的直接违背）**：

1. **全英文**。项目定位第一条是「全中文交互与反馈」，而这是新用户**最可能撞到**的一条路径（打错字）；
2. **没有说清发生了什么**。`too many arguments. Expected 0 arguments but got 1` —— 用户以为自己参数给多了，实际是**命令名不存在**；这句报错把人指向了错误的方向；
3. **没给下一步**。既不提示 `concertoai --help`，也不列可用命令，也不做「你是不是想输入 xxx」的模糊匹配。

**根因（代码定位）**：`src/cli/index.ts` 末尾直接 `program.parse()`，全程没有：
- `program.configureOutput(...)` 定制输出；
- `program.exitOverride(...)` 接管退出；
- 通配子命令 `.command('*')` 兜底未知命令。

于是所有解析层错误都走 commander 的英文默认实现。`src/i18n/zh.ts` 里也搜不到任何 `unknownCommand` / `unknownOption` 类键（已核，0 命中）——**即从来没有为这条路径写过中文**。

**定级 🟡（不阻塞发布）的理由**：它是**存量问题**，不是 v5.0 引入；exit code 是 1（不假绿）；不损坏数据。但它确实让「新手第一脚踩空」，建议 v5.1 第一批修。

**建议修法（v5.1）**：`.command('*', ...)` 兜底 + 中文文案 + 最相近命令提示（Levenshtein 距离 ≤2 建议 `concertoai review`），全部走 i18n（zh/en 两侧同构）。

### 2.4 审查子代理全部失败（K16，本轮修复）✅

修复前（实测崩溃）：
```
[ConcertoAI] 命令执行失败: Cannot read properties of undefined (reading 'length')
TypeError: Cannot read properties of undefined (reading 'length')
    at incompleteCount ... at ReviewerEngine.formatReport ...
```

修复后（实测）：见 §5。**这是本轮自审最重要的一条**——修复声明与真实行为不一致，只有真跑才看得出来。

---

## 三、退出是否体面？—— **13 个探针，退出码全部合理**

| 探针 | exit | 语义上是否该非 0 | 判定 |
|---|---|---|---|
| A1 裸跑（无 Key） | 1 | 是（没跑成） | ✅ |
| A2 doctor（有 ❌ 项） | 1 | 是（环境不全） | ✅ |
| A3 review（无 Key） | 1 | 是 | ✅ |
| A4 未知命令 | 1 | 是 | ✅（码对，文案差） |
| A5 check（非 Node） | 1 | 是 | ✅ |
| A6 --help | 0 | 否 | ✅ |
| A7 --version | 0 | 否 | ✅ |
| A8 chat（无 Key） | 1 | 是 | ✅ |
| A9 run（无 Key） | 1 | 是 | ✅ |
| B1 未知选项 | 1 | 是 | ✅（码对，文案差） |
| B2 commit（非 git） | 1 | 是 | ✅ |
| B3 review --help | 0 | 否 | ✅ |
| B4 check（非 Node） | 1 | 是 | ✅ |
| **K16 401 全失败** | **1** | **是（关键）** | ✅ **本轮修复的核心** |

**没有一条「该非 0 却退 0」**（这正是 K1/K16 那类假绿的特征）。`--help` / `--version` 退 0 也正确——它们是成功查询，不该让脚本误判失败。

> **特别说明 K16 的退出码**：修复前它**碰巧**也是 1（因为崩了）。所以「exit 1」本身不能证明修好了——必须同时看**退出码理由**是否被正确表达（报告有没有说清 0/9 维 + 原因）。这就是为什么本轮验收要求三条同时成立：exit 1 **且** 0/9 文案 **且** 原因文案。

---

## 四、新手能否上手？—— **能，路径清晰；两个小摩擦**

### 4.1 学习路径（实测可达）

```
① concertoai doctor   → 13 行诊断，逐项 ✅/❌ + 建议（实测可用）
② concertoai init     → 生成 AGENTS.md（给 AI）+ PROJECT_GUIDE.md（给人）
③ concertoai chat     → 开始对话（缺 Key 时给三种配置法）
```

这三步在 `--help` 首屏就以「快速开始（3 步）」列出，**不需要先读文档**。

### 4.2 摩擦点 1：`init` 的产出区分度

`--help` 里写明「生成 AGENTS.md 给 AI + PROJECT_GUIDE.md 给你」——**一份给机器、一份给人**的区分讲清楚了。这一点比多数同类工具好（它们通常只生成一份 CLAUDE.md 式的文件）。

### 4.3 摩擦点 2：英文尾巴（🟡，同 §2.3）

主 help 与子命令 help 的选项说明里混着 commander 默认英文：

```
  -V, --version         output the version number
  -h, --help            display help for command
```

中文产品里出现英文选项说明。**不影响可用性**（用户看得懂 `--version` 的作用），但破坏了「全中文」的一致性。建议与 §2.3 一起在 v5.1 处理：`.configureHelp()` 或统一改写 `description`。

---

## 五、本轮修复复核：K16 / K7 的探针通电证明

### 5.1 修复内容（提交 438a8b4）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/reviewer/types.ts` | 新增 `reviewGroupOfAgentName()`（唯一映射入口，取不到返 `undefined`） | 干掉 `def.name as ReviewAgentGroup` 这个「类型对了、值是 undefined」的 `as` |
| `src/reviewer/types.ts` | `incompleteCount()` 加 `Array.isArray` 守卫 | 宁可少算一维，不许整条 `review` 崩 |
| `src/reviewer/engine.ts` | Step 2 花 token **之前**校验名字→分组映射 | 编程缺陷在付费前暴露，不等聚合阶段炸 |
| `src/reviewer/engine.ts` | 聚合阶段改用函数 + 类型收窄，删掉 `as` | 同第一行 |
| `src/reviewer/dimensions.ts` | 删除重复的 `AGENT_DIMENSIONS_MAP`，改用 `AGENT_DIMENSIONS` | 同一事实只有一处，防两处漂移 |
| `src/reviewer/dimensions.ts` | `classifySubagentFailure`：`turn-limit` 判定前移 + network 正则去掉裸「代理」 | **写测试时抓到的真 bug**：spawner 原话「子代理达到 5 轮上限」被归成「网络不可达」 |

### 5.2 通电自证（关键：证明测试不是空转）

把 `as` 硬转**放回** `engine.ts`，再跑新增的端到端用例：

```
× ★ 401 全失败 → exit 1，且报告写「0/9 维已审」+「认证失败」+「未定义 verify 脚本」
× 部分失败：只有 security 组 401 → 「8/9 维已审」且只标这一维
× 模型回了非 JSON（乱码）→ 也算「没审到」，记 parse-failed 并 exit 1
✓ 反向自证：9 维全审到 + 零问题 → exit 0（这条不受影响，符合预期）
TypeError: Cannot read properties of undefined (reading 'join')
Tests  3 failed | 1 passed
```

**放回去就红、改回来就绿** —— 证明这 4 条用例真的盯着这个缺陷，不是摆设。恢复修复后全绿。

### 5.3 修复后真实 401 探针（假 Key 打官方端点，0 花费）

```
**自动测试**：✅ 通过
**严重程度**：🔴 严重 × 0 · 🟡 中等 × 0 · 🟢 建议 × 0

### 本次审查未完成（0/9 维已审）
> ⚠️ 这不是「没问题」——下面这些维度**没有审到**，请先解决原因再重跑。
- architecture / style：认证失败（API Key 无效或已过期）… → 检查 Key：concertoai doctor；…
  …（5 组逐条，各带 HTTP 401 原文与 request_id）

⚠️ 本次没有发现任何问题，但**审查未完成**（见上）——不能当作「代码没问题」。

🧮 9 维分级
  architecture：⚠ 未审到（认证失败（API Key 无效或已过期））
  …（9 维逐条）

⚠️ 结论：本次审查不完整（9/9 维没审到：认证失败）——不代表「没问题」，退出码 1。
💡 下一步：按上面的「未完成」原因逐条处理后重跑 `concertoai review`；没审完的报告不能当作通过。
```

exit = 1 ✅。三条验收同时成立：**退出码** + **N/9 计数** + **原因与下一步**。

> **诚实说明**：本探针里「自动测试」显示 **✅ 通过**（不是「未运行」）。因为**被审的是本仓库**，而本仓库有 `verify` 脚本，K7 三态走的是「通过」那一支。「未运行（项目未定义 verify 脚本）」那一支由 mock 用例取证（临时目录只放 `scripts.test`、不放 `verify`），见 `tests/cli/review.test.ts`。**不能用真实探针冒充那个分支。**

---

## 六、发现的问题清单（分级 + 是否阻塞发布）

| 编号 | 问题 | 等级 | 是否阻塞 v5.0 发布 | 理由 |
|---|---|---|---|---|
| C1 | 未知命令 → commander 英文 `too many arguments...` | 🟡 | **否** | 存量问题（非 v5.0 引入）；exit 1 不假绿；但违背「中文优先」，建议 v5.1 首选 |
| C2 | help 选项说明混英文（`output the version number` / `display help for command`） | 🟡 | **否** | 不影响可用性，与 C1 同源，一起改 |
| C3 | `review` 在非 git + 无 Key 时先报「缺 Key」，未先提「没有可审查改动」 | 🟢 | 否 | 两种顺序都说得通；配了 Key 后会继续走并有明确提示 |
| C4 | 报告「📊 汇总」表在 0 问题/全未审时只剩表头（空表） | 🟢 | 否 | `formatReport` 既有行为（只列有问题维度），非本轮引入 |
| C5 | 未完成行的 `detail` 内嵌原始 JSON，截 160 字仍偏长 | 🟢 | 否 | 可读性问题，信息量足够（含 request_id 便于排查） |

> **C1/C2 的共同根因**：解析层（commander）从未做过本地化，而业务层做了 i18n。这是「分层不一致」而非「某一个文案忘了写」。修的时候应该一次把 `configureOutput` / `configureHelp` / 通配命令补齐，而不是逐条补文案。

---

## 七、发布门逐条自核（v5.0 任务书 13 条）

| # | 门 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| 1 | 功能门（T1-T22） | ✅ | TASKS 看板 3/4 收尾；4 动词已落地 |
| 2 | 测试门（verify 全绿） | ✅ | **2254 passed / 155 files**（本轮 +29）；`LUMEN_LOCALE=en` 复跑亦 2254 全绿 |
| 3 | 性能门（审批 P95 < 150ms） | ✅ | T23.1 已实测（bench 8/8，见 docs 07.11） |
| 4 | 安全门（审批强度与 v4.1.1 一致） | ✅ | T23.1 安全回归 174 用例全绿 |
| 5 | 一致性门（CLI 与 TUI 同结构） | ✅ | `tests/cli/review.test.ts` 逐行相等断言（既有） |
| 6 | 边缘路径门（首次/失败恢复/主动退出/超长截断） | 🟡 | 首次 ✅、失败恢复 ✅（除 C1 文案）、超长截断 ✅；**「主动退出」本轮未实测**（07.11 已有 PTY 结论） |
| 7 | 噪音门（提示不刷屏） | ✅ | T12/T13 + `/hints off`（07.11 实测） |
| 8 | 安全边界门（4 动词无 push/force/--no-verify） | ✅ | 护栏测试通过 |
| 9 | 隐私门（metrics 默认 off、零网络） | ✅ | 源码扫描断言通过 |
| 10 | 文档门 | ⏳ | 待最终同步（CHANGELOG/ARCHITECTURE/README 版本行等） |
| 11 | 手工测试报告 | ✅ | `docs/07.11-手工测试报告-v5.0.md`（8 场景 124 PASS / 1 FAIL + 12 已知问题） |
| 12 | 自审报告 | ✅ | **本文件** |
| 13 | 版本归零门 | ⏳ | 版本联动 6 处待 publish 前统一改（约定） |

**结论：除第 10/13 门（按约定在 publish 前做）外，其余全绿；第 6 门有一处文案缺口（C1）已如实记录，不阻塞。**

---

## 八、总体结论

### 8.1 四问作答

| 问 | 答 | 一句话理由 |
|---|---|---|
| 第一次就跑通？ | **基本能** | 裸跑/doctor/help 都把「下一步」写清了；缺 Key 的引导是标杆级文案 |
| 失败怎么办？ | **能** | 缺 Key / 非 git / 非 Node / 审查全失败 四个面都给了具体命令；只有「敲错命令」是英文空话 |
| 退出是否体面？ | **体面** | 13 个探针无一「该失败却退 0」，也无一条崩溃栈直出（K16 修复后） |
| 新手能否上手？ | **能** | `--help` 首屏 3 步、doctor 逐项诊断、init 双输出分「给 AI / 给人」 |

### 8.2 本轮最重要的收获（写给下个版本）

**「修好了」不能用「代码改了 + verify 全绿」证明。**

K16 第一版修复（3e3ba6a）加了 495 行代码、0 行测试，2225 条用例全绿，`git log` 上写着「失败子代理计入未完成 + 报告写原因 + exit 1」——但真实 401 探针一跑就是 `TypeError` 崩溃。

它之所以能混过去，是因为**没有任何用例走到那条路径**。屏幕上的绿只证明「已测的路径是通的」，不证明「新写的那条路是通的」。

所以本轮的验收方式是三条一起看：**① verify 绿 ② 探针跑出真实输出 ③ 把缺陷放回去看测试会不会红**。三条缺一条，就还是纸面验收。

### 8.3 发布建议

**建议发布**，附三条前置：

1. 版本联动 6 处 → `5.0.0`（`package.json` / `package-lock.json` 顶部 2 处 / `src/version.ts` / `tests/smoke.test.ts` / `README` 状态行；`@concertoai/cli@4.1.1` 段标记 5 个测试文件一并 bump）；
2. 改完立即 `npm run verify` 复跑（版本号变更是硬编码相关改动，必须重验）；
3. `npm whoami` 必须输出 `mmclqx`（**本轮已实测确认**），发布后 `npx @concertoai/cli --version` 应为 `5.0.0`。

**不建议**因 C1/C2 阻塞发布：它们是存量问题、不假绿、不损坏数据，且 v5.0 的主要价值（4 动词 + 假绿修复）与它们无关。但**必须**在 TASKS 里留条目，避免「只在对话里说过」。

---

## 九、附：本轮探针脚本（可复现）

```js
// 隔离 HOME + 删 Key + 空目录，13 个场景
import { spawnSync } from 'node:child_process';
const env = { ...process.env, USERPROFILE: home, HOME: home, LUMEN_LOCALE: 'zh' };
delete env.DEEPSEEK_API_KEY;
const probes = ['（裸跑）', 'doctor', 'review', 'bogus-xyz', 'check', '--help', '--version', 'chat', 'run hello'];
for (const args of probes) { ... }   // cwd = 空目录（非 git、无 package.json）
```

> 临时目录已清理（`C:UsersmmcAppDataLocalTemp\ccai-v50-selfreview`）；本报告所有输出均为当次实跑所得。

