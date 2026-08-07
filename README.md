# Lumen

Lumen —— 面向个人开发者的**中文优先**终端编码助手 CLI（DeepSeek 驱动）。

在项目目录里启动：读取代码 → 提出 diff 方案 → 征求命令许可 → 跑验证 → 留下会话记录。

> 状态：v0.1 开发中（当前处于 M1 骨架阶段，详见 `docs/dev/TASKS.md`）。

## 环境要求

- Node.js ≥ 22（原生 fetch / SSE 流式）

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发运行（T10 完成后进入 chat） |
| `npm run test` | 单元测试（vitest） |
| `npm run test:watch` | 测试监听模式 |
| `npm run lint` / `npm run lint:fix` | Biome 检查 / 自动修复 |
| `npm run typecheck` | TypeScript 严格类型检查 |
| `npm run build` | tsup 打包到 `dist/`（ESM） |
| `npm run verify` | 验收主命令：build + lint + typecheck + test |

## 目录结构

```
lumen/
├── docs/dev/             # 开发文档（开发计划、任务拆解）
├── src/
│   ├── cli/              # commander 入口（chat / run）
│   ├── ui/               # Ink TUI 组件
│   ├── loop/             # 会话主循环
│   ├── model/            # DeepSeek 客户端 / 模型表 / token 估算
│   ├── tools/            # 工具注册表与工具实现（读/编辑/shell）
│   ├── store/            # 会话持久化 / 项目规则加载
│   └── i18n/             # 中文文案表
└── tests/                # 镜像 src 结构的测试
```

## 版权

本项目（Lumen）为**全新独立项目**，非任何上游项目的复制或派生。

所有代码、文档、测试的版权归项目作者所有（Copyright © 2026 Lumen 项目作者），保留一切权利。对外使用条款见 [LICENSE](LICENSE)。
