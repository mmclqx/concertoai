# 2026-11-19 Vitest 4 已移除 `basic` reporter——启动失败、0 用例却退出码 0

## 问题描述

- **现象**：修 `instruction-state` 的 `superseded` 过滤器时写了变异探针 `.tmp-cont-mutation.mjs`，用
  ```js
  spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', TEST,
    '-t', 'superseded', '--silent=true', '--reporter=basic'])
  ```
  三组变异 M1/M2/M3 **全部**打印「零匹配 ⇒ 读数无效（探针空转）」，且每组耗时短得反常。
- **实测**（直接跑同一条命令，见 `.tmp-j8.log`）：
  ```
  Startup Error
  Error: Failed to load custom Reporter from basic
  [cause]: Error: Failed to load url basic (resolved id: basic). Does the file exist?
  code: 'ERR_LOAD_URL'
  ```
  stdout 里没有 `Test Files` 行 ⇒ **一条用例都没跑，退出码却是 0**。
- **环境**：Windows x64 / Node 22 / Vitest 4.x / 2026-11-19
- **危害等级**：🟡 中（本次被自己的检查挡住了），但**影响面广**——任何从 3.x 项目模板抄来的探针 / 脚本都写着 `--reporter=basic`，抄过来就是「静默跑 0 条 + 退出码 0」，而且**连一条失败都没有**，看起来比真跑还干净。

## 根因分析

- **直接原因**：Vitest 4 的 reporter 集合里**没有 `basic`**（3.x 有）。写一个不存在的名字，vitest 不当成参数错误报错，而是当成**自定义 reporter 模块路径**去 `import` ⇒ vite resolver 报 `Failed to load url basic` ⇒ 进程在准备阶段退出。
- **退出码**：这条路径下 vitest 的退出码是 **0**。所以「启动失败」与「跑完零失败」在**退出码维度完全等价**，只能靠输出里的 `Startup Error` / `Failed to load custom Reporter` 区分。
- **与 2026-11-10 那条是同一族，但更靠前一层**：那条是「过滤器把集合筛空了（73 skipped ⇒ exit 0）」；这条是「**尺子根本没装起来**」。两者都是「读数看起来正常、其实什么也没测」。
- **为什么差点骗过我**：探针期望「变异 ⇒ 红」。三组全报「零匹配」，最自然的反应是「变异锚点没命中 / 用例名过滤写错」——也就是**去怀疑被测对象**。真正坏的是 `--reporter` 参数，属于**尺子最外层**。若当时把校验写成「输出里出现 FAIL 才算红」，三次都拿不到 FAIL，最终结论会是「探针没通电」，然后我会去改变异点，越改越远。

## 解决方案

- 探针改 `--reporter=default`。
- 新增一道判据：输出含 `Startup Error` / `Failed to load custom Reporter` ⇒ **直接判「读数无效」**，并打印前 4 行原文。理由：这两种情况在退出码上不可区分，必须显式分派。
- 补 `ran` 解析的第三档：全红时 default reporter 只打 `Tests  N failed (N)`，原正则只有 `failed | passed` 与 `passed` 两档 ⇒ **会把「全红」误读成「零匹配」**。「读数丢失」和「读数错误」一样危险，只是更隐蔽。
- **保留** `ran === 0 ⇒ 读数无效` 这道检查——它是本次唯一挡住假结论的东西（不是运气）。已在该行写注释说明为什么它在。

## 经验教训

- 判据一句话：**「探针说零匹配」的第一反应必须是「先证明尺子装起来了」，不是「改被测点」。** 「启动失败 / 零匹配 / 全红」三种状态在退出码上互不可分，只有输出里的特定行能分。
- 升级测试框架（或复制旧模板）后，**先用一条最小命令确认 reporter / flag 仍被识别**，再拿它写护栏。
- 与 AGENTS「注入 / 全局扰动类验证必须先自证探针通电」同一判据：这里的「通电自证」就是 `ran > 0`。

## 相关链接

- 同族：`2026-11-10-vitest过滤词零匹配也返回成功.md`（零匹配恒绿）、`2026-11-07-归档校验探针两次假红与空转.md`（探针空转）
- 本轮提交：`c674111`（代码 + 用例 + 探针修复）、`1fbbe8e`（看板登记）
