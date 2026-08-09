# KB-04: 错误处理最佳实践

## 原则
- 不静默吞异常：捕获后至少 log 或向上传播
- 用户可见错误用中文描述
- 区分可恢复（repairable）与不可恢复错误

## 模式
- `{ ok: boolean, error?: string, repairable?: boolean }` 用于工具返回值
- try-catch 不包裹大段代码（精确捕获已知异常）
- 异步函数内部异常需 await 或 .catch
- Promise.allSettled 处理部分失败场景
