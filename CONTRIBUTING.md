# 贡献指南（CONTRIBUTING）

感谢你愿意参与 Lumen 的开发。请先阅读 [架构文档](docs/02-架构设计/ARCHITECTURE.md) 与 [产品定位](docs/01-产品定位与范围.md) 了解设计意图——安全基线（审批门控、路径沙箱、fail-closed）与关键决策（D1-D14）是产品承诺，修改前请先理解原因。

## 环境准备

- Node.js ≥ 22，npm
- 无需全局依赖（vitest / Biome / tsup 均为项目内 devDependencies）
- 真机冒烟需要 `DEEPSEEK_API_KEY`（可选）

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 开发运行（chat 模式，需真实 TTY） |
| `npm run verify` | **提交前必跑**：build + lint + typecheck + test |
| `npm run test:watch` | 测试监听 |
| `npm run lint:fix` | Biome 自动修复 |
| `npm run build` | 打包 dist |

## 代码规范

- **TypeScript strict**：所有代码通过 `npm run typecheck`；
- **Biome**：通过 `npm run lint`；格式化问题用 `npm run lint:fix`；
- **文案**：所有用户可见文案必须走 `src/i18n/` 字典（`t().xxx`），**中英双语同时补充**（`zh.ts` + `en.ts`，键结构必须一致——`en.test.ts` 会断言）；
- **错误消息**：工具/loop 层错误直接中文（回填给模型），界面错误走 i18n；
- **安全**：任何新增的危险操作（写文件、执行命令、访问网络）必须纳入审批门控与沙箱；
- **命名**：与现有风格一致（中文注释、清晰职责的文件级注释）。

## 测试要求

- 新功能/修复必须带测试：单元（纯逻辑）或集成（loop/工具链）或 UI（ink-testing-library）；
- 测试文件镜像 src 结构：`tests/<模块>/<文件>.test.{ts,tsx}`；
- **含 JSX 的测试文件必须 `.tsx` 扩展名**（`.ts` 下 esbuild 不解析 JSX）；
- 改动涉及 UI 交互时，先跑 `npm run test:watch` 观察 UI 用例回归。

## 架构文档同步

修改架构/数据流/常量后，同步更新 `docs/02-架构设计/ARCHITECTURE.md`：

- 目录结构、全景图、决策表（D 编号）；
- 已知问题与规划清单；
- 保持文中文件/函数/常量名与实现一致。

## PR 流程

1. 从 `main` 开分支，命名如 `feat/t3.3-plan`、`fix/crlf-edit`；
2. 小步提交，信息用中文描述改动（如 `T3.3: plan 模式`）；
3. 提交前跑 `npm run verify` 全绿 + `npm audit` 无 high/critical；
4. 更新 CHANGELOG.md 的 `[Unreleased]` 小节（Added/Changed/Fixed/Removed）；
5. 提 PR 到 `main`（CI 会自动跑 verify）。

## 发布

发布流程见 [docs/04-发布流程.md](docs/04-发布流程.md)：`npm version` → CHANGELOG → GitHub Actions 手动发布（Trusted Publishing）。
