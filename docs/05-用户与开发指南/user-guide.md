# ConcertoAI 用户手册

> 面向使用 ConcertoAI 完成日常编码辅助的个人开发者。版本：v3.2。

## 1. 安装与升级

### 安装

```bash
npm install -g @concertoai/cli
```

要求 Node.js ≥ 22。验证：

```bash
concertoai --version
concertoai --help
```

### 升级

```bash
npm update -g @concertoai/cli
```

会话与配置存放在 `~/.concertoai/`（v3.1 起；旧版 `~/.lumen/` 会在首次启动时自动迁移），升级不影响已有数据。

## 2. 命令参考

### `concertoai` / `concertoai chat` —— 交互式对话

| 选项 | 说明 |
| --- | --- |
| `-r, --resume [id]` | 恢复会话；不带 ID 时列出全部会话供键盘选择 |
| `-l, --list` | 仅打印历史会话列表（时间/消息数/首条摘要），不进入对话 |
| `-m, --model <id>` | 指定模型（默认读取配置，最后兜底 deepseek-v4-flash） |
| `--lang <zh\|en>` | 界面语言 |

### `concertoai run "<任务>"` —— 一次性执行

| 选项 | 说明 |
| --- | --- |
| `-m, --model <id>` | 指定模型 |
| `--auto-approve` | 自动批准编辑与命令执行（**谨慎**；默认危险操作全部拒绝） |
| `--lang <zh\|en>` | 界面语言 |

默认（无 `--auto-approve`）下，编辑与命令一律拒绝（fail-closed），只读工具与白名单命令可执行。

### `concertoai plan "<任务>"` —— 计划模式

1. 模型输出分步执行计划（markdown 列表）；
2. 展示计划，终端输入 `y` 或 `Enter` 批准 / `n` 或 `Esc` 拒绝（需交互式终端，或 `--auto-approve` 跳过）；
3. 批准后，模型按计划逐步执行（编辑/命令仍走审批，除非 `--auto-approve`）。

计划模式增强：
- **依赖检测**：自动分析步骤间依赖关系，按拓扑顺序调度，循环依赖提前报错；
- **进度跟踪**：TUI 实时展示每步状态（⏳ 进行中 / ✅ 已完成 / ❌ 失败），失败步骤可跳过或重试；
- **文件回滚**：编辑前自动快照，步骤失败时可回滚已完成的文件变更。

### `concertoai snapshot` —— 多文件事务快照管理（v3.0）

| 选项 | 说明 |
| --- | --- |
| `concertoai snapshot` / `concertoai snapshot list` | 列出全部残留快照（失败/取消任务的 taskId 列表） |
| `concertoai snapshot clean` | 清理全部残留快照（多 Agent 任务失败/超限后遗留） |

### `concertoai balance` —— 查询 DeepSeek 账户余额

查询 DeepSeek 官方余额接口（`GET /user/balance`），按币种输出账户总额、赠送余额与充值余额；账户不可用或返回空列表时给出明确提示。需要 `DEEPSEEK_API_KEY`；查询失败时以非零退出码结束。

```
$ concertoai balance
DeepSeek 账户余额
账户可用
CNY: 总额 110.00 ｜ 赠送 10.00 ｜ 充值 100.00
```

### `concertoai doctor` —— 环境诊断

逐项检查运行环境并汇总退出码（存在任一失败项返回 1，全部正常返回 0）：

| 检查项 | 说明 |
| --- | --- |
| Node.js / 平台 | 版本与操作系统 |
| API Key | `DEEPSEEK_API_KEY` 是否设置（不泄露内容） |
| 配置文件 | `~/.concertoai/config.json` 可读性（区分不存在/损坏） |
| 会话目录 | 可写性探测（创建临时文件后删除） |
| 模型表 | 内置模型表是否可加载 |
| 账号完整性（v3.2） | active 指针 → 账号 config.json 是否存在且可读；缺失/损坏时给出可复制的修复命令（`concertoai login <name>`） |
| 账户余额 | 有 API Key 时查询 DeepSeek 余额（含总额/赠送/充值） |

典型场景：

```bash
$ concertoai doctor          # 全项检查
✅ Node.js / 平台: v22.x (win32)
✅ API Key: 已设置（sk-****abcd）
✅ 配置文件: 存在，schema 版本 1
✅ 会话目录: 可写
✅ 模型表: 11 个模型（deepseek-v4-flash, …）
✅ 账号完整性: active: work（账号完整）
✅ 账户余额: CNY 总额 110.00 ｜ 赠送 10.00 ｜ 充值 100.00
# 退出码 0 = 全部正常；任一失败项返回 1
```

### `concertoai self-heal` —— AI 自我修复闭环（v3.1）

执行 `npm run verify`，失败时自动分类 → 修复 → 验证 → 回滚：

