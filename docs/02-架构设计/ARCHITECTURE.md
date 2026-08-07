# Lumen 架构文档

> 版本：v1.0 · 2026-08-07 · 对应提交 `80c19fa`（T4.6 完成后）
> 本文档基于当前代码实现编写，作为后续维护与扩展的技术参考。
> 配套文档：[开发计划](../03-开发计划与任务/v1.0-dev-plan.md)、[任务看板](../03-开发计划与任务/TASKS.md)

---

## 1. 项目概览

Lumen 是一款**中文优先**的终端编码助手 CLI（DeepSeek 驱动）。在项目目录里启动后，它读取代码、提出 diff 方案、征求命令许可、跑验证，并留下可续接的会话记录。

- **技术栈**：TypeScript (strict) + Node ≥22 + ESM，Ink 7 (React 19) 渲染 TUI，commander 解析 CLI，zod 做工具参数校验，vitest 测试，Biome 检查，tsup 打包
- **运行时依赖**：`ink` / `react` / `commander` / `zod` / `cli-highlight` / `chalk`
- **测试现状**：22 个测试文件、218 个用例，`npm run verify` 全绿，`npm audit` 0 漏洞；已用真实 `DEEPSEEK_API_KEY` 完成端到端冒烟（`lumen run` 真实调用 DeepSeek API 成功）
- **安全基线**：编辑与命令一律审批（fail-closed）、路径沙箱、结果截断、白名单免审批——无 yolo 模式

## 2. 架构全景图

```
┌─────────────────────────────────────────────────────────────┐
│ cli/  commander 入口（src/cli/）                              │
│   index.ts   lumen / lumen chat / lumen run "任务" / lumen plan
│   chat.tsx   chat 装配：TUI + loop + store（含 TTY 检查）      │
│   run.ts     run 一次性执行：loop + stdout 流式 + 存档          │
│   plan.ts    plan 计划-批准-执行三段式（readline y/n）          │
└──────────────────────┬──────────────────────────────────────┘
                       │ render(<App …>) / runLoop(...)
┌──────────────────────▼──────────────────────────────────────┐
│ ui/  Ink TUI（src/ui/）                                      │
│   App.tsx          根组件 + 状态机 idle→streaming→approval→plan-approval
│   PromptInput      光标移动 + 输入历史 + 多行输入               │
│   StreamingView    markdown→ANSI 渲染（markdown.tsx + 高亮）   │
│   modals.tsx       EditConfirm / ShellConfirm / PlanConfirm   │
│   SessionPicker    -r 无 ID 时的会话列表选择                   │
│   Spinner          Braille 进度指示（思考中/工具执行）          │
│   StatusBar        模型名 + 真实 usage/估算 + 成本             │
└──────────────────────┬──────────────────────────────────────┘
                       │ ctx.requestApproval（审批挂起/恢复）
┌──────────────────────▼──────────────────────────────────────┐
│ loop/ 会话主循环（src/loop/）                                 │
│   loop.ts     runLoop：消息组装→模型→工具分发→回填（≤10 轮）   │
│   context.ts  上下文窗口管理（80% 预算裁剪 + 日志）            │
│   messages.ts ChatMessage⇄ApiMessage 序列化 / 工具结果格式化   │
│   types.ts    ChatMessage / ToolCall / Role                  │
└─────────┬───────────────────────────────┬───────────────────┘
          │ streamChat（ModelClient 抽象）  │ registry.run(...)
┌─────────▼──────────┐          ┌──────────▼───────────────────┐
│ model/ DeepSeek    │          │ tools/ 工具注册表（src/tools/）│
│  client.ts  SSE    │          │  registry.ts ToolSpec+zod 分发│
│  models.ts  模型表  │          │  read.ts   3 个只读工具       │
│  tokenizer.ts 估算 │          │  edit.ts   SEARCH/REPLACE     │
└─────────┬──────────┘          │  shell.ts  白名单+审批+超时   │
          │                     └──────────┬───────────────────┘
┌─────────▼─────────────────────────────────▼─────────────────┐
│ store/ 持久化（src/store/）      i18n/ 文案（src/i18n/）       │
│  session.ts       JSONL 会话（~/.lumen/sessions/）            │
│  project-rules.ts AGENTS.md→CARBON.md 规则加载（≤8000 字符）  │
│  config.ts        ~/.lumen/config.json（schema + 优先级解析）  │
│  zh.ts / en.ts / index.ts  多语言字典 + locale 解析（t/setLocale）
└─────────────────────────────────────────────────────────────┘
```

