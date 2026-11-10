# 13 · 提交时进度提醒 hook —— 方案 + 落地记录（**已实施，2026-11-10**）

> 状态：✅ **已落地并验收**（2026-11-10 晚）。`.githooks/prepare-commit-msg` 已加提醒段，
> `tests/scripts/githooks.test.ts` **18 条**用例全绿（zh / en 双环境同数），变异探针 P1–P6 + P1b 已跑，
> 端到端真 `git commit` 六组场景实测通过。**实测结果与原方案的三处偏差见 §十一**（P1 探针无牙、
> P3 首轮只红 13/18、`LUMEN_LOCALE` 泄漏导致 en 环境 5 红），这三条都是原方案没预料到的。
> 裁决结果见 §九（L3 语言 / 补测试含 trailer 回归 / blocked 打一句话 / 不做 dedup 提示 / 单独提交 + 补一条 `--no-verify` 用例）。
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

## 七、待你确认的问题（**已全部裁决，见 §九** —— 保留原文以便对照裁决变化）

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

## 九、用户裁决（2026-11-10）+ 实施细化（**待确认后动代码**）

### 9.1 五条裁决 + 一条补充（用户原话要点）

| # | 裁决 | 落地口径 |
|---|---|---|
| **Q1** | **L3 跟随 `LUMEN_LOCALE`**，与 i18n、`--help` 同一条链 | 语言判定必须与 `src/i18n/index.ts` 的 `resolveLocale` **行为等价**（见 9.3 的等价性表） |
| **Q2** | **补测试**，且含现有 trailer 行为回归 | 「不补测试，hook 改了 trailer 行为没人发现」——故 trailer 三条回归必进用例 |
| **Q3** | **打**，一句话「blocked：缺 X，等你确认」就够，**不打全 JSON** | 只输出 `blockedReason` 的**首段**（≤60 字，单行），不打印 JSON、不打印 instruction |
| **Q4** | **暂不做**「没跑过 dedup」提示 | 不读 `data.dedup`，不加时间窗逻辑 |
| **Q5** | **单独一件提交** | 只改 `.githooks/` + 新增测试 + 文档同步，一次提交 |
| **补充** | Q2 必须覆盖「`--no-verify` 提交时提醒照样出现」 | 「否则『绕不过』只是文档里写一句」——见 9.4 的用例造法（含对照组） |

### 9.2 改哪几行（精确到行号）

现有 `.githooks/prepare-commit-msg` 共 **52 行**（含末尾空行），结构如下：

```
19  msg_file="$1"
22-24  幂等：awk 清旧 Agent 行
26-41  身份解析（CONCERTOAI_AGENT → agent.detect.* → unmarked）
45-48  未声明身份时的 ASCII 告警
50  printf '\nAgent: %s\n' "$agent" >> "$msg_file"     ← 现有最后一行有效代码
51  exit 0
```

**改动只有一处插入**：在**第 50 行之后、第 51 行 `exit 0` 之前**，插入 6 行注释 + 约 22 行 sh（提醒段）。**其余 52 行一个字不改**（尤其 22-24 的 awk 段与 45-48 的告警段）。

为什么插在最后而不是最前：① 提醒段无论怎么出错都不能影响已经写好的 trailer（先完成主线，再做提示）；② 现有执行顺序零改动，改动面最小、review 最容易；③ 提醒段内部所有命令都容错，最后仍落在 `exit 0`。

**插入内容（草案，含 L3 语言分支与 `command -v node` 保护）**：

