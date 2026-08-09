# KB-01: 项目编码规范

## TypeScript 严格模式
- 启用 `strict: true`（tsconfig.json）
- 禁止 `any` 类型（除非有明确注释说明原因）
- 优先使用 `interface` 而非 `type`（公开 API）
- 函数参数超过 3 个时使用对象参数

## 命名规范
- 文件名：kebab-case（如 `memory-injector.ts`）
- 类/接口：PascalCase
- 函数/变量：camelCase
- 常量：UPPER_SNAKE_CASE
- 私有成员：不强制 `_` 前缀，但推荐 `private readonly`

## 模块组织
- 每个模块有 `index.ts` barrel 导出
- 类型定义集中在 `types.ts`
- 工具按功能分组（`src/tools/`、`src/loop/`）
- 测试文件镜像源文件结构（`tests/`）

## 错误处理
- 不静默吞掉异常；至少记录日志
- 公共 API 返回 `{ ok: boolean, error?: string }` 模式
- 使用 `try/catch` 时明确注释预期异常类型

## 注释
- 公开 API 需要 JSDoc
- 复杂逻辑需要行内注释说明"为什么"
- 不写"做什么"的注释（代码自说明）
