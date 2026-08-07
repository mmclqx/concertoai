# AGENTS.md - Lumen 项目开发规范

> 最后更新：2026-08-08
> 版本：v1.0.0

---

## 项目定位

Lumen 是一款**面向个人开发者的终端编码助手 CLI**（DeepSeek 驱动，中文优先）。它不是一个通用工具，而是一个有明确设计哲学的产品：

- **安全优先**：编辑与 Shell 命令一律审批，无 yolo 模式
- **中文优先**：全中文交互与反馈，降低使用门槛
- **低成本**：基于 DeepSeek API，Token 成本远低于同类产品
- **本地优先**：会话记录存储在本地，隐私可控

---

## 产品方向

**目标用户**：个人开发者、独立开发者、开源贡献者

**核心工作流**：
```bash
npm install -g @lumen/cli
cd path/to/project
lumen
```
### v1.0 已完成，核心能力包括：

CLI 交互（lumen chat / lumen run / lumen init / lumen plan）

DeepSeek 流式对话

5 个核心工具（读/搜/列/编辑/Shell）

审批流（编辑与命令一律审批）

会话持久化（JSONL）与 resume

Ink TUI 交互界面

项目规则加载（AGENTS.md / CARBON.md）

## 技术栈
类别	技术选型
运行时	Node ≥22，ESM
语言	TypeScript (strict)
TUI 框架	Ink 7 + React 19
CLI 解析	Commander 12
参数校验	Zod
测试	Vitest 4
代码检查	Biome
打包	tsup

## 工程规范
### 代码风格
使用 Biome 进行代码检查和格式化（配置见 biome.json）

所有新增功能必须包含测试用例

类型检查必须通过（npm run typecheck 零错误）

提交前运行 npm run verify 确保全绿

### 测试要求
单元测试：纯逻辑模块必须覆盖

集成测试：关键链路（loop / 工具调用）必须有集成测试

UI 测试：Ink 组件需用 ink-testing-library 覆盖

测试目标：保持 218+ 用例全绿

### it 规范
主分支：main

提交信息格式：<type>(<scope>): <subject>

示例：fix(loop): 达到最大轮数时返回 interrupted 状态

示例：feat(tools): 添加并行工具调度

每个任务完成后打标签（如 v1.0.0）

### 文档规范
所有文档放在 docs/ 目录下，编号规范（01-07）

新增功能需同步更新 ARCHITECTURE.md

重要决策记录在 DECISIONS.md 中

## 命名与包
项目	内容
产品名	Lumen
npm 包	@lumen/cli（如被占用则备选 lumen-cli）
主命令	lumen
短命令	lumen（不安装 cc，避免与 C 编译器冲突）

## 当前开发阶段
v1.0.0 已完成，全部 20 个任务（T1.1 ~ T4.6）已落地：

✅ 可靠性加固（模型核实 / usage 透传 / CRLF / 并发写 / 上下文裁剪）

✅ 体验升级（markdown / 光标历史 / resume 列表 / 中断进度）

✅ 能力扩展（并行调度 / 修复管线 / plan 模式 / 配置系统）

✅ 发布工程（npm 包 / 发布管线 / CI / 依赖升级 / EN 文案 / 文档）

v1.1 规划方向：

MCP 协议接入（filesystem / memory / github）

Plan-Then-Execute 模式增强

跨会话记忆系统

上下文压缩与摘要

## 发布门检查清单
1.0.0 发布前已全部通过：

☑ 模型 ID 与定价经官方文档核实
☑ npm run verify 全绿（218 用例）
☑ npm audit 无 high/critical
☑ 真实 API 冒烟通过
☑ Windows 冒烟通过（CRLF / 中文 / TTY）
☑ npm pack 预演通过
☑ 文档齐备（README / 用户手册 / 架构文档）
☑ v1.0.0 tag 已打

## 重要决策（已确定）
决策	说明
会话存储	JSONL 格式，存储在 ~/.lumen/sessions/
审批流	fail-closed（默认拒绝），编辑与 Shell 一律审批
上下文管理	v1.0 采用裁剪策略（保留 system + 最近 N 轮）
模型默认	deepseek-v4-flash，困难任务自动升级到 pro
配置系统	~/.lumen/config.json，CLI > 环境变量 > 配置文件 > 默认值

## 开发原则
单会话串行：一次只做一个任务，不并行

检查点提交：每完成一个里程碑做一次 Git 提交

测试先行：新增功能必须包含测试

文档同步：代码修改后同步更新相关文档

安全第一：所有危险操作必须走审批流

## 参考文档
- 产品定位与范围

- 架构设计

- 开发计划与任务

- 发布流程

- 用户指南

- 会议与决策记录

- 测试报告