```sh
# ── 进度提醒（ADR-051 裁决 4 / docs/12 §9.4）────────────────────────
# 只往 stderr 打印，绝不阻断、绝不改写提交信息（AGENTS 第 34 条 / docs/13）。
# 语言跟随 LUMEN_LOCALE > LANG（en* → 英文 ASCII，其余 → 中文），与 src/i18n 的
# resolveLocale 行为等价（等价性由 tests/scripts/githooks.test.ts 表驱动钉住）。
# 读不到状态 / 解析失败 / 没有 node ⇒ 一律静默（hook 不能成为新故障源）。
if command -v node >/dev/null 2>&1; then
  state_file="$(git rev-parse --git-dir 2>/dev/null)/concertoai-current-instruction.json"
  if [ -f "$state_file" ]; then
    node -e '
      const fs = require("fs");
      try {
        const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (d.status !== "in_progress" && d.status !== "blocked") process.exit(0);
        const loc = String(process.env.LUMEN_LOCALE || process.env.LANG || "").trim().toLowerCase();
        const en = loc.startsWith("en");
        const steps = Array.isArray(d.steps) ? d.steps : [];
        const done = steps.filter((s) => s && s.status === "done").length;
        const cur = d.currentStep == null ? "-" : d.currentStep;
        const err = (s) => process.stderr.write(s + "\n");
        if (d.status === "blocked") {
          const why = String(d.blockedReason || "").replace(/\s+/g, " ").trim().slice(0, 60);
          err(en
            ? `concertoai: blocked: ${why || "(no reason recorded)"} -- waiting for you`
            : `concertoai: blocked：${why || "（未记录原因）"}，等你确认`);
          process.exit(0);
        }
        err(en
          ? `concertoai: instruction not finished -- status=in_progress, step ${done}/${steps.length} (currentStep=${cur})`
          : `concertoai: 指令未收尾 —— status=in_progress，进度 ${done}/${steps.length} 步（currentStep=${cur}）`);
        err(en
          ? "concertoai: progress: show | dedup | update --set-status done"
          : "concertoai: 看进度 show ｜ 查重 dedup ｜ 收尾 update --set-status done");
      } catch {}
    ' "$state_file" 2>&1 >&2 || true
  fi
fi
```

> 注意三条实现细节：节点代码用**双引号**（因为整段包在 sh 单引号里，内部不能出现单引号）；`|| true` 兜住 node 自身非 0；`2>&1 >&2` 把 node 的 stdout 也压到 stderr（提醒不该污染 stdout）。

### 9.3 L3 的语言等价性（已实测，20 条边界 0 不一致）

`src/i18n/index.ts:30-36` 的真实规则是 `value?.trim().toLowerCase()` 后 `startsWith('en')`。hook 里不能 import TS（提交时可能未构建），所以必须复刻——**复刻就有「同一事实两处各解析一次」的风险（AGENTS 第 33 条）**，故用表驱动等价性用例钉住：

| 输入 | `resolveLocale` | hook 复刻 |
|---|---|---|
| `undefined` / `''` / `'   '` | zh | zh |
| `'en'` / `'EN'` / `'en_US.UTF-8'` / `'EN_us.UTF-8'` | en | en |
| `' en'` / `'en '` / `'  en  '` | en | en |
| `'ent'` / `'english'` | en | en |
| `'zh'` / `'ZH_CN.UTF-8'` / `'fr'` / `' fr '` | zh | zh |
| `'e n'` / `'zh en'` | zh | zh |
| `'en zh'` | en | en |

**20 条全一致（0 不一致）**——这是本轮实测结果，用例里要原样保留这张表。第一版草案漏了 `trim`，`'  en'` 被判成 zh，正是这张表抓出来的。

### 9.4 `--no-verify` 用例怎么造（含对照组，已实测）

**前提先验成事实**（AGENTS 第 30 条原本只有一句断言，本轮实测确认，git 2.45.1.windows.1）：

| 提交方式 | `pre-commit` marker | `prepare-commit-msg` marker | trailer |
|---|---|---|---|
| 普通 `git commit` | ✅ 有 | ✅ 有 | `Agent: probe-agent` |
| `git commit --no-verify` | ❌ **无**（被绕过） | ✅ **有** | `Agent: probe-agent` |

**造法（关键在「双 marker 对照」）**：临时仓库里同时放两个 hook——
- `.githooks/prepare-commit-msg` = **真实 hook** + 一行 `echo PCM_RAN >> "$(git rev-parse --git-dir)/marker.txt"`
- `.githooks/pre-commit` = 只写 `PRE_RAN` 的 5 行脚本

