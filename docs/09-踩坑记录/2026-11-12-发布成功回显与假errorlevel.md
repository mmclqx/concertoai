# 2026-11-12 `npm publish` 说成功、registry 查不到 —— 一个假 `%errorlevel%` 差点让我误判「已发布」

## 问题描述

- **现象**：`npm publish` 输出 `+ @concertoai/cli@5.1.0`，看起来干净成功。紧接着 `npm view @concertoai/cli version` 仍返回 **5.0.0**、`@5.1.0` 直接 **E404**。同一个动作，两个相反的结论。
- **环境**：Windows 10 x64 / Node 22.23.2 / npm 10.x / `registry=https://registry.npmjs.org/`
- **危害等级**：🟠 中高 —— 它不会让产品坏，但会让**发布记录撒谎**：TASKS.md 会写成「已发布」，而用户 `npm i -g @concertoai/cli` 装到的还是上一个版本。这是 AGENTS 三档口径（①已写入 / ②已提交 / ③已推送）之外的**第四档**：④**已进 registry 且线上可查可用**。

## 根因分析

### 假证据：`& echo exit=%errorlevel%` 拿到的是**命令开始前**的退出码

我当时的命令：

```bat
npm publish > "%TEMP%\v51-publish-run.log" 2>&1 & echo exit=%errorlevel%
```

`cmd.exe` 在**解析整行时**就把 `%errorlevel%` 展开成字面量（不是执行到那一步才取），所以 `exit=0` 是**上一条命令留下来的值**，与 `npm publish` 毫无关系。这一行的存在让「退出码」看起来已被核对，实际上什么都没核对。

> 判据：任何 `A & echo %errorlevel%` 的写法都**不是**在检查 A 的结果。要 A 的退出码必须 `A & echo %errorlevel%` 放在 `cmd /v:on` 里用 `!errorlevel!`，或者干脆 `if errorlevel 1`，或者分开跑两条命令。

### 真相：不是失败，是**传播期**

日志尾部原文（这才是该看的地方，而不是 grep）：

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
npm notice Your package is being processed and may take a few minutes to become available.
+ @concertoai/cli@5.1.0
```

npm 明确说了「正在处理，需要几分钟才可用」。**发布已受理，元数据未传播**，所以立刻 `npm view` 必然是 E404 或旧版本号。约 20 秒后复查即得到 `5.1.0`，`dist-tags.latest` 也指向 5.1.0。

### 为什么这一坑特别容易踩

| 层 | 表现 | 是否可信 |
|---|---|---|
| publish 的 stdout | `+ @concertoai/cli@5.1.0` | ⚠️ 只说明「请求被受理」，不说明「已可安装」 |
| registry 立即查询 | 旧版本 / E404 | ⚠️ 传播期正常现象，**不能据此判失败** |
| 等待后查询 | `5.1.0` + `latest` 指向它 | ✅ 有效 |
| 线上包实测 | 装下来 `--version` = 5.1.0 + 产物含新文案 | ✅ **唯一能证明「用户真的装得到」的** |

## 解决方案

1. **发布后固定四步复核**（缺一步都不算发布完成）：
   - `npm view <pkg>@<ver> version` 能查到；
   - `npm view <pkg> dist-tags` 的 `latest` 指向新版本；
   - `npm view <pkg> versions` 列表里有它；
   - **临时目录真装一份**，跑 `--version` + grep 一个本次新增的文案，证明修复真的进了产物。
2. **传播期要等、不要重发**：`Your package is being processed` 之后隔 20s 轮询即可。重发只会撞「版本已存在」。
3. **不要再写 `& echo %errorlevel%`**：要么 `if errorlevel 1`，要么把退出码写进日志文件再读回来。

## 教训

1. **「成功回显」和「失败回显」一样不可作为唯一证据**。AGENTS 早就写了「有 stderr ≠ 失败，判据看退出码」；这次是它的镜像——**有 `+ pkg@ver` ≠ 已发布**，判据也要看 registry 的最终事实，而不是命令自己的话。凡「不可逆的外部动作」（publish / push tag / 删远端），必须用**外部可查的状态**结案。
2. **`cmd` 的 `%VAR%` 是解析期展开**，把它和 `&` 连用等于自欺。我自己产出过一条看起来最像「已核对」的日志，恰恰是唯一没有信息量的那条。
3. **传播期的两头都会骗人**：立刻查是 E404（像失败），命令回显是成功（像完成）。所以发布复核必须**带重试 + 带外部实测**，一次查询不下结论。