**依赖方向**（上层依赖下层，无反向）：

```
cli → ui → loop → model / tools → store / i18n
             ↘        ↘
          loop/types（共享类型）   i18n（全项目引用）
```

## 3. 核心数据流

### 3.1 启动装配（chat 模式）

```
cli/index.ts（无子命令或 chat）
  → getApiKey()：DEEPSEEK_API_KEY 缺失则报错退出
  → chat.tsx：TTY 检查（非交互终端友好报错）
  → 组装：DeepSeekClient + ToolRegistry(5 工具) + ToolContext{白名单}
  → loadProjectRules(cwd)：AGENTS.md 优先 / CARBON.md 兜底，注入系统提示
  → SessionStore：resume 则读历史，否则 create 新会话
  → render(<App …/>)
```

### 3.2 一轮对话（App.send → runLoop）

```
用户在 PromptInput 输入 + Enter
  → App.send(text)：busy 防重入，user 消息入历史
  → runLoop(options, history, text)：
      ① systemPrompt 注入（history 无 system 时）
      ② streamAssistantReply：流式累积 content + 增量拼接 tool_calls
      ③ 无工具调用 → 返回完整消息历史（本轮结束）
      ④ 有工具调用 → 逐条执行（顺序）：
           JSON.parse(arguments) → registry.run(name, args, ctx)
           → 结果 formatToolResult 截断回填为 tool 消息
         → 回到 ②（最多 MAX_LOOP_TURNS = 10 轮，超限抛错）
  → App：消息历史更新、token 估算累计、store.appendAll 落盘
```

### 3.3 审批流（编辑/命令）

```
工具执行（edit_file / run_command）
  → 白名单命中（词边界匹配）→ 免审批直跑
  → 否则 requestApproval(ctx, {kind, summary, detail})
      TUI：App 挂起流程（phase=approval），弹审批框，y/n 决议
      测试：注入 stub；run 模式：默认拒绝（fail-closed）
  → 通过才 fs.writeFile / spawn；拒绝返回 ok:false，不产生副作用
```

### 3.4 消息生命周期与序列化

```
会话层 ChatMessage { role, content, toolCallId?, toolCalls? }
   │  toApiMessages()（loop/messages.ts）
   ▼
API 层 ApiMessage { role, content, name?, tool_call_id?, tool_calls? }
   │  streamChat SSE（client.ts）
   ▼
增量 chunk { choices[].delta: { content?, reasoning_content?, tool_calls?[] } }
   │  loop 累积：content 拼接 / tool_calls 按 index 增量拼接
   ▼
完整 assistant 消息 → 工具结果回填 → 下一轮
   │  JSON.stringify → JSONL 行
   ▼
~/.lumen/sessions/<id>.jsonl
```

## 4. 关键设计决策

> **先读这里再动手**：本节记录关键决策的「原因」。当你想修改某个模块（工具分发、审批流、会话存储、SSE 解析……）时，请先查阅对应条目，理解其设计意图。很多约束（fail-closed、路径沙箱、分层截断）是安全基线的一部分，破坏它们等于破坏产品承诺。

