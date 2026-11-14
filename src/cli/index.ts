#!/usr/bin/env node
/**
 * ConcertoAI CLI 入口：concertoai chat / concertoai run "任务"。
 */

import { Command } from 'commander';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { configPath, crashLogPath, migrateLegacyHome } from '../store/paths';
import { VERSION } from '../version';
import { buildMissingApiKeyGuide } from './api-key-guide';
// v5.1 T3.2：`--auto-low` 的两级取值合并（父命令会吃掉子命令的同名 flag，见该模块头注释）
import { resolveAutoLowFlag } from './auto-low-flag';
// v5.0 C1：commander 参数解析错误的本地化渲染（唯一出口，见该模块头注释）
import { isCommanderErrorShape, renderCliError } from './cli-errors';
import { parseMaxTurnsOption, resolveApiKeyWithConfigFallback } from './common';
import { installCrashHandlers } from './crash-handler';
import { describeFatalError } from './fatal-report';
import { checkNodeVersion, isNodeWarnSuppressed } from './node-version';
import { makePermissionConfirm as makeCliPermissionConfirm } from './plugin';
// v5.0 K14：`fix` 动词按运行时判断是否需要 Key（`needsVerbApiKey` 是纯函数，
// 与 `resolveVerbRuntime` 同模块；静态导入不引入副作用，动态导入留给重依赖）。
import { needsVerbApiKey } from './provider-runtime';

// ═══ 最早阶段：安装全局崩溃处理器（v3.1 M3 诊断） ═══
// 必须在任何异步操作前安装，确保 uncaughtException / unhandledRejection
// 都能被捕获并写入 ~/.concertoai/crash.log，防止"静默退出"。
installCrashHandlers();

// 启动时自动迁移旧配置目录（~/.lumen → ~/.concertoai，v3.1 起）。
// 幂等：~/.lumen 不存在或 ~/.concertoai 已存在时无操作。
migrateLegacyHome((message) => console.error(message));

// v5.0 T1：Node 版本提示（不阻断；仅交互式终端提示一次）。
// 背景：engines 要求 >= 22，但 Node 20 仍是 active LTS，npm 会刷多条英文
// EBADENGINE 警告（npx 零安装实测发现），新手会误以为装坏了 → 补一句中文说明。
{
  const check = checkNodeVersion(process.versions.node, {
    isTTY: process.stderr.isTTY === true,
    suppressed: isNodeWarnSuppressed(),
  });
  if (check.warning !== '') {
    process.stderr.write(`${check.warning}\n\n`);
  }
}

/**
 * 解析 API Key（v3.1 M3 T3.3）：CLI > 环境变量 > active account > config.json。
 * 无任何来源 → 报错退出（fail-closed，与现状一致）。
 */
async function getApiKey(): Promise<string> {
  // v5.0 K2：**含 config.json 回退的唯一链路**（doctor / chat / run / plan / commit 共用，
  // 避免「引导里的方式 ③ 在某个命令里不生效」的 v4.1.1 同类坑）
  const resolved = await resolveApiKeyWithConfigFallback();
  if (resolved.key !== undefined) {
    return resolved.key;
  }
  // v5.0 T1：缺 Key → 中文引导（三种真实生效的配置方式 + 获取地址），非静默崩溃
  console.error(buildMissingApiKeyGuide({ configPath: configPath() }).join('\n'));
  process.exit(1);
}

/**
 * 尽力解析 API Key，**缺 Key 不退出**（v5.0 T17）。
 *
 * `commit` 与 chat/run 不同：没有 Key 也能提交（message 走本地兜底），所以不能复用
 * `getApiKey()`——它在缺 Key 时直接 `process.exit(1)`，会把一次本可完成的提交挡在门外。
 * 解析链与 `getApiKey()` 完全一致（同一个函数），避免「引导里写的方式在这里不生效」的 v4.1.1 同类坑。
 */
async function tryGetApiKey(): Promise<string | undefined> {
  return (await resolveApiKeyWithConfigFallback()).key;
}

/**
 * 解析启动模型（v2.2 智能成本控制）：CLI -m 优先，随后应用高峰时段
 * 切换策略（ask 交互确认 / switch 直接切换 / ignore 保持主模型）。
 * 返回最终生效的模型 ID（可能为本地 ollama 模型）。
 */
async function resolveStartupModel(cliModel?: string): Promise<string> {
  const { maybeSwitchModel } = await import('../core/model-switcher');
  const { model } = await maybeSwitchModel({
    cliModel,
    interactive: process.stdin.isTTY === true,
  });
  return model;
}
// ═══ v5.0 T22：启动期先定语言（修复存量缺陷：--help 曾无视 locale） ═══
//
// 为什么必须在这里、且只调这一次：
// `--help` / `--version` / 参数校验失败这类输出由 commander 在**解析阶段直接打印并退出**，
// 根本进不到任何命令的 action，而 `setLocale` 此前只在各命令 action 内调用（chat / run /
// plan / commit / fix / review / team / self-heal / lsp）——于是 `--help` 永远用默认 zh，
// `en.ts` 那行定稿定位文案**没有任何路径能显示出来**（v5.0 T22 实测发现）。
// `description(...)` 在下面第 90 行就会取 `t()`，所以必须先定语言再建 `program`。
//
// 只认环境变量（LUMEN_LOCALE > LANG，与 `store/config.ts` 的解析优先级一致）：
// - 这个阶段没有命令上下文，拿不到各命令自己的 `--lang`；
// - 刻意**不读配置文件**：`--help` 要即时，且 `loadConfig()` 会在配置非法时往 stderr
//   打告警——让用户敲 `--help` 先看到一堆配置告警是新的噪音。命令内部仍会按
//   「--lang > 环境变量 > 配置」完整解析一次（各处 `setLocale` 调用保持不变，幂等兜底）。
setLocale(resolveLocale(process.env.LUMEN_LOCALE || process.env.LANG));

const program = new Command();

// v5.0 C2：`-V` / `-h` 两条**默认选项说明**由 commander 内置英文改为走字典。
// 注意顺序：`helpOption()` 也必须**在注册子命令之前**调用 —— commander 的
// `copyInheritedSettings()` 在 `.command()` 时把 `_helpOption` 一并复制给子命令
// （与 C1 的 configureOutput / exitOverride 同一个时机坑，症状同样是「一半一半」：
// 根级 `--help` 已中文、`concertoai plugin --help` 仍英文）。
program
  .name('concertoai')
  .description(t().cli.description)
  .version(VERSION, '-V, --version', t().cli.versionOption)
  .helpOption('-h, --help', t().cli.helpOption);

