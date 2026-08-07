import { Box, Text, useInput } from 'ink';

import { useRef, useState } from 'react';

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** 仅当 active 时处理按键（idle 态）；流式/审批期间忽略输入。 */
  active: boolean;
}

/** 历史记录条数上限。 */
const HISTORY_LIMIT = 50;
/** ANSI 反显（reverse video）标记光标处字符。 */
const REVERSE_ON = '\u001b[7m';
const REVERSE_OFF = '\u001b[27m';

/** 把光标位置渲染为反显标记；位置越界时收敛到边界，末尾显示反显空格。 */
function withCursor(text: string, cursor: number): string {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const at = text[pos] ?? ' ';
  return `${text.slice(0, pos)}${REVERSE_ON}${at}${REVERSE_OFF}${text.slice(pos + 1)}`;
}

/**
 * 多行输入框：Enter 发送、Shift+Enter 换行、←/→ 移动光标、Home/End 跳转行首尾、
 * Backspace/Delete 删除光标处字符、↑/↓ 浏览本会话输入历史（去重）。
 */
export function PromptInput({ value, onChange, onSubmit, placeholder, active }: PromptInputProps) {
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  /** -1 = 未在浏览历史；否则为当前显示的历史下标。 */
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** 浏览历史前的编辑中内容（↓ 回到底部时恢复）。 */
  const draftRef = useRef<string | null>(null);

  const browseHistory = (dir: -1 | 1): void => {
    if (history.length === 0) {
      return;
    }
    if (dir === -1) {
      // ↑：未浏览 → 暂存当前输入并取最后一条；已浏览 → 向前一条
      const nextIndex = historyIndex === -1 ? history.length - 1 : historyIndex - 1;
      if (historyIndex === -1) {
        draftRef.current = value;
      }
      if (nextIndex >= 0) {
        setHistoryIndex(nextIndex);
        const next = history[nextIndex] ?? '';
        onChange(next);
        setCursor(next.length);
      }
      return;
    }
    // ↓：已浏览 → 向后一条；越过最新一条 → 恢复暂存输入
    if (historyIndex === -1) {
      return;
    }
    if (historyIndex + 1 >= history.length) {
      setHistoryIndex(-1);
      const draft = draftRef.current ?? '';
      onChange(draft);
      setCursor(draft.length);
      return;
    }
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    const next = history[nextIndex] ?? '';
    onChange(next);
    setCursor(next.length);
  };

  useInput((input, key) => {
    if (!active) {
      return;
    }
    if (key.return && !key.shift) {
      onSubmit(value);
      if (value.trim() !== '') {
        setHistory((h) => [...h.filter((x) => x !== value), value].slice(-HISTORY_LIMIT));
      }
      setHistoryIndex(-1);
      draftRef.current = null;
      setCursor(0);
      return;
    }
    if (key.return && key.shift) {
      onChange(`${value.slice(0, cursor)}\n${value.slice(cursor)}`);
      setCursor((c) => c + 1);
      return;
    }
    if (key.upArrow) {
      browseHistory(-1);
      return;
    }
    if (key.downArrow) {
      browseHistory(1);
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(value.length);
      return;
    }
    if (key.backspace) {
      if (cursor > 0) {
        onChange(`${value.slice(0, cursor - 1)}${value.slice(cursor)}`);
        setCursor((c) => c - 1);
      }
      return;
    }
    if (key.delete) {
      if (cursor < value.length) {
        onChange(`${value.slice(0, cursor)}${value.slice(cursor + 1)}`);
      }
      return;
    }
    if (input !== '') {
      onChange(`${value.slice(0, cursor)}${input}${value.slice(cursor)}`);
      setCursor((c) => c + input.length);
    }
  });

  const isEmpty = value === '';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#CD853F" paddingX={1}>
      <Text color={isEmpty ? 'gray' : undefined}>
        {isEmpty ? (placeholder ?? '') : withCursor(value, cursor)}
      </Text>
    </Box>
  );
}
