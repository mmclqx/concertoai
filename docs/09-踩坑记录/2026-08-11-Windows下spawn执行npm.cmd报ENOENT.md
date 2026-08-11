# [2026-08-11] Windows 下 spawn 执行 npm.cmd 报 ENOENT（QA Agent verify 回归）

## 问题描述
- 现象：v3.1.0 发布后，Windows 上 `concertoai team` / `/orchestrate` 的 QA Agent 执行 `npm run verify` 时报 **ENOENT**（找不到命令），对抗性闭环在 QA 阶段直接失败；Linux/macOS 正常。
- 环境：Windows x64（Node ≥22，ESM）

## 根因分析
- 直接原因：`ChildProcessQaRunner.run()` 以 `spawn('npm.cmd', ['run', 'verify'], { shell: false })` 执行。Node 文档明确：`.cmd`/`.bat` 文件不能脱离终端由 `CreateProcess` 直接执行，`shell: false` 时 spawn `.cmd` 必然 ENOENT；必须 `shell: true`（经 `cmd.exe /c`）或改用 `cmd.exe /c npm run verify`。
- 深层原因：构造器已按平台解析 `npmCommand`（`win32 → npm.cmd`），但 run() 仍以 `shell: false` 直接 spawn——两个维度（命令名解析 + shell 开关）只处理了前者，漏了后者。v3.1.0 发布门 Windows 冒烟覆盖了 CLI 主链路，未覆盖 QA Agent 真实 spawn 路径。

## 解决方案
- 修复方式：`shell: false → true`，并加注释说明「npmCommand 已在构造器按平台处理，此处直接使用；若再追加 `.cmd` 会变成 `npm.cmd.cmd`（ENOENT）」，防止后人重复拼接后缀。
- 涉及文件：`src/agents/qa.ts`、`tests/agents/qa.test.ts`（新增 ChildProcessQaRunner 回归测试：mock spawn 断言命令无 `.cmd.cmd` 双后缀 + shell 场景可正常 resolve）

## 经验教训
- 如何避免同类问题：Windows 上 spawn `.cmd`/`.bat` 必须 `shell: true`（或显式 `cmd.exe /c`）；平台适配（命令名 vs shell 开关）要一并检查，不能只改一半。新增「spawn 外部命令」的代码，Windows 冒烟必须覆盖真实执行路径（如 QA runner 跑一次最小 verify）。
- 是否需要更新规范：✅
- 规范更新位置：`AGENTS.md`（跨平台兼容性规范 → 命令执行规则补充：`.cmd`/`.bat` 必须 `shell: true`）

## 相关链接
- 对话记录：v3.1.1 Windows 回归修复
- 相关 PR/Commit：（待提交）
