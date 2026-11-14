import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // v5.0 T10：全局测试隔离（见 tests/setup.ts 的说明）
    setupFiles: ['tests/setup.ts'],
    /**
     * v5.3 A：套件级不变式——跑完之后开发者真实 home 里本项目的交接单必须一字未变。
     * 为什么必须在 globalSetup 而不是某个用例里：用例只看得见自己 worker 的顺序，
     * 变异探针实测「用例版」在真实文件被覆盖的同一轮里仍全绿（见该文件头注释）。
     */
    globalSetup: ['tests/handoff-home-guard.global.ts'],
  },
});
