# ConcertoAI

ConcertoAI —— 面向个人开发者的**中文优先**终端编码助手 CLI（DeepSeek 驱动）。

在项目目录里启动：读取代码 → 提出 diff 方案 → 征求命令许可 → 跑验证 → 留下可续接的会话记录。

> 状态：v4.0 开发中（M0 config 迁移骨架 + M1 `/review --fix` 已完成；`npm run verify` 全绿，1080 用例 / 92 测试文件；`npm audit` 0 漏洞）。
> v4.0 M1 新增：`/review --fix` 审查后一键自动修复（A/B 类分批 + 批量审批 fail-closed + snapshot-guard 快照回滚 + 增量 verify + 「修复结果」区块，≤2 次交互）。
> v3.4 新增：审查建议闭环（collectKeys maxDepth / feedback 数据层 i18n / 正则去 gm 全项目复核 / en 字典 CJK 校验）+ `concertoai doctor --vscode`（进程数 / 崩溃转储 / AI 扩展 / argv.json 四维健康诊断）。
> v3.3 新增：消化 v3.2 审查遗留（lint:fix 失败语义显式化 / 全局正则去 g / self-heal 文案 i18n / 缓存语义注释 / 解析测试样本统一）。
> v3.2 新增：跨平台 CI 矩阵 + spawn/UNC/EXDEV 边界 / self-heal 模块化重构 + 增量 verify / 长任务进度推送（team、self-heal）/ project-account 视觉与 doctor 账号完整性 / 启动期缓存 / Agent 市场版本对比与批量更新 / audit 损坏行统计。
> 新特性：AI 自我修复闭环（self-heal）/ 多项目管理（project）/ 多账号（account）/ Orchestrator CLI（team、audit export）/ 结构化错误增强；智能成本控制（高峰时段自动切换本地 ollama 模型，peakTimeStrategy 可配）、`concertoai balance` 余额查询、`concertoai doctor` 环境诊断。
> v3.0 新增：多 Agent 协作（Orchestrator + 对抗性闭环）/ Agent 市场 / 可观测性面板 / 多文件事务回滚。
> v2.1 新增：知识图谱 / Reviewer Agent / 技能市场与嵌套 / 子代理 MCP 工具。

## 环境要求

- Node.js ≥ 22
- `DEEPSEEK_API_KEY` 环境变量（不写入任何配置文件）

## 安装

```bash
npm install -g @concertoai/cli
```

安装后直接使用 `concertoai` 命令（开发仓库内可用 `npm run dev` 代替）。

## 快速开始

```bash
# 1. 设置 API key（PowerShell 用 $env: 语法）
set DEEPSEEK_API_KEY=sk-xxx        # Windows cmd
export DEEPSEEK_API_KEY=sk-xxx     # macOS / Linux

# 2. 进入项目目录，启动交互式对话
concertoai                              # 等价于 concertoai chat

# 3. 一次性执行任务（非交互）
concertoai run "看看这个项目"

# 4. 先生成执行计划，批准后自动执行
concertoai plan "重构这个模块"
```

## 交互方式

| 操作 | 效果 |
| --- | --- |
| 输入文本 + Enter | 发送消息 |
| ← / → / Home / End | 移动光标（插入/删除位置） |
| ↑ / ↓ | 浏览本会话输入历史（去重） |
| Shift+Enter | 换行 |
| Ctrl+C（生成中） | 中断生成，已生成内容保留 |
| 审批框出现时按 `y` / `n` | 批准 / 拒绝编辑或命令 |
| 输入 `/plan 任务` | 对话内计划模式：先出计划，批准后执行 |
| Esc | 退出（会话自动保存） |

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `concertoai` / `concertoai chat` | 交互式对话（`-r [id]` 恢复 / `-l` 仅列会话 / `-m` 模型 / `--lang`） |
| `concertoai run "任务"` | 一次性执行（`--auto-approve` 谨慎使用 / `-m` / `--lang`） |
| `concertoai plan "任务"` | 计划-批准-执行三段式（`--auto-approve` 跳过确认） |
| `concertoai chat -l` | 仅打印历史会话列表 |
| `concertoai snapshot` / `concertoai snapshot list` | 列出多文件事务残留快照（taskId 列表） |
| `concertoai snapshot clean` | 清理全部残留快照（失败/取消后的遗留） |
| `concertoai balance` | 查询 DeepSeek 账户余额（总额/赠送/充值，按币种） |
| `concertoai doctor` | 环境诊断：Node/平台/API Key/配置/会话目录/模型表 + 账户余额 |

