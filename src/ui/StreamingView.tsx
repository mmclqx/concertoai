import { Text } from 'ink';

import { zh } from '../i18n/zh';

export interface StreamingViewProps {
  text: string;
}

/**
 * 流式回复渲染。
 * v0.1 为纯文本（保留换行）；markdown 解析与代码高亮（cli-highlight）留 v0.2。
 */
export function StreamingView({ text }: StreamingViewProps) {
  if (text === '') {
    return <Text dimColor>{zh.ui.thinking}</Text>;
  }
  return <Text>{text}</Text>;
}
