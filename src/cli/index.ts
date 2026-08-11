#!/usr/bin/env node
/**
 * ConcertoAI CLI 入口：concertoai chat / concertoai run "任务"。
 */

import { Command } from 'commander';
import { t } from '../i18n';
import { crashLogPath, migrateLegacyHome } from '../store/paths';
import { VERSION } from '../version';
import { resolveApiKeyCached } from './common';
import { installCrashHandlers } from './crash-handler';

// ═══ 最早阶段：安装全局崩溃处理器（v3.1 M3 诊断） ═══
// 必须在任何异步操作前安装，确保 uncaughtException / unhandledRejection
// 都能被捕获并写入 ~/.concertoai/crash.log，防止"静默退出"。
installCrashHandlers();

// 启动时自动迁移旧配置目录（~/.lumen → ~/.concertoai，v3.1 起）。
// 幂等：~/.lumen 不存在或 ~/.concertoai 已存在时无操作。
migrateLegacyHome((message) => console.error(message));

/**
 * 解析 API Key（v3.1 M3 T3.3）：CLI > 环境变量 > active account > config.json。
 * 无任何来源 → 报错退出（fail-closed，与现状一致）。
 */
async function getApiKey(): Promise<string> {
  // v3.2 M4 / T4.5：启动期一次性解析并缓存（同一进程后续命令复用，消除重复读盘）
  const resolved = await resolveApiKeyCached();
  if (resolved.key === undefined) {
    console.error(t().errors.noApiKey);
    process.exit(1);
  }
  return resolved.key;
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

const program = new Command();

program.name('concertoai').description(t().cli.description).version(VERSION);

// v3.1 M2 T2.3：全局 `-p, --project <name>` —— 启动前校验项目存在并 chdir 到项目路径
// （等价 cd 后启动）。preAction hook 在任意子命令 action 前执行，保证 chat/run/plan 等
// 都以项目路径为 cwd 装配。未注册项目 → 报错退出（fail-closed）。
program.option('-p, --project <name>', '按已注册项目启动（等价 cd 到项目目录）');
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
function safeAction(fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      process.stderr.write(`\n[ConcertoAI] 命令执行失败: ${msg}\n`);
      if (stack !== undefined) {
        process.stderr.write(`${stack}\n`);
      }
      process.stderr.write(`详情见 ${crashLogPath()}\n`);
      process.exit(1);
    });
  };
}

// 无子命令时默认进入 chat（产品定位：cd 项目 && concertoai）
program.action(
  safeAction(async () => {
    // 动态导入（v2.1 性能优化）：启动阶段只加载 commander + i18n，
    // TUI 依赖树（ink/react/ui/mcp/skill）在用户真正进入交互后才加载。
    const { runChat } = await import('./chat');
    const model = await resolveStartupModel();
    await runChat({
      cwd: process.cwd(),
      apiKey: await getApiKey(),
      model,
    });
  }),
);

program
  .command('chat')
  .description(t().cli.chat.description)
  .option('-r, --resume [id]', t().cli.resume.argument)
  .option('-l, --list', t().cli.list.description)
  .option('-m, --model <id>', t().cli.model.description)
  .action(
    async (options: { resume?: string | true; model?: string; list?: boolean; lang?: string }) => {
      const { runChat } = await import('./chat');
      // -l 仅列会话：不需要模型，跳过高峰切换（避免 ask 策略阻塞）
      const model =
        options.list === true ? options.model : await resolveStartupModel(options.model);
      await runChat({
        cwd: process.cwd(),
        apiKey: await getApiKey(),
        resume: options.resume,
        model,
        listOnly: options.list,
        lang: options.lang,
      });
    },
  );

program
  .command('run <task>')
  .description(t().cli.run.description)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--auto-approve', '自动批准编辑与命令执行（谨慎使用；默认全部拒绝）')
  .option('--lang <zh|en>', '界面语言')
  .action(
    async (task: string, options: { model?: string; autoApprove?: boolean; lang?: string }) => {
      const { runTask } = await import('./run');
      await runTask({
        cwd: process.cwd(),
        apiKey: await getApiKey(),
        task,
        model: options.model,
        autoApprove: options.autoApprove ?? false,
        lang: options.lang,
      });
    },
  );