## 智能成本控制

智能成本控制包含两大能力：**余额查询**（随时掌握 DeepSeek 账户余额）与**高峰时段切换**（成本高峰期自动切换到本地 ollama 模型）。

### 余额查询（`concertoai balance`）

```bash
$ concertoai balance
💰 余额：¥110.00
```

调用 DeepSeek 官方余额接口（`GET /user/balance`），按币种输出账户总额/赠送/充值；账户不可用或查询失败时输出明确提示并以非零退出码结束。需要设置 `DEEPSEEK_API_KEY`。

### 高峰时段切换

高峰时段（工作日 9:00-12:00 / 14:00-18:00）DeepSeek API 调用成本较高，ConcertoAI 可在此时自动切换到本地 ollama 模型（本地调用成本为 0）。在 `~/.concertoai/config.json` 中配置：

```json
{
  "schemaVersion": 1,
  "peakTimeStrategy": "ask",
  "ollamaModel": "qwen3.6:27b-q4_K_M",
  "ollamaBaseUrl": "http://localhost:11434/v1"
}
```

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `peakTimeStrategy` | `ask` = 高峰时段交互确认后切换；`switch` = 直接切换；`ignore` = 忽略（保持主模型） | `ask` |
| `ollamaModel` | 高峰时段切换到的本地模型 ID | `qwen3.6:27b-q4_K_M` |
| `ollamaBaseUrl` | 本地模型 OpenAI 兼容端点（Ollama /v1） | `http://localhost:11434/v1` |

非高峰时段或周末不打扰；非交互环境（如 `concertoai run`）下 `ask` 策略自动跳过切换，保持主模型。切换到的本地模型不在 DeepSeek 模型表中，客户端按 `ollamaBaseUrl` 构建（OpenAI 兼容 /v1），状态条成本按 0 展示。

## MCP 服务接入