| 阶段 | 处理 |
| --- | --- |
| build / test | 不自动修，给出结构化反馈（code + 中文建议）转人工 |
| lint | 确定性执行 `npm run lint:fix`（白名单免审批），成功后重新 verify |
| type（简单错误：缺 import / 缺类型标注） | 调用模型生成修复，**弹审批框逐项确认**（y/n，fail-closed），每次只修 1 个；修复后 verify 失败或引入新错误 → 快照回滚 |

- 修复上限 `MAX_SELF_HEAL_ATTEMPTS = 2`，超限保留详细报告转人工；
- 仅修复 ConcertoAI 自身代码，**不自动修用户项目代码**；
- chat 内也可用 `/self-heal`（v3.2：状态条 activeTool 随阶段动态更新——执行 verify / lint 修复 / 模型修复 / 修复后验证 / 回滚 / 完成，长任务可感知，不黑盒等待）。

典型场景：

```bash
$ concertoai self-heal
✓ 分类：2 个 lint 错误（确定性修复，免审批）
→ 执行 npm run lint:fix …
✓ lint 修复后重新 verify：通过
✅ 自我修复完成：2 个 lint 错误已自动修复，0 个遗留

# 模型修复场景（简单类型错误）：弹审批框逐项确认
⚠️ 需要审批：修复 src/cli/foo.ts:12 缺失类型标注（y/n）: y
→ 修复后 verify 失败 → 快照回滚，保留报告转人工
```

### `concertoai project` —— 多项目管理（v3.1）

| 子命令 | 说明 |
| --- | --- |
| `project add <name> [path]` | 注册项目（path 缺省用当前目录）；重名/嵌套子目录拒绝 |
| `project list` | 三列表格列出 名称 \| 路径 \| 注册时间（v3.2）；当前 cwd 所在项目整行绿色高亮 + ★（当前） |
| `project remove <name>` | 卸载（不删除项目目录） |
| `project info <name>` | 显示 path / whitelist / mcpServers |
| `project switch <name>` | 校验项目存在并提示用 `-p` 或 `cd` 启动 |

隔离矩阵：项目模式下会话写入 `~/.concertoai/sessions/<projectKey>/`、审批白名单按项目合并、MCP 服务按项目声明；启动时用 `-p <name>` 或 `cd` 到项目目录自动匹配，未匹配用全局配置（行为与 v3.0 一致）。

典型场景：

```bash
$ cd ~/work/my-app && concertoai project list
已注册项目：
名称            路径                    注册时间
--------        --------                ----------
demo            D:\dev\demo             2026-08-10T10:00:00.000Z
my-app ★（当前） D:\work\my-app          2026-08-11T09:30:00.000Z
# 当前项目 my-app 整行绿色高亮 + ★（当前）标记
```

### `concertoai team "<任务>"` —— Orchestrator 团队执行（v3.1）

1. 模型将需求拆解为结构化任务清单（负责人/依赖/文件）；
2. 展示清单，终端 `y` 批准 / `n` 拒绝（非交互需 `--auto-approve`）；
3. 对抗性闭环：Coder 实现 → Reviewer 审查 → QA 验证（≤ 5 次），超限/失败自动事务回滚；
4. 输出各角色工件引用（code / review-result / test-report）+ 中文摘要。

| 选项 | 说明 |
| --- | --- |
| `--dry-run` | 仅输出拆解清单，不执行任何 Agent |
| `--auto-approve` | 自动批准拆解方案与代码写盘（**谨慎**） |

**进度推送（v3.2）**：长任务不黑盒等待——CLI stdout 与 chat 消息流会渐进推送中间进度：拆解完成（📋 已拆解 N 个任务）→ 每轮闭环（🔁 第 x/5 轮 实现/审查/验证）→ 收尾（✅/❌）。

chat 内可用 `/orchestrate <任务>` 触发全链路（进度同样以聊天消息渐进推送），`o` 键打开可观测性面板查看 spans。

典型场景：

```bash
$ concertoai team "为项目添加单元测试框架配置"
📋 已拆解 3 个任务
=== 任务拆解 ===
1. [architect] 调研 vitest 配置（依赖：无）
2. [coder] 编写 vitest.config.ts（依赖：1）
3. [qa] 运行 npm run verify（依赖：2）
批准该方案并开始执行 (y/n): y
🔁 第 1/5 轮（实现）
🔁 第 1/5 轮（审查）
🔁 第 1/5 轮（验证）
✅ 团队执行完成
=== 工件 ===
- [code] vitest.config.ts
- [review-result] loop-1-review: 通过
- [test-report] loop-1-qa: 全部通过
```

### `concertoai audit export` —— 审计日志导出（v3.1）

导出 `~/.concertoai/audit/` 全部 JSONL 为**保序 JSON 数组**（按 seq 升序）：

