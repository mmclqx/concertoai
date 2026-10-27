/**
 * 模型斜杠命令处理器：`/model`（v5.0 T6）。
 *
 * 子命令：
 * - `/model`                 → 显示当前模型 + 当前时段单价 + auto 状态
 * - `/model auto`            → 启用 auto 预设（起始默认档 + 打印成本策略说明）
 * - `/model <modelId>`       → 手动切换（**升级方向需确认**，降级方向直接生效）
 * - `/model list`            → 列出可用模型与当前时段单价
 *
 * ## 安全边界（与 `src/model/auto.ts` 一致，勿破坏）
 * - **不存在任何自动切换路径**：本模块只处理用户显式输入；`auto` 也只设初值。
 * - 变贵的切换必须确认，非 TTY（或确认回调缺失）一律 fail-closed 拒绝。
 * - 只对 deepseek 生效：本地/其他 Provider 的模型不在价格表内，切换无意义 → 明确拒绝并说明。
 */

import type { ChatMessage } from '../../loop/types';
import {
  AUTO_MODEL,
  buildAutoPolicyGuide,
  buildUpgradeHint,
  isAutoModel,
  normalizeModelValue,
  quoteSwitch,
  resolveAutoStartModel,
  switchDirection,
} from '../../model/auto';
import { getModel, listModels, priceFor, priceTierFor, tierLabel } from '../../model/models';

/** 解析后的 /model 命令。 */
export type SlashModelCommand =
  | { type: 'status' }
  | { type: 'list' }
  | { type: 'auto' }
  | { type: 'switch'; modelId: string }
  | { type: 'unknown'; message: string };

/** 解析 /model 命令；非 /model 输入返回 null。 */
export function parseModelCommand(input: string): SlashModelCommand | null {
  const trimmed = input.trim();
  if (trimmed !== '/model' && !trimmed.startsWith('/model ')) {
    return null;
  }
  const rest = trimmed.slice('/model'.length).trim();
  if (rest === '') {
    return { type: 'status' };
  }
  if (rest === 'list') {
    return { type: 'list' };
  }
  if (isAutoModel(rest)) {
    return { type: 'auto' };
  }
  const modelId = normalizeModelValue(rest);
  if (modelId === undefined) {
    return {
      type: 'unknown',
      message: `未知模型：${rest}（可用：${listModels()
        .map((m) => m.id)
        .join(' / ')} / ${AUTO_MODEL}）`,
    };
  }
  return { type: 'switch', modelId };
}

// ── 执行 ──

/** 执行环境（App 注入；测试可完全替换）。 */
export interface ModelCommandContext {
  /** 当前模型 ID。 */
  currentModel: string;
  /** 当前 Provider 名（非 deepseek 时拒绝切换）。 */
  providerName: string;
  /** 确认回调（升级方向调用；返回 false = 不切换）。 */
  confirm: (question: string) => Promise<boolean>;
  /** 当前时刻（测试注入）。 */
  at?: Date;
}

/** 执行结果。 */
export interface ModelCommandResult {
  /** 是否由本命令处理（false = 不拦截，继续走普通对话）。 */
  handled: boolean;
  /** 回显消息。 */
  message?: ChatMessage;
  /** 切换后的模型 ID（未切换为 undefined，由 App 更新状态）。 */
  nextModel?: string;
}

/** 拼接消息的便捷函数。 */
function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

/** 当前模型状态文本。 */
function statusText(currentModel: string, at: Date): string {
  const tier = priceTierFor(at);
  const profile = getModel(currentModel);
  if (profile === undefined) {
    return [
      `🤖 当前模型：${currentModel}（不在 DeepSeek 价格表内，按本地/第三方模型处理，成本显示 0）`,
      '提示：/model list 查看 DeepSeek 可用模型。',
    ].join('\n');
  }
  const price = priceFor(currentModel, tier);
  const lines = [
    `🤖 当前模型：${profile.label}（${profile.id}）`,
    `   当前时段：${tierLabel(tier)}（输入 ¥${price.input}/百万 · 输出 ¥${price.output}/百万 · 缓存命中 ¥${price.cacheHit}/百万）`,
    `   上下文窗口：${profile.contextWindow.toLocaleString('en-US')} tokens · 并发限制：${profile.rateLimit}`,
  ];
  // 有更强档时给「提示」（不是切换）：只说清成本倍数，动作始终由用户发起
  const hint = buildUpgradeHint(currentModel, at);
  if (hint !== undefined) {
    lines.push(`   ${hint}`);
  }
  lines.push('用法：/model auto（自动预设）· /model list（模型列表）· /model <id>（手动切换）');
  return lines.join('\n');
}