program
  .command('plan <task>')
  .description(t().cli.plan.description)
  .option('-m, --model <id>', t().cli.model.description)
  .option('--auto-approve', '自动批准计划与编辑/命令执行（谨慎使用）')
  .option('--lang <zh|en>', '界面语言')
  .action(
    async (task: string, options: { model?: string; autoApprove?: boolean; lang?: string }) => {
      const { runPlan } = await import('./plan');
      await runPlan({
        cwd: process.cwd(),
        apiKey: await getApiKey(),
        task,
        model: options.model,
        autoApprove: options.autoApprove ?? false,
        lang: options.lang,
      });
    },
  );

program
  .command('snapshot')
  .description('管理多文件事务快照（T3.6）')
  .argument('[action]', 'list | clean（默认 list）')
  .option('--lang <zh|en>', '界面语言')
  .action(async (action?: string) => {
    const { runSnapshotCommand } = await import('./snapshot');
    await runSnapshotCommand({ cwd: process.cwd(), action });
  });

program
  .command('project <action> [name] [path]')
  .description('多项目管理（v3.1 M2）：project add/list/remove/info')
  .option('--lang <zh|en>', '界面语言')
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
  .description(
    'Orchestrator 团队执行（v3.1 M5）：拆解需求 → 对抗性闭环（Architect/Coder/Reviewer/QA）→ 事务回滚兜底',
  )
  .option('-m, --model <id>', t().cli.model.description)
  .option('--dry-run', '仅输出拆解清单，不执行任何 Agent')
  .option('--auto-approve', '自动批准拆解方案与代码写盘（谨慎使用；默认全部审批）')
  .option('--lang <zh|en>', '界面语言')
  .action(
    async (
      task: string,
      options: { model?: string; dryRun?: boolean; autoApprove?: boolean; lang?: string },
    ) => {
      const { runTeamCommand, formatTeamProgress } = await import('./team');
      const result = await runTeamCommand({
        cwd: process.cwd(),
        apiKey: await getApiKey(),
        task,
        model: options.model,
        dryRun: options.dryRun,
        autoApprove: options.autoApprove ?? false,
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
  .command('self-heal')
  .description('AI 自我修复闭环（v3.1 M1）：执行 npm run verify，失败自动分类→修复→验证→回滚')
  .option('-m, --model <id>', t().cli.model.description)
  .option('--auto-approve', '自动批准模型修复（谨慎使用；默认全部拒绝）')
  .option('--lang <zh|en>', '界面语言')
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
  .description('审计日志（v3.1 M5）：audit export [--out <file>] 导出保序 JSON')
  .option('--out <file>', '导出目标文件（缺省打印 stdout）')
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

program
  .command('doctor')
  .description(t().cli.doctor.description)
  .action(async () => {
    const { runDoctorCommand } = await import('./doctor');
    // v3.1 M3 T3.3：余额项按解析链（环境变量 > active account）标注账号
    // v3.2 M4 T4.5：走启动期缓存（getApiKey 已解析过则复用，消除二次读盘）
    const resolved = await resolveApiKeyCached();
    const code = await runDoctorCommand({
      apiKey: resolved.key,
      keySource: resolved.source,
      keyAccountName: resolved.accountName,
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

program
  .command('login <name>')
  .description('登录账号（v3.1 M3）：交互输入 API Key 不回显；--key 非交互注入')
  .option('--key <key>', '非交互注入 API Key（CI 场景）')
  .action(async (name: string, options: { key?: string }) => {
    const { runLoginCommand } = await import('./account');
    await runLoginCommand({ name, key: options.key });
  });

program
  .command('logout <name>')
  .description('登出账号（v3.1 M3）：清除 active 指针；--purge 删除账号文件')
  .option('--purge', '同时删除账号目录（含 Key 配置）')
  .action(async (name: string, options: { purge?: boolean }) => {
    const { runLogoutCommand } = await import('./account');
    await runLogoutCommand({ name, purge: options.purge });
  });

program
  .command('whoami')
  .description('显示当前账号（v3.1 M3）：账号名 + Key 后 4 位（打码）')
  .action(async () => {
    const { runWhoamiCommand } = await import('./account');
    await runWhoamiCommand({});
  });

program
  .command('account <action> [name]')
  .description('账号管理（v3.1 M3）：account list / switch <name>')
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

program.parse();
