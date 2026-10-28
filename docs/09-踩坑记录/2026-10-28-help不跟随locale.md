# `--help` 从来不跟随 locale，且没有任何测试发现它

> 日期：2026-10-28　版本：v5.0 T22（对外定位重写）　严重度：中（功能静默失效 + 文案工作量白做）

## 现象

T22 要给中英文都换上新的定位文案。中文侧一验就过：

```
$ npx tsx src/cli/index.ts --help
ConcertoAI —— 敢让你用来改生产代码的个人超级 CLI（…）
```

英文侧怎么都不生效，且**不是环境变量写错**：

```bash
$ LUMEN_LOCALE=en npx tsx src/cli/index.ts --help
ConcertoAI —— 敢让你用来改生产代码的个人超级 CLI（…）      # 仍是中文
$ npx tsx src/cli/index.ts --lang en --help
ConcertoAI —— 敢让你用来改生产代码的个人超级 CLI（…）      # 仍是中文
```

## 根因

`setLocale()` 的**全部调用点都在各命令的 action 内部**：

```
src/cli/chat.tsx:71   run.ts:49   plan.ts:68   commit.ts:191
fix.ts:270  review.ts:394  team.ts:195  self-heal.ts:34  lsp.ts:38
```

而 `--help` / `--version` / 参数校验失败这类输出由 **commander 在解析阶段直接打印并退出**，
根本进不到任何 action → `setLocale` 一次都没执行 → `t()` 恒返回默认 `zh`。

也就是说 `src/i18n/en.ts` 里那行英文定稿文案**没有任何执行路径能显示出来**，
`en.test.ts` 能保证它「键齐全、非空、无 CJK」，但保证不了它「真的会被渲染」。

## 为什么长期没人发现

`tests/cli/help.test.ts` 覆盖了行数预算、四段顺序、命令注册交叉校验、i18n 死文案检测……
**但没有一条用例切过 locale**。搜索 `locale|lang|LUMEN` 在该文件命中 0 次。
缺的恰好是「换个 locale 再跑一遍」这一维度——而缺陷也恰好只活在这个维度里。

## 修复

`src/cli/index.ts`：在 `new Command()` **之前**调一次

```ts
setLocale(resolveLocale(process.env.LUMEN_LOCALE || process.env.LANG));
```

三条刻意的设计取舍：

1. **不读配置文件**：`--help` 要即时；`loadConfig()` 在配置非法时会往 stderr 打告警，
   让用户敲 `--help` 先吃一堆告警是新增噪音。命令内部仍按
   「`--lang` > 环境变量 > 配置」完整解析一次（各处 `setLocale` 保持不动，幂等兜底）。
2. **只调一次**：不重构 i18n 加载链，不改已有 9 处调用——改动面越小，回归越可控。
3. **`||` 而非 `??`**：空串 `LUMEN_LOCALE=` 应视为未设置（与 `config.ts` 的 `env()` 语义一致）。

## 连带副作用（这才是真正花时间的部分）

修完后 **任何 spawn CLI 的测试都开始受开发机 shell 的 `LUMEN_LOCALE` 影响**
（此前 `--help` 恒中文，天然免疫）。本机 `npm run verify` 全绿只证明「本机没设这个变量」。

按「定义 LUMEN_LOCALE=en 跑一遍全量」验证，抓到 **4 个受害点**：

| # | 文件 | 形式 | 症状 |
|---|---|---|---|
| 1 | `tests/cli/check.test.ts` | spawn CLI，`...process.env` 直通 | `check --help` 的中文描述断言 |
| 2 | `tests/core/suggestion.test.ts` | spawn `--help` | 同上 |
| 3 | `tests/e2e/missing-key.test.ts` | spawn CLI | 缺 Key 中文引导断言 |
| 4 | `tests/cli/team-parallel.test.ts` | **间接**：进程内 `runTeamCommand` 调 `setLocale` | 全局 locale 被改成 en，同文件后续中文断言红 |

