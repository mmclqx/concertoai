/**
 * 缺 API Key 中文引导（v5.0 T1）。
 *
 * 设计要点：
 * - **纯函数**：返回行数组，不直接打印 → 便于单测 + 不同输出目标复用（stderr / doctor / 测试）；
 * - **文案与命令分离**：中文说明走 i18n（`t().missingApiKey`），命令片段跨语言一致留在本模块，
 *   避免 i18n 字典出现数组叶节点（`DeepStringify` 只允许 string 叶，见 src/i18n/index.ts）；
 * - **每种方式都真实生效**（G7 证据优先）：
 *   ① 环境变量 `DEEPSEEK_API_KEY` —— resolveApiKey 第 2 优先级；
 *   ② `concertoai login <name> --key <key>` —— 写 accounts + active 指针（第 3 优先级）；
 *   ③ `config.json` 的 `providers.deepseek.apiKey` —— 第 4 优先级（见 common.ts readConfigDeepseekKey）。
 *
 * 教训对齐：v4.1.1「preflight 自动初始化装好了但跑不通」——引导里绝不能写不生效的配置方式。
 */

import { t } from '../i18n';

/** 引导文案选项。 */
export interface MissingApiKeyGuideOptions {
  /** config.json 的实际绝对路径（展示给用户，便于直接复制打开）。 */
  configPath: string;
}

/** 环境变量配置方式的命令示例（三种 shell，跨语言一致故不进 i18n）。 */
const ENV_COMMANDS = [
  '   PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."',
  '   cmd.exe:     set DEEPSEEK_API_KEY=sk-...',
  '   bash/zsh:    export DEEPSEEK_API_KEY=sk-...',
];

/** 获取 API Key 的官方地址（DeepSeek 平台）。 */
export const API_KEY_URL = 'https://platform.deepseek.com/api_keys';

/**
 * 构建缺 Key 引导（返回行数组，调用方负责输出到 stderr 并退出）。
 *
 * 结构：标题 → 三种方式 → 获取地址 → 下一步验证。
 * 行数控制在 ~16 行内（避免\"输出淹没\"，AGENTS 边缘路径规范）。
 */
export function buildMissingApiKeyGuide(options: MissingApiKeyGuideOptions): string[] {
  const d = t().missingApiKey;
  return [
    d.title,
    '',
    d.intro,
    '',
    `  ${d.envTitle}`,
    ...ENV_COMMANDS,
    '',
    `  ${d.accountTitle}`,
    '   concertoai login myname --key sk-...',
    `   ${d.accountHint}`,
    '',
    `  ${d.configTitle}`,
    `   ${options.configPath}`,
    '   { "providers": { "deepseek": { "apiKey": "sk-..." } } }',
    '',
    `${d.getKeyLabel} ${API_KEY_URL}`,
    '',
    d.nextStep,
  ];
}
