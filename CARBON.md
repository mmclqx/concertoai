# Lumen 项目工作知识

> 最后更新：2026-08-09
> 版本：v2.1.0

Lumen 是一款面向个人开发者的终端编码助手 CLI（DeepSeek 驱动，中文优先），基于 TypeScript/Node 构建。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 22+ (ESM) |
| 语言 | TypeScript (strict) |
| TUI | Ink 7 + React 19 |
| CLI 框架 | Commander 12 |
| 参数校验 | Zod |
| 测试 | Vitest 4 |
| 代码检查 | Biome |
| 打包 | tsup |

---

## 常用命令

```bash
npm run dev          # 开发运行（进入交互模式）
npm run build        # 构建生产版本
npm run test         # 运行测试（42 文件 / 409 用例）
npm run test:watch   # 测试监听模式
npm run lint         # 代码检查
npm run lint:fix     # 自动修复代码风格
npm run typecheck    # TypeScript 类型检查
npm run verify       # 完整验收：build + lint + typecheck + test
```

## 产品规则
- npm 包：@lumen/cli（备选 lumen-cli）

- 主命令：lumen

- 短命令：lumen（不安装 cc，避免与 C 编译器冲突）

- 用户配置：~/.lumen/config.json

- 会话存储：~/.lumen/sessions/（JSONL 格式）

- 项目规则文件：AGENTS.md 优先，CARBON.md 兜底

## 关键文件位置
文件	说明
src/cli/index.ts	CLI 入口（commander 路由）
src/loop/loop.ts	对话主循环
src/model/client.ts	DeepSeek SSE 客户端
src/tools/registry.ts	工具注册表
src/ui/App.tsx	TUI 根组件
docs/	所有文档（01-07 编号规范）

## 开发注意事项
1. 审批流：编辑与 Shell 命令一律审批（fail-closed），无 yolo 模式

2. 测试：保持 409+ 用例全绿，新增功能必须包含测试

3. 文档：修改代码后同步更新 docs/ 中的相关文档

4. 提交：每个功能点独立提交，格式为 <type>(<scope>): <subject>

5. 环境变量：DEEPSEEK_API_KEY 为必需，永不提交到仓库

## 参考文档
- 完整文档见 docs/ 目录：

- 产品定位与范围

- 架构设计

- 测试报告