前 3 个是「没钉死 env」，补 `LUMEN_LOCALE: 'zh'` 即可；
**第 4 个是模块级可变状态跨用例泄漏**，必须在 `afterEach` 里 `setLocale('zh')` 复位。
第 4 个是本条最值得记的：它不在 `...process.env` 的搜索范围内，
只有真的在 `LUMEN_LOCALE=en` 下跑全量才能暴露——**「只改不验」会漏掉它**。

## 这是「一类」缺陷，不是一个个案：全仓模块级可变状态清单

第 4 个受害点的本质是「**模块级可变状态被某个命令写入，跨用例串味**」，与 locale 无关——
换任何一个模块级状态都会重演。截至本文档时的全部清单（`grep -n "^let " src`，顶层无缩进）：

| 文件 | 模块级可变状态 | 写入入口 | 泄漏风险 |
|---|---|---|---|
| `src/i18n/index.ts` | `currentLocale` | `setLocale()`（chat/run/plan/commit/fix/review/team/self-heal/lsp + T22 入口） | **已踩**：测试进程内调这些命令会改全局，后续中文断言红 |
| `src/core/holidays.ts` | `activeHolidays` / `activeMakeupWorkdays` / `activeConfigured` | `configureHolidayCalendar()`（被 `loadConfig()` 调用） | 高：任何调 `loadConfig` 的用例都会改写全局节假日表，跨用例影响计价断言 |
| `src/cli/common.ts` | `apiKeyCache` | `resolveApiKeyCached()` | 中：命中缓存会让「换账号/换 Key」类用例读到上一个用例的值 |
| `src/model/tokenizer.ts` | `_encoder` / `_encoderFallback` | 懒加载（首次调用写入） | 低（幂等缓存，但「首次失败」状态会被后续用例继承） |
| `src/cli/crash-handler.ts` | `installed` | `installCrashHandlers()` | 低（幂等标志，但会掩盖「二次安装」行为） |

**检出手段（可执行，别靠肉眼）**：

1. 改了任何**启动期 / 全局状态**相关的代码后，必须换一个「非默认环境」跑全量：
   `LUMEN_LOCALE=en npm run verify`（locale 类）、`LANG=en_US.UTF-8 npm run verify`（LANG 兜底类）。
2. 扫受害者**两条路径都要扫**：
   - 谁传了 `...process.env` → `search_content` 搜 `process.env`；
   - **谁在进程内调用了写全局状态的函数** → 搜上面清单里的写入入口名
     （`setLocale` / `configureHolidayCalendar` / `resolveApiKeyCached` / `installCrashHandlers`）。
3. 新增用例若在进程内调用任何写入入口，**必须在 `afterEach` 复位**，不能指望用例执行顺序。

## 教训

1. **改了「启动期行为」就要按最坏环境跑一遍全量**，不能只看本机绿。
   本机绿 + 单一环境只能证明「我的环境没踩到」，不能证明「没人会踩到」。
2. **「翻译键齐全」≠「翻译会被渲染」**。`en.test.ts` 校验的是字典自身，
   `help.test.ts` 才校验渲染链路——两者缺一不可（对应 AGENTS「存在性 ≠ 跑通」）。
3. **找间接受害者要按「谁写全局状态」搜，不能只按「谁传 process.env」搜**。
   第 4 个受害点靠 `runTeamCommand → setLocale` 这条写路径才找得到。
4. **断言 CLI 输出必须先归一化空白**：commander 按终端宽度（无 TTY 时 80 列）折行，
   长文案会被拆成两行，`toContain(整串)` 会假失败（本次第一版断言就这么红的）。
5. **悬空引用会二次传播**：CHANGELOG 里我一度照抄 T21 代码注释里的
   `ADR-049 / D86-D87`，而 ADR 实际只到 ADR-047、决策编号只到 D82——
   引用不存在的编号比不写编号更糟，本次已全部改为不写编号。
