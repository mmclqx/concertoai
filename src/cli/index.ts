#!/usr/bin/env node
/**
 * Lumen CLI 入口：lumen chat / lumen run "任务"。
 */

import { Command } from 'commander';

import { zh } from '../i18n/zh';
import { VERSION } from '../index';
import { runChat } from './chat';
import { runTask } from './run';

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (key === undefined || key === '') {
    console.error(zh.errors.noApiKey);
    process.exit(1);
  }
  return key;
}

const program = new Command();

program.name('lumen').description(zh.cli.description).version(VERSION);

// 无子命令时默认进入 chat（产品定位：cd 项目 && lumen）
program.action(() => {
  void runChat({
    cwd: process.cwd(),
    apiKey: getApiKey(),
  });
});

program
  .command('chat')
  .description(zh.cli.chat.description)
  .option('-r, --resume <id>', zh.cli.resume.argument)
  .option('-m, --model <id>', zh.cli.model.description)
  .action(async (options: { resume?: string; model?: string }) => {
    await runChat({
      cwd: process.cwd(),
      apiKey: getApiKey(),
      resume: options.resume,
      model: options.model,
    });
  });

program
  .command('run <task>')
  .description(zh.cli.run.description)
  .option('-m, --model <id>', zh.cli.model.description)
  .option('--auto-approve', '自动批准编辑与命令执行（谨慎使用；默认全部拒绝）')
  .action(async (task: string, options: { model?: string; autoApprove?: boolean }) => {
    await runTask({
      cwd: process.cwd(),
      apiKey: getApiKey(),
      task,
      model: options.model,
      autoApprove: options.autoApprove ?? false,
    });
  });

program.parse();
