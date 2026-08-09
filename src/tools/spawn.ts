/**
 * spawn_subagent 工具（v2.0）。
 *
 * 允许模型在对话中调用子代理执行探索/研究任务，结果以结构化 tool result 回填。
 * 子代理调用不占用主循环的 MAX_LOOP_TURNS 计数。
 */

import { z } from 'zod';

import type { SubagentSpawner } from '../agent/spawner';
import type { ToolResult, ToolSpec } from './registry';

const spawnSchema = z.object({
  agentName: z.string().min(1).describe('要调用的子代理名称（explore / research）'),
  prompt: z.string().min(1).describe('子代理任务描述'),
});

/**
 * 创建 spawn_subagent 工具规格。
 * 通过闭包捕获 spawner，execute 中调用 spawner.spawn()。
 */
export function createSpawnSubagentTool(spawner: SubagentSpawner): ToolSpec {
  return {
    name: 'spawn_subagent',
    description: `调用子代理在项目中执行探索/研究任务。子代理拥有独立的对话上下文，使用只读工具（read_file / search_content / list_directory），只回传结论不污染主对话。可用子代理：${spawner.listNames().join('、')}。`,
    parameters: spawnSchema,
    parallelSafe: false,
    execute: async (rawArgs): Promise<ToolResult> => {
      const args = rawArgs as { agentName: string; prompt: string };
      const result = await spawner.spawn({
        agentName: args.agentName,
        prompt: args.prompt,
      });

      // 结构化回填：将 SubagentResult 序列化为清晰的文本
      const lines: string[] = [];
      if (result.ok) {
        lines.push('✅ 子代理执行成功');
      } else {
        lines.push(`❌ 子代理执行失败${result.error ? `: ${result.error}` : ''}`);
      }
      lines.push('');
      lines.push(result.summary);
      lines.push('');
      lines.push(`---\n调用统计：${result.toolCallCount} 次工具调用，耗时 ${result.durationMs}ms`);

      return {
        ok: result.ok,
        // v2.1 修复：失败时 ToolResult.error 也需回填，否则 loop 修复管线
        // 取 result.error ?? '未知错误' 永远得 '未知错误'，子代理真实错误被吞掉。
        error: result.ok ? undefined : (result.error ?? '子代理执行失败'),
        data: {
          text: lines.join('\n'),
          ok: result.ok,
          summary: result.summary,
          error: result.error,
          toolCallCount: result.toolCallCount,
          durationMs: result.durationMs,
        },
      };
    },
  };
}