/** 模型列表文本。 */
function listText(currentModel: string, at: Date): string {
  const tier = priceTierFor(at);
  const lines = [`📋 可用模型（当前时段：${tierLabel(tier)}）`, ''];
  for (const model of listModels()) {
    const price = priceFor(model.id, tier);
    const mark = model.id === currentModel ? ' ← 当前' : '';
    lines.push(
      `- ${model.label}（${model.id}）${mark}\n    输入 ¥${price.input}/百万 · 输出 ¥${price.output}/百万 · 缓存命中 ¥${price.cacheHit}/百万`,
    );
  }
  lines.push(
    '',
    `另：/model ${AUTO_MODEL}（自动预设，默认 ${resolveAutoStartModel()}，不会自动升级）`,
  );
  return lines.join('\n');
}

/**
 * 执行 /model 命令。
 *
 * 切换逻辑：
 * - same    → 提示已是当前模型，不重复切换；
 * - downgrade → 直接切换（省钱方向，无需确认）+ 回显省了多少；
 * - upgrade → **先展示成本对比再确认**；确认回调抛错/超时/返回 false → 保持原模型（fail-closed）。
 */
export async function executeModelCommand(
  cmd: SlashModelCommand,
  ctx: ModelCommandContext,
): Promise<ModelCommandResult> {
  const at = ctx.at ?? new Date();

  if (cmd.type === 'unknown') {
    return { handled: true, message: assistant(`❌ ${cmd.message}`) };
  }
  if (cmd.type === 'status') {
    return { handled: true, message: assistant(statusText(ctx.currentModel, at)) };
  }
  if (cmd.type === 'list') {
    return { handled: true, message: assistant(listText(ctx.currentModel, at)) };
  }
  if (cmd.type === 'auto') {
    const lines = buildAutoPolicyGuide(at);
    return {
      handled: true,
      message: assistant(lines.join('\n')),
      nextModel: resolveAutoStartModel(),
    };
  }

  // switch
  const target = cmd.modelId;
  if (ctx.providerName !== 'deepseek') {
    return {
      handled: true,
      message: assistant(
        `⚠️ 当前 Provider 是 ${ctx.providerName}，/model 仅支持 DeepSeek 模型切换。\n如需切换 Provider，请用 \`concertoai provider switch <name>\`。`,
      ),
    };
  }
  const direction = switchDirection(ctx.currentModel, target);
  const targetProfile = getModel(target);
  const label = targetProfile?.label ?? target;

  if (direction === 'same') {
    return {
      handled: true,
      message: assistant(`ℹ️ 当前已是 ${label}，无需切换。`),
    };
  }

  const quote = quoteSwitch(ctx.currentModel, target, at);
  const costLine = `成本对比（同一示例用量，${tierLabel(quote.tier)}）：现在 ¥${quote.fromCost.toFixed(4)} → ${label} ¥${quote.toCost.toFixed(4)}（约 ${quote.ratio.toFixed(1)} 倍）`;

  if (direction === 'downgrade') {
    return {
      handled: true,
      nextModel: target,
      message: assistant(
        `✅ 已切换到 ${label}（省钱方向，直接生效）\n${costLine}\n提示：能力下降时可随时 /model ${ctx.currentModel} 切回。`,
      ),
    };
  }

  // upgrade：先给成本对比，再确认
  let confirmed = false;
  try {
    confirmed = await ctx.confirm(`即将切换到更贵的模型 ${label}。\n${costLine}\n是否继续？`);
  } catch {
    confirmed = false; // 确认过程异常 → fail-closed
  }
  if (!confirmed) {
    return {
      handled: true,
      message: assistant(
        `已取消切换，继续使用 ${getModel(ctx.currentModel)?.label ?? ctx.currentModel}。\n${costLine}`,
      ),
    };
  }
  return {
    handled: true,
    nextModel: target,
    message: assistant(
      `✅ 已切换到 ${label}\n${costLine}\n提示：能力富余时可 /model ${ctx.currentModel} 切回省钱。`,
    ),
  };
}
