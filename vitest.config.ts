import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // v5.0 T10：全局测试隔离（见 tests/setup.ts 的说明）
    setupFiles: ['tests/setup.ts'],
  },
});
