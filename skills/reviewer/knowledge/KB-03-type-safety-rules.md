# KB-03: TypeScript 类型安全规则

## 必须检查
- ❌ `any` 使用 — 必须替换为具体类型或 `unknown`
- ❌ 非空断言 `!` — 使用可选链 `?.` 或类型守卫
- ❌ 类型断言 `as` 绕过类型检查 — 需要注释说明原因
- ❌ 缺少 null/undefined 检查 — 对可能为空的值使用条件判断

## 推荐模式
- 使用 `zod` 做运行时校验（外部输入边界）
- 使用 discriminated union 替代 optional fields
- `Map<string, T>` 取值后检查 undefined
- 异步函数返回 `Promise<T>` 而非 `Promise<any>`
