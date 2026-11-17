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

import { fmt, t, tierLabel } from '../../i18n';
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
import { getModel, listModels, priceFor, priceTierFor } from '../../model/models';

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
      // 跨行模板串也必须走 i18n：这里原本是 `未知模型：${…}` 分三行的模板，
      // 「按行扫裸中文」的检查会整条漏掉（v5.6 实测踩过，故注释留痕）。
      message: fmt(t().modelCmd.unknownModel, {
        model: rest,
        available: `${listModels()
          .map((m) => m.id)
          .join(' / ')} / ${AUTO_MODEL}`,
      }),
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
  const c = t().modelCmd;
  if (profile === undefined) {
    return [fmt(c.statusCurrentUnknown, { model: currentModel }), c.statusUnknownHint].join('\n');
  }
  const price = priceFor(currentModel, tier);
  const lines = [
    fmt(c.statusCurrent, { label: profile.label, id: profile.id }),
    // 单位口径：`¥` 与 `tokens` 两种语言都保留原样；`/百万` ↔ `M` 才是需要本地化的「文字」，
    // 故它写在模板里而不是拼在这里（否则 en 下会出现 `¥1/百万`）。
    fmt(c.statusPrice, {
      tier: tierLabel(tier),
      input: price.input,
      output: price.output,
      cacheHit: price.cacheHit,
    }),
    fmt(c.statusWindow, {
      window: profile.contextWindow.toLocaleString('en-US'),
      rateLimit: profile.rateLimit,
    }),
  ];
  // 有更强档时给「提示」（不是切换）：只说清成本倍数，动作始终由用户发起
  const hint = buildUpgradeHint(currentModel, at);
  if (hint !== undefined) {
    lines.push(`   ${hint}`);
  }
  lines.push(c.statusUsage);
  return lines.join('\n');
}

/** 模型列表文本。 */
function listText(currentModel: string, at: Date): string {
  const tier = priceTierFor(at);
  const c = t().modelCmd;
  const lines = [fmt(c.listTitle, { tier: tierLabel(tier) }), ''];
  for (const model of listModels()) {
    const price = priceFor(model.id, tier);
    const mark = model.id === currentModel ? c.listCurrentMark : '';
    lines.push(
      fmt(c.listItem, {
        label: model.label,
        id: model.id,
        mark,
        input: price.input,
        output: price.output,
        cacheHit: price.cacheHit,
      }),
    );
  }
  lines.push('', fmt(c.listAutoNote, { auto: AUTO_MODEL, start: resolveAutoStartModel() }));
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
  const c = t().modelCmd;
  if (ctx.providerName !== 'deepseek') {
    return {
      handled: true,
      message: assistant(fmt(c.providerNotDeepseek, { provider: ctx.providerName })),
    };
  }
  const direction = switchDirection(ctx.currentModel, target);
  const targetProfile = getModel(target);
  const label = targetProfile?.label ?? target;

  if (direction === 'same') {
    return {
      handled: true,
      message: assistant(fmt(c.alreadyCurrent, { label })),
    };
  }

  const quote = quoteSwitch(ctx.currentModel, target, at);
  const costLine = fmt(c.costCompare, {
    tier: tierLabel(quote.tier),
    from: quote.fromCost.toFixed(4),
    label,
    to: quote.toCost.toFixed(4),
    ratio: quote.ratio.toFixed(1),
  });

  if (direction === 'downgrade') {
    return {
      handled: true,
      nextModel: target,
      message: assistant(
        fmt(c.switchedDowngrade, { label, cost: costLine, prev: ctx.currentModel }),
      ),
    };
  }

  // upgrade：先给成本对比，再确认
  let confirmed = false;
  try {
    confirmed = await ctx.confirm(fmt(c.confirmUpgrade, { label, cost: costLine }));
  } catch {
    confirmed = false; // 确认过程异常 → fail-closed
  }
  if (!confirmed) {
    return {
      handled: true,
      message: assistant(
        fmt(c.upgradeCancelled, {
          label: getModel(ctx.currentModel)?.label ?? ctx.currentModel,
          cost: costLine,
        }),
      ),
    };
  }
  return {
    handled: true,
    nextModel: target,
    message: assistant(fmt(c.switchedUpgrade, { label, cost: costLine, prev: ctx.currentModel })),
  };
}
