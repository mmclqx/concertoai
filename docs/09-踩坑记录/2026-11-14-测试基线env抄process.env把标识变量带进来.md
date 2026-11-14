# 2026-11-14 测试基线 env 抄 process.env 把标识变量带进来（按规范办事反而假红）

## 问题描述

- **现象**：`set CONCERTOAI_AGENT=concertoai-loop && npm run verify` ⇒ 退出码 1，唯一失败是
  `tests/scripts/githooks.test.ts` 的「未声明 ⇒ `Agent: unmarked`」，回显是
  `expected 'feat: probe\n\nAgent: concertoai-loop…' to contain 'Agent: unmarked'`；
  **不设该变量时 180 文件 / 2708 用例全绿**。
- **环境**：Windows 11 / Node 22 / git for Windows 2.45+（三平台 CI 中 posix 一侧的差异见「根因」第 3 条）
- **为什么这条比一般红更严重**：`AGENTS.md` 第 30 条**要求每次提交都设 `CONCERTOAI_AGENT`**。
  于是「照规范办事的人」看到一条假红，「不照办的人」看到全绿——**规范在这里变成了负向激励**。

## 根因分析

- **直接原因（定位到行）**：`tests/scripts/githooks.test.ts:78`
  `const BASE_ENV = { ...process.env, LUMEN_LOCALE: '', LANG: '' }` 在**模块加载时**就把父进程的
  `CONCERTOAI_AGENT` 抄进基线。用例里 `const env = { ...BASE_ENV }; delete env.CONCERTOAI_AGENT`
  只删了**副本**；而 `commit()` 内部是 `{ ...BASE_ENV, ...env }` ⇒ **`BASE_ENV` 把删掉的键原样注回来**，
  删除完全无效。
- **深层原因 1（形态）**：这是 AGENTS「进程级全局状态隔离」条款的同族缺陷——与 v5.0 T22 的
  `LUMEN_LOCALE` 泄漏一模一样：**spawn 用例没有钉死 env，而是依赖「开发机 shell 恰好干净」**。
  区别只在于 `LUMEN_LOCALE` 当年被发现并钉死了，`CONCERTOAI_AGENT` 是**第 30 条后来才引入的**，
  没有人回头补第二笔。
- **深层原因 2（为什么 4 天没人发现）**：`BASE_ENV` 里 `LUMEN_LOCALE: ''` 是**显式钉空**
  ——说明作者知道「要钉死会漂的东西」；但钉法是**逐项追加**，于是一个新变量出现时，
  默认状态是「漏」。**默认漏、漏了还全绿**，靠人记得去补是不可能的。
- **深层原因 3（修法不能凭直觉选）**：`BASE_ENV` 是「继承必要」还是「抄着省事」，决定修法完全不同
  （候选 4 ⑤ 要求先取证）。本轮取证结论 = **继承必要**（见下）：三条证据。

## 取证（判 (a) / (b)，不靠推断）

| # | 证据 | 读数 | 指向 |
|---|---|---|---|
| 1 | `git log -S"BASE_ENV" -- tests/scripts/githooks.test.ts` | 只有 `6e35b0e`（2026-11-10），提交说明写「测试继承开发机 `LUMEN_LOCALE=en` 导致 en 环境 5 红，**改为 `BASE_ENV` 钉死 locale**」 | 它是**为钉死而加**的，不是图省事 |
| 2 | `commit()` / `commitEmpty()` 里 `{ ...BASE_ENV, ...env }`，全部调用点的 `env` 都是**增量**（`{ CONCERTOAI_AGENT: 'x' }` / `{ PATH: stripped }`） | 底座不含 `PATH` ⇒ 每个调用点都得重建完整环境 | 底座必须**全** ⇒ (a) |
| 3 | hook 里 `command -v node`（决定打不打提醒）与 `git rev-parse`（决定状态文件路径）都靠 `PATH`；用例 242 还专门 `{ ...BASE_ENV, PATH: stripped }` 覆盖它 | `PATH` 是**硬需求** | (a) |

**一个必须记住的假绿**：Windows 上 `spawnSync(..., { env: {} })` 子进程**仍有 11 个变量**——
libuv 会补一组必需变量（`PATH` / `SYSTEMROOT` / `WINDIR` / `TEMP` / `USERPROFILE` / `HOMEDRIVE` /
`HOMEPATH` / `SYSTEMDRIVE` / `USERNAME` / `USERDOMAIN` / `LOGONSERVER`，实测打印得到）。
所以「把 env 削成空的本机也全绿」**证明不了 (b) 可用**：POSIX 的 `spawn` 是按给的那份 env 原样传，
而本仓库 CI 是 ubuntu / windows / macos 三平台 ⇒ (b) 会**本地全绿、Linux/macOS 上 hook 找不到 node、
提醒段静默、断言「期望中文提醒」的用例整片红**。
判据一句话：**「我这台机器上削掉还能跑」不构成证据——能削掉的是 libuv 补的那一组，不是我抄的这一组。**

