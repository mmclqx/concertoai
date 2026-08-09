# KB-05: 安全漏洞清单

## Node.js 常见漏洞
1. **路径遍历**：`path.resolve(userInput)` 未校验 → 使用 `resolveSafe()` 沙箱
2. **命令注入**：`exec(userInput)` 未转义 → 使用白名单 + argv 数组
3. **SQL 注入**：拼接 SQL 字符串 → 使用参数化查询
4. **敏感信息泄露**：API key/log 输出到对话 → `.env` 文件拒绝读取 + 密钥遮蔽
5. **SSRF**：fetch 用户提供的 URL → 校验协议（仅 https）和域名白名单
6. **原型污染**：`Object.assign({}, userInput)` → 使用 Map 替代普通对象存储外部数据
7. **拒绝服务**：大文件读取/无限循环 → 设置 size limit + timeout + max turns

## 检查项
- 文件操作路径是否经过沙箱校验？
- 外部输入是否经过 zod 校验？
- API Key / Token 是否可能泄露到日志？
