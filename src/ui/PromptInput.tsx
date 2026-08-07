import { Box, Text, useInput } from 'ink';

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** 仅当 active 时处理按键（idle 态）；流式/审批期间忽略输入。 */
  active: boolean;
}

/**
 * 多行输入框：Enter 发送、Shift+Enter 换行、Backspace/Delete 删除末尾字符。
 * 注：v0.1 不实现光标移动（v0.2 增强）。
 */
export function PromptInput({ value, onChange, onSubmit, placeholder, active }: PromptInputProps) {
  useInput((input, key) => {
    if (!active) {
      return;
    }
    if (key.return && !key.shift) {
      onSubmit(value);
      return;
    }
    if (key.return && key.shift) {
      onChange(`${value}\n`);
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (input !== '') {
      onChange(value + input);
    }
  });

  const isEmpty = value === '';
  return (
    <Box flexDirection="column">
      <Text color={isEmpty ? 'gray' : undefined}>{isEmpty ? (placeholder ?? '') : value}</Text>
    </Box>
  );
}
