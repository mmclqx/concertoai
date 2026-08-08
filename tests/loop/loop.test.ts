import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LoopEvent } from '../../src/loop/loop';
import { MAX_LOOP_TURNS, runLoop } from '../../src/loop/loop';
import { assistantMessage, systemMessage, userMessage } from '../../src/loop/messages';
import type { ChatMessage, ToolCall } from '../../src/loop/types';
import type {
  ApiMessage,
  ChatCompletionChunk,
  ModelClient,
  StreamChatParams,
  Usage,
} from '../../src/model/client';
import { ApiError } from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { readFileTool } from '../../src/tools/read';
import type { ToolContext, ToolSpec } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';

interface FakeReply {
  content?: string;
  toolCalls?: ToolCall[];
  /** 附加在流末尾 chunk 上的用量统计。 */
  usage?: Usage;
  throwError?: Error;
}

/** 脚本式 mock 模型：每次调用按序消费一个回复；tool_calls 的 name/arguments 故意分片下发。 */
class FakeModel implements ModelClient {
  receivedMessages: ApiMessage[][] = [];
  constructor(private readonly script: Array<(messages: ApiMessage[]) => FakeReply>) {}

  async *streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    this.receivedMessages.push(params.messages);
    const step = this.script.shift();
    if (step === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    const reply = step(params.messages);
    if (reply.throwError !== undefined) {
      throw reply.throwError;
    }
    if (reply.content !== undefined) {
      yield fakeChunk({ content: reply.content });
    }
    let index = 0;
    for (const tc of reply.toolCalls ?? []) {
      // 拆成两片：id 单独一片，name/arguments 各拆两半——覆盖增量拼接
      yield fakeChunk({
        tool_calls: [
          {
            index,
            id: tc.id,
            function: { name: tc.name.slice(0, 4), arguments: tc.arguments.slice(0, 6) },
          },
        ],
      });
      yield fakeChunk({
        tool_calls: [
          { index, function: { name: tc.name.slice(4), arguments: tc.arguments.slice(6) } },
        ],
      });
      index += 1;
    }
    yield fakeChunk({}, 'stop', reply.usage);
  }
}

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
  usage?: Usage,
): ChatCompletionChunk {
  return {
    id: 'fake-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: usage ?? null,
  };
}

const model = 'deepseek-v4-flash';

