# 第三方许可声明（THIRD_PARTY_NOTICES）

> 本文件由 `scripts/gen-third-party-notices.mjs` **自动生成**，请勿手工编辑。
> 生成时间：2026-11-05 · 数据来源：本仓库 node_modules 实测

## 说明

ConcertoAI 通过 tsup 打包，**实测（2026-11-05）产物不打包任何第三方依赖**：
`dist/` 里是 `import "x"` / 动态 `import("cli-highlight")` 这样的外链，运行时由用户自己
`node_modules` 解析（探针：临时改名 `node_modules/zod` ⇒ CLI 立刻 `ERR_MODULE_NOT_FOUND`）；
`dist/` 内也搜不到 `hljs` / `registerLanguage` 等 highlight.js 特征串，故下表依赖**都不是打包进产物的代码**。
它们虽不随产物分发，但会随 `npm install` 一并装到用户机器上，许可证仍需声明。
原始许可证全文见 [`LICENSES/`](./LICENSES/) 目录。

本项目**未修改**任何第三方依赖的源码。

## 直接依赖

| 包 | 版本 | 许可证 | 版权声明 | 许可证全文 |
| --- | --- | --- | --- | --- |
| `chalk` | 4.1.2 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) | [chalk-4.1.2.txt](./LICENSES/chalk-4.1.2.txt) |
| `cli-highlight` | 2.1.11 | ISC | Felix Becker <felix.b@outlook.com> | [cli-highlight-2.1.11.txt](./LICENSES/cli-highlight-2.1.11.txt) |
| `commander` | 15.0.0 | MIT | TJ Holowaychuk <tj@vision-media.ca> | [commander-15.0.0.txt](./LICENSES/commander-15.0.0.txt) |
| `ink` | 7.1.1 | MIT | Vadim Demedes <vadimdemedes@hey.com> | [ink-7.1.1.txt](./LICENSES/ink-7.1.1.txt) |
| `react` | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | [react-19.2.8.txt](./LICENSES/react-19.2.8.txt) |
| `tiktoken` | 1.0.22 | MIT | （package.json 与 LICENSE 均未声明版权信息） | [tiktoken-1.0.22.txt](./LICENSES/tiktoken-1.0.22.txt) |
| `zod` | 4.6.7 | MIT | Colin McDonnell <zod@colinhacks.com> | [zod-4.6.7.txt](./LICENSES/zod-4.6.7.txt) |

## 传递依赖（不在 `dependencies` 里，但会随 `npm install` 装上）

以下依赖不是直接依赖，会被一并安装到用户机器上，需要一并声明：

| 包 | 版本 | 许可证 | 版权声明 | 许可证全文 |
| --- | --- | --- | --- | --- |
| `highlight.js` | 10.7.3 | BSD-3-Clause | Ivan Sagalaev <maniac@softwaremaniacs.org> | [highlight.js-10.7.3.txt](./LICENSES/highlight.js-10.7.3.txt) |

## 需要复现版权声明的许可证（BSD / Apache）

以下依赖使用 BSD-3-Clause 等「二进制分发须复现版权声明」的许可证。
当前构建并未把它打进 `dist/`（见上方说明），但用户机器上会装上它，
且若将来改为打包，这份声明就已就位；因此本项目始终在此处及 `LICENSES/` 中复现其版权信息：

- **highlight.js@10.7.3** — BSD-3-Clause — Copyright Ivan Sagalaev <maniac@softwaremaniacs.org>

## 已知的许可证文件缺失（如实记录）

以下依赖在 npm 发布物中**未附带 LICENSE 文件**（本项目无法凭空生成其原文），
其许可证类型以上游仓库为准，`LICENSES/` 中为说明文件：

- **tiktoken@1.0.22** — package.json 声明 `MIT` — 上游：https://github.com/dqbd/tiktoken

## 本项目许可证

ConcertoAI 本身以 MIT 许可证发布，详见 [LICENSE](./LICENSE)。
