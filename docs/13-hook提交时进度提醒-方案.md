# 13 · 提交时进度提醒 hook —— 方案（**待用户确认，本轮不实施**）

> 状态：**待用户确认**。本轮只落方案，**不动 `.githooks/prepare-commit-msg`、不写任何代码**。
> 依据：ADR-051 裁决 4「先『纯纪律 + hook 提醒』并行，hook 只打印不阻断；跑几轮再定是否强化」
> 相关：`docs/12-指令进度记录机制.md` §9.4 · `AGENTS.md` 第 30 条（agent trailer hook）· 本方案在第 34 条纪律落地之后
> 起草：2026-11-10 · 作者：concertoai-loop

---

## 一、要解决什么

`dedup` 已经能判「要不要重做」，`AGENTS` 第 34 条已经把它写成**开工第二动作**。但纪律有一个天然漏洞：**「开工时忘了跑」没有任何提示**——第 34 条靠的是我每次自觉执行，而「忘」正是这套机制要防的东西。

hook 提醒要补的正是这一环：**在「提交」这个已有的、逃不掉的时刻，把「你还有一条没做完的指令」打在脸上，只打印、不阻断。**

### 非目标（明确不做，防止范围蔓延）

| 不做 | 理由 |
|---|---|
| 阻断提交（exit 1） | 裁决 4 明写「只打印不阻断」；阻断会让「先提交代码再补文档」这类正常工作流断掉，进而被 `--no-verify` 绕过，提醒彻底失效 |
| 在 hook 里跑 `dedup` / `check` | 判据动辄十几秒（全量 verify），提交会变得不可用。hook 只做**毫秒级读文件** |
| 自动写状态文件 / 自动推进 step | 状态只能由 `write`/`update` 写（ADR-051 红线），hook 越权就等于把「进度记录」变成 hook 猜的东西 |
| 覆盖「开工」时刻 | hook 拦不到「开工」（没有那个事件）。开工靠第 34 条纪律 + `dedup`；hook 只在交付时刻做**兜底提醒** |

---

## 二、现状取证（都是本次实测/直读，不是推断）

| 项 | 事实 | 取证方式 |
|---|---|---|
| hook 位置 | `.githooks/prepare-commit-msg`（**不是** `.git/hooks`） | `git config core.hooksPath` → `.githooks`；`dir /b .githooks` → `prepare-commit-msg` |
| 现有 hook 职责 | 只做一件事：清掉旧 `Agent:` 行、按 `CONCERTOAI_AGENT` 重写末行，未声明时打 2 行 **ASCII** 告警 | 直读全文（1705 字节） |
| 现有 hook 的**语言选择** | 刻意用 ASCII，注释写明「避免 cmd 代码页把中文打成乱码」 | 同上 |
| 现有 hook 的**测试覆盖** | **零**。`search_content "prepare-commit-msg" tests/` → 0 命中 | 本仓 `tests/` 全量搜索 |
| `core.hooksPath` 局限 | 本地配置、不进版本库 ⇒ 新克隆/换机器 hook 静默失效 | AGENTS 第 30 条⑤ + `TASKS.md` 待办 |
| `--no-verify` 能否绕过 | **不能**绕过 `prepare-commit-msg`（能绕过 `pre-commit`/`commit-msg`） | AGENTS 第 30 条③（历史实测） |
| 索引模式要求 | 必须 `100755`，否则 POSIX 上 hook 被静默忽略 | AGENTS 第 30 条⑥ |

---

## 三、成本实测（本机 Windows x64 / Git for Windows / n 次取中位）

### 3.1 单次调用成本

| 测什么 | 中位 | 说明 |
|---|---|---|
| 空 sh 脚本（基线） | **36.2ms** | sh 解释器自身启动 |
| `sh` + `grep` 判 `"status": "in_progress"` | **51.3ms** | 净增 ~15ms |
| `node -e` 解析 JSON 判 status | **59.2ms** | 净增 ~23ms |
| 现有 hook 本体（真实执行） | **123.7ms** | 含 awk 改写提交信息 |

