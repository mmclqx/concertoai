# config.json v3 → v4 迁移器设计

> 状态：📋 设计完成（M0 T0.2）· 实现归 M3 T3.5
> 关联：v4.0-dev-plan-final.md M0 T0.2 / M3 T3.5 · ADR-034（Provider 切换）· ARCHITECTURE D54

## 1. 背景与目标

v3.x 的 `~/.concertoai/config.json` 使用单一 `defaultModel` 表达模型，并带 v2.2 的 `ollamaModel/ollamaBaseUrl`（本地模型高峰切换）。v4.0 引入多 Provider（DeepSeek/OpenAI/Ollama），config 结构升级为 `defaultProvider` + `providers` 字典。

**目标**：用户升级到 v4.0 后 **零手动操作**——启动时自动迁移、旧配置备份、失败可回滚、doctor 可检测迁移完整性。

## 2. 现状（v3 格式，schemaVersion=1）

```jsonc
{
  "schemaVersion": 1,
  "defaultModel": "deepseek-chat",
  "allowlist": ["npm test", "git status"],
  "approvalPolicy": "ask",
  "sessionDir": "...",
  "locale": "zh",
  "mcpServers": [],
  "peakTimeStrategy": "ask",
  "ollamaModel": "qwen3.6:27b-q4_K_M",
  "ollamaBaseUrl": "http://localhost:11434/v1"
}
```

## 3. 目标（v4 格式，schemaVersion=2）

```jsonc
{
  "schemaVersion": 2,
  "defaultProvider": "deepseek",
  "providers": {
    "deepseek": { "type": "deepseek", "model": "deepseek-chat" },
    "ollama":   { "type": "ollama",   "model": "qwen3.6:27b-q4_K_M", "baseUrl": "http://localhost:11434/v1" }
  },
  "allowlist": ["npm test", "git status"],
  "approvalPolicy": "ask",
  "sessionDir": "...",
  "locale": "zh",
  "mcpServers": [],
  "peakTimeStrategy": "ask",
  "_migrated": true
}
```

## 4. 字段映射表

| v3 字段 | v4 目标 | 规则 |
|---------|---------|------|
| `defaultModel: 'deepseek-chat'` | `defaultProvider: 'deepseek'` + `providers.deepseek.model` | 默认 Provider 键 `deepseek`；无 defaultModel 时 defaultProvider 用内置默认 |
| `ollamaModel` + `ollamaBaseUrl` | `providers.ollama = { type:'ollama', model, baseUrl }` | 两个字段同时存在才建 ollama provider；单独存在时补默认值 |
| `peakTimeStrategy` | 直通（保留） | v2.2 成本控制策略不变 |
| `allowlist/approvalPolicy/sessionDir/locale/mcpServers` | 直通 | 语义不变 |
| — | `_migrated: true` | 幂等标记，防止重复迁移 |

## 5. 判定与幂等

- **isV3Config**（已实现 + 测试）：`schemaVersion===1` → v3；无 schemaVersion 但含 `defaultModel` → v3（兼容旧配置）；`schemaVersion===2` 或空配置 → 非 v3。
- **幂等**：迁移成功后写 `_migrated: true`（或 schemaVersion=2 本身即幂等标记）。重复执行时 `isV3Config` 返回 false，跳过。

## 6. 备份与回滚

- **备份**：迁移写盘前，将原文件复制为 `config.v3.bak`（与 config.json 同目录）。
- **回滚**：`concertoai config restore`——用 `config.v3.bak` 覆盖回 config.json（升级指南 §9 已含此命令）。
- **原子写**：复用 `writeConfig` 的临时文件 + rename 模式，避免迁移中断产生半文件。

## 7. doctor 迁移完整性检测（M3 接入）

`concertoai doctor` 新增「config 迁移」区块，四项检测：

| 检测 | 通过条件 |
|------|----------|
| config 迁移成功 | `schemaVersion===2` 且 `defaultProvider` 存在且 `providers[defaultProvider]` 存在 |
| 备份存在 | `config.v3.bak` 文件存在（若发生过迁移） |
| 会话格式兼容 | 会话 JSONL 可读（session.version 缺失或为 3 均可，v4 只新增字段不破坏） |
| 迁移幂等 | 重复运行 doctor 不产生重复迁移/重复备份 |

## 8. 接入点（M3 T3.5）

1. `src/store/config.ts` `loadConfig`：读盘后若 `isV3Config` → 调 `migrateV3ToV4` → 返回迁移后配置；
2. `src/store/config.ts` `resolveConfig`：`model` 解析改为 `defaultProvider.providers[defaultProvider].model`，`-m` CLI 参数映射到该 model（保持兼容）；
3. `src/cli/doctor.ts`：接入 §7 检测；
4. 新命令 `concertoai config restore`：回滚 v3 备份。

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 迁移损坏用户配置 | 备份 + 原子写 + doctor 检测；`config restore` 一键回滚 |
| 旧配置无 schemaVersion 误判 | isV3Config 保守：有 defaultModel 才判 v3；空配置不迁移 |
| 迁移后模型行为差异（ADR-034） | 固定 Orchestrator Provider；切换前成本对比提示 |
| Key 迁移 | Provider apiKey 优先引用 accounts/（v3.1 体系），不落 config 明文（见 ProviderConfig.apiKey 注释） |
