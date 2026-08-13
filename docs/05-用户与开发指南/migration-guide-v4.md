# ConcertoAI v4.0 升级迁移指南（v3.4 → v4.0）

> 日期：2026-08-14 · 对应 v4.0-dev-tasks.md T8.2

## 1. 升级动作

```bash
npm install -g @concertoai/cli@4.0.0
concertoai doctor   # 自动检测 config 迁移完整性 + 模型推荐
```

## 2. 破坏性变更清单（7 项）

| # | 变更 | 影响 | 处理 |
|---|------|------|------|
| 1 | **config.json 格式 v3 → v4**：`model` → `defaultProvider` + `providers` 字典 | 启动自动迁移（备份 `config.v3.bak` + `_migrated` 幂等标记） | 无操作；`concertoai config restore` 一键回滚 |
| 2 | **CLI 新增 `--provider`**：临时切换 Provider | 新增，不破坏旧命令 | `concertoai --provider openai`；`-m` 仍兼容（映射 defaultProvider.model） |
| 3 | **工具与 Agent 注册改 Plugin 接口** | Plugin 成为公共 API（semver）；内置 Provider/工具/技能/Agent 统一实现 | 旧注册方式保留兼容层，无感知 |
| 4 | **插件必须 ESM** | CJS 插件拒绝加载（明确报错） | 第三方插件作者需迁移到 ESM |
| 5 | **市场 schema 扩展 `plugins[]`** | 兼容旧 `skills[]`/`agents[]`，installer 按 type 分派 | 零破坏，已装技能/Agent 不受影响 |
| 6 | **`concertoai workflow` 命令族新增** | 工作流 YAML（steps/depends/retry/approval）+ 4 内置模板 | 新增，不破坏旧命令 |
| 7 | **会话格式兼容** | JSONL 不变，新增 `session.version: 4` 字段 | v3 会话可继续读取 |

## 3. config 自动迁移详解

```jsonc
// v3 格式（迁移前）
{ "model": "deepseek-chat", "ollamaModel": "qwen3.6:27b", "ollamaBaseUrl": "http://localhost:11434/v1" }

// v4 格式（迁移后）
{
  "defaultProvider": "deepseek",
  "providers": {
    "deepseek": { "model": "deepseek-chat" },
    "ollama": { "model": "qwen3.6:27b", "baseUrl": "http://localhost:11434/v1" }
  },
  "_migrated": true
}
```

- **幂等**：`_migrated: true` 或 schemaVersion=2 后重复运行跳过；
- **备份**：迁移发生时自动复制 `config.v3.bak`；
- **回滚**：`concertoai config restore` 从备份覆盖回 v3 格式；
- **验证**：`concertoai doctor` 四检测（迁移成功 / 备份存在 / 会话兼容 / 幂等）。

## 4. Provider 认证与切换

```bash
# 首次使用 OpenAI：认证（Key 存 ~/.concertoai/accounts/openai/config.json，0600）
concertoai provider auth openai
# 仅验证不保存
concertoai provider auth openai --verify
# 查看所有 Provider 状态（🟢 可用 / 🔴 不可用 / 🟡 降级）
concertoai provider list
# 临时切换（本次进程）
concertoai --provider openai
# 持久化切换
concertoai config set provider openai
```

切换前状态条显示成本对比（如「OpenAI 成本约为 DeepSeek 的 7 倍」）。

## 5. 一键回滚

```bash
npm install -g @concertoai/cli@3.4.0   # 降级 npm 包
concertoai config restore               # 若已迁移，恢复 v3 config
```

> 注意：v4.0 新增的 plugin/workflow 配置不会在 v3.4 下生效，但旧功能（chat/run/plan/team/review 等）完全可用；会话 JSONL 兼容双向读取。