let tmp: string;
let ctx: ToolContext;
let registry: ToolRegistry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  ctx = { cwd: tmp, requestApproval: vi.fn(async () => true) };
  registry = new ToolRegistry().register(readFileTool).register(editFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runLoop 基础路径', () => {
  it('无工具调用：user + assistant 直接返回', async () => {
    const modelClient = new FakeModel([() => ({ content: '你好，我是 Lumen' })]);
    const { messages } = await runLoop({ model, client: modelClient, registry, ctx }, [], '你好');

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toBe('你好，我是 Lumen');
    expect(modelClient.receivedMessages[0]?.map((m) => m.role)).toEqual(['user']);
  });

  it('systemPrompt 注入且不重复（history 已有 system 时）', async () => {
    const modelClient = new FakeModel([() => ({ content: 'ok' })]);
    const { messages } = await runLoop(
      { model, client: modelClient, registry, ctx, systemPrompt: '项目规则' },
      [],
      'hi',
    );
    expect(messages[0]).toMatchObject({ role: 'system', content: '项目规则' });

    const { messages: withSystem } = await runLoop(
      {
        model,
        client: new FakeModel([() => ({ content: 'ok2' })]),
        registry,
        ctx,
        systemPrompt: '规则2',
      },
      [systemMessage('已有规则'), userMessage('旧问题'), assistantMessage('旧回答')],
      'hi',
    );
    expect(withSystem.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(withSystem[0]?.content).toBe('已有规则');
    expect(withSystem.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('历史消息透传', async () => {
    const modelClient = new FakeModel([() => ({ content: '这是新回答' })]);
    const history: ChatMessage[] = [userMessage('第一问'), assistantMessage('第一答')];
    const { messages } = await runLoop(
      { model, client: modelClient, registry, ctx },
      history,
      '第二问',
    );
    expect(messages.slice(0, 2)).toEqual(history);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('chunk 事件按流式增量触发，拼接等于完整回复', async () => {
    const modelClient = new FakeModel([() => ({ content: '流式回复' })]);
    const events: LoopEvent[] = [];
    await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    const chunks = events.filter((e) => e.type === 'chunk');
    expect(chunks.map((e) => (e as { text: string }).text).join('')).toBe('流式回复');
  });

  it('usage 事件：上报最后一个带 usage 的 chunk', async () => {
    const usageA: Usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const usageB: Usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_cache_hit_tokens: 40,
    };
    const modelClient: ModelClient = {
      async *streamChat() {
        yield fakeChunk({ content: '前' }, null, usageA);
        yield fakeChunk({ content: '后' }, null, usageB);
        yield fakeChunk({}, 'stop');
      },
    };
    const events: LoopEvent[] = [];
    await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0] as { usage: Usage }).usage).toEqual(usageB);
  });

  it('无 usage 的流不上报 usage 事件', async () => {
    const modelClient = new FakeModel([() => ({ content: 'ok' })]);
    const events: LoopEvent[] = [];
    await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('多轮工具循环每轮上报 usage', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const usage: Usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
        usage,
      }),
      () => ({ content: '完成', usage }),
    ]);
    const events: LoopEvent[] = [];
    await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
  });

  it('流中中断：保留已生成内容回填会话，上报 error 事件且不重试', async () => {
    const controller = new AbortController();
    let calls = 0;
    const modelClient: ModelClient = {
      async *streamChat() {
        calls += 1;
        yield fakeChunk({ content: '前半' });
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    };
    const events: LoopEvent[] = [];
    const { messages } = await runLoop(
      {
        model,
        client: modelClient,
        registry,
        ctx,
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      },
      [],
      'hi',
    );
    expect(calls).toBe(1);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toBe('前半');
    expect(events.find((e) => e.type === 'error')).toBeDefined();
  });

  it('流中中断且尚无已生成内容：直接抛错', async () => {
    const controller = new AbortController();
    const modelClient: ModelClient = {
      async *streamChat() {
        controller.abort();
        yield fakeChunk({});
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    };
    await expect(
      runLoop({ model, client: modelClient, registry, ctx, signal: controller.signal }, [], 'hi'),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('流中网络错误（非中断）：保留已生成内容并上报 error 事件', async () => {
    const modelClient: ModelClient = {
      async *streamChat() {
        yield fakeChunk({ content: '一半' });
        throw new TypeError('fetch failed');
      },
    };
    const events: LoopEvent[] = [];
    const { messages } = await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    expect(messages[1]?.content).toBe('一半');
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect((errEvent as { error: Error }).error).toBeInstanceOf(TypeError);
  });

  it('contextWindow 超预算时发送消息被裁剪，返回历史保持完整', async () => {
    const long = `长问题${'长'.repeat(196)}`;
    const history: ChatMessage[] = [
      systemMessage('项目规则'),
      userMessage(long),
      assistantMessage('旧回答'),
      userMessage(long),
    ];
    const modelClient = new FakeModel([() => ({ content: '新回答' })]);
    const { messages } = await runLoop(
      { model, client: modelClient, registry, ctx, contextWindow: 400 },
      history,
      '最新提问',
    );
    // 返回历史完整：旧消息全部保留
    expect(messages.length).toBe(history.length + 2);
    expect(messages[0]?.content).toBe('项目规则');
    // 发送给模型的被裁剪：system + 预算内最近的整轮（第二问组 + 最新提问）
    const sent = modelClient.receivedMessages[0];
    expect(sent?.length).toBe(3);
    expect(sent?.[0]).toMatchObject({ role: 'system', content: '项目规则' });
    expect(sent?.[2]).toMatchObject({ role: 'user', content: '最新提问' });
  });
});

describe('runLoop 工具链路', () => {
  it('工具调用 → 执行 → 结果回填 → 模型给出最终回复', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'hello world');
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] }),
      (messages) => {
        const toolMsg = messages.at(-1);
        expect(toolMsg?.role).toBe('tool');
        expect(String(toolMsg?.content)).toContain('hello world');
        return { content: '读到了文件内容' };
      },
    ]);

    const events: LoopEvent[] = [];
    const { messages } = await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      '读文件',
    );

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = messages[2];
    expect(toolMsg?.role).toBe('tool');
    expect(toolMsg?.toolCallId).toBe('call_1');
    expect(String(toolMsg?.content)).toContain('"content":"hello world"');
    expect(messages[3]?.content).toBe('读到了文件内容');

    const callEvent = events.find((e) => e.type === 'tool_call');
    expect(callEvent).toBeDefined();
    const resultEvent = events.find((e) => e.type === 'tool_result');
    expect(resultEvent).toBeDefined();
    // 第二次模型调用收到的消息里必须带 tool 结果
    expect(modelClient.receivedMessages[1]?.at(-1)?.role).toBe('tool');
  });

  it('tool_calls 分片增量正确拼接（name/arguments 各拆两片）', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
          { id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        ],
      }),
      () => ({ content: 'done' }),
    ]);
    const { messages: result } = await runLoop(
      { model, client: modelClient, registry, ctx },
      [],
      '双工具',
    );
    const assistant = result[1];
    expect(assistant?.toolCalls).toEqual([
      { id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { id: 'c2', name: 'read_file', arguments: '{"path":"a.txt"}' },
    ]);
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
  });

  it('审批拒绝：edit_file 不落盘，拒绝信息回填后循环继续', async () => {
    const denyCtx: ToolContext = { cwd: tmp, requestApproval: vi.fn(async () => false) };
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [
          { id: 'c1', name: 'edit_file', arguments: '{"path":"b.txt","search":"","replace":"x"}' },
        ],
      }),
      (messages) => {
        const toolMsg = messages.at(-1);
        expect(String(toolMsg?.content)).toContain('拒绝');
        return { content: '好的，不修改' };
      },
    ]);
    const { messages: result } = await runLoop(
      { model, client: modelClient, registry, ctx: denyCtx },
      [],
      '创建文件',
    );

    const toolMsg = result[2];
    expect(toolMsg?.role).toBe('tool');
    expect(String(toolMsg?.content)).toContain('编辑被拒绝');
    expect(() => readFileSync(path.join(tmp, 'b.txt'))).toThrow();
    expect(result[3]?.content).toBe('好的，不修改');
  });

  it('工具参数 JSON 非法 → 错误回填，循环继续', async () => {
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{bad json' }] }),
      () => ({ content: '参数有问题' }),
    ]);
    const { messages: result } = await runLoop(
      { model, client: modelClient, registry, ctx },
      [],
      'hi',
    );
    expect(String(result[2]?.content)).toContain('执行失败');
    expect(result[3]?.content).toBe('参数有问题');
  });

  it('未知工具 → ok:false 回填，循环继续', async () => {
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'c1', name: 'no_such_tool', arguments: '{}' }] }),
      () => ({ content: '我用不了这个工具' }),
    ]);
    const { messages: result } = await runLoop(
      { model, client: modelClient, registry, ctx },
      [],
      'hi',
    );
    expect(String(result[2]?.content)).toContain('未知工具');
  });

  it('模型调用失败（ApiError）直接上抛', async () => {
    const modelClient = new FakeModel([
      () => ({ throwError: new ApiError(401, 'invalid api key') }),
    ]);
    await expect(
      runLoop({ model, client: modelClient, registry, ctx }, [], 'hi'),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });

  it('工具循环超过最大轮数 → 返回 interrupted 并保留累积历史', async () => {
    const script = Array.from({ length: MAX_LOOP_TURNS }, () => () => ({
      toolCalls: [{ id: 'c', name: 'no_such_tool', arguments: '{}' }],
    }));
    const modelClient = new FakeModel(script);
    const { messages, interrupted } = await runLoop(
      { model, client: modelClient, registry, ctx },
      [],
      'hi',
    );
    expect(interrupted).toBe(true);
    // user + 10 轮 assistant + 10 轮 tool = 21 条消息
    expect(messages.length).toBe(21);
    expect(messages[0]?.role).toBe('user');
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(MAX_LOOP_TURNS);
    expect(String(toolMsgs.at(-1)?.content)).toContain('未知工具');
    expect(messages.filter((m) => m.role === 'assistant').length).toBe(MAX_LOOP_TURNS);
  });
});

