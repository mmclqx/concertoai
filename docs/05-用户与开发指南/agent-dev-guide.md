# ConcertoAI Agent 开发指南

> 面向第三方开发者：如何开发、打包并发布一个 ConcertoAI Agent。
> 版本：v3.0 · 2026-08-09
> 前置阅读：[用户手册](./user-guide.md)（多 Agent 协作 / Agent 市场章节）、[架构文档](../02-架构设计/ARCHITECTURE.md)（§4 D33-D38）

---

## 1. 核心概念

ConcertoAI Agent 是遵循统一接口契约（`AgentDef` + `Agent` 接口）的**可插拔能力单元**，由 Orchestrator 调度参与多 Agent 协作。

```
AgentDef（声明契约）          Agent（实现实例）
├── name                      ├── def（AgentDef 引用）
├── version                   ├── runtimeState（运行时状态）
├── interfaces {              ├── execute(input, context)  核心执行
│   input: Schema ①            ├── send(message)            发送消息
│   output: Schema             └── receive(message)         接收消息
│   version: string }
└── permissions []            权限声明（fail-closed）
```

① interfaces.input/output 在**实现侧**为 zod Schema（编译期类型 + 运行时校验）；
在市场分发包内为**描述性结构**（JSON 无法携带 zod 实例，安装器做结构完整性校验）。

## 2. 接口契约

### 2.1 AgentDef（`src/orchestrator/types.ts`）

```typescript
interface AgentDef {
  name: string;            // Agent 标识名（唯一）
  version: string;         // semver 版本号
  interfaces: {
    input: z.ZodType;      // 输入 Schema（execute 前校验）
    output: z.ZodType;     // 输出 Schema（execute 后校验）
    version: string;       // 接口版本号（契约演进用）
  };
  permissions: AgentPermission[]; // [{ tool: 'edit_file', args?: {...} }]
}
```

**权限 fail-closed**：`permissions` 是 Agent 可调用工具的唯一白名单。未声明的工具一律拒绝
（对齐 ADR-004）。`args` 可选，用于命令级参数约束（如 QA 的
`{ tool: 'run_command', args: { command: 'npm run verify' } }`）。

### 2.2 Agent 接口（`src/agents/protocol.ts`）

```typescript
interface Agent<TDef extends AgentDef = AgentDef> {
  readonly def: TDef;
  runtimeState: AgentRuntimeState;
  execute(input: z.infer<TDef['interfaces']['input']>, context: AgentContext): Promise<z.infer<TDef['interfaces']['output']>>;
  send(message: AgentMessage): Promise<void>;
  receive(message: AnyAgentMessage): Promise<AgentReply | undefined>;
}
```

- `execute` 是核心：输入经 `interfaces.input` schema 校验，输出经 `interfaces.output` 校验；
- `send` / `receive` 支撑消息收发（task → result / feedback → 修复等闭环驱动）；
- `runtimeState` 与任务级 `AgentState` 解耦（ADR-016 修正项 #3），记录 `attempts` / `updatedAt` 等。

### 2.3 AgentContext（显式上下文，`src/orchestrator/types.ts`）

```typescript
interface AgentContext {
  sessionId: string;
  taskId: string;
  parentTaskId?: string;
  dependencies: string[];
  artifacts: Artifact[]; // 已产出工件（code / review-result / test-report …）
}
```

上下文**显式传递**（§3.3）：随消息携带，不依赖隐式全局状态；`src/orchestrator/context.ts`
提供 `serialize` / `deserialize` / `extractSubset` / `mergeContexts`，上限 64KB。

## 3. 开发一个 Agent

### 3.1 方式一：`/agent promote <skill>`（最快路径）

已有 SKILL.md 技能 → 对话内执行 `/agent promote <skill>`，自动生成脚手架：

```
~/.concertoai/agents/<skill>/
├── agent.json    # InstalledAgent 元数据（name/version/def/installedAt）
└── index.js      # CJS 执行骨架：create({ client, model }) 工厂
```

- 权限默认继承技能 SKILL.md 的 `tools` 白名单（无 tools → 只读三件套）；
- 原技能保留（升级非迁移）。

