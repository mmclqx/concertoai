/**
 * ConcertoAI 版本号。
 *
 * 独立模块（v2.1 性能优化）：CLI 入口只需读取版本号即可完成 --version，
 * 不必通过 barrel（src/index.ts）加载整个库的模块树（agent/loop/mcp/…）。
 * 库入口 src/index.ts 从这里 re-export，保持公共 API 不变。
 */
export const VERSION = '4.1.0';