describe('并行工具调度（T3.1）', () => {
  it('parallelSafe 工具并行执行（并发计数到达组大小）', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowTool: ToolSpec = {
      name: 'slow_tool',
      description: '测试用慢工具',
      parameters: z.object({}),
      parallelSafe: true,
      execute: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrent -= 1;
        return { ok: true, data: { done: true } };
      },
    };
    const reg = new ToolRegistry().register(slowTool);
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [
          { id: 'a', name: 'slow_tool', arguments: '{}' },
          { id: 'b', name: 'slow_tool', arguments: '{}' },
          { id: 'c', name: 'slow_tool', arguments: '{}' },
        ],
      }),
      () => ({ content: '完成' }),
    ]);
    await runLoop({ model, client: modelClient, registry: reg, ctx }, [], 'hi');
    expect(maxConcurrent).toBe(3);
  });

  it('审批类工具（edit_file）串行执行', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const approvalCtx: ToolContext = {
      cwd: tmp,
      requestApproval: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        return true;
      },
    };
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [
          { id: 'e1', name: 'edit_file', arguments: '{"path":"b.txt","search":"","replace":"x"}' },
          { id: 'e2', name: 'edit_file', arguments: '{"path":"c.txt","search":"","replace":"y"}' },
        ],
      }),
      () => ({ content: '完成' }),
    ]);
    await runLoop({ model, client: modelClient, registry, ctx: approvalCtx }, [], 'hi');
    expect(maxConcurrent).toBe(1);
    expect(readFileSync(path.join(tmp, 'b.txt'), 'utf8')).toBe('x');
    expect(readFileSync(path.join(tmp, 'c.txt'), 'utf8')).toBe('y');
  });

  it('混合调用：parallelSafe 组内并行、审批类独立串行，事件按原始顺序', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), '内容');
    const events: LoopEvent[] = [];
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [
          { id: 'r1', name: 'read_file', arguments: '{"path":"a.txt"}' },
          { id: 'e1', name: 'edit_file', arguments: '{"path":"b.txt","search":"","replace":"hi"}' },
          { id: 'r2', name: 'read_file', arguments: '{"path":"a.txt"}' },
        ],
      }),
      () => ({ content: '完成' }),
    ]);
    await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    const callIds = events
      .filter((e) => e.type === 'tool_call')
      .map((e) => (e as { toolCall: ToolCall }).toolCall.id);
    const resultIds = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as { toolCall: ToolCall }).toolCall.id);
    expect(callIds).toEqual(['r1', 'e1', 'r2']);
    expect(resultIds).toEqual(['r1', 'e1', 'r2']);
    expect(readFileSync(path.join(tmp, 'b.txt'), 'utf8')).toBe('hi');
  });

  it('并行组内完成顺序不同，tool_result 仍按调用顺序回填', async () => {
    const delayTool: ToolSpec = {
      name: 'delay_tool',
      description: '可配置延迟的并行安全工具',
      parameters: z.object({ ms: z.number() }),
      parallelSafe: true,
      execute: async (rawArgs) => {
        const { ms } = rawArgs as { ms: number };
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { ok: true, data: { ms } };
      },
    };
    const reg = new ToolRegistry().register(delayTool);
    const events: LoopEvent[] = [];
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [
          { id: 'slow', name: 'delay_tool', arguments: '{"ms":60}' },
          { id: 'fast', name: 'delay_tool', arguments: '{"ms":10}' },
        ],
      }),
      (messages) => {
        // 第二个工具先完成，但 tool 消息顺序必须与调用顺序一致
        const toolMsgs = messages.filter((m) => m.role === 'tool');
        expect(String(toolMsgs[0]?.content)).toContain('"ms":60');
        expect(String(toolMsgs[1]?.content)).toContain('"ms":10');
        return { content: '完成' };
      },
    ]);
    await runLoop(
      { model, client: modelClient, registry: reg, ctx, onEvent: (e) => events.push(e) },
      [],
      'hi',
    );
    const resultIds = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as { toolCall: ToolCall }).toolCall.id);
    expect(resultIds).toEqual(['slow', 'fast']);
  });
});