### 3.2 方式二：手工开发（内置 Agent 同款）

参考 `src/agents/architect.ts` / `coder.ts` / `reviewer.ts` / `qa.ts`，实现 `Agent` 接口后
注册到 `AgentRegistry`（`src/agents/registry.ts`）：

```typescript
import { InMemoryAgentRegistry } from '@concertoai/cli';

const registry = new InMemoryAgentRegistry();
registry.register(
  {
    name: 'my-agent',
    version: '1.0.0',
    interfaces: { input: myInputSchema, output: myOutputSchema, version: '1.0.0' },
    permissions: [{ tool: 'read_file' }, { tool: 'search_content' }],
  },
  myAgentImpl, // Agent 实例（可选）
);
```

## 4. 打包与发布

### 4.1 包格式（市场分发）

```json
{
  "def": {
    "name": "my-agent",
    "version": "1.0.0",
    "interfaces": { "input": {}, "output": {}, "version": "1.0.0" },
    "permissions": [{ "tool": "read_file" }]
  },
  "entry": "module.exports = { create: ({ client, model }) => ({ ... }) };"
}
```

- `interfaces.input/output` 为描述性结构（JSON 序列化限制），安装器校验**结构完整性**；
- `entry` 为可被 `import()` 加载的 CJS 源码（与 promote 脚手架同构，`create(deps)` 工厂模式）；
- **权限必填且非空**：`permissions: []` 会被拒绝安装（fail-closed）。

### 4.2 注册表条目

在 `registry.json` 的 `agents[]` 中声明（复用技能市场 schema）：

```json
{
  "registry": "https://example.com/registry.json",
  "skills": [],
  "agents": [
    {
      "type": "agent",
      "name": "my-agent",
      "version": "1.0.0",
      "description": "一句话描述",
      "author": "you",
      "url": "https://example.com/agents/my-agent.json",
      "sha256": "<内容 sha256 校验值>",
      "interfaces": { "input": {}, "output": {}, "version": "1.0.0" },
      "permissions": [{ "tool": "read_file" }],
      "runtime": "external"
    }
  ]
}
```

### 4.3 安装流程（用户侧）

`/agent install my-agent` → fetch 注册表 → 匹配条目 → 下载 → **sha256 校验** →
**接口合规检查**（zod schema）→ 写入 `~/.concertoai/agents/<name>/` → 刷新注册表。
任何一步失败 → 明确中文报错，拒绝安装。

## 5. 发布清单

发布前逐项自查：

- [ ] `AgentDef` 契约完整（name/version/interfaces/permissions，接口版本号）；
- [ ] 权限最小化：只声明实际使用的工具（fail-closed）；
- [ ] 包内容 sha256 与注册表条目一致；
- [ ] `entry` 可被 `import()` 加载（`module.exports = { create }` 工厂）；
- [ ] `execute` 输入/输出与 `interfaces` 声明的 Schema 一致；
- [ ] 写操作（edit_file / run_command）在实现中走审批流（ConcertoAI 安全基线，不可绕过）；
- [ ] 本地验证：`/agent install <name>` → `/agent list` 可见 → `/agent remove <name>` 可卸载。

## 6. 常见问题

| 问题 | 处理 |
|------|------|
| 安装被拒：`permissions 不能为空` | 权限声明是安全契约（fail-closed），补全实际使用的工具 |
| 安装被拒：`sha256 校验不通过` | 包内容与注册表 `sha256` 不一致，重新计算并更新 |
| 安装被拒：`AgentDef 结构不符合协议` | 对照 §4.1 包格式检查 def 字段完整性 |
| 内置 Agent 无法安装/卸载 | 内置 4 个（architect/coder/reviewer/qa）随 ConcertoAI 分发，`runtime: 'builtin'` 拒绝装卸 |
| 如何测试自己的 Agent？ | 注入 Fake ModelClient（`tests/e2e/orchestrator.test.ts` 同款）驱动 `execute`，断言输出符合 schema |

---

*本指南与代码同步维护：接口变更（`src/agents/protocol.ts` / `src/orchestrator/types.ts`）后请同步更新。*
