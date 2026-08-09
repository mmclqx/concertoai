# KB-06: 性能审查清单

## 检查项
- 同步阻塞：`readFileSync` / `execSync` 在热路径中？→ 改用异步版本
- N+1 查询：循环内 await？→ 批量操作或 Promise.all
- 大文件读取：一次性读入内存？→ 流式处理或 size limit
- 内存泄漏：事件监听器未 remove？闭包持有大对象？
- 不必要的对象创建：循环内 new 大对象？

## Node 特定
- `fs.readFileSync` 在请求处理中 = 🔴 严重
- 未设置 timeout 的 fetch/网络请求 = 🟡 中等
- JSON.parse 大文件未限制大小 = 🟡 中等
