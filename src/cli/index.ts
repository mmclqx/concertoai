#!/usr/bin/env node
/**
 * Lumen CLI 入口：lumen chat / lumen run "任务"。
 */

import { Command } from 'commander';

import { t } from '../i18n';
import { VERSION } from '../version';

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (key === undefined || key === '') {
    console.error(t().errors.noApiKey);
    process.exit(1);
  }
  return key;
}

const program = new Command();

program.name('lumen').description(t().cli.description).version(VERSION);

// 无子命令时默认进入 chat（产品定位：cd 项目 && lumen）
program.action(() => {
  // 动态导入（v2.1 性能优化）：启动阶段只加载 commander + i18n，
  // TUI 依赖树（ink/react/ui/mcp/skill）在用户真正进入交互后才加载。
  void import('./chat').then(({ runChat }) => {
    void runChat({
      cwd: process.cwd(),
      apiKey: getApiKey(),
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
      await runChat({
        cwd: process.cwd(),
        apiKey: getApiKey(),
        resume: options.resume,
        model: options.model,
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

program.parse();
