# KB-08: TypeScript/Node 常见反模式

1. **`any` 滥用** — 应使用 `unknown` + 类型守卫
2. **同步阻塞** — `readFileSync`/`execSync` 在异步上下文中
3. **Promise 遗忘** — 未 await 的 Promise（静默丢失错误）
4. **回调地狱** — 应使用 async/await
5. **魔法数字** — 应提取为命名常量
6. **重复代码** — 跨文件复制粘贴相同逻辑
7. **巨型函数** — 超过 30 行考虑拆分
8. **过多参数** — 超过 3 个使用对象参数
9. **深层属性访问** — `a.b.c.d` 未做 null 检查
10. **事件监听器泄漏** — 组件卸载未 removeListener
