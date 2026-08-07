# Lumen 用户手册

> 面向使用 Lumen 完成日常编码辅助的个人开发者。版本：v1.0。

## 1. 安装与升级

### 安装

```bash
npm install -g @lumen/cli
```

要求 Node.js ≥ 22。验证：

```bash
lumen --version
lumen --help
```

### 升级

```bash
npm update -g @lumen/cli
```

会话与配置存放在 `~/.lumen/`，升级不影响已有数据。

## 2. 命令参考

### `lumen` / `lumen chat` —— 交互式对话

| 选项 | 说明 |
| --- | --- |
| `-r, --resume [id]` | 恢复会话；不带 ID 时列出全部会话供键盘选择 |
| `-l, --list` | 仅打印历史会话列表（时间/消息数/首条摘要），不进入对话 |
| `-m, --model <id>` | 指定模型（默认读取配置，最后兜底 deepseek-v4-flash） |
| `--lang <zh\|en>` | 界面语言 |

### `lumen run "<任务>"` —— 一次性执行

| 选项 | 说明 |
| --- | --- |
| `-m, --model <id>` | 指定模型 |
| `--auto-approve` | 自动批准编辑与命令执行（**谨慎**；默认危险操作全部拒绝） |
| `--lang <zh\|en>` | 界面语言 |

默认（无 `--auto-approve`）下，编辑与命令一律拒绝（fail-closed），只读工具与白名单命令可执行。

### `lumen plan "<任务>"` —— 计划模式

1. 模型输出分步执行计划（markdown 列表）；
2. 展示计划，终端输入 `y` 批准 / `n` 拒绝（需交互式终端，或 `--auto-approve` 跳过）；
3. 批准后，模型按计划逐步执行（编辑/命令仍走审批，除非 `--auto-approve`）。

## 3. 交互细节

### 输入框

- ← / → 移动光标，Home / End 跳转行首尾；
- Backspace / Delete 删除光标前/处字符；
- ↑ / ↓ 浏览本会话输入历史（重复输入自动去重，上限 50 条）；
- Shift+Enter 换行；Enter 发送。

### 生成过程

- 思考中/工具执行时显示 Braille spinner；
- **Ctrl+C** 中断生成：已生成内容保留并回填会话，可继续输入；
- 网络中断：保留已生成部分并提示中文错误，不自动重连，请重试。

### 审批

- `edit_file` / 非白名单 `run_command` 会弹出审批框（黄色边框）；
- `y` 批准、`n` 拒绝；拒绝后模型会收到拒绝信息并调整方案，但**不会自动重试同一操作**；
- 审批策略可在配置中改为 `allowlist-only`（只放行白名单，其余一律拒绝且不弹框）。

### 对话内计划（/plan）

输入 `/plan 任务`：先由模型输出计划 → 弹出 PlanConfirm 审批框（品红色边框）→ `y` 批准后自动执行，`n` 拒绝。

## 4. 配置参考

文件：`~/.lumen/config.json`。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | number | 1 | 配置格式版本；不匹配时按空配置处理 |
| `defaultModel` | string | deepseek-v4-flash | 默认模型 ID |
| `allowlist` | string[] | 内置 4 条 | 免审批命令前缀 |
| `approvalPolicy` | `"ask" \| "allowlist-only"` | ask | 审批策略 |
| `sessionDir` | string | `~/.lumen/sessions` | 会话存储目录 |
| `locale` | `"zh" \| "en"` | zh | 界面语言 |

优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

环境变量：`LUMEN_MODEL` / `LUMEN_ALLOWLIST`（逗号分隔）/ `LUMEN_APPROVAL` / `LUMEN_SESSION_DIR` / `LUMEN_LOCALE`；语言还会参考系统 `LANG`（zh/en 前缀）。

## 5. 会话管理

- 每轮对话结束自动追加到 `~/.lumen/sessions/<id>.jsonl`；
- `lumen chat -r` 列出全部会话（时间/消息数/首条摘要），↑/↓ + Enter 选择；
- 会话文件为 JSONL：每行一条消息，可手动编辑（损坏行会被跳过并计数）；
- 并发写入有保护：同一会话内串行、原子落盘；跨进程冲突会提示。

## 6. 安全模型

- 审批门控：编辑与命令一律审批（fail-closed），无 yolo 模式；
- 路径沙箱：工具只能访问项目目录内；
- 白名单：命令前缀词边界匹配（`npm test` 命中 `npm test --x`，不命中 `npm testx`）；
- 截断：文件 50k 字符、搜索结果 100 条、工具回填 20k、命令输出 20k、项目规则 8k；
- 上下文：超模型 80% 预算自动裁剪（保留 system + 最近轮），记录日志；
- 防失控：工具循环上限 10 轮；可修复失败累计超 2 次终止；审批拒绝/越界不进入重试管线。

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报"未找到 DEEPSEEK_API_KEY" | 设置环境变量后重试 |
| chat 提示需要交互式终端 | 用真实终端运行，或改用 `lumen run` |
| 生成中断/网络错误 | 已保留内容会回填；直接重试即可 |
| 状态条显示"（真实）" | token 为 API 真实用量；流式中为估算值 |
| 命令全部被拒绝 | run 模式需 `--auto-approve`；chat 模式确认审批框按 y |
| 想要英文界面 | `--lang en` 或配置 `locale` |

## 8. 从 v0.1 迁移

v0.1 是开发期版本（源码运行 `npm run dev`）。v1.0 的变更：

- 安装方式改为 `npm install -g @lumen/cli`（`lumen` 命令）；
- 会话文件格式不变（JSONL），旧会话可直接 `lumen chat -r` 恢复；
- 新增 `lumen plan`、对话内 `/plan`、配置系统、EN 界面；
- 交互增强：光标/历史输入、markdown 渲染与代码高亮、真实 token 统计。