// ═══ v5.0 C1：commander 的参数解析错误改由我们按 locale 渲染 ═══
//
// ## 为什么必须写在「注册任何子命令之前」
//
// 这是实测踩到的第一个坑（初版写在文件末尾）：commander 的 `copyInheritedSettings()`
// 在 **`.command()` 创建子命令的那一刻**把父命令的 `_outputConfiguration` / `_exitCallback`
// **复制一份**给子命令。写在末尾 → 子命令拿到的是默认设置 → `concertoai run`（缺参）
// 仍打印英文并直接 `process.exit(1)`，只有根级选项（`-p`）才走我们的渲染。
// 症状极有迷惑性：**一半中文一半英文**，看起来像"某些 code 没映射"。
//
// ## 两步各自管什么（少一步就漏一半）
//
// 1. `configureOutput({ outputError })` 抑制 commander 的**报错文案**
//    （`error: unknown option …` 走的就是这条通道）。帮助正文走 `outputHelp` → `writeErr`，
//    **不受影响** —— 子命令 `help({ error: true })` 的帮助照旧打印。
// 2. `exitOverride()` 把 `process.exit` 换成抛 `CommanderError`，让文件末尾的 catch 拿到
//    `code` / `message` / `exitCode` 三个事实 —— 否则 commander 直接干掉进程，我们没机会说话。
//
// 最终打印由 `renderCliError()`（`src/cli/cli-errors.ts`）单点负责，**不要**在这里拼文案。
program.configureOutput({
  outputError: () => {},
});
program.exitOverride();

// ═══ v5.0 T14：--help 首屏精简（分层，不再平铺 21 条命令） ═══

/**
 * 「常用命令」的展示顺序（v5.0 T14）。
 *
 * ## 为什么这是**顺序表**而不是文案表
 *
 * 首屏里的每一行都从 `program.commands` 现取（命令名与描述都取真实注册值），
 * 本表只决定**谁排前面**。这样有两层保护：
 *
 * 1. **不漂移**：命令改名 / 删除 / 描述改动，首屏自动跟随，不需要改两份；
 * 2. **不打空头支票**：表里写了但没注册的命令，会被 `findCommand` 过滤掉，
 *    一个字都不会出现在用户眼前（T10 / T12 两次踩过的坑，见 ADR-044）。
 *
 * ## M4 四动词（用户 2026-10-28 拍板：「绝对不允许打空头支票」）
 *
 * `check` / `fix` / `commit` / `review` 四个动词**已全部落地**（T15 / T16 / T17 / T18）。
 * 本表是它们的唯一登记处：**只改下面这一个数组**（按顺序插入）即可自动出现在
 * 「常用命令」，渲染逻辑不用动；顺序表里的名字若没注册，`findCommand` 会把它过滤掉
 * （不打空头支票），`tests/cli/help.test.ts` 另有双向不变量盯着。
 * 顺序即产品主张：`check`（能不能提交）→ `fix`（报错自动修）→ `commit`（提交）→
 * `review`（审一遍）是 v5.0 的「提交前主路径」。
 */
const COMMON_COMMAND_ORDER: readonly string[] = [
  // v5.0 T15：`check`（提交前主路径的第一步，只读最安全）。
  'check',
  // v5.0 T16：`fix`（check 说「不行」之后的那一步：薄包装 self-heal）。
  'fix',
  // v5.0 T17：`commit`（体检 → message 审批 → 本地提交）。
  'commit',
  // v5.0 T18：`review`（9 维审查，与 TUI 的 /review 同引擎同输出）。
  'review',
  'init', // 生成规则文件（也是 T13 场景提示指向的命令）
  'self-heal', // 跑 verify，失败自动修（fix 是它的推荐入口，保留原名不删）
  'doctor', // 环境诊断
  'chat', // 进入对话
  'run', // 一次性任务
];

/**
 * 「交互」段展示的斜杠命令（v5.0 T14）。
 *
 * 这些**不是** commander 子命令，无法从 `program.commands` 校验，
 * 所以存在性由测试护栏保证：每条都用**真实解析器**断言可接受
 * （`parseReviewCommand` / `parseWorkflowCommand` … 见 `tests/cli/help.test.ts`）。
 * 描述走 i18n `help.slash*`。
 */
const SLASH_COMMAND_ENTRIES: ReadonlyArray<{
  name: string;
  descKey: 'slashPlan' | 'slashReview' | 'slashWorkflow' | 'slashHints' | 'slashApprovals';
}> = [
  { name: '/plan', descKey: 'slashPlan' },
  { name: '/review', descKey: 'slashReview' },
  { name: '/workflow', descKey: 'slashWorkflow' },
  { name: '/hints', descKey: 'slashHints' },
  // v5.2 N2：只读查询「本会话被自动放行的调用」（恢复会话后也有效）
  { name: '/approvals', descKey: 'slashApprovals' },
];

/**
 * 从已注册命令里查一条（查不到返回 `undefined`）。
 *
 * **查不到 = 不渲染**：这是「不许打空头支票」的落地点，而不是靠人工核对。
 */
function findCommand(prog: Command, name: string): Command | undefined {
  return prog.commands.find((command) => command.name() === name);
}

/**
 * 渲染分组首屏（v5.0 T14）。
 *
 * 结构：快速开始（3 步）→ 常用命令 → 交互（斜杠）→ 高级（其余命令折叠成一行）。
 *
 * 行数预算 ≤ 40（T14 验收，防淹没）：实测约 33 行。
 */
