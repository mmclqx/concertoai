# 2026-10-30 publish 被 2FA 阻断，且 OTP 窗口会被 prepublishOnly 吃掉

> 场景：v5.0.0 发布。代码侧全绿（verify 2254 用例 / tarball 打包正常），**卡在 registry 鉴权**。这条记录的是「发布链最后一公里」的两个非代码坑。

## 问题描述

- **现象 1（E403）**：`npm publish` 打包全部成功（`@concertoai/cli@5.0.0`，171 文件，987.9 kB，shasum `44ed767f…`），到上传阶段失败：

  ```
  npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
  npm error code E403
  npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@concertoai%2fcli
  npm error 403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
  ```

- **现象 2（诊断被误导）**：同一时刻 `npm whoami` 输出 `mmclqx`（正常）、`npm view` 正常、`npm profile get --json` 显示 **`"tfa": false`** —— 三个只读信号全部指向「账号没问题，应该能发」，但写操作 403。
- **现象 3（潜在坑，未及踩到但必然踩到）**：若改用「输 OTP」方案，`prepublishOnly` 会在 publish 前**重跑一遍 `npm run verify`**（本项目约 2–3 分钟），而 **OTP 只有 30 秒有效期** → 等 verify 跑完，码已经过期，必然二次 403。
- 环境：Windows x64 · npm 10.9.8 · Node v22.23.2 · registry.npmjs.org

## 根因分析

- **直接原因（现象 1）**：`~/.npmrc` 里是 **granular access token**（`npm_` 前缀 + 40 字符），创建时**未勾选 "Bypass two-factor authentication (2FA)"**。npm registry 对 `PUT`（发版）要求「OTP 或带 bypass 的 token」二者之一，该 token 两者都不满足。
- **直接原因（现象 2）**：**只读 API 与写 API 的鉴权口径不同**。`whoami` / `view` / `profile get` 只验「这个 token 属于谁」，`PUT` 还要验「这个 token 是否有权在无 OTP 的情况下写」。`npm profile get` 的 `tfa:false` 是**账号级**是否开启 2FA，**不等于** token 级写权限已获豁免——两者不可互相推断。（附带：`npm profile get tfa` 单独查询回的是**空输出**，比 `--json` 更没信息量。）
- **直接原因（现象 3）**：`prepublishOnly` 是 npm 生命周期脚本，`npm publish` 会自动先跑它；而 `--otp` 的值是**一次性、30 秒窗口**。**生命周期钩子的固定耗时与 OTP 的短窗口天然冲突**——项目越规范（钩子越重），这条路越不可行。
- **深层原因**：发布链上有三类「通过信号」，**它们互不等价**：① 本地 verify 全绿（代码质量）② 打包成功（工程配置）③ 鉴权通过（账号权限）。本轮 ①②全绿、③失败，而我拿 ①② 的证据去推断 ③ 成立——**不同环节的绿灯不能互相担保**。同理，只读权限的绿灯不能担保写权限。

## 解决方案

- **现象 1 的正解**：在 npm 网站创建 **带 Bypass 2FA 的 granular access token**（`Read and write` + 包范围 `@concertoai` 或 All packages + 勾选 Bypass 2FA），替换 `~/.npmrc` 里的 `_authToken`。这是唯一能「一条命令发完」的路径。
- **现象 3 的正确打法（若只能拿到 OTP）**：**把 verify 从 publish 时序里摘出来**——
  1. 先单独跑 `npm run verify` 并留存输出（这是真正的质量门，不能省）；
  2. 再 `npm publish --ignore-scripts --otp=<码>`，让 30 秒窗口只覆盖上传本身。
  - 注意 `--ignore-scripts` 会跳过**所有**生命周期脚本（含 `prepublishOnly`），所以第 1 步**不能省**，否则等于门没关。**「跳过钩子」必须与「手工补上钩子做的事」成对出现**，单做前者就是关掉发布门。
- **不推荐的野路子（记录以免后人尝试）**：改 `package.json` 临时删 `prepublishOnly` → 会在工作区留下改动，违背「发布前工作区干净」；且删钩子的提交一旦漏还原，后续所有发布都静默失去质量门。
- **涉及文件**：`~/.npmrc`（token 替换，非仓库文件）；仓库侧无需改动。**publish 失败无副作用**：registry 仍 `4.1.1`、`git tag --list v5*` 为空、`git status` 干净——「不可逆操作失败」不等于「留下了烂摊子」，这一点要实测确认而不是假定。

## 经验教训

- **发布前把「能通过」拆成环节逐项实测**：本地 verify / 打包 / 鉴权 / tag 权限，每一项都要有独立的直接证据。**上一环的绿灯不是下一环的证据**。本项目 AGENTS 第 15 条「存在性 ≠ 跑通」是同一原理在另一处的表述。
- **写权限的动作，必须用一个「也做写操作」的探针去验**，不能用只读探针（`whoami` / `view`）代验。判据——「我这个探针，如果权限不足，它会失败吗？」答否，那它验不了权限。
- **生命周期钩子的耗时是发布方案的一部分**：钩子越重（本项目 `prepublishOnly` = build + lint + typecheck + 跳过检测 + 2254 用例），越不能与「短窗口凭据」（OTP）配合。要在设计发布流程时就把「钩子耗时」当成一个显式参数。
- **`--ignore-scripts` 属「拆门」操作，只能与「人肉补门」成对使用**，且必须在日志里写清补了什么、证据在哪。
- **不可逆操作失败后，第一件事是取「无副作用」的证据**（registry 版本未变 / 无新 tag / 工作区干净），而不是急着重试。重试前不知道状态，就可能把「已部分成功」当成「完全失败」。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md` 版本强制工作流第 7 步（发布）+ 发布前自查（新增「鉴权用写探针自证」的意识）；本条与 AGENTS 第 15 条「装好 ≠ 跑通」互为同类

## 相关链接

- 执行日志：`docs/execution-log-20261030-014100.md`（本轮完整自证与实测输出）
- 取证明细：`publish-attempt1.log`（一次性，已 gitignore）、`npm token list`、`npm profile get --json`
- 同类历史踩坑：`docs/09-踩坑记录/2026-08-11-npm-token-expired.md`（另一次发布被 token 挡住）
- 账号侧文档：npm「Granular access tokens」的 `Bypass 2FA` 选项
