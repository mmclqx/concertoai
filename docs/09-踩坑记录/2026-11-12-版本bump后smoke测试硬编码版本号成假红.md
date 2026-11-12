# 2026-11-12 版本 bump 之后 `smoke.test.ts` 硬编码版本号 ⇒ `verify` 变红，且**红得毫无信息量**

## 问题描述

- **现象**：v5.1.0 发版前跑 `npm run verify`（发布门 8/12 的必跑项），全量 2665 用例里**唯一一条红**是：

  ```
  FAIL tests/smoke.test.ts > smoke > 库入口可加载且版本正确
  AssertionError: expected '5.1.0' to be '5.0.0'
  ```

  版本号 `5.0.0 → 5.1.0` 的 bump 已经提交（`39ba8ff`），但 `tests/smoke.test.ts` 里写的是 `expect(VERSION).toBe('5.0.0')`。
- **环境**：Windows x64 / Node 22.23.2 / vitest 4.1.12
- **危害等级**：🟡 中 —— 不涉及运行时风险，但它是**假红的典型发生器**，而假红比假绿更早腐蚀护栏：团队当天就会学会「这条红了不用管」，那天护栏就没了。

## 根因分析

### 拿「每次发布都会变的值」当断言常量

```ts
// 修前
expect(VERSION).toBe('5.0.0');
```

这条断言守的是「版本号恰好等于我上次写它时的那个数字」，而不是任何**不变量**。它的日常维护成本是「每次发版记得手改测试」——一旦忘记，红；而红了之后最省事的做法是「把字面量改成新版本号」，改完它又退化成「测试跑得起来」。

### 为什么 bump 提交没发现

`39ba8ff`（`chore(release): v5.1.0 —— 版本 bump + CHANGELOG 落版`）只跑了版本联动脚本（`scripts/sync-version.mjs` 改 `package.json` 与 `src/version.ts`），**没有跑 `npm run verify`**。版本 bump 看起来「只是改两个数字」，恰恰是这种提交最容易跳过验证，而它的失败面又正好落在测试上。

## 解决方案

改成对照 `package.json`，让断言守一条**真正的不变量**（`src/version.ts` 与 `package.json` 必须同版本）：

```ts
const PKG_VERSION = (JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  version: string;
}).version;

it('库入口可加载且版本正确', () => {
  expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+$/); // 正例自证：package.json 真被读到
  expect(VERSION).toBe(PKG_VERSION);
});
```

**变异自证（M6）**：把 `src/version.ts` 的 `VERSION` 临时改成 `'9.9.9'` ⇒ 用例红：

```
AssertionError: expected '9.9.9' to be '5.1.0'
```

复原后 `src/version.ts` sha256 `8c901674…` 与改前一致。**这条红现在有含义了**：它意味着「`--version` 报的版本与发布的包版本对不上，用户报 bug 时对不上号」。

**附带的排查动作**：全仓搜 `5.0.0` 确认没有第二个同类断言。其余命中都是**模拟 npm 输出的 fixture**（如 `'> @concertoai/cli@5.0.0 build'`）与 `compareVersions` 的任意版本样例——它们不随发布变化，保留字面量是对的。

## 教训

1. **断言里不许出现「每次发布都会变的值」**。判据一句话：*这个字面量下次发版时还需要人来改吗？* 需要，就说明它守的不是不变量，而是人的记性。版本号、包名、日期、价格表都是这一类。
2. **`chore(release)` 类提交同样要跑 `verify`**。「只是改两个数字」是本仓最容易漏验证的形态，而它最可能踩坏的恰好是测试里的字面量断言。发版流程里 bump 与 verify 必须成对出现。
3. **一条红必须能说出「为什么会红」**。当一条断言红了，如果唯一能想到的修法是「把期望值改成实际值」，那这条断言本身就该重写——重写成对照另一个独立来源（这里是 `package.json`），它才有资格叫护栏。