### 3.2 端到端（真实 `git commit` 触发，n=6 取中位）

| 组 | 提交耗时 |
|---|---|
| A 现有 hook 原样 | **168ms** |
| B 现有 hook + 进度提醒（`node -e` 解析） | **202ms** |
| **净增** | **+34ms** |

> 结论：**加一次 node 启动 ≈ 34ms**，相对 168ms 的基线是 1.2 倍，用户无感。**不选 grep**：只省 8ms，但脆弱——手写状态若写成 `"status":"in_progress"`（无空格）就漏判，而 `node -e` 是真解析。

### 3.3 两个候选实现的正负例实测（用 B 方案原型跑真 git commit）

```
探针（status=in_progress）stderr：
  concertoai: 有未完成的指令 —— status=in_progress, step 1/2 (currentStep=2)
  concertoai: 看进度 show ｜ 查重 dedup ｜ 收尾 update --set-status done

负例（status=done）stderr 是否含「未完成」= false ✅
```

**grep 的误判探针**（我原以为会误判，实测没有，如实记）：把 `status` 做成 `done`、但在指令原文里塞进 `"status": "in_progress"` 这段文字，grep **没有**误命中——因为 JSON 字符串里的双引号必被转义成 `\"`，未转义的那串不可能出现在值里。**所以 grep 的正确性风险不是「值里藏了同样文本」，而是「手写 JSON 的空格格式不固定」**——这才是选 `node -e` 的真正理由。

---

## 四、方案（推荐 B：追加式提醒，不阻断、不改写消息）

### 4.1 改哪里

在**现有** `.githooks/prepare-commit-msg` 的 `exit 0` **之前**追加一段（约 12 行 sh），**其余一行不动**：

```sh
# ── 进度提醒（只打印，不阻断；读不到就静默） ──
state_file="$(git rev-parse --git-dir 2>/dev/null)/concertoai-current-instruction.json"
if [ -f "$state_file" ]; then
  node -e '...解析 status/steps/currentStep，in_progress 才往 stderr 打两行...' "$state_file" 2>&1 >&2
fi
```

### 4.2 五条硬约束（写死在实现里）

| # | 约束 | 为什么 |
|---|---|---|
| 1 | **只写 stderr，绝不 exit 非 0** | 裁决 4；且「提交失败」会让人直接 `--no-verify`，提醒永久失效 |
| 2 | **不改写提交信息**（只在 `exit 0` 前插尾部代码，不碰 awk 段） | 2026-11-08 已踩：hook 改写消息会让 `-m "Agent: …"` 变 `unmarked` |
| 3 | **读不到 / 解析失败 / 无 node ⇒ 静默** | hook 不能成为新故障源；`try/catch` + `[ -f ]` 双保险 |
| 4 | **只用 git 自己给的 `--git-dir`** 定位状态文件 | 不写死 `.git/`：worktree / submodule 下 `.git` 是文件不是目录 |
| 5 | **不调 `dedup`/`check`** | 只读文件，毫秒级；跑判据会让提交从 168ms 变十几秒 |

### 4.3 打印什么（3 行以内，可复制即用）

```
concertoai: 指令未收尾 —— status=in_progress, step 1/3 (currentStep=2)
concertoai: 看进度 show ｜ 查重 dedup ｜ 收尾 update --set-status done
```

- 有 `blockedReason` 时额外一行 `concertoai: 卡住：<原因前 60 字>`（这是「下次继续最该看到的」）。
- `status` 为 `done`/`abandoned`/无文件/损坏 ⇒ **什么都不打**（不制造噪音）。

### 4.4 语言的选择（**需要你裁决，见 §七 Q1**）