| # | 决策 | 理由 | 代码位置 |
| --- | --- | --- | --- |
| D1 | **函数式 runLoop**：返回完整消息历史，调用方持有状态 | 多轮对话、resume、持久化天然支持；无隐式状态 | `src/loop/loop.ts` |
| D2 | **ModelClient 抽象接口**，DeepSeekClient 实现之 | 测试注入 Fake 模型驱动全链路，无需网络 | `src/model/client.ts` |
| D3 | **SSE 解析器独立**（`readSseEvents`，字节级行切分 + TextDecoder stream 模式） | 跨 chunk 截断、UTF-8 多字节边界安全 | `src/model/client.ts` |
| D4 | **工具统一 ToolSpec 契约**：zod parameters + `parallelSafe` 字段位 + execute | 注册/校验/分发/捕获错误统一；v0.2 并行调度预留 | `src/tools/registry.ts` |
| D5 | **审批在工具内部强制**（fail-closed：回调未配置默认拒绝） | 即使调用方误用，危险操作也无法绕过审批 | `edit.ts` / `shell.ts` / `registry.ts` |
| D6 | **白名单词边界匹配**（`npm test` 命中 `npm test --x`，不命中 `npm testx`） | 用户提前授权安全命令，其余每次审批 | `src/tools/shell.ts` |
| D7 | **路径沙箱 resolveSafe**：所有工具路径基于 `ctx.cwd` 解析，越界拒绝 | 模型不可信，防止 `..` 逃逸/绝对路径越界 | `src/tools/read.ts` |
| D8 | **分层截断防上下文膨胀**：read_file 50k 字符 / search 100 条 / 工具回填 20k / shell 输出 20k / 规则 8k | 成本与上下文控制 | 各工具 + `messages.ts` + `project-rules.ts` |
| D9 | **会话 JSONL 宽松读取**（空行跳过、损坏行计数） | 容忍手动编辑；毫秒时间戳 id + `wx` 排他创建防同毫秒覆盖 | `src/store/session.ts` |
| D10 | **token 估算 CJK 加权**（中文 1 token/字，其余 4 字符/token） | 纯字符/4 会低估中文 4 倍，成本条失真 | `src/model/tokenizer.ts` |
| D11 | **工具失败不中断循环**：ok:false 回填让模型自行修正 | 模型可自愈（换参数/换工具），循环上限兜底 | `src/loop/loop.ts` |
| D12 | **中文文案单一来源** `i18n/zh.ts` + `fmt()` 占位符 | 全项目文案可检索、可统一改 | `src/i18n/zh.ts` |
| D13 | **并行工具调度**（T3.1）：连续 `parallelSafe` 工具组内并行，审批类串行 | 只读工具并行提速；审批框不与并行执行交错；事件按原始顺序回填 | `loop.ts` + `registry.ts` |
| D14 | **无子命令默认进 chat**（commander program.action） | 产品定位：`cd 项目 && lumen` 直接可用 | `src/cli/index.ts` |
| D15 | **修复管线**（T3.2）：`repairable` 字段区分错误，可修复失败限 2 次终止 | 防模型死循环刷失败；审批拒绝/越界绝不重试 | `loop.ts` + `registry.ts` |
| D16 | **上下文裁剪**（T1.6）：80% 预算，保留 system + 最近整轮，仅发送视角 | 给回复留余量；不截断持久化历史 | `loop/context.ts` |
| D17 | **配置优先级**（T3.4）：CLI > 环境变量 > 配置文件 > 默认值 | 可预测、可覆盖；schema 版本兜底 | `store/config.ts` |
| D18 | **locale 字典**（T4.5）：`zh`/`en` 键同构 + `setLocale`/`t()` | 文案单点维护；启动期固定语言 | `i18n/index.ts` |
| D19 | **会话原子写**（T1.5）：进程内锁 + 临时文件 rename + 写后 size 校验 | 并发不损坏；跨进程冲突提示（尽力而为） | `store/session.ts` |

## 5. 目录结构说明