describe('工具调用修复管线（T3.2）', () => {
  it('可修复错误连续 3 次 → 终止（修复上限 2 次）', async () => {
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"nope.txt"}' }],
      }),
      () => ({
        toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{"path":"nope.txt"}' }],
      }),
      () => ({
        toolCalls: [{ id: 'c3', name: 'read_file', arguments: '{"path":"nope.txt"}' }],
      }),
    ]);
    await expect(runLoop({ model, client: modelClient, registry, ctx }, [], 'hi')).rejects.toThrow(
      '可修复错误',
    );
  });

  it('参数校验失败同样计入修复计数（3 次终止）', async () => {
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] }),
      () => ({ toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{}' }] }),
      () => ({ toolCalls: [{ id: 'c3', name: 'read_file', arguments: '{}' }] }),
    ]);
    await expect(runLoop({ model, client: modelClient, registry, ctx }, [], 'hi')).rejects.toThrow(
      '可修复错误',
    );
  });

  it('修复 2 次内模型修正成功 → 正常完成', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), '内容');
    const modelClient = new FakeModel([
      () => ({
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"nope.txt"}' }],
      }),
      () => ({ toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{"path":"a.txt"}' }] }),
      () => ({ content: '读到了' }),
    ]);
    const { messages: result } = await runLoop(
      { model, client: modelClient, registry, ctx },
      [],
      'hi',
    );
    expect(result.at(-1)?.content).toBe('读到了');
  });

  it('审批拒绝（repairable: false）连续多次不触发修复终止', async () => {
    const denyCtx: ToolContext = { cwd: tmp, requestApproval: vi.fn(async () => false) };
    const editArgs = '{"path":"b.txt","search":"","replace":"x"}';
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'c1', name: 'edit_file', arguments: editArgs }] }),
      () => ({ toolCalls: [{ id: 'c2', name: 'edit_file', arguments: editArgs }] }),
      () => ({ toolCalls: [{ id: 'c3', name: 'edit_file', arguments: editArgs }] }),
      () => ({ toolCalls: [{ id: 'c4', name: 'edit_file', arguments: editArgs }] }),
      () => ({ content: '放弃了' }),
    ]);
    const { messages } = await runLoop(
      { model, client: modelClient, registry, ctx: denyCtx },
      [],
      'hi',
    );
    expect(messages.at(-1)?.content).toBe('放弃了');
  });

  it('路径越界（repairable: false）连续多次不触发修复终止', async () => {
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":".."}' }] }),
      () => ({ toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{"path":".."}' }] }),
      () => ({ toolCalls: [{ id: 'c3', name: 'read_file', arguments: '{"path":".."}' }] }),
      () => ({ content: '换个方式' }),
    ]);
    const { messages } = await runLoop({ model, client: modelClient, registry, ctx }, [], 'hi');
    expect(messages.at(-1)?.content).toBe('换个方式');
  });
});