ConcertoAI 支持通过 [MCP（Model Context Protocol）](https://modelcontextprotocol.io) 连接外部工具服务，扩展模型的能力边界。

### 配置方式

在 `~/.concertoai/config.json` 中添加 `mcpServers` 数组：

```json
{
  "schemaVersion": 1,
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  ]
}
```

### 内置预配置

ConcertoAI 提供了三种常用 MCP 服务的推荐配置（`src/mcp/builtin-servers.ts`）：

| 服务 | 用途 | 需额外准备 |
| --- | --- | --- |
| `filesystem` | 文件系统读写，受限在指定目录内 | 允许访问的目录路径 |
| `memory` | 跨会话知识图谱存储与检索 | 无 |
| `github` | GitHub 仓库操作（Issue/PR/文件） | `GITHUB_PERSONAL_ACCESS_TOKEN` 环境变量 |

### 工具命名

MCP 服务的工具以 `服务名_工具名` 格式注册（如 `filesystem_read_file`），与内置工具（`read_file`）并存，避免命名冲突。MCP 服务不可用时自动降级，不影响内置工具正常工作。

## v3.2 新增功能

### 跨平台可靠性
- **CI 三平台矩阵**：ubuntu / windows / macOS 全覆盖，Windows 专属问题（spawn ENOENT / `__dirname` / 路径解析）前置拦截
- **spawn 审计**：Windows 下 `.cmd`/`.bat` 一律 `shell: true` 或经命令兼容层（`npx` → `npx.cmd` 等）
- **UNC / EXDEV 边界**：项目注册表支持 `\\server\share\` 网络共享路径（规范化 + 嵌套拒绝），账号原子写跨盘回退复制

### 长任务可感知
- **team / /orchestrate 进度推送**：拆解（📋 已拆解 N 个任务）→ 每轮闭环（🔁 第 x/5 轮）→ 收尾，CLI stdout 与 chat 消息流渐进推送，不再黑盒等待
- **self-heal 阶段进度**：状态条 activeTool 随阶段动态更新（执行 verify / lint 修复 / 模型修复 / 修复后验证 / 回滚 / 完成）

### 日常体验
- **project list 三列表格**（名称|路径|注册时间）+ 当前项目绿色高亮；**account list** active 高亮
- **whoami 修复提示**：账号缺失时给出可复制命令 `concertoai login <name>`；**doctor 账号完整性检查**
- **启动期缓存**：API Key / 项目注册表同一进程只解析一次（消除重复读盘）
- **Agent 市场版本管理**：`/agent list` 显示已安装 vs 最新版本对比、`/agent update --all` 批量更新

### 质量与可维护性
- **self-heal 模块化重构**：单文件 870 行 → 3 模块（classifier / repair / snapshot-guard）+ 增量 verify（lint 修复后仅 rerun lint 段）
- **audit export 损坏行统计**：输出「共 N 条记录（跳过 M 条损坏行）」不静默

## v3.1 新增功能
### AI 自我修复闭环（self-heal）
- `concertoai self-heal` / chat 内 `/self-heal`：`npm run verify` 失败后自动分类 → 修复 → 验证 → 回滚
- lint 错误确定性 `npm run lint:fix`（免审批）；缺 import / 缺类型标注等简单类型错误由模型修复（弹审批框 fail-closed）
- 修复前 SnapshotManager 快照登记，修复失败或引入新错误自动回滚；仅修复 ConcertoAI 自身，不碰用户项目代码

### 多项目管理（project）
- `concertoai project add/list/remove/info/switch` + 启动 `-p <name>`（等价 cd 后启动）
- 隔离矩阵：会话 / 审批白名单 / MCP 服务按项目隔离；全局配置 / 技能 / Agent 共享

### 多租户登录（account）
- `concertoai login/logout/whoami/account switch|list`：账号 = 一个 API Key 配置文件（git credential 模式）
- API Key 解析链：CLI > 环境变量 `DEEPSEEK_API_KEY` > active account > config.json；Key 打码展示

### Orchestrator CLI + 运维命令
- `concertoai team "<任务>"`：拆解 → 对抗性闭环（Coder→Reviewer→QA）→ 事务回滚兜底；`--dry-run` 仅输出拆解清单
- `/orchestrate <任务>`：chat 内触发全链路，`o` 键可观测性面板实时查看 spans
- `concertoai audit export [--out <file>]`：审计日志保序 JSON 导出
- `/agent update [name]` + `/review --severity <strict|normal|lenient>`

### 结构化错误增强
- 工具错误统一携带机器可读 `code` + 中文 `suggestion`（read/edit/shell/knowledge/registry 全覆盖）

## v3.0 新增功能

### 多 Agent 协作团队（Orchestrator 模式）

v3.0 引入「多 Agent 团队」工作流：Orchestrator 接收用户需求 → 拆解为结构化任务（含依赖）→ 按 DAG 拓扑调度并行执行 → 聚合结果交付。

4 个专业 Agent 各司其职：

| Agent | 职责 | 权限（fail-closed） |
|-------|------|---------------------|
| `architect` | 接收需求 → 输出结构化设计 spec（接口定义 + 文件结构 + 约束条件） | 只读工具 |
| `coder` | 按 spec 实现代码 + 接收审查反馈自动修复（审批后写盘） | `edit_file` |
| `reviewer` | 9 维审查，输出 `ReviewResult`（approve / reject 打回） | 只读工具 |
| `qa` | 子代理沙箱执行 `npm run verify`，输出结构化测试报告 | `run_command npm run verify` |

**对抗性闭环**：Coder 实现 → Reviewer 审查 → reject 则打回修复 → approve 则 QA 验证 → 失败则继续修复，循环 ≤ 5 次；超限自动退出并触发事务回滚（保留中间结果供人工检查）。

**调度器特性**：依赖分析 + 拓扑排序、无依赖任务并行（默认并发 3）、循环依赖检测、单任务失败级联跳过、最多 2 次指数退避重试、文件级冲突检测。

### Agent 市场

升级自技能市场——从「技能复用」到「Agent 复用」，复用 registry.json 格式与安装器架构：

| 命令 | 说明 |
|------|------|
| `/agent list` | 列出 Agent 团队（内置 4 个 + 已安装外部 Agent，含权限摘要） |
| `/agent install <name>` | 从市场安装（下载 → sha256 校验 → 接口合规检查 → 注册） |
| `/agent remove <name>` | 卸载已安装外部 Agent（内置 Agent 不可卸载） |
| `/agent promote <skill>` | 将技能一键升级为 Agent（脚手架 + 接口声明，原技能保留） |

外部 Agent 权限 fail-closed：未在 `AgentDef.permissions` 声明工具一律拒绝。

### 多文件事务回滚

任务级多文件原子回滚：任务开始前创建 `.concertoai/snapshots/<taskId>/` 快照，失败/超限时恢复所有涉及文件（含已通过审批的部分文件）；外部修改检测拒绝静默覆盖；成功后自动清理快照，`concertoai snapshot clean` 手动清理残留。

### 可观测性面板

- **调用链追踪**：记录每个 Agent 的输入/输出/决策/耗时，按 taskId 查询完整父子任务树（LRU 上限 5000 条）；
- **审计日志**：所有 Agent 交互（消息/状态变更/审批/回滚）JSONL 追加写入 `~/.concertoai/audit/`，可导出 JSON，单条写入 < 10ms；
- **面板 TUI**：对话中按快捷键展开 Agent 协作流程树（实时状态/耗时/消息数），不阻塞主对话流。

## v2.1 新增功能

### 轻量级知识图谱

v2.1 引入项目级结构化记忆：知识图谱以 JSONL 持久化 + 内存邻接表索引 + LRU 淘汰（按项目隔离，上限 1000 实体），模型可通过 `knowledge_*` 系列工具（共 5 个：实体/关系/观察的创建、检索、删除）记录并查询项目知识；每轮对话开始时自动双源记忆注入（本地记忆 + 知识图谱）检索相关内容。

### Reviewer Agent 代码评审

输入 `/review` 启动多智能体代码评审：9 维审查维度聚合为 5 个并行子代理交叉验证，自动执行 `npm run verify` 验证可运行性，输出按文件去重 + 严重程度排序的审查报告。

| 命令 | 说明 |
|------|------|
| `/review` | 审查最近修改的文件（auto 模式） |
| `/review <路径>` | 审查指定文件/目录 |
| `/review --pr` | PR 模式（审查当前分支 diff） |

### 技能市场与嵌套

v2.1 技能系统升级为可组合、可市场化的：

- **技能嵌套**：`@skill <name>` 递归展开（≤3 层 + 循环检测）、`@agent <name>` 引用子代理；
- **技能市场**：`/skill search <关键词>` 搜索、`/skill install <name>` 安装、`/skill update` 更新。

### 子代理 MCP 工具

子代理（explore / research）可通过 `allowedMcpServers` 声明加载 MCP 工具，扩展只读能力边界：`explore` → filesystem，`research` → filesystem / github。服务不可用时静默降级，不影响子代理内置工具。

## v2.0 新增功能

### BPE 精确 Token 计数

v2.0 使用 `tiktoken`（o200k_base 编码器）替换 v1.0 的 CJK 加权估算，误差从 ±40% 降至 <5%。成本计算精确到缓存命中 token（`💾 缓存命中 N token（¥X）`）。

### 智能摘要压缩

上下文超过 80% 预算时，v2.0 不再粗暴丢弃旧消息，而是优先调用模型生成对话摘要，保留关键决策和上下文。摘要失败时自动回退到旧裁剪策略。

### 子代理系统

模型可在对话中调用 `spawn_subagent` 工具启动隔离子代理执行探索/研究任务：

| 子代理 | 用途 |
|--------|------|
| `explore` | 只读探索代码库，返回 ≤200 字结论 + 文件路径引用 |
| `research` | 深度研究分析，对比多文件/模式，返回 ≤500 字结论 |

子代理拥有独立的对话上下文和受限工具集，只回传结论不污染主对话。

### 技能系统

通过 `/skill` 命令调用预定义的技能指令，注入为 system prompt：

| 命令 | 说明 |
|------|------|
| `/skill list` | 列出所有可用技能（名称 + 版本 + 描述） |
| `/skill code-review <路径>` | 对指定文件/目录执行代码审查 |
| `/skill explain <路径>` | 逐段解读代码逻辑与数据流 |
| `/skill refactor <策略> <路径>` | 按指定策略重构代码 |

自定义技能：将 `SKILL.md` 放入 `.concertoai/skills/<name>/` 目录即可注册（项目级）或 `~/.concertoai/skills/<name>/`（全局）。

### MCP 动态管理

v2.0 支持运行时管理 MCP 服务连接：

| 命令 | 说明 |
|------|------|
| `/mcp status` | 查看所有 MCP 服务连接状态（✅/❌ + 工具数） |
| `/mcp connect <name>` | 手动连接/重连指定服务 |
| `/mcp disconnect <name>` | 断开指定服务 |

状态条实时显示 MCP 连接摘要（`🔌 2/3 服务`）。

## 跨会话记忆

ConcertoAI 支持项目级跨会话记忆，存储位置为项目根目录的 `.lumen-memory/memories.jsonl`。

### 对话内命令

| 命令 | 说明 |
| --- | --- |
| `/remember <内容>` | 让模型生成记忆摘要，确认后写入存储 |
| `/forget <关键词>` | 搜索匹配的记忆，选择后删除 |
| `/memories` | 列出当前项目所有已保存的记忆 |

每轮对话开始时，ConcertoAI 自动从本地记忆中检索与当前问题相关的内容（按关键词 + 标签匹配，最多 5 条），注入系统提示，帮助模型「记住」项目上下文。

> **注意**：本地记忆与 MCP memory 服务互补——本地记忆轻量、零依赖，适合项目级知识；MCP memory 适合外部知识库。两者可同时启用，记忆会合并注入。

## 计划增强

计划模式对 `concertoai plan` 和对话内 `/plan` 进行了三项增强：

| 能力 | 说明 |
| --- | --- |
| **依赖检测** | 自动分析计划步骤间的依赖关系（显式声明 + 文件引用），按拓扑顺序调度，循环依赖提前报错 |
| **进度跟踪** | 执行时 TUI 实时展示每步骤状态（⏳ 进行中 / ✅ 已完成 / ❌ 失败 / ⬜ 待执行），失败步骤可跳过或重试 |
| **文件回滚** | 编辑操作前自动创建文件快照（`.concertoai/snapshots/`），步骤失败时可回滚所有已完成步骤的文件变更；正常完成后自动清理 |

## 安全模型

- **编辑与命令一律审批**：`edit_file` / `run_command` 在落盘/执行前弹出审批框，无 yolo 模式；审批拒绝绝不自动重试
- **白名单免审批**：`git status` / `git diff` / `npm test` / `npm run test` 默认命中前缀直接执行（可在配置中自定义）
- **审批策略**：`ask`（默认逐个审批）/ `allowlist-only`（只放行白名单，其余一律拒绝，不弹框）
- **fail-closed**：审批回调未配置（如 `run` 默认模式）时，危险操作一律拒绝
- **路径沙箱**：所有工具只能访问项目目录内（`..` 逃逸 / 绝对路径越界一律拒绝）
- **上下文保护**：文件读取、搜索结果、工具回填、命令输出均按长度截断；超模型 80% 预算自动裁剪旧消息
- **健壮性**：可修复的工具失败限 2 次重试后终止；连续失败、循环失控均有上限

## 配置

配置文件：`~/.concertoai/config.json`（带 `schemaVersion` 字段；不存在即用默认）。

```json
{
  "schemaVersion": 1,
  "defaultModel": "deepseek-v4-flash",
  "allowlist": ["npm test", "git status"],
  "approvalPolicy": "ask",
  "sessionDir": "~/.concertoai/sessions",
  "locale": "zh",
  "mcpServers": [
    { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"] }
  ]
}
```

优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

| 配置项 | 环境变量 | 默认 |
| --- | --- | --- |
| 模型 | `LUMEN_MODEL` | deepseek-v4-flash |
| 白名单（逗号分隔） | `LUMEN_ALLOWLIST` | 内置 4 条 |
| 审批策略 | `LUMEN_APPROVAL` | ask |
| 会话目录 | `LUMEN_SESSION_DIR` | `~/.concertoai/sessions` |
| 语言 | `LUMEN_LOCALE`（或 `LANG` zh/en 前缀） | zh |
| MCP 服务 | —（通过配置文件声明） | 无 |

## 会话记录

- 存储位置：`~/.concertoai/sessions/<时间戳>.jsonl`（JSONL，每行一条消息）
- 自动保存：每轮对话结束即追加落盘；`concertoai chat -r` 无 ID 时列出全部会话供选择
- 项目规则：自动加载项目根的 `AGENTS.md`（优先）或 `CARBON.md`，截断至 8000 字符注入系统提示

## FAQ

**没有 API key 会怎样？** 启动时报错退出，提示设置 `DEEPSEEK_API_KEY`。

**管道/编辑器内嵌终端无法使用 chat？** chat 需要真实 TTY；用 `concertoai run "任务"` 走非交互路径。

**成本如何？** 状态条实时显示 token 与成本（API 真实 usage，带"（真实）"标记）；模型定价按 DeepSeek 官方定价页维护在 `MODEL_PROFILES`。

**数据存在哪？** 全部本地：会话在 `~/.concertoai/sessions/`，配置在 `~/.concertoai/config.json`；仅对话请求发送给 DeepSeek API。旧版本（v3.0 及以前）的 `~/.lumen/` 会在启动时自动迁移到 `~/.concertoai/`。

**如何换英文？** `concertoai chat --lang en`，或配置 `locale: "en"` / 环境变量 `LUMEN_LOCALE=en`。

**从 v0.1 迁移？** v0.1 为开发期版本（`npm run dev` 直接跑源码）；v1.0 通过 `npm install -g @concertoai/cli` 安装，命令与配置完全兼容，会话文件格式不变（JSONL）。

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发运行（tsx 直接跑源码） |
| `npm run test` / `test:watch` | 单元 + 集成 + UI 渲染测试 |
| `npm run lint` / `lint:fix` | Biome 检查 / 自动修复 |
| `npm run typecheck` | TypeScript 严格类型检查 |
| `npm run build` | tsup 打包到 `dist/`（ESM + d.ts + CLI 入口） |
| `npm run verify` | 验收主命令：build + lint + typecheck + test |

## 文档

- [用户手册](docs/05-用户与开发指南/user-guide.md) —— 详细使用说明
- [Agent 开发指南](docs/05-用户与开发指南/agent-dev-guide.md) —— 开发与发布第三方 Agent
- [架构文档](docs/02-架构设计/ARCHITECTURE.md) —— 技术设计
- [发布流程](docs/04-发布流程.md) —— 版本与发布
- [贡献指南](CONTRIBUTING.md) —— 参与开发

## 版权

本项目（ConcertoAI）为**全新独立项目**，非任何上游项目的复制或派生。

所有代码、文档、测试的版权归项目作者所有（Copyright © 2026 mmclqx），保留一切权利。对外使用条款见 [LICENSE](LICENSE)。