实测里我拿到的是 UTF-8 正常的中文（`spawnSync` UTF-8 解码），但这**不等于 cmd 窗口显示正常**——本仓库已有「假乱码」踩坑（`09-踩坑记录/2026-10-28-Windows管道符串联导致假死与假乱码.md`）。现有 hook 正因如此才用 ASCII。三个选项：

| 选项 | 效果 | 代价 |
|---|---|---|
| **L1 ASCII**（与现有 hook 一致） | 永不乱码 | 中文用户读起来费劲 |
| **L2 中文默认 + `CONCERTOAI_HOOK_ASCII=1` 逃生** | 可读性最好 | 默认路径可能在个别终端乱码 |
| **L3 跟随 `LUMEN_LOCALE`**（en→ASCII / zh→中文） | 与全仓 i18n 口径一致 | hook 里多几行判断 |

**我的建议：L3**（与 `LUMEN_LOCALE` 同口径，默认中文），并把 L1 作为 `CONCERTOAI_HOOK_ASCII=1` 的逃生口。

---

## 五、边缘路径（AGENTS 强制逐条覆盖，每条都要有对应用例）

| 场景 | 期望行为 | 怎么验 |
|---|---|---|
| 状态文件不存在（首次 / 新克隆） | **静默**，exit 0 | 临时仓库无状态文件 ⇒ commit 成功且 stderr 无「未完成」 |
| `status=done` | 静默 | 负例（§3.3 已实测 false） |
| `status=blocked` + `blockedReason` | 打印卡住原因 | 造记录 ⇒ stderr 含原因前 60 字 |
| JSON 损坏 | 静默（catch 吞掉） | 写 `{ 坏 JSON` ⇒ commit 成功、无提醒 |
| 无 `node`（或 node 很慢） | 静默（`command -v node` 先探） | PATH 去掉 node ⇒ commit 仍成功 |
| worktree / submodule（`.git` 是文件） | 用 `git rev-parse --git-dir` 正确定位 | worktree 里实测 |
| `git commit --amend` | 与普通提交同一行为（提醒照打） | amend 一次 |
| `--no-verify` | **仍提醒**（prepare-commit-msg 不被绕过） | 加 `--no-verify` 提交 |
| 合并提交（`git merge` 触发） | 提醒照打（不需要特殊处理） | 建分支 merge 一次 |
| `core.hooksPath` 未配置（新克隆） | hook 不运行 ⇒ **无提醒也无报错**（已知局限） | 不配 hooksPath ⇒ 无提醒（如实记录，不假装能救） |
| 超长 `instruction` | 不打印原文（只打 step 进度），避免刷屏 | 600 字指令 ⇒ stderr 仍 3 行内 |
| 记录里 `steps` 为空 | 打 `step 0/0`，不崩 | 造空 steps |

---

## 六、测试方案（**这是本方案最关键的一节**）

### 6.1 现状：hook 零测试

`search_content "prepare-commit-msg" tests/` → **0 命中**。也就是说现在连「hook 到底有没有生效、会不会把 `Agent:` 写错」都没有自动化保护，全靠 AGENTS 第 30 条的纪律和事后 `git log` 核对。加提醒之前，应当把这个洞一并补上。

### 6.2 拟新增 `tests/scripts/githooks.test.ts`

**做法**：在 `os.tmpdir()` 里 `git init` 造**真仓库**，把 `.githooks/prepare-commit-msg` 复制进去、`config core.hooksPath .githooks`，然后**真的 `git commit`**，断言 stderr。不 mock sh、不 mock git（hook 的全部行为都在「真提交」里）。

| 用例 | 断言 |
|---|---|
| 正例：`in_progress` | stderr 含 `status=in_progress` + `step 1/2` + 三命令提示 |
| 负例：`done` / 无文件 / 损坏 | stderr **不含**「未完成」（三条） |
| `blocked` | stderr 含 `blockedReason` 片段 |
| 提交必须成功 | 全部用例都断言 `exit 0` 且 `git log -1` 有提交（**提醒绝不阻断**） |
| 消息未被改写 | `git log -1 --format=%B` 的 `Agent:` 行仍是预期值（守住 2026-11-08 那个坑） |
| 性能预算 | 断言「提醒带来的净增 < 300ms」（宽松阈值，防有人往里加 `dedup`） |