- `concertoai audit export`：打印到 stdout；
- `concertoai audit export --out <file>`：写入文件（目录自动创建）；
- 无审计日志时输出「暂无审计日志」，退出码 0（非错误）；
- v3.2：输出末尾显示损坏行统计「共 N 条记录（跳过 M 条损坏行）」，损坏 JSONL 行跳过但不静默。

典型场景：

```bash
$ concertoai audit export --out audit.json
✅ 审计日志已导出到 audit.json：共 42 条记录（跳过 0 条损坏行）。
```

### `concertoai workflow` —— 工作流引擎（v4.0 M2）

| 子命令 | 说明 |
| --- | --- |
| `workflow init` | 交互选模板（init-ts / upgrade-deps / release / precommit）生成 `.concertoai/workflows/<name>.yml` |
| `workflow run <name>` | DAG 依赖排序执行（并行 where possible + 审批节点暂停 + 失败恢复 R/S/F/A + SnapshotManager 整体回滚） |
| `workflow list` | 列出已注册工作流 |
| `workflow export <name>` | 导出 YAML（可重定向分享） |
| `workflow import <file>` | 导入校验并注册 |
| `workflow create "<自然语言>"` | 模型生成工作流 YAML（非法降级人工编辑） |

chat 内 `/workflow run <name>` 同样可用。语法参考见 [workflow-syntax.md](./workflow-syntax.md)。

### `concertoai provider` —— 多 Provider 切换（v4.0 M3）

| 子命令 | 说明 |
| --- | --- |
| `provider list` | 查看全部 Provider 状态（🟢 可用 / 🔴 不可用 / 🟡 降级） |
| `provider auth <name> [--verify]` | 认证 Key（0600 存储；`--verify` 仅验证不保存） |
| `provider switch <name>` | 持久化切换 defaultProvider |

`concertoai --provider openai` 临时切换；`concertoai config set provider openai` 持久化。切换前状态条显示成本对比。DeepSeek（默认）/ OpenAI（兼容协议，baseUrl 可配）/ Ollama（本地探测 /api/tags）。config v3→v4 自动迁移（备份 + `_migrated` 幂等），`config restore` 回滚。详见 [migration-guide-v4.md](./migration-guide-v4.md)。

### 对话内 `/model` —— 模型查看与切换（v5.0 T6）

| 命令 | 说明 |
| --- | --- |
| `/model` | 显示当前模型 + **当前时段单价**（高峰价 / 空闲价）+ 更强档升级提示（可复制命令 + 成本倍数） |
| `/model list` | 列出可用模型与当前时段单价，`← 当前` 标记正在使用的模型 |
| `/model auto` | 启用 auto 预设：**从默认档（flash）起步**，打印成本策略说明；**不会自动升级** |
| `/model <id>` | 手动切换：**变贵（升级）先弹审批框确认**，变便宜（降级）直接生效 |

**保守边界（务必知情）**：`auto` 不是「后台自动升降级」，而是「一套被说明清楚的默认策略 + 手动一键切换」。任何「根据任务复杂度自动换模型」的行为都**不会发生**——是否花更多钱跑更强的模型，永远由你确认（见 ADR-039）。

```
$ /model
🤖 当前模型：DeepSeek V4 Flash（deepseek-v4-flash）
   当前时段：空闲价（输入 ¥1.5/百万 · 输出 ¥4.5/百万 · 缓存命中 ¥0.05/百万）
   上下文窗口：128,000 tokens · 并发限制：2500
   💡 任务较复杂？可手动升级到 DeepSeek V4 Pro：/model deepseek-v4-pro（同一示例用量约 3.0 倍成本，需确认）
用法：/model auto（自动预设）· /model list（模型列表）· /model <id>（手动切换）

$ /model deepseek-v4-pro
# → 弹出审批框「切换模型（成本将上升）」+ 成本对比；y 批准 / n、Esc 拒绝（拒绝即保持原模型）
```

其他细节：

- 切换按「成本方向」决策，与编辑/命令**同一套 fail-closed 决议机制**（确认过程异常视为拒绝）；
- 成本对比用与 `concertoai doctor` 月成本预估**同一套示例用量**（输入 8k 含缓存命中 4k、输出 1.2k），不会两处算出不同数；
- 非 deepseek Provider 下 `/model` 明确拒绝并提示 `concertoai provider switch <name>`（不在价格表内的模型切换无意义）；
- 配置文件也可写 `providers.deepseek.model: "auto"`，启动时会明确告知实际生效模型（不静默替换）。

### `concertoai plugin` —— 插件市场（v4.0 M4）

