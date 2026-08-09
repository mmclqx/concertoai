# KB-09: 审查报告标准模板

## 格式规范
- 使用 markdown 格式
- 按严重程度分组（🔴 → 🟡 → 🟢）
- 每个问题包含：文件路径 + 行号 + 标题 + 描述 + 修复建议

## 严重程度判定
- 🔴 critical：运行时错误、安全漏洞、数据损坏 — 必须修复
- 🟡 medium：可维护性/性能风险 — 建议修复
- 🟢 suggestion：代码优化建议 — 可选修复

## 输出约束
- JSON 数组格式：`[{dimension, severity, file, line, title, description, suggestion}]`
- line 不存在时用 null
- suggestion 可选