**顺带审出的第二类泄漏**（"只排除当前这一个变量，就是「排除了这个、下个还在」"）：
在临时仓库 B 里提交、但 env 带仓库 A 的 `GIT_DIR` ⇒ **提交落到 A**（A 的提交数 2、B 仍是 1），
且退出码 0。⇒ 定位类变量（`GIT_*`）与身份类一样必须排除。

## 解决方案

- **修复方式**：`BASE_ENV` 改为 `baseEnvFrom(process.env)` = **抄 + 钉死 locale + 排除会漂的**
  （`LEAKY_ENV_KEYS`：身份类 `CONCERTOAI_AGENT`；定位类 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` /
  `GIT_COMMON_DIR` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` / `GIT_NAMESPACE`）。
  抽成函数是为了让用例能拿**构造出来的父环境**验证，而不是「只有设了变量的机器上才红」。
- **涉及文件**：`tests/scripts/githooks.test.ts`（`LEAKY_ENV_KEYS` + `baseEnvFrom` + 2 条新用例；
  原「未声明」用例里那句无效的 `delete` 已删并注明原因）
- **配的两条用例（双向）**：
  1. `父进程 env 带 CONCERTOAI_AGENT ⇒ 仍得到 Agent: unmarked`（**该红必红**：变异探针 M1 见下）
  2. `基线 env 仍继承必要变量（PATH / 家目录）`（**不该红必不红**：防止有人把修法做成被否掉的 (b)）
- **三环境实测**（同一天，全部 `exit 0`）：

| 环境 | 读数 | 结论 |
|---|---|---|
| 默认 | `Test Files 180 passed` / `Tests 2710 passed` | 基线绿（用例数 2708 → 2710 = 新增 2 条） |
| `set CONCERTOAI_AGENT=concertoai-loop` | 180 / 2710 全绿 | **原缺陷已修**（修复前此环境 1 红） |
| `set LUMEN_LOCALE=en` | 180 / 2710 全绿 | 换环境复跑（AGENTS 硬要求） |

- **变异探针（证明用例有牙，不是"改完就绿"）**：

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 删掉 `for (const key of LEAKY_ENV_KEYS) delete env[key];`（回到修复前） | 用例 1 红 | ✅ 红在指定的那条（`× 父进程 env 带 CONCERTOAI_AGENT ⇒ … unmarked`） |
| M2 `{ ...source, … }` → `{ … }`（被否掉的 (b) 做法） | 用例 2 红 | ✅ 红在指定的那条（`× 基线 env 仍继承必要变量…`） |
| 还原 | sha 与原件一致、复跑绿 | ✅ `sha=961ef64a60aa` 一致，20/20 绿 |

> **M2 的意义**：Windows 上 (b) 做法端到端**全绿**（libuv 补 `PATH`），只有这条显式断言能抓住它 ⇒
> 这正是「不该红必不红」那一半的价值：**没有它，一个会在 CI 上炸的修法能在这里骗过所有用例**。

## 经验教训

- **「设了环境变量才红」是最难被发现的一类红**：默认环境永远绿，只有照规范办事的人踩到，
  而人第一反应是怀疑自己那条命令而不是怀疑测试。凡「环境变量会影响行为」的用例，
  必须**显式构造污染环境**来测，而不是「依赖本机恰好干净」。
- **钉死要钉「会漂的一类」，不是「我遇到过的那一个」**：逐项追加式钉死的默认状态是漏。
  修法上要么排除一类（身份类 / 定位类），要么像 locale 那样显式钉空。
- **判定 (a)/(b) 必须取证**：`git log -S` 查来历 + 看调用点是不是「增量覆盖」+ 实测「削掉就跑不动吗」。
  凭「感觉像偷懒」选 (b)，代价是子进程缺 `PATH` 报 `git: command not found`。
- **「本机削掉还能跑」不是证据**（libuv 会补必需变量）：判断 env 注入是否生效，必须**打印子进程实际 env**，
  不能只看退出码。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md`「测试要求」段「进程级全局状态隔离」条款第 ④ 项（判据句
  「按规范做事反而假红，比不做事更糟」+ (a)/(b) 不可混用的判据）

## 相关链接

- 同族先例：`docs/09-踩坑记录/2026-11-10-测试继承开发机locale导致换环境5红.md`（`BASE_ENV` 的来历）
- 看板：`docs/03-开发计划与任务/TASKS.md` §候选队列 候选 4
- 执行日志：`docs/execution-log-20261114-1530.md` §四
- 相关提交：`6e35b0e`（`BASE_ENV` 引入）、本轮修复提交见 `git log -- tests/scripts/githooks.test.ts`