function renderGroupedHelp(prog: Command): string {
  const dict = t();
  const lines: string[] = [];

  // ① 快速开始（三步都是真实存在的命令：doctor / init / chat）
  lines.push('', dict.help.fastStart, dict.help.fast1, dict.help.fast2, dict.help.fast3);

  // ② 常用命令：按顺序表取，**只渲染真实注册的**，描述用注册值（不手写）
  const common = COMMON_COMMAND_ORDER.map((name) => findCommand(prog, name)).filter(
    (command): command is Command => command !== undefined,
  );
  if (common.length > 0) {
    lines.push('', `${dict.help.common} ${dict.help.commonHint}`);
    const width = Math.max(...common.map((command) => command.name().length));
    for (const command of common) {
      lines.push(`  ${command.name().padEnd(width)}  ${command.description()}`);
    }
  }

  // ③ 交互（斜杠命令，存在性由测试护栏保证）
  lines.push('', dict.help.slash);
  for (const entry of SLASH_COMMAND_ENTRIES) {
    lines.push(`  ${entry.name.padEnd(10)} ${dict.help[entry.descKey]}`);
  }

  // ④ 高级：其余命令折叠成一行（点名不点名都行——它们是「查得到但不该抢位置」的）
  const hidden = prog.commands
    .map((command) => command.name())
    .filter((name) => !COMMON_COMMAND_ORDER.includes(name));
  if (hidden.length > 0) {
    lines.push('', dict.help.advanced, `  ${hidden.join(' · ')}`);
  }
  // 末尾不加 `''`：commander 自己会补换行，多推一个会留一行空行（首屏更短更干净）
  lines.push(dict.help.advancedHint);

  return lines.join('\n');
}

// v5.0 T14：隐藏 commander 默认的「全部命令平铺」，改由 renderGroupedHelp 分组呈现。
//
// `visibleCommands` 里读 `process.argv` 而不是 `program.opts()`：`--help` 一旦被解析
// commander 就**立即打印并退出**，此刻同批的 `--all` 很可能还没进 opts
// （`concertoai --help --all` 与 `--all --help` 行为会不一致）。argv 判断两者等价，
// 这是唯一可靠的时机。只影响帮助渲染，不参与任何业务判断。
program.configureHelp({
  // `cmd.commands` 是 `readonly Command[]`，commander 签名要可变数组 → 展开一份副本
  // （不就地改原数组，只为了满足类型；esbuild 不做类型检查，只有 tsc 会报）。
  visibleCommands: (cmd) => (process.argv.includes('--all') ? [...cmd.commands] : []),
});

// v4.1 T2.2：--help 增强（v5.0 T14 改为动态分组，命令与描述一律从已注册命令取）
program.addHelpText('afterAll', () => renderGroupedHelp(program));

// v3.1 M2 T2.3：全局 `-p, --project <name>` —— 启动前校验项目存在并 chdir 到项目路径
// （等价 cd 后启动）。preAction hook 在任意子命令 action 前执行，保证 chat/run/plan 等
// 都以项目路径为 cwd 装配。未注册项目 → 报错退出（fail-closed）。
program.option('-p, --project <name>', t().cli.globalOptions.project);
// v4.0 M3 T3.1：--provider 临时切换（本次进程生效，不写盘）
program.option('--provider <name>', t().cli.globalOptions.provider);
program.hook('preAction', async () => {
  const projectName = program.opts().project as string | undefined;
  if (projectName === undefined) {
    return;
  }
  const { loadProjectRegistryCached } = await import('./common');
  const registry = await loadProjectRegistryCached();
  const entry = registry.get(projectName);
  if (entry === undefined) {
    console.error(
      `❌ 项目 ${projectName} 未注册。请先运行 \`concertoai project add ${projectName} <path>\` 注册。`,
    );
    process.exit(1);
  }
  process.chdir(entry.path);
  console.log(`✅ 已切换到项目 ${projectName}（${entry.path}）`);
});

/** 包装异步 action，捕获异常并输出到 stderr + crash.log。 */
// v4.1 P0-1：支持带参 action（workflow <action> [param]）——commander 会把
// action 参数（含 options）依次传入；泛型保留回调参数类型（TS strict 下
// unknown[] 与具体参数类型不兼容）。
//
// ═══ v5.0 K17：这里从「一律打堆栈」改成「先分类再决定打什么」 ═══
//
// 旧行为的问题（K17 实测）：`concertoai run` 端点点不通时，用户看到
// `未处理的 Promise 拒绝 + TypeError: fetch failed + undici 堆栈`——把「端点/网络配错」
// 呈现成「程序崩了」，且没有一句中文说明连不上哪个端点。分类与措辞在
// `./fatal-report`（唯一渲染点），本函数只负责「写 stderr + 退出码」。
//
// 三条不变量：
// ① 可归因的外部失败（端点不可达 / 连接超时）→ 一句人话 + 下一步，**不打堆栈**，
//    也**不提 crash.log**（这类错误不写崩溃日志，提了就是假线索）；
// ② 未知异常（疑似缺陷）→ 消息 + 堆栈 + crash.log 路径 + 通用下一步，行为与旧版一致；
// ③ 退出码恒为 1（fail-closed），不因错误类型而变。
function safeAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => void {
  return (...args: A) => {
    fn(...args).catch((err: unknown) => {
      const report = describeFatalError(err);
      // 前缀也走 i18n：此前硬编码中文，`LUMEN_LOCALE=en` 的用户会看到
      // 「命令执行失败: Cannot reach the model endpoint…」这种中英混排（K17 收尾实测）。
      process.stderr.write(`\n[ConcertoAI] ${t().errors.commandFailed}: ${report.message}\n`);
      if (report.showStack) {
        const stack = err instanceof Error ? err.stack : undefined;
        if (stack !== undefined) {
          process.stderr.write(`${stack}\n`);
        }
        process.stderr.write(`详情见 ${crashLogPath()}\n`);
        process.stderr.write(`${t().errors.fatalNextStep}\n`);
      } else if (report.hint !== undefined && report.hint !== '') {
        process.stderr.write(`${report.hint}\n`);
      }
      process.exit(1);
    });
  };
}

/**
 * 读取 `-t/--max-turns` 并翻译成「本次生效的轮数上限」（v5.0 架构修正）。
 *
 * 校验本身在 `parseMaxTurnsOption`（`./common`，纯函数 + 单测），这里只做两件事：
 * 1. 写错（非法字符串 / 0 / 负数 / 超过硬上限）→ **如实提示但不中断**，与
 *    `reflect --limit` 同口径：一次手滑不该让整条长任务跑不起来；
 * 2. 返回 `undefined` 把最终决定权交回 `resolveConfig`（config.maxTurns > 默认）。
 *
 * 为什么不用 commander 的 `Number()` / `parseInt`：`parseInt('5x')` = 5、`Number('1e3')`
 * = 1000，都会让用户拿到的上限和他写的**不是一回事**（静默改值）。
 */
/**
 * 记一条「用了哪个动词」的本地指标（v5.0 T21）。
 *
 * **动态 import + fire-and-forget**：指标不是关键路径，绝不该为它拖慢启动
 * （`./metrics` 会连带加载 `store/config`），也不该因为写盘失败影响命令结果。
 * 开关判定在 `recordVerbMetric` 内部走 `resolveConfig`（唯一来源）。
 */