| 子命令 | 说明 |
| --- | --- |
| `plugin install <name>` | 注册表匹配 → 下载/builtin 直装 → sha256 → 权限清单确认 → 落盘 |
| `plugin search <kw>` | 模糊搜索 |
| `plugin list` / `plugin remove <name>` | 已安装列表 / 卸载 |
| `plugin browse` | 分类浏览（🔧工具/📋工作流/🤖Agent，含下载量+评分） |
| `plugin recommend` | 基于项目特征推荐（「检测到 Express+TypeORM → 推荐 api-docs」） |
| `plugin popular` | 社区热门 Top 10 |

chat 内 `/plugin list|install|remove` 可用。插件开发见 [plugin-dev-guide.md](./plugin-dev-guide.md)。

### `concertoai lsp --stdio` —— LSP 三来源诊断（v4.0 M6）

启动 Language Server（stdin/stdout Content-Length 帧），VS Code 一行配置即可连接：

```json
{ "concertoai.lsp.serverPath": "concertoai", "concertoai.lsp.args": ["lsp", "--stdio"] }
```

保存 .ts/.tsx → Problems 面板三来源诊断：biome lint（Warning）/ tsc type（Error）/ self-heal 静态规则（Information：未使用 import、显式 any、console.log）；CodeAction「🔧 用 ConcertoAI 修复」/「移除未使用的 import」一键修复（服务端只产出 diff，不直接改用户文件）。

### `concertoai review --fix` —— 一键修复（v4.0 M1）

`/review --fix`（chat 内）：审查完成后自动进入修复模式——A/B 类分批 → 批量审批 diff 摘要 → snapshot-guard 快照回滚 → 增量 verify → 报告底部「修复结果」区块（✅已修复 / ⚠需人工 / ❌自动回滚），≤2 次交互。

### `concertoai team --parallel` —— 多 Agent 并行（v4.0 M5）

`concertoai team --parallel "同时修复登录 bug 和重构用户模块"`（或自然语言含「同时/并行/分别」自动触发）：任务按依赖分层并行 → 每任务独立上下文/事务 → 汇总报告（含文件冲突提示「A 和 B 都修改了 X，请检查保留哪个版本」）；意图识别失败降级串行 + 提示。

### `concertoai login / logout / whoami / account` —— 多账号管理（v3.1）

| 命令 | 说明 |
| --- | --- |
| `login <name> [--key <key>]` | 登录账号（交互输入 API Key 不回显；`--key` 供 CI 非交互注入）；重名覆盖前确认 |
| `logout <name> [--purge]` | 登出（清除 active 指针；`--purge` 才删除账号文件） |
| `whoami` | 显示当前账号名 + Key 后 4 位（打码 `sk-****abcd`）；账号配置缺失时给出可复制修复命令（v3.2） |
| `account switch <name>` / `account list` | 切换 active / 列出账号（v3.2：active 账号绿色高亮） |

API Key 解析优先级：CLI > 环境变量 `DEEPSEEK_API_KEY` > active account > config.json（回退）。账号 = 一个 API Key 配置文件（`~/.concertoai/accounts/<name>/config.json`，权限 0600），与项目无关；任意命令不输出完整 Key。

典型场景：

```bash
$ concertoai whoami
当前账号: work（sk-****abcd）

# 账号配置缺失（active 指针指向已删除账号）：
$ concertoai whoami
当前账号指针: ghost（账号配置缺失，请重新登录：concertoai login ghost）
# ↑ 命令可直接复制执行修复

$ concertoai account list
已登录账号：
  work ★（当前）      # 绿色高亮
  personal
```

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

- `edit_file` / 非白名单 `run_command` 会弹出审批框（黄色边框）；v5.0 起**升级模型**（`/model <更贵模型>`）也走审批框（标题「切换模型（成本将上升）」+ 成本对比）；
- `y` 或 `Enter` 批准、`n` 或 `Esc` 拒绝；拒绝后模型会收到拒绝信息并调整方案，但**不会自动重试同一操作**；
- 审批策略可在配置中改为 `allowlist-only`（只放行白名单，其余一律拒绝且不弹框）。

### 对话内计划（/plan）

输入 `/plan 任务`：先由模型输出计划 → 弹出 PlanConfirm 审批框（品红色边框）→ `y` 或 `Enter` 批准后自动执行，`n` 或 `Esc` 拒绝。

## 4. 配置参考

文件：`~/.concertoai/config.json`。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | number | 1 | 配置格式版本；不匹配时按空配置处理 |
| `defaultModel` | string | deepseek-v4-flash | 默认模型 ID |
| `allowlist` | string[] | 内置 4 条 | 免审批命令前缀 |
| `approvalPolicy` | `"ask" \| "allowlist-only"` | ask | 审批策略 |
| `sessionDir` | string | `~/.concertoai/sessions` | 会话存储目录 |
| `locale` | `"zh" \| "en"` | zh | 界面语言 |
| `mcpServers` | `MCPServerEntry[]` | `[]` | MCP 服务连接配置（v1.1 新增），每项含 `name`/`command`/`args`/`env` |
| `peakTimeStrategy` | `"ask" \| "switch" \| "ignore"` | ask | 高峰时段模型切换策略（v2.2）：`ask`=交互确认 / `switch`=直接切换 / `ignore`=忽略 |
| `ollamaModel` | string | `qwen3.6:27b-q4_K_M` | 高峰时段切换到的本地模型 ID（v2.2） |
| `ollamaBaseUrl` | string | `http://localhost:11434/v1` | 本地模型 OpenAI 兼容端点（Ollama /v1，v2.2） |

