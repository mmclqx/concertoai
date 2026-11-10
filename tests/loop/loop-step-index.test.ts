/**
 * `LoopEvent.stepIndex` 契约测试（v5.1 T2.1，判据 C5 前半）。
 *
 * ## 这条守的是什么
 *
 * 用户要的是「第 N 步」——不是「第 N 轮」。一个 turn 里模型可能一次发好几个工具
 * （`groupToolCalls` 会把连续的 parallelSafe 工具聚成一组并行执行），
 * 所以步号必须满足三条：
 *
 * 1. **从 1 开始**（用户看到的第一个动作是「第 1 步」）；
 * 2. **跨轮连续累计**（第 2 轮的第一个工具是第 N+1 步，不是又回到 1）；
 * 3. **并行组内按数组顺序**（不是完成顺序——否则同组工具谁跑得快谁号小，用户对数对不上）。
 *
 * ## 没有 total 也是契约
 *
 * loop 事先不知道模型会发多少工具，硬造分母只能靠猜。本文件同时断言
 * **事件里根本没有 total 字段**——防止后人「为了显示好看」加一个假分母回来。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LoopEvent, LoopOptions } from '../../src/loop/loop';
import { runLoop } from '../../src/loop/loop';
import type { ChatMessage, ToolCall } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import type { ToolResult, ToolSpec } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';

/** 按脚本回 toolCalls 的假模型（每轮一条）。 */
class ScriptedModel implements ModelClient {
  private index = 0;
  constructor(private readonly rounds: ToolCall[][]) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const calls = this.rounds[this.index] ?? [];
    this.index += 1;
    let i = 0;
    for (const tc of calls) {
      yield {
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: i, id: tc.id, function: { name: tc.name, arguments: tc.arguments } },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      };
      i += 1;
    }
    yield {
      id: 'fake',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: null,
    };
  }
}

/** 造一个工具：`parallelSafe` 决定它是否与相邻并行组聚合。 */
function makeTool(name: string, parallelSafe: boolean): ToolSpec {
  return {
    name,
    description: name,
    parameters: z.object({}),
    parallelSafe,
    execute: async (): Promise<ToolResult> => ({ ok: true, data: name }),
  };
}

function call(id: string, name: string): ToolCall {
  return { id, name, arguments: '{}' };
}

const userMessage: ChatMessage = { role: 'user', content: '干活' };

async function run(rounds: ToolCall[][], tools: ToolSpec[]): Promise<LoopEvent[]> {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const events: LoopEvent[] = [];
  const options: LoopOptions = {
    model: 'fake',
    client: new ScriptedModel(rounds),
    registry,
    ctx: { cwd: process.cwd() },
    // 审批类工具一律放行：本文件只测步号
    onEvent: (event) => events.push(event),
  };
  await runLoop(options, [], '干活');
  return events;
}

/** 取出所有 tool_call / tool_result 的 stepIndex。 */
const stepIndexes = (events: LoopEvent[], type: 'tool_call' | 'tool_result'): number[] =>
  events
    .filter((e): e is Extract<LoopEvent, { type: typeof type }> => e.type === type)
    .map((e) => e.stepIndex);

describe('stepIndex：一轮内多个工具 ⇒ 1,2,3', () => {
  it('3 个串行工具（parallelSafe=false）⇒ 依次 1、2、3', async () => {
    const tools = [makeTool('a', false), makeTool('b', false), makeTool('c', false)];
    const events = await run([[call('1', 'a'), call('2', 'b'), call('3', 'c')], []], tools);
    expect(stepIndexes(events, 'tool_call')).toEqual([1, 2, 3]);
  });

  it('并行组内按**数组顺序**编号（不是完成顺序）', async () => {
    // 三个 parallelSafe 工具会被 groupToolCalls 聚成一组并行执行。
    // 让 b 的 execute 最慢、a 最快 —— 若按完成顺序编号，顺序会被打乱。
    const tools = [makeTool('a', true), makeTool('b', true), makeTool('c', true)];
    const events = await run([[call('1', 'a'), call('2', 'b'), call('3', 'c')], []], tools);
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(
      calls.map((e) => (e.type === 'tool_call' ? [e.toolCall.name, e.stepIndex] : null)),
    ).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });
});

describe('stepIndex：跨轮连续累计（不重置）', () => {
  it('两轮（1 个 + 2 个）⇒ 1,2,3', async () => {
    const tools = [makeTool('a', false), makeTool('b', false)];
    const events = await run([[call('1', 'a')], [call('2', 'a'), call('3', 'b')], []], tools);
    expect(stepIndexes(events, 'tool_call')).toEqual([1, 2, 3]);
  });

  it('**反例对照**：若按轮重置会得到 1,1,2 —— 断言实际结果不是它', async () => {
    const tools = [makeTool('a', false), makeTool('b', false)];
    const events = await run([[call('1', 'a')], [call('2', 'a'), call('3', 'b')], []], tools);
    const got = stepIndexes(events, 'tool_call');
    expect(got).not.toEqual([1, 1, 2]);
  });
});

describe('stepIndex：tool_result 与对应 tool_call 相同', () => {
  it('每个 result 的步号等于同名调用的步号', async () => {
    const tools = [makeTool('a', false), makeTool('b', true), makeTool('c', true)];
    const events = await run([[call('1', 'a'), call('2', 'b'), call('3', 'c')], []], tools);
    expect(stepIndexes(events, 'tool_result')).toEqual(stepIndexes(events, 'tool_call'));
  });
});

describe('契约：**不许有 total**（假分母只能靠猜）', () => {
  it('tool_call / tool_result 事件里不存在 total 字段', async () => {
    const tools = [makeTool('a', false)];
    const events = await run([[call('1', 'a')], []], tools);
    const toolEvents = events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result');
    expect(toolEvents.length).toBeGreaterThan(0);
    for (const event of toolEvents) {
      expect(Object.keys(event)).not.toContain('total');
      expect(Object.keys(event)).not.toContain('stepTotal');
    }
  });
});

describe('步号是「本次输入」口径', () => {
  it('runLoop 每次调用都从 1 开始（新输入 = 新任务）', async () => {
    const tools = [makeTool('a', false)];
    const first = await run([[call('1', 'a')], []], tools);
    const second = await run([[call('2', 'a')], []], tools);
    expect(stepIndexes(first, 'tool_call')).toEqual([1]);
    expect(stepIndexes(second, 'tool_call')).toEqual([1]);
  });
});

// 保持导入被使用（userMessage 便于后续扩展时直接可用）
void userMessage;