**变异探针（每条都要验有牙）**：① 把 `if [ -f "$state_file" ]` 去掉 ⇒ 无文件用例红；② 把 `status!=="in_progress"` 判断删掉 ⇒ 负例红；③ 把 `exit 0` 改成 `exit 1` ⇒ 「提交必须成功」红；④ 把 awk 段删掉 ⇒ trailer 用例红。

### 6.3 与 `--no-verify` 的组合用例

断言 `git commit --no-verify` **仍然**打印提醒（这是「hook 选 prepare-commit-msg」的全部价值，不能被悄悄改回 `commit-msg`）。

---

## 七、待你确认的问题（**这 5 条不回，我不动代码**）

| # | 问题 | 我的建议 |
|---|---|---|
| **Q1** | 提醒文案语言：L1 ASCII / L2 中文默认 + 逃生 / **L3 跟随 `LUMEN_LOCALE`** | **L3**（与全仓 i18n 口径一致，默认中文 + `CONCERTOAI_HOOK_ASCII=1` 逃生） |
| **Q2** | 是否**同时**补 `tests/scripts/githooks.test.ts`（含现有 trailer 行为）？ | **补**。hook 现在零测试，而它每次提交都在跑；顺带把 Q1-Q2 一起锁住 |
| **Q3** | `blocked` 时是否打印 `blockedReason`？ | **打**（那是「下次继续最该看到的一句话」） |
| **Q4** | 是否需要「提交时提示『本条指令还没跑过 dedup』」？ | **暂不做**：要先读 `data.dedup` 并算时间窗，逻辑多、收益不确定；等 Q1-Q3 跑几轮再看 |
| **Q5** | 实施顺序：单独一件 + 单独提交？ | **是**，动 `.githooks/` 不与脚本混提交（沿用 `docs/12` §9.1 的既定口径） |

---

## 八、风险与回滚

| 风险 | 缓解 |
|---|---|
| hook 抛错导致**提交失败** | 全部逻辑包 `try/catch` + `[ -f ]` + 末尾固定 `exit 0`；用例「提交必须成功」钉住 |
| 中文在 cmd 乱码，被误读成「文件写坏了」 | Q1 的逃生口；且提醒**只出现在 stderr**，不写入提交信息 |
| 新克隆机器上 hook 静默失效（`core.hooksPath` 是本地配置） | **无法在仓库内解决**（已知局限，AGENTS 第 30 条⑤）；`TASKS.md` 已记 clone 后三步复配 |
| 提醒变成噪音（每条提交都刷） | 只在 `status=in_progress` 时打；`done` 后静默 |
| 有人往 hook 里加 `dedup` 把提交拖成十几秒 | 用例断「净增 < 300ms」 |

**回滚**：`git revert` 该提交即可（hook 是纯追加段，回滚无残留）；或临时 `git config core.hooksPath /dev/null` 关掉全部 hook。

---

## 九、实施清单（确认后照此做，逐项验收）

1. 改 `.githooks/prepare-commit-msg`（追加 §4.1 那段 + 语言分支），**不动 awk 段**
2. 新增 `tests/scripts/githooks.test.ts`（§6.2 全部用例 + 4 条变异探针）
3. 实测端到端（本方案 §3.2 的测法，贴 A/B 两组数字）
4. `npm run verify` 全绿 + `LUMEN_LOCALE=en` 换环境复跑
5. 更新 `docs/12` §9.4（裁决 4 状态 ⏳→✅）、`AGENTS.md` 第 34 条补一行「交付时刻有 hook 兜底」
6. 单独提交（`feat(hooks): …`），不与其他改动混