优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

### 智能成本控制（高峰时段切换）

工作日（周一至周五）9:00-12:00 / 14:00-18:00 为高峰时段，此时 API 调用成本较高，可切换到本地 ollama 模型（成本为 0）。启动时按 `peakTimeStrategy` 决策：

- `ask`（默认）：交互终端弹出确认提示，输入 `y` 切换到本地模型、`n` 保持主模型；非交互环境（如 `concertoai run`）自动跳过切换不阻塞；
- `switch`：高峰时段直接切换到本地模型；
- `ignore`：忽略切换，始终使用主模型。

非高峰时段或周末不触发任何切换与提示（零打扰）。切换到的本地模型不在 DeepSeek 模型表中，客户端按 `ollamaBaseUrl` 构建（OpenAI 兼容 /v1），状态条成本按 0 展示。

环境变量：`LUMEN_MODEL` / `LUMEN_ALLOWLIST`（逗号分隔）/ `LUMEN_APPROVAL` / `LUMEN_SESSION_DIR` / `LUMEN_LOCALE`；语言还会参考系统 `LANG`（zh/en 前缀）。

## 5. MCP 服务配置

ConcertoAI 支持通过 [MCP（Model Context Protocol）](https://modelcontextprotocol.io) 连接外部工具服务。

### 配置示例

```json
{
  "schemaVersion": 1,
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    {
      "name": "memory",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  ]
}
```

### 内置预配置

三种常用 MCP 服务的推荐配置（`src/mcp/builtin-servers.ts`）：

| 服务 | 用途 | 需额外准备 |
| --- | --- | --- |
| `filesystem` | 文件系统读写（受限在指定目录内） | 允许访问的目录路径 |
| `memory` | 跨会话知识图谱存储与检索 | 无 |
| `github` | GitHub 仓库操作（Issue/PR/文件） | `GITHUB_PERSONAL_ACCESS_TOKEN` 环境变量 |

### 工作原理

- 启动时自动连接已配置的 MCP 服务（并发），工具以 `服务名_工具名` 格式注册；
- MCP 工具与内置工具共存——MCP 服务不可用时自动降级，不影响内置工具；
- 模型在对话中可直接调用 MCP 工具（如 `filesystem_read_file`），调用结果回填上下文。

## 6. 多 Agent 协作团队（v3.0）

v3.0 引入「多 Agent 团队」工作流（Orchestrator 模式）：Orchestrator 接收需求 → 拆解为结构化任务（含依赖与负责人）→ 按 DAG 拓扑调度（无依赖任务并行）→ 聚合结果交付。

### 6.1 四个专业 Agent

| Agent | 职责 | 权限（fail-closed） |
|-------|------|---------------------|
| `architect` | 接收需求 → 输出结构化设计 spec（接口定义 + 文件结构 + 约束条件） | 只读工具 |
| `coder` | 按 spec 实现代码 + 接收审查反馈自动修复（审批后写盘） | `edit_file` |
| `reviewer` | 9 维审查代码，输出 `ReviewResult`（approve / reject 打回） | 只读工具 |
| `qa` | 子代理沙箱执行 `npm run verify`，输出结构化测试报告 | `run_command npm run verify` |

### 6.2 对抗性闭环

`Coder 实现 → Reviewer 审查 → reject 则打回修复 → approve 则 QA 验证 → 失败则继续修复`，循环 ≤ 5 次。

- **终止条件**：Reviewer approve 且 QA 全绿；
- **超限退出**：超过 5 次自动退出，保留中间结果（代码/审查/测试报告）供人工检查，并触发多文件事务回滚（恢复所有涉及文件到任务前状态）；
- **审批流**：Coder 的写盘操作仍走审批（fail-closed），Agent 不会未经确认修改代码。

### 6.3 多文件事务回滚

每个 Agent 任务开始前创建 `.concertoai/snapshots/<taskId>/` 快照，回滚时原子恢复全部涉及文件：

- 快照时存在的文件 → 恢复原始内容；
- 任务新增的文件 → 删除；
- **外部修改检测**：任务未登记或内容不符的文件拒绝覆盖（避免误伤人工改动）；
- 成功后自动清理快照；失败/取消后保留，可用 `concertoai snapshot clean` 手动清理。

## 7. Agent 市场（v3.0）

升级自技能市场——从「技能复用」到「Agent 复用」。复用 `registry.json` 注册表格式与安装器架构（下载 → sha256 校验 → 写入），通过 `type: "skill" | "agent"` 区分条目。

### 对话内命令

| 命令 | 说明 |
|------|------|
| `/agent list` | 列出 Agent 团队：内置 4 个（architect/coder/reviewer/qa）+ 已安装外部 Agent（含权限摘要与安装时间）；v3.2：网络可用时标注「↑ 可更新到 <最新版>」或「最新」（已安装 vs 注册表最新版本对比），注册表不可达自动降级为无对比列表 |
| `/agent install <name>` | 从市场安装 Agent：fetch 注册表 → 匹配条目 → 下载 → sha256 校验 → 接口合规检查 → 写入 `~/.concertoai/agents/<name>/` → 刷新注册表 |
| `/agent remove <name>` | 卸载已安装外部 Agent（内置 Agent 随 ConcertoAI 分发，拒绝卸载） |
| `/agent update [name]` | 检查并更新指定 Agent（版本落后覆盖；已最新提示无需更新）；无参数时列出全部可更新 Agent |
| `/agent update --all` | （v3.2）批量更新全部可更新 Agent，逐条输出 ✅ 已更新 / ⏭️ 已最新 / ❌ 失败，单个失败不影响其他 |
| `/agent promote <skill>` | 将技能一键升级为 Agent：读取 SKILL.md → 生成脚手架（AgentDef 接口声明 + 实现骨架 + 权限声明，默认继承技能所需最小权限）→ 注册；原技能保留 |

典型场景：

```bash
$ /agent update --all
📦 批量更新完成（2 个可更新）：
- ✅ **my-agent** 1.0.0 → 2.0.0
- ❌ **other-agent** 下载 other-agent 失败或 sha256 校验不通过（已拒绝安装）。

$ /agent list
📋 Agent 团队（内置 4 个）：
- **architect** 1.0.0 — 需求 → 设计 spec [权限: read_file, search_content, list_directory]
…
📦 已安装外部 Agent（1 个）：
- **my-agent** 1.0.0（↑ 可更新到 2.0.0）— [权限: read_file]（安装于 2026/8/10 10:00:00）
```

### 安全保证

- **sha256 校验**：包内容与注册表声明不一致 → 拒绝安装；
- **接口合规检查**：安装前校验 `AgentDef.interfaces`（input/output Schema）与 `permissions` 完整，不符合拒绝安装；
- **权限 fail-closed**：未在 `AgentDef.permissions` 声明的工具一律拒绝（对齐 ADR-004），外部 Agent 无法越权。

### 安装位置

外部 Agent 安装在 `~/.concertoai/agents/<name>/`；内置 Agent 随 ConcertoAI 分发（`BUILTIN_AGENT_ITEMS`）。`/agent list` 同时展示两者。

## 8. 可观测性（v3.0）

多 Agent 协作的每一步决策都可追溯、可审计。

### 调用链追踪

每条 Agent 消息记录输入/输出/决策/耗时，按 taskId 查询完整父子任务树（内存 LRU，上限 5000 条）；任务状态机状态变更自动记录为决策跨度（含 reason）。

### 审计日志

所有 Agent 交互（消息 / 状态变更 / 审批 / 回滚）JSONL 追加写入 `~/.concertoai/audit/<时间戳>.jsonl`，异步不阻塞主流程，单条写入 < 10ms；`AuditLogger.exportJson()` 可导出为 JSON。

### 可观测性面板

对话中可展开 Agent 协作流程树面板：节点 = 任务/Agent，展示实时状态、耗时与消息数；输入 → 决策 → 输出摘要逐条可见；可展开/收起，不阻塞主对话流。

## 9. 跨会话记忆

ConcertoAI 支持项目级跨会话记忆，帮助模型在多次对话中「记住」项目上下文。

### 存储位置

项目根目录 `.lumen-memory/memories.jsonl`（JSONL 格式，每行一条记忆）。各项目独立存储，互不干扰。

### 对话内命令

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `/remember <内容>` | 模型生成记忆摘要，确认后写入 | `/remember 这个项目使用 vitest 做测试框架` |
| `/forget <关键词>` | 搜索匹配记忆，选择后删除 | `/forget vitest` |
| `/memories` | 列出当前项目所有已保存的记忆 | `/memories` |

### 自动检索

每轮对话开始时，ConcertoAI 自动从本地记忆中检索与当前问题相关的内容（按关键词 + 标签匹配，最多 5 条），以「# 项目记忆」块注入系统提示。无相关记忆时不注入。

> **与 MCP memory 的关系**：本地记忆（`.lumen-memory/`）是零依赖的轻量方案，MCP memory 服务提供知识图谱能力。两者可同时启用，记忆合并注入上下文。

## 10. 会话管理

- 每轮对话结束自动追加到 `~/.concertoai/sessions/<id>.jsonl`；
- `concertoai chat -r` 列出全部会话（时间/消息数/首条摘要），↑/↓ + Enter 选择；
- 会话文件为 JSONL：每行一条消息，可手动编辑（损坏行会被跳过并计数）；
- 并发写入有保护：同一会话内串行、原子落盘；跨进程冲突会提示。

## 11. 安全模型

- 审批门控：编辑与命令一律审批（fail-closed），无 yolo 模式；多 Agent 的 Coder 写盘同样走审批；
- Agent 权限 fail-closed：外部 Agent 只能使用 `AgentDef.permissions` 声明过的工具；
- 路径沙箱：工具只能访问项目目录内；
- 白名单：命令前缀词边界匹配（`npm test` 命中 `npm test --x`，不命中 `npm testx`）；
- 截断：文件 50k 字符、搜索结果 100 条、工具回填 20k、命令输出 20k、项目规则 8k；
- 上下文：超模型 80% 预算自动裁剪（保留 system + 最近轮），记录日志；Agent 显式上下文 ≤ 64KB；
- 防失控：工具循环上限 50 轮；可修复失败累计超 2 次终止；审批拒绝/越界不进入重试管线；对抗性闭环 ≤ 5 次。

## 12. 故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报"未找到 DEEPSEEK_API_KEY" | 设置环境变量后重试 |
| chat 提示需要交互式终端 | 用真实终端运行，或改用 `concertoai run` |
| 生成中断/网络错误 | 已保留内容会回填；直接重试即可 |
| 状态条显示"（真实）" | token 为 API 真实用量；流式中为估算值 |
| 命令全部被拒绝 | run 模式需 `--auto-approve`；chat 模式确认审批框按 y 或 Enter |
| 想要英文界面 | `--lang en` 或配置 `locale` |

## 13. 从 v0.1 迁移

v1.0 从 v0.1 的变更：

- 安装方式改为 `npm install -g @concertoai/cli`（`concertoai` 命令）；
- 会话文件格式不变（JSONL），旧会话可直接 `concertoai chat -r` 恢复；
- 新增 `concertoai plan`、对话内 `/plan`、配置系统、EN 界面；
- 交互增强：光标/历史输入、markdown 渲染与代码高亮、真实 token 统计。

v1.1 新增：

- **MCP 协议接入**：连接外部工具服务（filesystem / memory / github）；
- **跨会话记忆**：`/remember` `/forget` `/memories` 管理项目知识；
- **计划增强**：依赖检测、进度跟踪、文件回滚。

v2.0 新增：

- **BPE 精确 Token 计数**：`tiktoken`（o200k_base）替换 CJK 加权估算，误差 <5%，状态条显示缓存命中成本（`💾 缓存命中 N token（¥X）`）；
- **智能摘要压缩**：上下文超 80% 预算时优先调模型生成摘要，失败回退旧裁剪策略；
- **子代理系统**：模型可调用 `spawn_subagent` 启动隔离子代理（`explore` / `research`），独立上下文 + 只读工具集，回填结论不污染主对话；
- **技能系统**：`/skill list` 列出技能、`/skill <name>` 注入 system prompt（内置 code-review / explain / refactor，自定义放 `.concertoai/skills/<name>/SKILL.md`）；
- **MCP 动态管理**：`/mcp status` `/mcp connect <name>` `/mcp disconnect <name>` 运行时管理连接，状态条显示 `🔌 N/M 服务`。

v2.1 新增：

- **轻量级知识图谱**：项目级结构化记忆（JSONL + 内存邻接表索引 + LRU，按项目隔离），`knowledge_*` 系列 5 个工具记录/查询项目知识，双源记忆注入（本地记忆 + 知识图谱）；
- **Reviewer Agent**：`/review` 9 维审查聚合 5 个并行子代理 + 自动测试 `npm run verify`，输出按文件去重 + 严重程度排序的审查报告（auto / 指定路径 / `--pr` 三种模式）；
- **技能市场与嵌套**：`@skill` / `@agent` 引用递归展开（≤3 层 + 循环检测），`/skill install <name>` / `search <关键词>` / `update` 市场命令；
- **子代理 MCP 工具**：explore → filesystem、research → filesystem/github，服务不可用时静默降级。

v3.0 新增：

- **多 Agent 协作团队**：Orchestrator 拆解需求 → DAG 拓扑调度（并行）→ 4 个专业 Agent（architect/coder/reviewer/qa）各司其职 → 对抗性闭环（Coder→Reviewer→QA，≤ 5 次）；
- **多文件事务回滚**：任务级快照 `.concertoai/snapshots/<taskId>/`，原子恢复 + 外部修改检测 + `concertoai snapshot clean`；
- **Agent 市场**：`/agent list` / `install <name>` / `remove <name>` / `promote <skill>`，外部 Agent sha256 校验 + 接口合规检查 + 权限 fail-closed；
- **可观测性**：调用链追踪（TraceStore LRU）、审计日志（`~/.concertoai/audit/`，JSON 可导出）、Agent 协作流程树面板。

v2.2 新增（智能成本控制）：

- **高峰时段检测与模型切换**：工作日 9:00-12:00 / 14:00-18:00 判定为高峰时段，启动时按 `peakTimeStrategy`（ask/switch/ignore）决定是否切换到本地 ollama 模型，`concertoai balance` 可随时查看 DeepSeek 账户余额。

v3.1 新增：

- **AI 自我修复**：`concertoai self-heal` / `/self-heal`，verify 失败自动分类（lint 直修 / 简单类型模型修复走审批）→ 快照回滚，仅修自身代码；
- **多项目管理**：`concertoai project add/list/remove/info/switch` + `-p <name>`，会话 / 审批白名单 / MCP 按项目隔离；
- **多账号**：`concertoai login/logout/whoami/account`，账号 = API Key 配置文件（0600 + active 指针），Key 打码展示；
- **Orchestrator CLI**：`concertoai team "<任务>"`（拆解 → 对抗性闭环 → 回滚兜底）+ `/orchestrate` + `audit export`（审计日志保序导出）+ `/agent update` + `/review --severity`；
- **结构化错误增强**：工具错误统一携带机器可读 `code` + 中文 `suggestion`。

v3.2 新增（跨平台可靠 + 长任务可感知 + 代码可维护）：

- **跨平台兼容性增强**：CI 三平台矩阵（ubuntu / windows / macOS）；spawn 审计（Windows `.cmd`/`.bat` 走 `shell: true` 或命令兼容层）；UNC 路径与 EXDEV 跨盘回退边界补齐；
- **self-heal 模块化重构**：单文件 870 行 → 3 模块（classifier / repair / snapshot-guard）+ 增量 verify（lint 修复后仅 rerun lint 段，通过跳过全量）+ 快照失效通知；
- **错误处理强化**：`audit export` 损坏行统计（共 N 条 / 跳过 M 条）、`/orchestrate` 拆解失败 diagnostics、inferErrorCode 英文关键词回归；
- **用户体验优化**：`team` / `/orchestrate` 进度渐进推送（拆解/轮次/收尾）、`self-heal` 状态条阶段动态更新、`project list` 三列表格 + 当前项目高亮、`whoami` 可复制修复命令、`doctor` 账号完整性检查、启动期缓存（重复命令不再重复读盘）；
- **Agent 市场版本管理**：`/agent list` 显示已安装 vs 最新版本对比、`/agent update --all` 批量更新。

v4.0 新增（可扩展的插件化 AI 开发平台）：

- **插件市场**：`plugin install/search/list/remove/browse/recommend/popular` + 六类权限（read/write/network/shell/knowledge/mcp）安装时清单审批 + 运行时两层校验（fail-closed）+ 4 内置示例插件；插件开发见 plugin-dev-guide.md；
- **多 Provider 切换**：DeepSeek/OpenAI/Ollama 任意切换 + `provider auth`（0600）+ config v3→v4 自动迁移（备份 + 幂等 + restore 回滚）+ doctor 模型推荐（月成本预估）；
- **工作流引擎**：`workflow init/run/export/import/create`，DAG 依赖排序 + 并行 + 审批节点 + 失败恢复 R/S/F/A + 整体回滚；语法参考见 workflow-syntax.md；
- **`/review --fix` 一键修复**：A/B 类分批 + 批量审批 + 快照回滚 + 增量 verify + 修复报告（≤2 次交互）；
- **`team --parallel`**：自然语言「同时/并行」自动触发多 Agent 并行 + 文件冲突提示 + 独立事务；
- **`lsp --stdio`**：三来源诊断（biome/tsc/self-heal）推送到 IDE Problems 面板 + CodeAction 一键修复；
- **升级迁移**：v3.4 → v4.0 破坏性变更与回滚见 migration-guide-v4.md。

### 配置目录迁移（~/.lumen → ~/.concertoai）

v3.1 起全局目录统一为 `~/.concertoai/`（v3.0 及以前为 `~/.lumen/`）。首次启动（CLI 入口）自动幂等迁移：

1. `~/.lumen` 不存在 → 无操作（新安装直接用新版目录）；
2. `~/.concertoai` 已存在 → 保留新版，不覆盖旧目录；
3. `~/.lumen` 存在且 `~/.concertoai` 不存在 → 整目录改名迁移（rename，失败回退复制 + 删除）。

会话 / 配置 / 技能 / 知识图谱 / 审计 / Agent 安装全部随迁移保留。若想手动确认，可查看 `~/.concertoai/config.json` 与 `~/.concertoai/sessions/` 是否已就位。
