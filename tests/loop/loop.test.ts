import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent } from '../../src/loop/loop';
import { MAX_LOOP_TURNS, runLoop } from '../../src/loop/loop';
import { assistantMessage, systemMessage, userMessage } from '../../src/loop/messages';
import type { ChatMessage, ToolCall } from '../../src/loop/types';
import type {
  ApiMessage,
  ChatCompletionChunk,
  ModelClient,
  StreamChatParams,
} from '../../src/model/client';
import { ApiError } from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { readFileTool } from '../../src/tools/read';
import type { ToolContext } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';

interface FakeReply {
  content?: string;
  toolCalls?: ToolCall[];
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
    yield fakeChunk({}, 'stop');
  }
}

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: 'fake-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
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
    const result = await runLoop({ model, client: modelClient, registry, ctx }, [], '你好');

    expect(result.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result[1]?.content).toBe('你好，我是 Lumen');
    expect(modelClient.receivedMessages[0]?.map((m) => m.role)).toEqual(['user']);
  });

  it('systemPrompt 注入且不重复（history 已有 system 时）', async () => {
    const modelClient = new FakeModel([() => ({ content: 'ok' })]);
    const result = await runLoop(
      { model, client: modelClient, registry, ctx, systemPrompt: '项目规则' },
      [],
      'hi',
    );
    expect(result[0]).toMatchObject({ role: 'system', content: '项目规则' });

    const withSystem = await runLoop(
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
    const result = await runLoop({ model, client: modelClient, registry, ctx }, history, '第二问');
    expect(result.slice(0, 2)).toEqual(history);
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
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
    const result = await runLoop(
      { model, client: modelClient, registry, ctx, onEvent: (e) => events.push(e) },
      [],
      '读文件',
    );

    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = result[2];
    expect(toolMsg?.role).toBe('tool');
    expect(toolMsg?.toolCallId).toBe('call_1');
    expect(String(toolMsg?.content)).toContain('"content":"hello world"');
    expect(result[3]?.content).toBe('读到了文件内容');

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
    const result = await runLoop({ model, client: modelClient, registry, ctx }, [], '双工具');
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
    const result = await runLoop(
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
    const result = await runLoop({ model, client: modelClient, registry, ctx }, [], 'hi');
    expect(String(result[2]?.content)).toContain('执行失败');
    expect(result[3]?.content).toBe('参数有问题');
  });

  it('未知工具 → ok:false 回填，循环继续', async () => {
    const modelClient = new FakeModel([
      () => ({ toolCalls: [{ id: 'c1', name: 'no_such_tool', arguments: '{}' }] }),
      () => ({ content: '我用不了这个工具' }),
    ]);
    const result = await runLoop({ model, client: modelClient, registry, ctx }, [], 'hi');
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

  it('工具循环超过最大轮数 → 抛错终止', async () => {
    const script = Array.from({ length: MAX_LOOP_TURNS }, () => () => ({
      toolCalls: [{ id: 'c', name: 'no_such_tool', arguments: '{}' }],
    }));
    const modelClient = new FakeModel(script);
    await expect(runLoop({ model, client: modelClient, registry, ctx }, [], 'hi')).rejects.toThrow(
      '最大轮数',
    );
  });
});