然后跑两次提交（普通 / `--no-verify`），断言四件事：
1. `--no-verify` 那次 **`PRE_RAN` 消失** ⇒ 证明 `--no-verify` 确实生效了（**没有这条对照，「PCM_RAN 还在」可能只是 `--no-verify` 没起作用**）；
2. `--no-verify` 那次 **`PCM_RAN` 仍在** ⇒ 绕不过；
3. `--no-verify` 那次 **stderr 仍含提醒文案** ⇒ 用户真正关心的事实；
4. `--no-verify` 那次 **trailer 仍写入** ⇒ 提醒没破坏身份机制。

### 9.5 测试清单（13 条，`tests/scripts/githooks.test.ts`）

全部在 `os.tmpdir()` 造真仓库 + 真 `git commit` + 断言 stderr/marker/`git log`；不 mock sh、不 mock git。

| # | 用例 | 断言 |
|---|---|---|
| 1 | 正例：`in_progress` | stderr 含「指令未收尾」+ `1/2` + `currentStep=2` + 三个命令名 |
| 2 | 负例：`done` | stderr **不含**提醒关键词 |
| 3 | 负例：无状态文件 | stderr 不含提醒；提交成功 |
| 4 | 负例：JSON 损坏 | stderr 不含提醒；提交成功（静默吞掉） |
| 5 | `blocked` + 原因 | 打一行「blocked：<原因>，等你确认」；**不含** `instruction` 原文、不含 `{`（不打 JSON）、≤ 1 行 |
| 6 | `blocked` 无原因 | 打「（未记录原因）」，不崩 |
| 7 | **`--no-verify` 提醒照出** | 见 10.4 四条断言（含 pre-commit 对照） |
| 8 | L3 英文：`LUMEN_LOCALE=en` | stderr 为英文且**不含 CJK 字符** |
| 9 | L3 中文：未设 / `zh` | stderr 含中文 |
| 10 | 语言等价性表 | 20 条输入，hook 复刻 vs `resolveLocale` 同结果 |
| 11 | trailer 回归：已声明 | `git log -1 --format=%B` 末行 `Agent: <id>` |
| 12 | trailer 回归：未声明 | 落 `Agent: unmarked` + 两行 ASCII 告警（stderr） |
| 13 | trailer 幂等 | `--amend` 后 `Agent:` 行仍只有 1 行（不叠加） |
| 14 | 性能预算 | 两次提交（有/无状态文件）中位差 < 300ms（防有人往 hook 塞 `dedup`） |

> 共 **14 条**（9.5 表里 14 行；上表标题写 13 是按用户「测试几条」的粗口径，实际按行计 14 条）。另加 4 条变异探针（§6.2 已列）+ 性能预算 1 条。

### 9.6 变异探针（新代码必须验有牙）

| 探针 | 改法 | 期望红的用例 |
|---|---|---|
| P1 | 删 `if [ -f "$state_file" ]` 判断（改成无条件跑） | #3 无状态文件 |
| P2 | 删 `status !== "in_progress" && status !== "blocked"` 的早退 | #2 `done` |
| P3 | 把末尾 `exit 0` 改成 `exit 1` | #1/#2/#3 全部（提交必须成功） |
| P4 | 删掉 awk 幂等段 | #13 `--amend` 不叠加 |
| P5 | 删 `trim()`（回退到第一版草案） | #10 等价性表（`'  en'` 那条） |
| P6 | 把 `2>&1 >&2` 改成普通输出（走 stdout） | 断言「提醒只出现在 stderr」的用例 |

#### 9.6.1 实测结果（2026-11-10，**这是实测值，不是计划值**）

跑法：`.tmp-probe-hook.mjs`（一次性脚本，用完即删；基准在**变异前**固定成独立副本 `.tmp-hook-baseline`，
每条复原后逐字节比对 sha256，防止 2026-11-05 那次「用旧备份恢复吃掉改动」重演）。

