import { Text } from 'ink';

import { zh } from '../i18n/zh';
import { renderMarkdownToAnsi } from './markdown';
import { Spinner } from './Spinner';

export interface StreamingViewProps {
  text: string;
}

/**
 * 流式回复渲染：markdown → ANSI 增量渲染（标题/列表/加粗/行内码/代码块高亮）。
 * 纯 ANSI 字符串输出（ink 原样保留转义序列），无 DOM、无 React 树开销。
 */
export function StreamingView({ text }: StreamingViewProps) {
  if (text === '') {
    return <Spinner text={zh.ui.thinking} />;
  }
  return <Text>{renderMarkdownToAnsi(text)}</Text>;
}