function recordVerb(verb: 'check' | 'fix' | 'commit' | 'review'): void {
  void import('./metrics')
    .then((mod) => mod.recordVerbMetric(verb))
    .catch(() => {
      // 静默：指标写不进去不影响用户正在做的事
    });
}

function readMaxTurnsOption(raw: string | undefined): number | undefined {
  const parsed = parseMaxTurnsOption(raw);
  if (parsed.invalid) {
    console.error(fmt(t().cli.maxTurns.invalid, { value: raw ?? '' }));
  }
  return parsed.maxTurns;
}

// ── v5.1：chat 的低风险自动放行开关（`--auto-low`）────────────────────────
/**
 * 往命令上挂 `--auto-low`（**唯一文案来源**）。
 *
 * 为什么需要这个帮助函数：本仓 chat 有**两个入口**——
 *   ① `program.action(...)`（无子命令时默认进 chat，产品定位 `cd 项目 && concertoai`）；
 *   ② `.command('chat')`（显式子命令）。
 * 只在②上挂的话，`npm run dev -- --auto-low` 会以 `unknown option` 失败，而这条正是用户日常路径。
 * 两处各调一次本函数，文案与行为就不会漂移。
 *
 * ⚠️ 与既有 `--auto-approve` 的区别（**不要混用**）：
 *   `--auto-approve`（run/plan/team/self-heal/fix）语义是**全批**（`requestApproval: async () => true`）；
 *   `--auto-low` 只放行「分析成功且零命中」的**编辑**，shell/high/medium/降级一律仍问。
 *   名字不同是刻意的：同名不同义会让人以为「和 run 一样全放」。
 */
function addAutoLowOption(cmd: Command): Command {
  return cmd.option('--auto-low', t().cli.chat.autoLow);
}

/**
 * 把 `--auto-low` 的取值落到 `runChat` 入参（**两个入口共用，只有这一处**）。
 *
 * ⚠️ 不能只读 `options.autoLow`（v5.1 T3.2 真机抓到的静默失效）：父命令与子命令注册了同名
 * flag 时，commander 会把 `chat --auto-low` 里的那个**解析到根命令**，子命令的 options 是空对象。
 * 实测 `chat-action options={} rootOpts={"autoLow":true}` ⇒ 只读子命令就等于把用户敲的开关丢掉。
 * 合并逻辑与取证写在 `src/cli/auto-low-flag.ts` 文件头。
 */
function autoLowFrom(options: { autoLow?: boolean }): boolean {
  return resolveAutoLowFlag({ subcommand: options.autoLow, root: program.opts().autoLow });
}

// 无子命令时默认进入 chat（产品定位：cd 项目 && concertoai）
addAutoLowOption(program).action(
  safeAction(async () => {
    // 动态导入（v2.1 性能优化）：启动阶段只加载 commander + i18n，
    // TUI 依赖树（ink/react/ui/mcp/skill）在用户真正进入交互后才加载。
    const { runChat } = await import('./chat');
    const model = await resolveStartupModel();
    await runChat({
      cwd: process.cwd(),
      apiKey: await getApiKey(),
      model,
      // v5.1：根命令选项经 program.opts() 取（根 action 的入参是它自己的参数列表，不含选项）
      autoLow: autoLowFrom({}),
    });
  }),
);

addAutoLowOption(
  program
    .command('chat')
    .description(t().cli.chat.description)
    .option('-r, --resume [id]', t().cli.resume.argument)
    .option('-l, --list', t().cli.list.description)
    .option('-m, --model <id>', t().cli.model.description)
    .option('-t, --max-turns <n>', t().cli.maxTurns.description),
).action(
  async (options: {
    resume?: string | true;
    model?: string;
    list?: boolean;
    lang?: string;
    maxTurns?: string;
    autoLow?: boolean;
  }) => {
    const { runChat } = await import('./chat');
    // 先解析 -t：写错时**立刻**提示，不必等模型/Key 解析完才让用户知道
    const maxTurns = readMaxTurnsOption(options.maxTurns);
    // -l 仅列会话：不需要模型，跳过高峰切换（避免 ask 策略阻塞）
    const model = options.list === true ? options.model : await resolveStartupModel(options.model);
    await runChat({
      cwd: process.cwd(),
      apiKey: await getApiKey(),
      resume: options.resume,
      model,
      listOnly: options.list,
      lang: options.lang,
      // v4.0 M3 T3.1：--provider 临时切换（本次进程生效，不写 config）
      provider: program.opts().provider,
      // v5.0 架构修正：-t/--max-turns（CLI > config.maxTurns > 默认 50）
      maxTurns,
      // v5.1：低风险自动放行（默认关；只放行零命中的编辑，见 src/core/auto-approve.ts）
      // ⚠️ 必须走 autoLowFrom 合并两级：`chat --auto-low` 的 flag 会被根命令吃掉（见该函数注释）
      autoLow: autoLowFrom(options),
    });
  },
);

program
  .command('run <task>')
  .description(t().cli.run.description)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--auto-approve', t().cli.run.autoApprove)
  .option('--lang <zh|en>', t().cli.lang.description)
  .option('-t, --max-turns <n>', t().cli.maxTurns.description)
  .action(
    // v5.0 K17：`run` 此前**没有**包 safeAction —— 模型调用失败（端点不可达等）会以
    // unhandledRejection 落到 crash-handler，用户看到的是 `TypeError: fetch failed` 堆栈。
    // 包上以后走统一的 fatal-report 渲染（说清连不上哪个端点 + 下一步）。
    safeAction(
      async (
        task: string,
        options: { model?: string; autoApprove?: boolean; lang?: string; maxTurns?: string },
      ) => {
        const { runTask } = await import('./run');
        // 先解析 -t：写错时立刻提示（不等 Key 解析完才让用户知道）
        const maxTurns = readMaxTurnsOption(options.maxTurns);
        await runTask({
          cwd: process.cwd(),
          apiKey: await getApiKey(),
          task,
          model: options.model,
          autoApprove: options.autoApprove ?? false,
          lang: options.lang,
          provider: program.opts().provider,
          // v5.0 架构修正：-t/--max-turns（CLI > config.maxTurns > 默认 50）
          maxTurns,
        });
      },
    ),
  );

