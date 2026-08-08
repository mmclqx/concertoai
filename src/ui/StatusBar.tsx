import { Box, Text } from 'ink';

import { t } from '../i18n';

export interface StatusBarProps {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** token 数是否为 API 真实 usage（false = 估算值，流式中途展示）。 */
  isReal?: boolean;
  /** 缓存命中 token 数（> 0 时显示缓存命中行）。 */
  cacheHitTokens?: number;
  /** 缓存命中 token 成本（元）。 */
  cacheHitCost?: number;
  /** MCP 服务连接状态摘要（如 "2/3 服务"），不传则不显示。 */
  mcpStatus?: string;
}

/** 状态条：模型名 + 输入/输出 token + 缓存命中 + 成本（元）。真实 usage 到达后显示真实值并标记。 */
export function StatusBar({
  model,
  inputTokens,
  outputTokens,
  cost,
  isReal = false,
  cacheHitTokens = 0,
  cacheHitCost = 0,
  mcpStatus,
}: StatusBarProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {t().status.model}: {model} │ {t().status.tokens}: {inputTokens}/{outputTokens}
          {isReal ? `（${t().status.real}）` : ''} │ {t().status.cost}: ¥{cost.toFixed(4)}
          {t().status.yuan}
          {mcpStatus !== undefined ? ` │ 🔌 ${mcpStatus}` : ''}
        </Text>
      </Box>
      {cacheHitTokens > 0 && (
        <Box>
          <Text dimColor>
            💾 {t().status.cacheHit}: {cacheHitTokens} token（约 ¥{cacheHitCost.toFixed(4)}）
          </Text>
        </Box>
      )}
    </Box>
  );
}
