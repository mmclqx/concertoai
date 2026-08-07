import { Text } from 'ink';

import { useEffect, useState } from 'react';

/** Braille spinner 帧序列。 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** 帧间隔（毫秒）。 */
const FRAME_MS = 80;

export interface SpinnerProps {
  text: string;
}

/** 动态进度指示：Braille spinner + 文本（思考中 / 工具执行 / 等待审批）。 */
export function Spinner({ text }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {FRAMES[frame]} {text}
    </Text>
  );
}