```
lumen/
├── package.json          ESM；scripts: dev/build/test/test:watch/lint/lint:fix/typecheck/verify
├── tsconfig.json         strict 全开；verbatimModuleSyntax；jsx: react-jsx；noEmit（tsup 负责产物）
├── biome.json            Biome 2.5；lint 范围 src tests
├── vitest.config.ts      include tests/**/*.test.{ts,tsx}（注意：必须含 tsx，否则 UI 测试被静默跳过）
├── tsup.config.ts        entry：src/index.ts（库）+ src/cli/index.ts（CLI）→ dist/（ESM + d.ts + sourcemap）
├── CHANGELOG.md          变更日志（npm version 发布流程）
├── scripts/              sync-version.mjs（npm version 钩子）/ smoke-install.mjs（安装冒烟）
├── docs/
│   ├── 01-产品定位与范围.md
│   ├── 02-架构设计/ARCHITECTURE.md   ← 本文档
│   ├── 03-开发计划与任务/            v0.1/v1.0 计划与任务书 + 任务看板
│   ├── 04-发布流程.md
│   ├── 05-用户与开发指南/user-guide.md
│   └── 06-会议与决策记录/DECISIONS.md（ADR）
├── .github/workflows/     ci.yml（push/PR verify + 手动冒烟）/ publish.yml（Trusted Publishing）
├── src/
│   ├── index.ts          barrel：导出 v1.0 公共 API（VERSION / client / loop / tools / store / i18n）
│   ├── cli/
│   │   ├── index.ts      commander 入口：lumen（默认 chat）/ chat / run / plan；DEEPSEEK_API_KEY 检查
│   │   ├── chat.tsx      chat 装配：TTY 检查、配置加载、注册表、规则加载、resume、render(App)
│   │   ├── run.ts        run 装配：非交互、stdout 流式、--auto-approve 显式开启、存档
│   │   └── plan.ts       plan 装配：计划轮 → 终端 y/n → 执行轮
│   ├── ui/
│   │   ├── App.tsx       状态机组件：send/sendPlan/executePlan/审批挂起/消息渲染/错误显示
│   │   ├── PromptInput.tsx  光标移动 + 历史浏览 + 多行输入
│   │   ├── StreamingView.tsx 流式 markdown→ANSI（空文本显示 spinner）
│   │   ├── markdown.tsx   markdown 解析 + cli-highlight 高亮（纯 ANSI 字符串）
│   │   ├── modals.tsx    ApprovalModal + EditConfirm/ShellConfirm/PlanConfirm
│   │   ├── SessionPicker.tsx 会话列表交互选择（-r 无 ID）
│   │   ├── Spinner.tsx   Braille 进度指示
│   │   └── StatusBar.tsx 模型名/token（真实 usage/估算）/成本（costFor 实时计算）
│   ├── loop/
│   │   ├── loop.ts       runLoop / MAX_LOOP_TURNS=10 / MAX_REPAIRS=2 / LoopEvent（chunk/tool_call/tool_result/usage/error）
│   │   ├── context.ts    上下文窗口管理（trimContext：80% 预算、整轮保留、日志）
│   │   ├── messages.ts   消息构造 + toApiMessages + formatToolResult（20k 截断）
│   │   └── types.ts      ChatMessage / ToolCall / Role
│   ├── model/
│   │   ├── client.ts     DeepSeekClient（implements ModelClient）+ readSseEvents + ApiError/TimeoutError + Usage
│   │   ├── models.ts     MODEL_PROFILES（flash 默认/pro，官方定价 2026-08 核实）+ costFor
│   │   └── tokenizer.ts  estimateTokens（CJK 加权）/ estimateMessageListTokens
│   ├── tools/
│   │   ├── registry.ts   ToolSpec/ToolContext/ToolRegistry/ApprovalRequest/ToolResult（repairable 字段）
│   │   ├── read.ts       read_file/search_content/list_directory + resolveSafe（BOM 剥离）
│   │   ├── edit.ts       edit_file：SEARCH 规范化匹配（CRLF）、保留换行风格、审批后落盘
│   │   └── shell.ts      run_command：白名单免审、每次审批、超时杀进程树、输出截断
│   ├── store/
│   │   ├── session.ts    SessionStore：create/append/appendAll/read/list；锁 + 原子写 + 冲突检测
│   │   ├── project-rules.ts  loadProjectRules：AGENTS→CARBON 优先级、8k 截断
│   │   └── config.ts      loadConfig/writeConfig/resolveConfig（CLI > env > 配置 > 默认）
│   └── i18n/
│       ├── zh.ts         中文字典 + fmt()
│       ├── en.ts         英文字典（键与 zh 同构）
│       └── index.ts      resolveLocale / setLocale / t() / DICTS
└── tests/                镜像 src 结构（22 个文件 / 218 用例）
```

## 6. 5分钟快速体验

> 目标：从零跑通第一次真实对话，立刻获得正反馈。

### 6.1 开发环境准备

- **Node.js ≥ 22**（npm 随附；`node --version` 确认）
- 无其他全局依赖（vitest / Biome / tsup 均为项目内 devDependencies）
- `DEEPSEEK_API_KEY` 环境变量（不写入任何配置文件）

