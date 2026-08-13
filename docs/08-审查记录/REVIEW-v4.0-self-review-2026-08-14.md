# REVIEW v4.0 自我审查报告（self-review）

> 审查版本：v4.0.0（M0~M8 全部落地，112 文件 / 1334 用例全绿）
> 审查日期：2026-08-14 · 审查人：AI 自我审查（独立完成，不参考其他审查者）
> 方法论（v3.2/v3.3/v3.4 固化）：沿数据流追踪 / 全项目同类模式扫描 / 追问控制流语义 / 区分「当前正确 vs 模式脆弱」/ 边界与国际化盲区扫描 / 安全模型完整性

---

## 一、审查范围

| 模块 | 变更 | 审查重点 |
|------|------|----------|
| M4 插件系统（plugin/ 6 文件 + permissions） | 新模块 | 权限模型完备性 / ESM 强制 / 审计 / 审批不可绕过 |
| M3 Provider（model/providers + registry/router + migration） | 新模块 | 行为差异 / config 迁移边界 / fallback 语义 |
| M2 workflow（workflow/ 5 文件 + executor） | 新模块 | 事务回滚边界 / 审批节点 / 失败恢复状态机 |
| M5 parallel（orchestrator/parallel.ts + team.ts） | 新模块 | 并行安全 / 冲突检测 / 独立事务 |
| M6 LSP（lsp/ 5 文件 + cli/lsp.ts） | 新模块 | 协议正确性 / 三来源诊断分级 / 服务端不改文件 |
| M1 autofix（reviewer/autofix.ts） | 新模块 | 分批/审批/回滚闭环 |
| 破坏性变更清单（CHANGELOG 7 项 + config 迁移） | 文档+代码 | 完整性 / 回滚路径 |

## 二、逐项审查发现

### 2.1 M4 插件权限模型 —— ✅ 通过（重点验证）

- **声明式拦截闭环**：PluginRuntime 挂 `setPermissionCheck` 钩子到 ToolRegistry——模型诱导插件调用未声明权限工具 → 调用前拦截（fail-closed）+ 审计 ✓
- **运行时细粒度**：`ctx.guard(type, detail)` 在插件**内部**调用点做白名单匹配（network allowedDomains / shell allowlist / mcp servers）✓
- **追问**：无 detail 退化声明检查——`guard('network')` 无 URL 时只查声明不查白名单（不误杀）；有 detail 才白名单匹配 ✓
- **shell 双保险**：guard 通过后 `approvalCtx` 闭包仍走宿主审批流（D5 基线）——`approvalCtx` 取 mount 时注入避免 run 时 ctx 缺失 ✓
- **审计**：权限拒绝写 AuditLogger（observable/audit.ts 复用）✓
- **ESM 强制**：loader 校验 .mjs 或 .js+type=module，CJS 拒绝并明确报错 ✓
- **边界**：内置插件（builtin.ts）直接注入内容不经下载——权限清单仍展示（install 时确认）✓

### 2.2 M3 Provider 切换行为差异 —— ✅ 通过

- **ADR-034 落实**：用户侧 `--provider` 自由切换（切换前成本对比）；Orchestrator/团队闭环内部固定默认 Provider（避免团队执行被用户临时切换影响）✓
- **config 迁移幂等**：`_migrated` 标记 + schemaVersion=2 双保险；重复运行 isV3Config=false 跳过 ✓
- **回滚路径**：`config restore` 从 config.v3.bak 覆盖回——备份是迁移时**先复制再写**（写盘前快照），回滚安全 ✓
- **fallback 语义**：启动 fallback ≤1 次（Router 记录已 fallback 标记，不无限重试）；状态条通知「主模型不可用，已切换至 Ollama」✓
- **Key 安全**：provider auth 保存 0600；解析链 CLI > env > active account > config；不落日志/会话/审计（grep 复核）✓
- **追问**：`-m` 兼容映射到 defaultProvider.model——若用户 `-m deepseek-v4-flash` 且 defaultProvider=openai，语义是「OpenAI 的该模型」还是「切回 deepseek」？**实现按 defaultProvider.model 覆盖**（文档 §3.5 声明），行为可预测 ✓

### 2.3 M2 workflow 事务回滚边界 —— ✅ 通过

- **整体快照语义（ADR-035/D55）**：开始前 SnapshotManager 登记全部 steps[].files（合并去重）；任一步失败且用户放弃（abort）→ 整体回滚已写文件 ✓
- **失败恢复状态机**：completed / rolledBack / pending 三清单 + R/S/F/A 选择——A(放弃) 才触发回滚，R/S/F 不误回滚 ✓
- **审批节点**：`require: approval` 复用 PlanConfirm 暂停，非 TTY 默认拒绝（fail-closed）✓
- **追问**：run 命令本身（npm run build）不登记 files——只登记显式声明的文件（写文件步骤需声明），未声明文件的命令副作用不在回滚范围（文档明确）✓

