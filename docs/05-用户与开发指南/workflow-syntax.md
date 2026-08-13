# ConcertoAI 工作流语法参考（v4.0 M2）

> 日期：2026-08-14 · 对应 v4.0-dev-tasks.md T8.2

## 1. 文件位置

```bash
.concertoai/workflows/<name>.yml    # 项目级（推荐，可提交 Git 团队共享）
```

## 2. YAML 结构

```yaml
name: release
description: 标准发版流程（lint → test → build → 审批 → publish）
steps:
  - id: lint
    run: npm run lint
  - id: test
    run: npm run test
    depends: [lint]          # 显式依赖（test 等 lint）
  - id: build
    run: npm run build
    depends: [test]          # 自动推断 test→build 时可省略，但显式更清晰
  - id: changelog
    run: npm run changelog
    depends: [build]
  - id: publish
    run: npm publish
    require: approval        # 审批节点：暂停等待用户确认
    depends: [changelog]
    files: [package.json, CHANGELOG.md]   # 事务回滚登记（失败整体回滚）
```

## 3. 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 工作流名（唯一，`workflow run <name>` 使用） |
| `description` | — | 描述 |
| `steps[].id` | ✅ | 步骤唯一 ID |
| `steps[].run` | ✅ | 要执行的命令（npm/任意 shell） |
| `steps[].depends` | — | 依赖的步骤 ID 列表（拓扑排序保证顺序） |
| `steps[].retry` | — | 失败重试次数（默认 0） |
| `steps[].require` | — | `approval` = 审批节点（暂停等确认） |
| `steps[].files` | — | 该步骤涉及的文件（事务回滚登记） |

## 4. 命令族

```bash
concertoai workflow init                 # 交互选模板（init-ts/upgrade-deps/release/precommit）
concertoai workflow run release          # 执行（DAG 排序 + 并行 + 审批 + 失败恢复）
concertoai workflow list                 # 列出已注册工作流
concertoai workflow export release       # 导出 YAML（可重定向到文件）
concertoai workflow import release.yml   # 导入校验并注册
concertoai workflow create "每次发版先 lint 再 test 然后 build 审批后 publish"  # 自然语言生成 YAML
```

chat 内 `/workflow run release` 同样可用。

## 5. 执行语义

- **DAG 依赖排序**：`depends` 显式声明 + `inferDependencies` 自动推断（test→build、publish→build 等启发式，推断结果提示确认，不静默写入）；
- **并行**：无依赖关系的步骤可并行执行；
- **审批节点**：`require: approval` 步骤暂停，等待用户 y/n（复用统一审批弹窗）；
- **失败恢复**：失败时展示已完成/已回滚/待执行清单 + 选择 `[R]重试 [S]跳过 [F]修复后重试 [A]放弃`；
- **事务回滚**：开始前 SnapshotManager 登记全部 `files`，任一步失败且放弃（abort）→ 整体回滚已写文件；
- **进度推送**：实时显示「▎▍▌▋ 正在执行 step 3/5: build…」。

## 6. 内置模板一览

| 模板 | 用途 |
|------|------|
| `init-ts` | 初始化 TS 项目（tsconfig + vitest + biome） |
| `upgrade-deps` | npm outdated → 逐个升级 → verify |
| `release` | lint → test → build → changelog → **审批** → publish |
| `precommit` | lint + type + test（提交前检查） |

## 7. 分享

```bash
concertoai workflow export release > release.yml
# 提交 Git 或发团队 → 对方
concertoai workflow import release.yml
```