**Windows 注意事项**：

- `npm run dev`（chat 模式）需在**真实终端**（PowerShell / cmd / Windows Terminal）运行；管道或脚本调用会因 TTY 检查失败并提示「需要交互式终端」——此时改用系统终端，或 `npm run dev -- run "任务"` 走非交互路径。
- 设置环境变量：cmd 用 `set DEEPSEEK_API_KEY=sk-xxx`，PowerShell 用 `$env:DEEPSEEK_API_KEY="sk-xxx"`。
- 仓库当前未配置远程（origin 未推送），从本地目录进入即可；发布后把下面第 1 步换成 `git clone <url>`。

### 6.2 完整命令链（约 5 分钟）

```bash
# 1. 进入项目（当前未发布远程；发布后为 git clone <url>）
cd F:\developer\2026\lumen

# 2. 安装依赖（仅首次）
npm install

# 3. 设置 API Key（cmd 语法）
set DEEPSEEK_API_KEY=sk-你的密钥

# 4. 第一次体验：非交互执行，立刻看到成果
npm run dev -- run "列出这个项目的文件结构"

# 5. 进阶：进入交互式对话（需真实终端）
npm run dev
#    → 输入「读一下 package.json 并总结」+ Enter
#    → 输入「运行 npm run test 看看结果」→ npm test 命中白名单，免审批直跑
#    → 尝试编辑类指令 → 弹出审批框，按 y 批准 / n 拒绝
#    → Esc 退出，会话自动保存到 ~/.lumen/sessions/
```

**预期输出**（第 4 步）：模型流式回复 + 结尾 `会话已保存: <会话ID>`。

## 7. 开发调试指南

### 7.1 环境与命令

```bash
npm install        # Node ≥22
npm run dev        # 开发运行（= lumen，默认进 chat，需真实 TTY）
npm run verify     # 验收：build + lint + typecheck + test（--silent）
```

| 命令 | 说明 |
| --- | --- |
| `npm run dev -- run "任务"` | 非交互执行（真实 API） |
| `npm run dev -- chat -m deepseek-v4-pro` | 指定模型 |
| `npm run dev -- chat -r <会话ID>` | 恢复会话 |
| `npm run test:watch` | 测试监听 |
| `npm run lint:fix` | Biome 自动修复 |

### 7.2 测试策略（三层）

| 层 | 方式 | 推荐阅读（文件 → 具体用例） |
| --- | --- | --- |
| 单元 | mock SSE 字节流（逐字节切分）、临时目录夹具、真实子进程（node -e） | `tests/model/client.test.ts` → 「跨 chunk 逐字节切分」；`tests/tools/read.test.ts` → 「路径越界被拒绝」；`tests/tools/shell.test.ts` → 「超时自动终止」 |
| 集成 | FakeModel 脚本驱动 runLoop 全链路（含审批拒绝、分片拼接、轮数上限） | `tests/loop/loop.test.ts` → 「工具调用 → 执行 → 结果回填」与「审批拒绝」 |
| UI | ink-testing-library 渲染断言（状态条/审批框/App 全流程） | `tests/ui/app.test.tsx` → 「审批流：y 批准后落盘并继续」与「n 拒绝不落盘」 |

### 7.3 关键调试经验（踩坑记录）

1. **Ink 7 按键注入**：普通文本块会整体作为 `input` 传入（多字符一次事件）；`\r` 必须**单独 `stdin.write('\r')`** 才会被识别为 Enter（混在文本里会被当普通字符）。
2. **UI 测试时序**：`stdin.write('文本')` 与 `write('\r')` 之间必须 `await sleep(50)`——React 重渲染未完成时回车回调读到旧 value 闭包。
3. **vitest include**：`tests/**/*.test.{ts,tsx}` ——漏掉 `tsx` 会导致 UI 测试被静默跳过（verify 仍绿，极具迷惑性）。
4. **含 JSX 的装配文件必须 `.tsx`**（如 `chat.tsx`），`.ts` 下 JSX 是解析错误。
5. **超时杀进程树**：Windows 下 `child.kill()` 只杀 cmd.exe 壳，残留子进程会锁目录（EBUSY）——用 `taskkill /T /F` / POSIX 进程组 SIGKILL。
6. **毫秒级 id 碰撞**：连续 create 可能同毫秒覆盖文件——`wx` 排他创建 + EEXIST 重试（曾导致 list 测试间歇性失败）。
7. **真实 API 冒烟**：机器上有 `DEEPSEEK_API_KEY` 时 `npm run dev -- run "任务"` 可端到端验证（SSE→loop→回复→存档）。
8. **`npm run dev` 需真实 TTY**：管道/编辑器内嵌终端会触发"需要交互式终端"提示（by design）。

