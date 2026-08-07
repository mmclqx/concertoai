/**
 * MCP inputSchema → Zod 适配器。
 *
 * 将 MCP 工具的 JSON Schema 定义转为 Zod schema，用于 ToolRegistry 参数校验。
 * v1.1 策略：使用宽松的 passthrough 对象 schema（MCP 服务端自行校验输入），
 * 后续版本可升级为精确的 JSON Schema → Zod 动态编译。
 */

import { z } from 'zod';

/** 宽松的"任意对象" schema：接受任何属性并透传，不做本地校验。 */
const LOOSE_SCHEMA = z.object({}).passthrough();

/**
 * 将 MCP 工具 inputSchema 转为 zod schema。
 * 当前版本返回宽松 schema（MCP 服务端负责校验），后续可做精确映射。
 */
export function toZodSchema(_inputSchema: {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}): z.ZodTypeAny {
  // v1.1: 宽松策略——MCP 服务端负责校验输入
  return LOOSE_SCHEMA;
}