program
  .command('plan <task>')
  .description(t().cli.plan.description)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--auto-approve', t().cli.plan.autoApprove)
  .option('--lang <zh|en>', t().cli.lang.description)
  .option('-t, --max-turns <n>', t().cli.maxTurns.description)
  .action(
    // v5.0 K17：与 `run` 同因——`plan` 也没包 safeAction（计划阶段的模型调用失败会直接砸堆栈）。
    safeAction(
      async (
        task: string,
        options: { model?: string; autoApprove?: boolean; lang?: string; maxTurns?: string },
      ) => {
        const { runPlan } = await import('./plan');
        // 先解析 -t：写错时立刻提示（不等 Key 解析完才让用户知道）
        const maxTurns = readMaxTurnsOption(options.maxTurns);
        await runPlan({
          cwd: process.cwd(),
          apiKey: await getApiKey(),
          task,
          model: options.model,
          autoApprove: options.autoApprove ?? false,
          lang: options.lang,
          provider: program.opts().provider,
          // v5.0 架构修正：-t/--max-turns（CLI > config.maxTurns > 默认 50）
          maxTurns,
        });
      },
    ),
  );

program
  .command('snapshot')
  .description(t().cli.snapshot.description)
  .argument('[action]', t().cli.snapshot.argument)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(async (action?: string) => {
    const { runSnapshotCommand } = await import('./snapshot');
    await runSnapshotCommand({ cwd: process.cwd(), action });
  });

program
  .command('project <action> [name] [path]')
  .description(t().cli.project.description)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(async (action: string, name?: string, p?: string) => {
    const { runProjectCommand } = await import('./project');
    await runProjectCommand({
      cwd: process.cwd(),
      action: action as 'add' | 'list' | 'remove' | 'info' | 'switch',
      name,
      path: p,
    });
  });

program
  .command('team <task>')
  // v5.0 T20：功能冻结（FEATURE_FREEZE.md）——team 与 `--parallel` 停扩，只修 bug
  .description(t().cli.team.description)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--dry-run', t().cli.team.dryRun)
  .option('--auto-approve', t().cli.team.autoApprove)
  // v5.0 T20：并行模式停扩（维护模式），只修 bug
  .option('--parallel', t().cli.team.parallel)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(
    async (
      task: string,
      options: {
        model?: string;
        dryRun?: boolean;
        autoApprove?: boolean;
        parallel?: boolean;
        lang?: string;
      },
    ) => {
      const { runTeamCommand, formatTeamProgress } = await import('./team');
      const result = await runTeamCommand({
        cwd: process.cwd(),
        apiKey: await getApiKey(),
        task,
        model: options.model,
        dryRun: options.dryRun,
        autoApprove: options.autoApprove ?? false,
        parallel: options.parallel,
        lang: options.lang,
        // T4.1：长任务中间进度 → stdout（拆解/轮次/收尾，避免黑盒等待）
        onProgress: (p) => process.stdout.write(`${formatTeamProgress(p)}\n`),
      });
      if (!result.ok && result.loop === undefined) {
        process.exitCode = 1;
      }
    },
  );

program
  .command('lsp')
  .description(t().cli.lsp.description)
  .option('--stdio', t().cli.lsp.stdio)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(async (options: { stdio?: boolean; lang?: string }) => {
    if (options.stdio !== true) {
      process.stderr.write(`❌ ${t().cli.lsp.stdioRequired}\n`);
      process.exitCode = 1;
      return;
    }
    const { runLspCommand } = await import('./lsp');
    await runLspCommand({ cwd: process.cwd(), lang: options.lang });
  });

program
  .command('self-heal')
  .description(t().cli.selfHeal.description)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--auto-approve', t().cli.selfHeal.autoApprove)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(async (options: { model?: string; autoApprove?: boolean; lang?: string }) => {
    const { runSelfHealCommand } = await import('./self-heal');
    await runSelfHealCommand({
      cwd: process.cwd(),
      apiKey: await getApiKey(),
      model: options.model,
      autoApprove: options.autoApprove ?? false,
      lang: options.lang,
    });
  });

