/**
 * self-heal 命令：非交互执行 AI 自我修复闭环（v3.1 M1 / T1.4）。
 *
 * 流程：执行 `npm run verify` → 通过则输出「✅ verify 全部通过，无需修复」；
 * 失败则自动走 M1 闭环（分类 → 修复 → 验证 → 回滚，全程快照保护）。
 *
 * 安全基线（与 run/plan 一致）：
 * - 默认 fail-closed——模型修复审批回调未配置时一律拒绝（lint 直修仍执行）；
 * - 显式传 --auto-approve 才会自动批准模型修复；
 * - 无 TTY 时可运行（lint 直修与结构化反馈不依赖交互），
 *   需要审批的模型修复默认拒绝并转人工。
 */

import { resolveLocale, setLocale } from '../i18n';
import { type RepairVerifyResult, runSelfHeal } from '../loop/self-heal';
import { DeepSeekClient } from '../model/client';
import { loadConfig, resolveConfig } from '../store/config';
import { resolveModel } from './common';
import { formatSelfHealReport } from './slash/self-heal';

export interface RunSelfHealCommandOptions {
  cwd: string;
  apiKey: string;
  model?: string;
  /** 显式开启才自动批准模型修复（谨慎使用；默认全部拒绝）。 */
  autoApprove?: boolean;
  lang?: string;
}

/** 非交互 self-heal 入口：跑 verify → 失败走 M1 闭环 → 输出中文报告。 */
export async function runSelfHealCommand(options: RunSelfHealCommandOptions): Promise<void> {
  const config = await loadConfig();
  const resolved = resolveConfig(config, options.model, options.lang);
  setLocale(resolveLocale(resolved.locale));
  const model = resolveModel(resolved.model);
  const client = new DeepSeekClient({ apiKey: options.apiKey });

  const result: RepairVerifyResult = await runSelfHeal({
    cwd: options.cwd,
    client,
    model,
    // 非交互：未显式 --auto-approve 时模型修复默认拒绝（fail-closed）
    requestApproval: options.autoApprove === true ? async () => true : undefined,
    log: (m) => process.stderr.write(`\n${m}\n`),
  });

  process.stdout.write(`\n${formatSelfHealReport(result)}\n`);
}
