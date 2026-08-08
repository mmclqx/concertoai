import { Text } from 'ink';

import { useEffect, useRef, useState } from 'react';

/** Braille spinner 帧序列。 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** 帧间隔（毫秒）。 */
const FRAME_MS = 80;

export interface SpinnerProps {
  text: string;
}

/** 动态进度指示：Braille spinner + 文本 + 已用秒数。 */
export function Spinner({ text }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_MS);
    const elapsedTimer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 250);
    return () => {
      clearInterval(frameTimer);
      clearInterval(elapsedTimer);
    };
  }, []);

  return (
    <Text dimColor>
      {FRAMES[frame]} {text} {elapsed}s
    </Text>
  );
}
