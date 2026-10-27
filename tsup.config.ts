import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
    // v5.0 T9：审批框单独出一个入口——发布门基准脚本（scripts/bench-approval-ui.mjs）
    // 要测「真实 Ink 首帧」，必须能 import 到构建产物里的组件；
    // 又不希望为了基准把 Ink 组件塞进库 barrel（会让 import 库的人白加载 Ink）。
    'ui/modals': 'src/ui/modals.tsx',
  },
  format: ['esm'],
  target: 'node22',
  dts: {
    entry: { index: 'src/index.ts' },
  },
  sourcemap: true,
  clean: true,
});