## 8. 已知问题与规划

### 8.1 已知问题（v1.0 状态）

| 问题 | 状态 | 位置 |
| --- | --- | --- |
| 模型 ID 与定价为开发期暂定值 | ✅ T1.1 已按官方定价页核实（2026-08） | `models.ts` |
| StreamingView 纯文本 | ✅ T2.1 markdown→ANSI + cli-highlight 高亮 | `ui/markdown.tsx` |
| PromptInput 无光标/历史 | ✅ T2.2 光标 + Home/End + ↑/↓ 历史（去重） | `ui/PromptInput.tsx` |
| 成本条无真实 usage | ✅ T1.2 透传 API usage（真实标记） | `loop/loop.ts` + `ui/StatusBar.tsx` |
| 工具顺序执行 | ✅ T3.1 并行调度（parallelSafe 组内并行） | `loop/loop.ts` |
| 白名单硬编码 | ✅ T3.4 配置化（config/environment 覆盖） | `store/config.ts` |
| resume 手输 ID | ✅ T2.3 交互式会话列表（-r 无 ID / -l） | `ui/SessionPicker.tsx` |
| PlanConfirm 未实现 | ✅ T3.3 plan 模式（CLI + 对话内 /plan） | `ui/modals.tsx` |
| audit 告警（1 critical） | ✅ T4.4 依赖升级 + esbuild overrides → 0 漏洞 | package.json |
| `run` 模式非 `--auto-approve` 时危险操作全被拒 | 保留（安全优先，by design） | `cli/run.ts` |

### 8.2 规划（v1.1+，源自开发计划非目标清单）

- **精度**：BPE tokenizer 替换估算；缓存命中 token 计入成本（`inputCacheHitPricePerM` 已就绪）
- **能力**：子代理/技能系统；MCP 接入；缓存优先上下文
- **工程**：`@lumen/cli` 正式发布（Trusted Publishing 已配置）；TypeScript 7（原生）评估；依赖持续升级

---

## 9. 术语表

| 术语 | 说明 |
| --- | --- |
| SSE | Server-Sent Events：服务器单向推送的事件流协议；DeepSeek 流式响应按 `data: {...}` 行下发，`[DONE]` 收尾 |
| JSONL | JSON Lines：每行一条 JSON 的文本格式；会话存档采用它，支持逐行追加与宽松续读 |
| fail-closed | 默认拒绝：审批回调未配置时，危险操作（编辑/命令）一律拒绝——宁可误拒，不可漏放 |
| 路径沙箱 | 所有工具路径基于项目根（ctx.cwd）解析，`..` 逃逸 / 绝对路径越界一律拒绝 |
| TTY | 交互式终端设备；chat 模式的 raw mode 输入依赖它，非 TTY 环境会友好报错 |
| token | 模型文本的最小计价单位；Lumen 用 CJK 加权估算（中文 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token） |
| BPE | Byte-Pair Encoding：主流 tokenizer 算法，v0.2 计划替换估算 |
| barrel | 汇总导出文件（src/index.ts），对外暴露统一的公共 API 入口 |
| hunk | diff 中一个连续变更块，形如 `@@ -a,b +c,d @@`（编辑工具的审批详情即 hunk 列表） |
| 白名单 | 用户提前授权的命令前缀（如 npm test），命中（词边界匹配）可免审批执行 |
| parallelSafe | ToolSpec 上的字段位，标记工具可否并行执行（T3.1 起由 loop 调度消费：组内并行、审批类串行） |

---

*本文档与代码同步维护：修改架构/数据流/常量后请同步更新，并保持引用（文件/函数/常量名）与实现一致。*
