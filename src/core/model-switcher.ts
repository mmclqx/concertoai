/**
 * 高峰时段模型自动切换器（v2.2 智能成本控制）。
 *
 * 决策逻辑（applyPeakStrategy，纯函数可测试）：
 * - 非高峰时段（非工作日或非高峰小时）→ 保持主模型，不打扰；
 * - 策略 `ask`：交互环境提示用户确认（y=切换本地模型 / n=保持主模型），
 *   非交互环境跳过切换并提示；
 * - 策略 `switch`：直接切换到本地模型（ollamaModel）；
 * - 策略 `ignore`：忽略切换，始终使用主模型。
 *
 * 配置入口（maybeSwitchModel）：读取 ~/.concertoai/config.json 的
 * peakTimeStrategy / ollamaModel / ollamaBaseUrl（经 resolveConfig 合并默认值），
 * 供 CLI 启动流程调用。
 *
 * 说明：本地模型 ID 不在 DeepSeek 模型表中（无计费/上下文窗），
 * 由 chat 装配层识别后按 ollamaBaseUrl 构建客户端、成本按 0 展示。
 */

import { createInterface } from 'node:readline';

import { fmt, t } from '../i18n';
import { getDefaultModel } from '../model/models';
import {
  type ConcertoAIConfig,
  loadConfig,
  type PeakTimeStrategy,
  resolveConfig,
} from '../store/config';
import { isPeakTime } from './peak-time';

/** 切换器输入（applyPeakStrategy，纯决策所需全部参数）。 */
export interface PeakSwitchOptions {
  /** 当前主模型 ID（CLI -m / 配置 defaultModel 解析后的模型）。 */
  currentModel: string;
  /** 高峰时段策略：ask / switch / ignore。 */
  strategy: PeakTimeStrategy;
  /** 本地模型 ID（ollamaModel）。 */
  ollamaModel: string;
  /** 本地模型 OpenAI 兼容端点（ollamaBaseUrl）。 */
  ollamaBaseUrl: string;
  /** 是否为交互式终端（ask 策略是否可提问；缺省 false）。 */
  interactive?: boolean;
  /** 确认提问实现（测试注入；缺省用 readline 读 stdin）。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 当前时间（测试注入；缺省 new Date()）。 */
  now?: Date;
  /** 输出实现（测试注入；缺省 console.log）。 */
  log?: (message: string) => void;
}

/** 切换结果：最终生效模型 + 是否发生了切换 + 提示信息。 */
export interface PeakSwitchResult {
  /** 最终生效的模型 ID。 */
  model: string;
  /** 是否从主模型切换到了本地模型。 */
  switched: boolean;
  /** 已输出的提示信息（测试断言用）。 */
  message?: string;
}

/** 默认确认实现：stdin/stdout 提问，`y`/`yes` 视为同意，其余（含直接回车）拒绝。 */
async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(`${question} [y/N] `, (answer) => {
        resolve(/^(y|yes)$/i.test(answer.trim()));
      });
    });
  } finally {
    rl.close();
  }
}

/**
 * 应用高峰时段切换策略（纯决策，不读取文件）。
 *
 * 返回最终模型 ID 与是否切换；消息经 log() 输出（缺省 console.log）。
 */
export async function applyPeakStrategy(options: PeakSwitchOptions): Promise<PeakSwitchResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const dict = t().peakTime;

  // 非高峰时段：保持主模型，不打扰
  if (!isPeakTime(options.now)) {
    return { model: options.currentModel, switched: false };
  }

  switch (options.strategy) {
    case 'switch': {
      const message = fmt(dict.switched, {
        model: options.ollamaModel,
        baseUrl: options.ollamaBaseUrl,
      });
      log(message);
      return { model: options.ollamaModel, switched: true, message };
    }
    case 'ignore': {
      const message = fmt(dict.ignored, { model: options.currentModel });
      log(message);
      return { model: options.currentModel, switched: false, message };
    }
    case 'ask': {
      if (options.interactive !== true) {
        const message = fmt(dict.noInteractive, { model: options.currentModel });
        log(message);
        return { model: options.currentModel, switched: false, message };
      }
      const question = fmt(dict.askSwitch, {
        model: options.ollamaModel,
        baseUrl: options.ollamaBaseUrl,
      });
      const confirmed = await (options.confirm ?? defaultConfirm)(question);
      if (confirmed) {
        const message = fmt(dict.switched, {
          model: options.ollamaModel,
          baseUrl: options.ollamaBaseUrl,
        });
        log(message);
        return { model: options.ollamaModel, switched: true, message };
      }
      const message = fmt(dict.declined, { model: options.currentModel });
      log(message);
      return { model: options.currentModel, switched: false, message };
    }
    default: {
      // 防御：未知策略按 ignore 处理（保持主模型）
      return { model: options.currentModel, switched: false };
    }
  }
}

/** maybeSwitchModel 输入：CLI 启动流程的调用参数。 */
export interface MaybeSwitchModelOptions {
  /** CLI -m 显式模型（优先于配置 defaultModel）。 */
  cliModel?: string;
  /** 是否为交互式终端（决定 ask 策略是否可提问）。 */
  interactive?: boolean;
  /** 测试注入：配置对象（缺省 loadConfig() 读取 ~/.concertoai/config.json）。 */
  config?: ConcertoAIConfig;
  /** 确认提问实现（测试注入）。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 当前时间（测试注入）。 */
  now?: Date;
  /** 输出实现（测试注入）。 */
  log?: (message: string) => void;
}

/**
 * 配置感知的切换入口：读取配置（peakTimeStrategy / ollamaModel / ollamaBaseUrl），
 * 解析主模型后应用策略。返回最终生效模型。
 */
export async function maybeSwitchModel(
  options: MaybeSwitchModelOptions = {},
): Promise<PeakSwitchResult> {
  const config = options.config ?? (await loadConfig());
  const resolved = resolveConfig(config, options.cliModel);
  const currentModel = resolved.model ?? getDefaultModel().id;
  return applyPeakStrategy({
    currentModel,
    strategy: resolved.peakTimeStrategy,
    ollamaModel: resolved.ollamaModel,
    ollamaBaseUrl: resolved.ollamaBaseUrl,
    interactive: options.interactive,
    confirm: options.confirm,
    now: options.now,
    log: options.log,
  });
}
