#!/usr/bin/env node
/**
 * ConcertoAI CLI 入口：concertoai chat / concertoai run "任务"。
 */

import { Command } from 'commander';

import { t } from '../i18n';
import { migrateLegacyHome } from '../store/paths';
import { VERSION } from '../version';

// 启动时自动迁移旧配置目录（~/.lumen → ~/.concertoai，v3.1 起）。
// 幂等：~/.lumen 不存在或 ~/.concertoai 已存在时无操作。
migrateLegacyHome((message) => console.error(message));

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (key === undefined || key === '') {
    console.error(t().errors.noApiKey);
    process.exit(1);
  }
  return key;
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

// 无子命令时默认进入 chat（产品定位：cd 项目 && concertoai）
program.action(() => {
  // 动态导入（v2.1 性能优化）：启动阶段只加载 commander + i18n，
  // TUI 依赖树（ink/react/ui/mcp/skill）在用户真正进入交互后才加载。
  void import('./chat').then(async ({ runChat }) => {
    const model = await resolveStartupModel();
    void runChat({
      cwd: process.cwd(),
      apiKey: getApiKey(),
      model,
    });
  });
});

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
        apiKey: getApiKey(),
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
        apiKey: getApiKey(),
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
        apiKey: getApiKey(),
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
      action: action as 'add' | 'list' | 'remove' | 'info',
      name,
      path: p,
    });
  });

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
      apiKey: getApiKey(),
      model: options.model,
      autoApprove: options.autoApprove ?? false,
      lang: options.lang,
    });
  });

program
  .command('balance')
  .description(t().cli.balance.description)
  .action(async () => {
    const { runBalanceCommand } = await import('./balance');
    const code = await runBalanceCommand({ apiKey: getApiKey() });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

program
  .command('doctor')
  .description(t().cli.doctor.description)
  .action(async () => {
    const { runDoctorCommand } = await import('./doctor');
    const code = await runDoctorCommand({ apiKey: process.env.DEEPSEEK_API_KEY });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

program.parse();