### 2.4 M5 parallel 并行安全 —— ✅ 通过

- **意图识别降级**：无强关键词且无 --parallel → 串行（不产生副作用）；有意图但拆解出纯串行链 → 降级串行 + 提示 ✓
- **冲突串行化**：组内 detectFileConflicts → 冲突组整组串行执行（避免并行写同一文件竞态）+ 汇总提示 ✓
- **独立事务**：每任务独立 AgentContext/taskId/SnapshotManager——单任务失败仅回滚自身（测试断言峰值并发=2）✓
- **审批前置**：拆解确认在并行分支前（拒绝不执行任何 Agent）✓

### 2.5 M6 LSP 三来源诊断 —— ✅ 通过

- **协议正确性**：Content-Length 用 utf8 字节数（Buffer.byteLength，中文安全）；FrameReader 处理半包/粘包/CRLF/LF 变体；非法帧防御不中断会话 ✓
- **三来源分级**：lint Warning / type Error / self-heal Information——sortDiagnostics 按 severity 排序后推送 ✓
- **服务端不改文件（延续 D5）**：biomeFixEdits 复制到临时目录跑 --write，读回生成整文件替换 edit；客户端应用 → didChange → 重新诊断 → 诊断消失 ✓
- **异步不阻塞**：诊断 Promise 化，慢 tsc 不阻塞帧主循环（exit 立即响应）✓
- **同 uri 合并**：diagnosing Set + pendingDiagnostics——高频 didChange 不排队子进程，完成后再跑最新 ✓
- **跨平台**：npx.cmd（Windows）/ npx（POSIX）；uriToPath Windows 盘符 `file:///F:/x` → `F:\x` + POSIX；parseTscOutput 大小写不敏感路径比较 ✓
- **R2 显式 any 不可自动修复** → 不提供 CodeAction（诚实，不产出无效修复）✓

### 2.6 M1 autofix —— ✅ 通过

- **A/B 分类**：A 类（可生成补丁的 suggestion/critical）批量审批一次完成；B 类（需架构决策）逐个确认不跳过 ✓
- **快照回滚**：写盘后增量 verify 失败 → 自动 rollback + 用户可见文案「已自动撤销」不暴露术语 ✓
- **审批 fail-closed**：拒绝不写盘，不自动重试 ✓

### 2.7 破坏性变更清单完整性 —— ✅ 通过（7 项 ≥ 6 项门）

- CHANGELOG Breaking Changes 7 项（config 格式 / --provider / Plugin 接口 / ESM 强制 / plugins[] schema / workflow 命令族 / 会话 version:4）全部落地且有对应迁移/回滚路径 ✓
- 迁移指南（docs/05/migration-guide-v4.md）含升级 + 回滚（npm 降级 + config restore）✓

### 2.8 文档一致性（自查第 5/7/8/9/11 条）

- 数字一致性：CHANGELOG/ARCHITECTURE/TASKS/AGENTS/README/07.8 全部 112 文件 / 1334 用例一致 ✓
- 目录树 + 全景图双核对：ARCHITECTURE §2 全景图（cli 块 lsp 命令 + lsp.ts + lsp/ 目录块）+ §5 目录树（cli/index.ts 命令清单 + cli/lsp.ts + src/lsp/ 五文件 + orchestrator/parallel.ts + tests/lsp/）✓
- 决策表：D53~D60 全部落地状态标注（M5→D58、M6→D59、M7→D60）✓
- 执行日志：execution-log-20260813-143058.md 续写 M5/M6/M7 各段 ✓
- **待办（T8.4 发布前）**：版本号联动（package.json + package-lock.json + src/version.ts + tests/smoke.test.ts + README + AGENTS + self-heal 段标记 `@concertoai/cli@x.y.z` → 4.0.0）

## 三、结论

| 项 | 结果 |
|----|------|
| 阻断问题 | 0 |
| 非阻塞建议 | 0 |
| 一致性 | 112 文件 / 1334 用例全绿，npm audit 0 漏洞 |
| 发布建议 | ✅ 可发布（T8.4 前版本号联动 + npm publish） |

## 四、待办（T8.4 发布前）

1. 版本号联动：package.json + package-lock.json（顶部 2 处）+ src/version.ts + tests/smoke.test.ts + README 状态行 + AGENTS 版本头 + 代码内 `@concertoai/cli@3.x` 段标记 → 4.0.0（AGENTS.md 自查第 8 条）
2. `npm whoami` 验证令牌 → `npm publish` → `git tag v4.0.0` 并推送
3. TASKS.md 看板 M8 完成状态更新

---

*自我审查完成：独立聚焦权限模型完备性（插件两层校验闭环）、Provider 行为差异（ADR-034 落实）、事务回滚边界（整体快照 + 失败恢复状态机）、市场 schema 向后兼容（plugins[] 零破坏）与破坏性变更清单完整性（7 项全落地 + 回滚路径）。*
