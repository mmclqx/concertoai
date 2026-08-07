import { Box, Text } from 'ink';

import { zh } from '../i18n/zh';

export interface StatusBarProps {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** 状态条：模型名 + 输入/输出 token 估算 + 成本（元）。 */
export function StatusBar({ model, inputTokens, outputTokens, cost }: StatusBarProps) {
  return (
    <Box>
      <Text dimColor>
        {zh.status.model}: {model} │ {zh.status.tokens}: {inputTokens}/{outputTokens} │{' '}
        {zh.status.cost}: ¥{cost.toFixed(4)}
        {zh.status.yuan}
      </Text>
    </Box>
  );
}