| 探针 | 改法 | 实测红 | 复原 |
|---|---|---|---|
| P1 | 删 `[ -f "$state_file" ]`（无条件启动 node） | **0/18（无牙）** | sha256 一致 |
| P1b | 删 `command -v node` 判断 | **1/18** ⇒ 红在 #4「PATH 无 node ⇒ 静默」 | sha256 一致 |
| P2 | 删 status 早退（`done` 也提醒） | **1/18** ⇒ 红在 #3「`status=done` ⇒ 静默」 | sha256 一致 |
| P3 | 末尾 `exit 0` → `exit 1` | **18/18**（首轮只 13/18，补断言后全红，见 §十一） | sha256 一致 |
| P4 | 删 awk 幂等段 | **1/18** ⇒ 红在 #17「`--amend` 不叠加」 | sha256 一致 |
| P5 | 删 locale 的 `.trim()` | **1/18** ⇒ 红在 #14「语言等价性表」 | sha256 一致 |
| P6 | 提醒同时追加进 `$msg_file` | **1/18** ⇒ 红在 #2「提醒不得进入提交信息」 | sha256 一致 |

> **P6 的改法与原文不同，如实说明**：原计划写「把 `2>&1 >&2` 改成普通输出（走 stdout）」，但落地时
> 发现那段重定向**已经被删掉了**——实测 git 跑 hook 时本就把 hook 的 stdout 合并进 stderr，
> 该重定向是冗余的（无重定向变体的 stdout 实测为**空**）。所以 P6 改为**真正有危害的那种废实现**：
> 把提醒 `appendFileSync` 进 `$msg_file`（污染提交信息）。这个改动才对应「用户会真的受害」的场景，
> 而「写到 stdout」在 git 语境下不可观测（详见用例 #1 的注释）。

### 9.7 风险补充（相对 §八 新增）

| 风险 | 缓解 |
|---|---|
| hook 里的语言规则与 `src/i18n` 漂移（两处各解析一次） | #10 表驱动等价性用例；将来若 `resolveLocale` 改规则，该用例会红并提示同步 hook |
| Windows 上中文经 `node -e` → stderr → cmd 可能乱码 | L3 的 `LUMEN_LOCALE=en` 路径为纯 ASCII；中文路径的乱码不影响提交成功（只影响可读性），且 `show`/`dedup` 侧已有 UTF-8 输出可对照 |
| hook 段被后人删掉却无人发现 | #1 正例 + #7 `--no-verify` 两条都依赖它，删了必红 |

## 十、实施清单（✅ 全部完成，2026-11-10）

| # | 项 | 结果 |
|---|---|---|
| 1 | 改 `.githooks/prepare-commit-msg` | ✅ 只在 `exit 0` 之前追加提醒段；awk 段 / 告警段 / 身份解析段**一字未改**（每条探针复原后与变异前的基准副本 sha256 逐字节一致） |
| 2 | 新增 `tests/scripts/githooks.test.ts` | ✅ **18 条**（规划 14 条 + 补 4 条负例：`status=done` / 坏 JSON / PATH 无 node / `blocked` 未记原因） |
| 3 | 6 条变异探针 P1–P6 | ✅ 加跑 **P1b**（`command -v node` 那道判断），结果表见 §9.6 下方「实测」与 §十一 |
| 4 | 端到端实测 | ✅ 真 cmd + 真 `git commit`，六组场景（普通 / `--no-verify` / `done` / `blocked` / `en` / 无状态）全部 exit 0，stderr 落盘按 UTF-8 读回核对 |
| 5 | `npm run verify` + 换环境复跑 | ✅ 默认环境 **170 文件 / 2567 用例**；`LUMEN_LOCALE=en` **同数全绿**（首轮 en 曾 5 红，见 §十一） |
| 6 | 文档同步 | ✅ `docs/12` §9.4 + 裁决 4（🟡→✅）、`AGENTS.md` 第 34 条补「交付时刻有 hook 兜底」、hook 头部注释补「有测试钉住」 |
| 7 | 单独提交 | ✅ `feat(hooks): 提交时打印未收尾进度提醒（只 stderr，不阻断、不进提交信息）` |

### 10.1 本方案特别声明（防止「照文档施工」时漏掉）

- **`--no-verify` 那条不是文档承诺，而是用例**：`#7` 会同时断言「pre-commit marker 消失（对照）」与「prepare-commit-msg marker 仍在 + 提醒仍打出」。只断言后者等于空转——`--no-verify` 若压根没生效，后者也会绿。
- **hook 里的语言规则是复刻，不是 import**：提交时 `dist/` 可能未构建，故不能 `import src/i18n`。复刻的代价由 `#10` 的 20 条等价性表兜住；将来 `resolveLocale` 改规则时该用例会红，届时**同时改 hook 与用例**，不许只改用例。
- **`blocked` 只打一句话**：不打 JSON、不打 `instruction`、不打 `steps` 明细；用例 `#5` 断言「不含 `{`」「≤1 行」。

