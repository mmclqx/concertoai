import { Box, Text } from 'ink';

import { t } from '../i18n';

export interface StatusBarProps {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** token 数是否为 API 真实 usage（false = 估算值，流式中途展示）。 */
  isReal?: boolean;
}

/** 状态条：模型名 + 输入/输出 token + 成本（元）。真实 usage 到达后显示真实值并标记。 */
export function StatusBar({
  model,
  inputTokens,
  outputTokens,
  cost,
  isReal = false,
}: StatusBarProps) {
  return (
    <Box>
      <Text dimColor>
        {t().status.model}: {model} │ {t().status.tokens}: {inputTokens}/{outputTokens}
        {isReal ? `（${t().status.real}）` : ''} │ {t().status.cost}: ¥{cost.toFixed(4)}
        {t().status.yuan}
      </Text>
    </Box>
  );
}