program
  .command('audit <action>')
  .description(t().cli.audit.description)
  .option('--out <file>', t().cli.audit.out)
  .action(async (action: string, options: { out?: string }) => {
    const { runAuditCommand } = await import('./audit');
    if (action !== 'export') {
      console.error(`未知 audit 子命令: ${action}（支持 export）`);
      process.exitCode = 1;
      return;
    }
    const code = await runAuditCommand({ out: options.out });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// v5.0 T10：拒绝复盘记录（本地 JSONL，零上传；list 查看 / clear 清空）
program
  .command('reflect <action>')
  .description(t().cli.reflect.description)
  .option('--limit <n>', t().cli.reflect.limit)
  .option('-y, --yes', t().cli.reflect.yes)
  .action(async (action: string, options: { limit?: string; yes?: boolean }) => {
    const { parseReflectLimit, runReflectCommand } = await import('./reflect');
    const { limit, invalid } = parseReflectLimit(options.limit);
    if (invalid) {
      // 参数写错如实提示（不静默吞掉），但仍按默认条数继续 —— 别让一次手滑中断用户的查看
      console.error(fmt(t().reflect.limitInvalid, { limit }));
    }
    const code = await runReflectCommand({ action, limit, yes: options.yes ?? false });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

program
  .command('balance')
  .description(t().cli.balance.description)
  .action(async () => {
    const { runBalanceCommand } = await import('./balance');
    const code = await runBalanceCommand({ apiKey: await getApiKey() });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// v5.0 T5：init 命令（一次分析、双文件输出：AGENTS.md 给 AI + PROJECT_GUIDE.md 给人）
program
  .command('init')
  .description(t().cli.init.description)
  .option('-f, --force', t().cli.init.force)
  .action(async (options: { force?: boolean }) => {
    const { runInitCommand } = await import('./init');
    const result = await runInitCommand({
      cwd: process.cwd(),
      overwrite: options.force === true ? 'yes' : 'ask',
    });
    if (result.code !== 0) {
      process.exitCode = result.code;
    }
  });

// v5.0 T15：check 命令（提交前只读体检：四段分类 + 一句结论 + 下一步命令）
// ⚠️ 只读零写入——本命令**不修任何东西**（修是 self-heal 的事）。
program
  .command('check')
  .description(t().cli.check.description)
  .option('--json', t().cli.check.json)
  .action(async (options: { json?: boolean }) => {
    const { runCheckCommand } = await import('./check');
    const code = await runCheckCommand({ cwd: process.cwd(), json: options.json === true });
    recordVerb('check');
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// v5.0 T16：fix 命令（报错自动修：self-heal 的推荐入口，薄包装 + 每次写盘审批）
// ⚠️ 与 `self-heal` 的关系：同一闭环，`fix` 是推荐入口（`--help` 里排在前面），
// `self-heal` 保留不删（旧脚本/文档引用它，改语义会静默改变行为）。
program
  .command('fix')
  .description(t().cli.fix.description)
  .option('--dry-run', t().cli.fix.dryRun)
  .option('--auto-approve', t().cli.fix.autoApprove)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(
    safeAction(
      async (options: {
        dryRun?: boolean;
        autoApprove?: boolean;
        model?: string;
        lang?: string;
      }) => {
        const { runFixCommand } = await import('./fix');
        const { resolveVerbRuntime } = await import('./provider-runtime');
        // v4.0 M3 T3.1 全局 `--provider`（本次进程生效，不写盘）
        const provider = program.opts().provider as string | undefined;
        /**
         * K14：**端点/模型在入口只解析一次**，往下传 `runtime`。
         *
         * 为什么不是在动词里自己读配置：`loadConfig` 有副作用（装载计价节假日表 +
         * 打印非法配置提示），一个命令里读两次就等于提示打两遍；而且「同一事实两处
         * 各解析一次」正是 K10/K14 这类「说法与事实不符」的共同病根。
         */
        const runtime = await resolveVerbRuntime({
          // 全局 `--provider` 与 chat/run/plan 同口径：本次进程临时切换
          // （三个动词此前压根不看它 —— 「用户配了却被静默忽略」正是 K14 的病）
          ...(provider !== undefined ? { provider } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        });
        /**
         * `--dry-run` 只诊断不调模型 → 不要 Key；其余情况**按运行时判断**是否需要 Key
         * （`defaultProvider=ollama` 的用户没有 DeepSeek Key，先要 Key 会把人挡在门外）。
         * 缺 Key 时走既有中文引导（`getApiKey()` 打印三种配置方式后 exit 1）。
         */
        const needKey = options.dryRun !== true && needsVerbApiKey(runtime);
        const apiKey = needKey
          ? await getApiKey()
          : runtime.apiKey !== ''
            ? runtime.apiKey
            : undefined;
        const code = await runFixCommand({
          cwd: process.cwd(),
          ...(apiKey !== undefined ? { apiKey } : {}),
          runtime,
          model: options.model,
          dryRun: options.dryRun === true,
          autoApprove: options.autoApprove === true,
          lang: options.lang,
        });
        recordVerb('fix');
        if (code !== 0) {
          process.exitCode = code;
        }
      },
    ),
  );

// v5.0 T17：commit 命令（先体检 → 生成 message → 审批 → 本地提交）
// ⚠️ 安全边界：只做本地提交；本命令**不**执行任何远程操作、不改写历史、不绕过检查。
// ⚠️ --yes 只跳过 message 审批，**不跳过体检**（体检是 T15 的意义所在）。
program
  .command('commit')
  .description(t().cli.commit.description)
  .option('-y, --yes', t().cli.commit.yes)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(
    safeAction(async (options: { yes?: boolean; model?: string; lang?: string }) => {
      const { runCommitCommand } = await import('./commit');
      const { resolveVerbRuntime } = await import('./provider-runtime');
      const provider = program.opts().provider as string | undefined;
      // 没有 Key 也能提交：message 走本地兜底（如实告知未调模型），不因缺 Key 卡死。
      // 走与 chat/run 同一条解析链（CLI > env > account > config.json），不另读环境变量。
      const key = await tryGetApiKey();
      // K14：`config.providers.deepseek.baseUrl` / `defaultProvider` 只在入口解析一次
      const runtime = await resolveVerbRuntime({
        // 全局 `--provider` 与 chat/run/plan 同口径（此前三个动词不看它）
        ...(provider !== undefined ? { provider } : {}),
        ...(key !== undefined ? { apiKey: key } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
      });
      const code = await runCommitCommand({
        cwd: process.cwd(),
        yes: options.yes === true,
        ...(key !== undefined ? { apiKey: key } : {}),
        runtime,
        model: options.model,
        lang: options.lang,
      });
      recordVerb('commit');
      if (code !== 0) {
        process.exitCode = code;
      }
    }),
  );

// v5.0 T18：review 命令（9 维审查，CLI 层直达；与 TUI 的 /review 同引擎同输出）
// ⚠️ 退出码语义：0 = 无 A 级（严重）问题；1 = 有 A 级（含「判不了」：非仓库 / 没装 git / 缺 Key）。
// ⚠️ 默认只读：不带 --fix 时零写入；带 --fix 时每次写盘都审批（非交互终端一个字节都不写）。
program
  .command('review [path]')
  .description(t().cli.review.description)
  .option('--fix', t().cli.review.fix)
  .option('--severity <level>', t().cli.review.severity)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(
    safeAction(
      async (
        p: string | undefined,
        options: { fix?: boolean; severity?: string; model?: string; lang?: string },
      ) => {
        const { formatInvalidSeverity, parseReviewSeverity, runReviewCommand } = await import(
          './review'
        );
        const { resolveVerbRuntime } = await import('./provider-runtime');
        const provider = program.opts().provider as string | undefined;
        // 参数错误先报（别让「缺 Key」把「severity 写错」掩盖掉）；校验规则只此一处
        const severity = parseReviewSeverity(options.severity);
        if (!severity.ok) {
          console.error(formatInvalidSeverity(severity.value));
          process.exitCode = 1;
          return;
        }
        /**
         * K14：**先解析端点/模型，再判 Key**（顺序不能反）。
         *
         * 此前这里一上来就 `await getApiKey()`——缺 Key 直接打印引导并 `exit 1`，
         * 于是 `defaultProvider=ollama`（本地模型、不需要 Key）的用户连「端点配对了」
         * 都轮不到验证：键一被判缺失就出局，等于 K14 只修了一半。
         * 现在按运行时判断（`needsVerbApiKey` 只对 deepseek 成立），与 `fix` 同口径。
         */
        const runtime = await resolveVerbRuntime({
          ...(provider !== undefined ? { provider } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        });
        /**
         * C3（v5.0 自审发现）：这里**刻意不判 Key**。
         *
         * 原先 `needsVerbApiKey(runtime) ? await getApiKey() : …`：缺 Key 时 `getApiKey()`
         * 打完整引导并 `exit 1`，于是「空目录里跑 review」的第一反馈是「没配 Key」，
         * 而真相是「这目录不是 git 仓库 / 没有可审的改动」——用户会先去配 Key，
         * 配完回来才发现还是审不了。**顺序判定收敛到 `runReviewCommand` 内一处**
         * （范围 → Key），入口只负责把运行时递下去。
         */
        const code = await runReviewCommand({
          cwd: process.cwd(),
          ...(p !== undefined ? { path: p } : {}),
          fix: options.fix === true,
          ...(severity.severity !== undefined ? { severity: severity.severity } : {}),
          // K14：端点/模型只在入口解析一次（此前 review 自己 `new DeepSeekClient({ apiKey })`，
          // 配了 baseUrl 的用户会被静默改打官方端点，成本回执也据此报错价）
          runtime,
          model: options.model,
          lang: options.lang,
        });
        // v5.0 T21 动词使用指标（本来就在这，K14 改入口时被误删，补回并加固）
        recordVerb('review');
        if (code !== 0) {
          process.exitCode = code;
        }
      },
    ),
  );

// v5.0 T2：update 命令（检查 npm 最新版并升级）
program
  .command('update')
  .description(t().cli.update.description)
  .option('-y, --yes', t().cli.update.yes)
  .action(async (options: { yes?: boolean }) => {
    const { runUpdateCommand } = await import('./update');
    const code = await runUpdateCommand({ yes: options.yes ?? false });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

program
  .command('doctor')
  .description(t().cli.doctor.description)
  .option('--vscode', t().cli.doctor.vscode)
  // v5.0 T21：本地指标汇总（默认 off 时如实显示「未开启」，不冒充有数据）
  .option('--metrics', t().cli.doctor.metrics)
  .action(async (options: { vscode?: boolean; metrics?: boolean }) => {
    const { runDoctorCommand } = await import('./doctor');
    // v3.1 M3 T3.3：余额项按解析链（环境变量 > active account）标注账号
    // v3.2 M4 T4.5：走启动期缓存（同一进程内复用，消除二次读盘）
    // v5.0 K2：**补 config.json 回退** —— 缺 Key 引导的方式 ③ 写的是这个字段，
    // 若 doctor 不认它，「按引导配好 → 按引导去验证」必然得到「未设置」。
    // v5.3 N1：**诊断命令永不写盘** —— readOnly 意味着 v3 配置不会被迁移（不会生成
    // config.v3.bak、不会改写 config.json）。否则「跑一次 doctor 看环境」这件事本身
    // 会改动用户配置，且改不改取决于「有没有配 Key」（同一个命令两种行为，用户无法预期）。
    const resolved = await resolveApiKeyWithConfigFallback({ readOnly: true });
    const code = await runDoctorCommand({
      apiKey: resolved.key,
      keySource: resolved.source,
      keyAccountName: resolved.accountName,
      vscode: options.vscode,
      metrics: options.metrics === true,
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

program
  .command('login <name>')
  .description(t().cli.login.description)
  .option('--key <key>', t().cli.login.key)
  .action(async (name: string, options: { key?: string }) => {
    const { runLoginCommand } = await import('./account');
    await runLoginCommand({ name, key: options.key });
  });

program
  .command('logout <name>')
  .description(t().cli.logout.description)
  .option('--purge', t().cli.logout.purge)
  .action(async (name: string, options: { purge?: boolean }) => {
    const { runLogoutCommand } = await import('./account');
    await runLogoutCommand({ name, purge: options.purge });
  });

program
  .command('whoami')
  .description(t().cli.whoami.description)
  .action(async () => {
    const { runWhoamiCommand } = await import('./account');
    await runWhoamiCommand({});
  });

program
  .command('account <action> [name]')
  .description(t().cli.account.description)
  .action(async (action: string, name?: string) => {
    const { runAccountListCommand, runAccountSwitchCommand } = await import('./account');
    if (action === 'list') {
      await runAccountListCommand({});
      return;
    }
    if (action === 'switch') {
      await runAccountSwitchCommand({ name });
      return;
    }
    console.error(`未知 account 子命令: ${action}（支持 list / switch <name>）`);
    process.exitCode = 1;
  });

// v4.0 M2 T2.6：工作流命令族（DAG 执行引擎）
// v4.1 P0-1：包 safeAction——workflow run 内部异常（含未预期错误）不再 unhandledRejection 进 crash.log，
// 而是输出「命令执行失败 + 堆栈 + 💡 下一步」后退出（与 chat/run/plan 兜底一致）。
program
  .command('workflow <action> [param]')
  .description(t().cli.workflow.description)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(
    safeAction(async (action: string, param?: string) => {
      const { runWorkflowCli } = await import('./workflow');
      // 解析 API Key（仅 create 需要模型；失败不阻断 list/init/run/export/import）
      let client: import('../model/client').ModelClient | undefined;
      let model: string | undefined;
      if (action === 'create') {
        const { DeepSeekClient } = await import('../model/client');
        try {
          model = await resolveStartupModel();
          client = new DeepSeekClient({ apiKey: await getApiKey() });
        } catch {
          client = undefined;
        }
      }
      const code = await runWorkflowCli({
        cwd: process.cwd(),
        action,
        param,
        client,
        model,
      });
      if (code !== 0) {
        process.exitCode = code;
      }
    }),
  );

// v4.0 M4 T4.1/T4.1a/T4.5：插件命令族（install / search / list / remove / browse / recommend / popular）
program
  .command('plugin <action> [param]')
  .description(t().cli.plugin.description)
  .option('-y, --yes', t().cli.plugin.yes)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(async (action: string, param: string | undefined, options: { yes?: boolean }) => {
    const { runPluginCli } = await import('./plugin');
    const code = await runPluginCli({
      cwd: process.cwd(),
      action,
      param,
      confirm: makeCliPermissionConfirm(options.yes ?? false),
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// v4.0 M3 T3.1/T3.2b：Provider 命令族（list / auth / switch）
program
  .command('provider <action> [name]')
  .description(t().cli.provider.description)
  .option('--key <key>', t().cli.provider.key)
  .option('--verify', t().cli.provider.verify)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(
    async (
      action: string,
      name: string | undefined,
      options: { key?: string; verify?: boolean; lang?: string },
    ) => {
      const { runProviderAuth, runProviderList, runProviderSwitch } = await import('./provider');
      if (action === 'list') {
        const code = await runProviderList({});
        if (code !== 0) process.exitCode = code;
        return;
      }
      if (action === 'switch') {
        if (name === undefined) {
          console.error('用法: concertoai provider switch <name>');
          process.exitCode = 1;
          return;
        }
        const code = await runProviderSwitch({ name });
        if (code !== 0) process.exitCode = code;
        return;
      }
      if (action === 'auth') {
        if (name === undefined) {
          console.error('用法: concertoai provider auth <name> [--key <key>] [--verify]');
          process.exitCode = 1;
          return;
        }
        const code = await runProviderAuth({ name, key: options.key, verify: options.verify });
        if (code !== 0) process.exitCode = code;
        return;
      }
      console.error(`未知 provider 子命令: ${action}（支持 list / auth <name> / switch <name>）`);
      process.exitCode = 1;
    },
  );

// v4.0 M3 T3.5：config 命令族（config set provider <name> / config restore）
program
  .command('config <action> [name] [value]')
  .description(t().cli.config.description)
  .option('--lang <zh|en>', t().cli.lang.description)
  .action(async (action: string, name?: string, value?: string) => {
    const { configPath } = await import('../store/paths');
    const { copyFile, rm } = await import('node:fs/promises');
    const cfgPath = configPath();
    if (action === 'set' && name === 'provider') {
      if (value === undefined) {
        console.error('用法: concertoai config set provider <name>');
        process.exitCode = 1;
        return;
      }
      const { runProviderSwitch } = await import('./provider');
      const code = await runProviderSwitch({ name: value });
      if (code !== 0) process.exitCode = code;
      return;
    }
    if (action === 'restore') {
      // 从 config.v3.bak 回滚（M3 T3.5）
      const bak = `${cfgPath}.v3.bak`;
      try {
        await copyFile(bak, cfgPath);
        await rm(bak, { force: true });
        console.log('✅ 已从 config.v3.bak 回滚配置（v3 格式恢复）。');
        return;
      } catch (err) {
        console.error(
          `❌ config restore 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
        return;
      }
    }
    // v5.0 T10/T11/T12：枚举类配置写入（拒绝提示里承诺的 `config set reflections off`
    // / `config set hints off` 必须真能用——提示里的话是承诺，不能是空头支票）
    const {
      isApprovalInsightMode,
      isHintsMode,
      isMetricsMode,
      isReflectionsMode,
      loadConfig,
      writeConfig,
    } = await import('../store/config');
    // v5.0 T21：`metrics` 也进枚举表——`/metrics on` 的回执里承诺了这条命令，必须真能用
    const enumKeys = ['approvalInsight', 'reflections', 'hints', 'metrics'] as const;
    if (action === 'set' && name !== undefined && (enumKeys as readonly string[]).includes(name)) {
      const acceptsOnOff = name === 'reflections' || name === 'hints' || name === 'metrics';
      const expected = acceptsOnOff ? 'on | off' : 'rich | plain';
      if (value === undefined) {
        console.error(`用法: concertoai config set ${name} <${expected}>`);
        process.exitCode = 1;
        return;
      }
      const valid =
        name === 'reflections'
          ? isReflectionsMode(value)
          : name === 'hints'
            ? isHintsMode(value)
            : name === 'metrics'
              ? isMetricsMode(value)
              : isApprovalInsightMode(value);
      if (!valid) {
        // 非法值 fail-closed：宁可报错让用户改，也不写入一个「看起来设了但无效」的值
        console.error(`❌ ${name} 仅接受 ${expected}，收到: ${value}`);
        process.exitCode = 1;
        return;
      }
      const cfg = await loadConfig(cfgPath);
      const next = { ...cfg, [name]: value };
      await writeConfig(next, cfgPath);
      if (name === 'reflections') {
        console.log(
          value === 'off'
            ? '✅ 已关闭拒绝复盘记录（拒绝照常工作，只是不再写记录）。'
            : '✅ 已开启拒绝复盘记录（本地 JSONL，零上传）。',
        );
      } else if (name === 'hints') {
        console.log(
          value === 'off'
            ? '✅ 已关闭场景提示（chat 内 /hints off 也可即时静音本次会话）。'
            : '✅ 已开启场景提示（默认即开启；每会话最多 3 条，10 分钟冷却）。',
        );
      } else if (name === 'metrics') {
        console.log(
          value === 'off'
            ? '✅ 已关闭本地指标（已有的 metrics.jsonl 不会被删除；需要清空请用 chat 内 /metrics clear）。'
            : '✅ 已开启本地指标（只写 ~/.concertoai/metrics.jsonl，零上传；汇总：concertoai doctor --metrics）。',
        );
      } else {
        console.log(
          value === 'plain'
            ? '✅ 审批卡已切回 v4.1.1 原貌（plain）。'
            : '✅ 审批卡已启用风险教学卡（rich）。',
        );
      }
      return;
    }
    console.error(
      '用法: concertoai config set provider <name> | config set approvalInsight <rich|plain> | config set reflections <on|off> | config set hints <on|off> | config set metrics <on|off> | config restore',
    );
    process.exitCode = 1;
  });

// ═══ v5.0 C1：commander 错误的唯一 catch 点（配置本身在文件上部，见那里的说明） ═══

/**
 * commander 错误出口（C1 的唯一 catch 点）。
 *
 * 三条硬纪律：
 * - **只吞 commander 的错**：非 commander 形态原样上抛（程序 bug 不许伪装成「你参数写错了」）；
 * - **退出码原样透传**：`--version` / `--help` 仍是 0，各类报错仍是 1（`exitOverride` 后最容易坏的就是这个）；
 * - **`text` 为空就不打印**：help / version 已由 commander 自己输出，补一句就是噪音。
 */
function reportCommanderError(error: unknown): void {
  if (!isCommanderErrorShape(error)) {
    throw error;
  }
  const rendered = renderCliError(error, {
    commandNames: program.commands.flatMap((command) =>
      [command.name(), command.alias()].filter((name): name is string => typeof name === 'string'),
    ),
    // 只取顶层长选项：子命令选项不在此列（给不出可信候选时宁可说「查看用法」，
    // 也不能建议一个当前命令不接受的选项），理由见 cli-errors.ts 模块头注释。
    optionFlags: program.options
      .map((option) => option.long)
      .filter((flag): flag is string => typeof flag === 'string'),
  });
  if (rendered.text !== '') {
    process.stderr.write(`${rendered.text}\n`);
  }
  process.exitCode = rendered.exitCode;
}

try {
  program.parse();
} catch (error) {
  reportCommanderError(error);
}