---

## 十一、落地时的三处偏差（**原方案没预料到的，如实记**）

> 写这节的理由：这一轮有三件事「方案里写的是一个样子，实测是另一个样子」。如果只把成功的部分写进文档，
> 下一个人会按方案以为探针都红得干净、环境随便跑都绿——那是拿文档骗自己。

### 11.1 P1 探针无牙：`[ -f "$state_file" ]` 根本没有测试能钉住

- **方案说**：删掉这行 ⇒ 用例 #3「无状态文件」必红。
- **实测**：删掉后 **18/18 全绿**。
- **根因**：静默其实由 node 代码里的 `try/catch` 保证（读不到文件 → 抛错 → 吞掉）。那行 `[ -f ]`
  只做**性能优化**（省一次 node 启动，实测省 ~50-70ms），不是行为护栏。
- **处置**：不删这行（它有价值），但**把注释改成实话**——用例 #4 的注释里写明「本用例守的是外部行为
  「无文件不报错」，别误以为它在钉那行判断」。真正有牙的是 **P1b**（删 `command -v node` ⇒ #4 必红）。

### 11.2 P3 首轮只红 13/18：4 条「期望看到提醒」的用例没断言提交成功

- **方案说**：`exit 0` → `exit 1` ⇒ 全部用例红（提交必须成功）。
- **首轮实测**：只红 **13/18**。没红的是 `blocked` 超长 / `en` 明文 / `en` blocked / `zh` 反向自证
  这 4 条（只断言 stderr 内容、没断言 `c.status`），外加性能用例（只计时，不看退出码）。
- **为什么这算缺陷**：这 4 条正是「提醒文案对不对」的主力用例。如果哪天有人把它们改成 `exit 1`
  来「让测试变绿」，它们自己不会发现——**判据不覆盖自己的前提**。
- **处置**：4 条全补 `expect(c.status).toBe(0)`；性能用例补「每次计时提交必须成功」（失败时测到的是
  「失败耗时」，没有意义）。补后 **P3 重跑 ⇒ 18/18 全红**。此处「红了一部分」比「全绿」更危险。

### 11.3 `LUMEN_LOCALE=en` 换环境：5 条红，全是 locale 泄漏

- **首轮 en 全量**：`2562 passed / 5 failed`（都在 `githooks.test.ts`）。
- **报错长这样**：`expected 'concertoai: agent identity NOT declar…' to contain '指令未收尾'`
  —— 用例要中文，hook 给了英文。
- **根因**：测试里 `{ ...process.env }` 把开发机的 `LUMEN_LOCALE=en` 继承进了子进程。
  **这正是 AGENTS「spawn 用例必须显式指定 `LUMEN_LOCALE`，不依赖开发机 shell」那条**，
  而本文件第一版恰好踩了它。
- **附带暴露一条口径问题**：`blocked 原因超长` 那条的阈值 `length < 100` 卡得过紧（中文行实测 100），
  属于「恰好压线」，与 locale 无关但一起修了（阈值 60+60，注释说明仍远小于 200 字原文）。
- **处置**：新增 `BASE_ENV = { ...process.env, LUMEN_LOCALE: '', LANG: '' }` 作为**默认基线**，
  所有 `git` 调用都从它出发；要英文的用例显式传 `{ LUMEN_LOCALE: 'en' }` 覆盖。
  改后 en 环境 **18/18 绿**，默认环境同数绿。

### 11.4 一句话总结

三条偏差里有两条（11.2 / 11.3）都是**「我以为测了，其实测的是别的东西」**：一条是判据没覆盖自身前提，
一条是测试自己没有隔离环境。这跟 AGENTS 第 33 条的「同一事实两处各解析一次」是同族病——
**测试里的「隐含前提」必须显式写出来，否则它只在你的机器上成立**。
