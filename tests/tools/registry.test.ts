/**
 * ToolRegistry.toApiTools 缓存测试（v2.1 性能优化）。
 *
 * 验证：缓存命中返回同一引用；register 后缓存失效、新工具立即可见。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readFileTool } from '../../src/tools/read';
import { ToolRegistry } from '../../src/tools/registry';

describe('ToolRegistry.toApiTools 缓存', () => {
  it('重复调用返回同一缓存引用（避免每轮重复 zod→JSON Schema 转换）', () => {
    const reg = new ToolRegistry().register(readFileTool);
    const first = reg.toApiTools();
    const second = reg.toApiTools();
    expect(first).toBe(second);
    expect(first[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } });
  });

  it('register 后缓存失效，新工具立即可见', () => {
    const reg = new ToolRegistry().register(readFileTool);
    expect(reg.toApiTools()).toHaveLength(1);

    reg.register({
      name: 'echo',
      description: '回声测试工具',
      parameters: z.object({}),
      parallelSafe: true,
      execute: () => ({ ok: true, data: 'echo' }),
    });

    const after = reg.toApiTools();
    expect(after).toHaveLength(2);
    expect(after.some((t) => t.function.name === 'echo')).toBe(true);
  });
});
