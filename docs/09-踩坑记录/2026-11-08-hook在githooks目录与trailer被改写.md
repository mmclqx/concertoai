# 2026-11-08 · hooks 在 `.githooks` 不在 `.git/hooks`；`-m "Agent: …"` 会被 hook 改写成 `unmarked`

- **发现场景**：指令进度记录机制落脚本前的「补账」步（用户要求「每步做完贴证据」）
- **影响面**：① 结论层——差点把「已存在的 hook」报成「未实现」；② 产物层——一条提交的 `Agent:` trailer 被写成 `unmarked`

---

## 一、两个坑（同一次提交里连着踩）

### 坑 A：搜错目录 ⇒ 「搜不到」被当成「不存在」

```cmd
> dir /b .git\hooks
prepare-commit-msg.sample   ← 只有 sample
```

据此我对外说「hook 提醒未实现」。**错**：本仓库把 hooks 挪到了 `.githooks`：

```cmd
> git config --get core.hooksPath
.githooks
> git rev-parse --git-path hooks
.githooks
> git ls-files .githooks
.githooks/prepare-commit-msg      ← 真实存在，历史提交 afb7bdb / 3af85ba 引入
```

**根因**：把「git 的默认 hooks 目录」当成「本仓库的实际 hooks 目录」。`core.hooksPath` 一配，默认目录就成摆设（里面永远只剩 sample）。

**正确探法（先通电再结论）**：

```cmd
git rev-parse --git-path hooks          :: 任何结论之前先问 git「你的 hooks 在哪」
node -e "const{execSync}=require('child_process'),fs=require('fs');const p=execSync('git rev-parse --git-path hooks').toString().trim();for(const f of fs.readdirSync(p))if(!f.endsWith('.sample'))console.log('HOOK:',f)"
```

这条同时满足 AGENTS「检索类必须先让探针命中必然存在的样本」——样本就是**hook 目录本身由 git 报出**，而不是我在代码树里猜一个路径。

### 坑 B：`git commit -m "Agent: concertoai-loop"` 被改写成 `Agent: unmarked`

| 项 | 内容 |
|---|---|
| 现象 | 我传了 `-m "Agent: concertoai-loop"`，落盘末行是 `Agent: unmarked`，stderr 同时打印 `concertoai: agent identity NOT declared` |
| 根因 | `.githooks/prepare-commit-msg` **按设计幂等覆盖**：先 `awk '!/^Agent: /'` 删掉消息里所有 `Agent:` 行（防 `--amend` 叠加），再依 `CONCERTOAI_AGENT` 环境变量重写末行。没设该变量 ⇒ 我手写的 trailer 被当脏行删掉、重写成 `unmarked` |
| 为什么不能改 hook 迁就 | 该 hook 的目的就是让「忘了声明身份」**当场可见**（`3af85ba` 的提交意图）；为了让 `-m` 生效而放宽，等于把「事后审计唯一可信字段」重新变成可伪造 |
| 修法 | **用环境变量声明身份，不要用 `-m` 传 trailer**：<br>cmd：`set CONCERTOAI_AGENT=concertoai-loop&&git commit -m "…"`<br>POSIX：`CONCERTOAI_AGENT=concertoai-loop git commit -m "…"`<br>已提交的：`set CONCERTOAI_AGENT=…&&git commit --amend --no-edit` |
| 自证命令 | `git log -1 --format=%B` 看末行；或机器判：<br>`node -e "const{execSync}=require('child_process');const b=execSync('git log -1 --format=%B').toString().trim().split(/\r?\n/);console.log('trailer='+JSON.stringify(b[b.length-1]))"` |

---

## 二、为什么两条要写在一起

它们是**同一个错误的两个面**：

- 坑 A 是「**没找对地方就宣布不存在**」——安静地给出一个对自己有利的结论（「这活还没做，那我不用看」）；
- 坑 B 是「**以为自己控制了产物，其实产物被别人覆盖**」——同样不报错（只有一行英文告警很容易被刷过去），但落进 git 历史的字段已经错了。

两条的共同点：**都不抛异常，只在事后对照时才会发现**。所以检查方式不能是「看有没有报错」，只能是「**现跑一条能证伪的命令**」——坑 A 跑 `git rev-parse --git-path hooks`，坑 B 跑 `git log -1 --format=%B` 并看末行。

## 三、沉淀为习惯（下次直接照做）

1. 说「某物不存在」之前，先问**工具自己它在哪**（`git rev-parse --git-path …` / `npm root` / `where`），不要按默认路径猜。
2. 提交一律 `CONCERTOAI_AGENT=<id>` + `git commit`；提交后**读末行**确认 trailer，不假定 `-m` 里写了就生效。
3. 报告里带「结论 + 支持它的那条命令」，别人才能一眼看出我是**实测**还是**猜的**（本次事故就是结论半对、证据全错）。
