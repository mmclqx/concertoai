# [2026-08-11] ESM 模块误用全局 __dirname 导致 team/review 命令崩溃

## 问题描述
- 现象：v3.1.0 发布后，`concertoai team` / `/orchestrate` / `/review` 触发 Reviewer 知识库加载时抛 **`ReferenceError: __dirname is not defined`**，命令直接崩溃退出（CLI 主链路未触发该路径，Linux/macOS 同现）。
- 环境：Node ≥22，ESM（package.json `"type": "module"`，全平台）

## 根因分析
- 直接原因：`src/reviewer/knowledge.ts` 的 `builtinKbDir()` 使用 CommonJS 全局 `__dirname`（`path.resolve(__dirname, '..', '..', ...)`），ESM 模块没有该全局变量，运行时即抛 ReferenceError。
- 深层原因：项目为 ESM（`"type": "module"`），但代码沿用 CJS 时代的 `__dirname` 习惯；该函数只在「加载内置知识库」路径被调用（team/review 场景），单测与 CLI 主链路未覆盖，v3.1.0 发布门漏检。

## 解决方案
- 修复方式：`builtinKbDir()` 改为接收 `cwd` 参数、基于 `path.resolve(cwd, 'skills', 'reviewer', 'knowledge')` 定位；知识库目录不存在时由 `loadKnowledgeBase` 的 try/catch 静默降级到项目级/全局级知识库（不崩溃）。
- 涉及文件：`src/reviewer/knowledge.ts`、`tests/reviewer/knowledge.test.ts`（新增回归测试：空目录不抛错返回空 Map + 项目级/内置知识库加载 + 超限截断）

## 经验教训
- 如何避免同类问题：ESM 项目禁用 `__dirname`/`__filename`，用 `import.meta.url` 或函数参数传递 cwd；凡是「相对路径定位」的函数，优先从调用方传入根目录（显式依赖）而非隐式全局。新增代码 lint 可加规则禁止 `__dirname` 裸引用。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md`（TypeScript 类型安全规范可补充：ESM 下禁用 `__dirname`/`__filename`）

## 相关链接
- 对话记录：v3.1.1 回归修复
- 相关 PR/Commit：（待提交）
