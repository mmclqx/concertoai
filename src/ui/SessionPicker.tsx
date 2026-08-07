import { Box, Text, useInput } from 'ink';

import { useState } from 'react';

import { t } from '../i18n';
import type { SessionSummary } from '../store/session';

/** 会话创建时间格式化：YYYY-MM-DD HH:mm（本地时区）。 */
export function formatSessionTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

/** 历史会话选择器：↑/↓ 移动高亮，Enter 选定，Esc 取消。 */
export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setIndex((i) => Math.min(sessions.length - 1, i + 1));
    } else if (key.return) {
      const picked = sessions[index];
      if (picked !== undefined) {
        onSelect(picked.id);
      }
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{t().session.listTitle}</Text>
      {sessions.map((s, i) => (
        <Text key={s.id} color={i === index ? 'cyan' : undefined} bold={i === index}>
          {`${i === index ? '› ' : '  '}${formatSessionTime(s.createdAt)}  ${s.messageCount} 条  ${
            s.firstUserMessage ?? t().session.noUserMessage
          }`}
        </Text>
      ))}
      <Text dimColor>{t().session.pickerHint}</Text>
    </Box>
  );
}
