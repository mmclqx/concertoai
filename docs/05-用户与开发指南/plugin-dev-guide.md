# ConcertoAI 插件开发指南

> 日期：2026-08-14 · 对应 v4.0-dev-tasks.md T8.2（M4 插件系统）

## 1. 插件结构

```
my-plugin/
├── plugin.json      # 插件描述（名称/权限/入口）
└── index.mjs        # ESM 入口（必须 ESM；.mjs 或 .js + package.json type=module）
```

### plugin.json 最小示例

```json
{
  "name": "api-docs",
  "version": "1.0.0",
  "description": "扫描项目生成 API 文档",
  "entry": "index.mjs",
  "permissions": ["read"],
  "constraints": { "network": { "allowedDomains": [] } }
}
```

## 2. 六类权限

| 权限 | 说明 | 约束字段 |
|------|------|---------|
| `read` | 读文件/搜索 | — |
| `write` | 写文件（走审批） | — |
| `network` | 网络请求 | `constraints.network.allowedDomains` 白名单 |
| `shell` | 执行命令（走审批流，不可绕过） | `constraints.shell.allowlist` |
| `knowledge` | 知识图谱读写 | — |
| `mcp` | 访问 MCP 工具 | `constraints.mcp.servers` |

未声明权限的运行时访问被拦截（fail-closed）+ 审计日志。

## 3. 入口文件（ESM）

```javascript
// index.mjs
export function create(ctx) {
  // ctx: { t, logger, cwd, requestApproval, guard }
  return {
    // 单工具
    async 'api-docs:generate'({ target }) {
      // 声明了 read 权限 → 可读文件
      const files = await ctx.guard('read', { path: target }) || true;
      // ...
      return '文档已生成';
    },
    // 多工具写法：对象展开
    ...otherTools,
  };
}
```

- `ctx.guard(type, detail)`：运行时细粒度白名单校验（network/shell/mcp 必须传 detail）；
- `ctx.requestApproval`：审批回调（shell 权限通过 guard 后仍需审批）；
- 工具注册到 ToolRegistry 带 `pluginSource`/`pluginPermission`，调用前权限钩子拦截。

## 4. 安装与验证

```bash
concertoai plugin install my-plugin       # 从市场注册表安装
concertoai plugin install ./my-plugin     # 本地目录（开发调试）
concertoai plugin list                    # 已安装列表
concertoai plugin remove my-plugin        # 卸载
```

安装时展示权限清单（彩色图标）→ 用户确认 → 落盘到 `~/.concertoai/plugins/<name>/`（全局）或 `.concertoai/plugins/<name>/`（项目）。

## 5. 内置示例（可参考）

- `git-status`：只读，跑 `git status`（shell 权限 + 审批）
- `api-docs`：read，扫描 src/ 生成 API 文档
- `todo-tracker`：read/write，管理 TODO 清单
- `release-helper`：read + shell，发版辅助

## 6. 安全注意事项

1. **最小权限**：只声明需要的权限，`network`/`shell`/`mcp` 用白名单收窄；
2. **ESM 强制**：CJS 插件拒绝加载（明确报错）；
3. **目录名 = name**：加载器校验目录名与 plugin.json name 一致；
4. **不可绕过审批**：shell 权限 guard 通过后仍走宿主审批流（D5 基线）；
5. **审计**：权限拒绝与使用均写审计日志（`audit export` 可查）。
