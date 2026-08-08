import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SubagentSpawner } from '../../src/agent/spawner';
import type { LoopEvent } from '../../src/loop/loop';
import { runLoop } from '../../src/loop/loop';
import type {
  ChatCompletionChunk,
  ModelClient,
  StreamChatParams,
  Usage,
} from '../../src/model/client';
import type { ToolContext } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';
import { createSpawnSubagentTool } from '../../src/tools/spawn';

// ── FakeModel ────────────────────────────────────────────────

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
  usage?: Usage,
): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: usage ?? null,
  };
}

let tmp: string;
let ctx: ToolContext;
const model = 'deepseek-v4-flash';

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-agent-e2e-'));
  ctx = { cwd: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('子代理 E2E', () => {
  it('spawn_subagent 工具调用 → 子代理执行 → 结果回填', async () => {
    // 先创建要读取的文件
    writeFileSync(path.join(tmp, 'readme.md'), '# 项目说明\n这是一个测试项目');

    // 子代理模型：explore 子代理会调用 read_file
    // 第一轮：子代理收到 readme 内容后返回结论
    const subModel: ModelClient = {
      async *streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
        // 子代理的 system prompt 包含 "探索助手"
        const hasExplore = params.messages.some(
          (m) => typeof m.content === 'string' && m.content.includes('探索'),
        );
        if (hasExplore) {
          // 子代理返回结论
          yield fakeChunk({ content: '探索结论：项目是测试项目' });
          yield fakeChunk({}, 'stop');
        } else {
          yield fakeChunk({ content: 'ok' });
          yield fakeChunk({}, 'stop');
        }
      },
    };

    // 注册子代理
    const spawner = new SubagentSpawner(subModel, { cwd: tmp }, model);
    spawner.register({
      name: 'explore',
      description: '探索',
      allowedTools: ['read_file'],
      maxTurns: 3,
      timeoutMs: 10_000,
      systemPrompt: '你是探索助手，只返回结论。',
    });

    const spawnTool = createSpawnSubagentTool(spawner);
    const registry = new ToolRegistry().register(spawnTool);

    // 主循环模型：调用 spawn_subagent
    const mainModel: ModelClient = {
      async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
        yield fakeChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_spawn',
              type: 'function',
              function: {
                name: 'spawn_subagent',
                arguments: JSON.stringify({
                  agentName: 'explore',
                  prompt: '查看项目里有什么文件',
                }),
              },
            },
          ],
        });
        yield fakeChunk({}, 'stop');
      },
    };

    const events: LoopEvent[] = [];
    const { messages } = await runLoop(
      {
        model,
        client: mainModel,
        registry,
        ctx,
        onEvent: (e) => events.push(e),
        maxTurns: 5,
      },
      [],
      '探索项目',
    );

    // 应该有工具调用和结果回填
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThan(0);
    // tool 消息应包含子代理结论
    const toolContent = String(toolMsgs[0]?.content);
    expect(toolContent).toContain('探索结论');
  }, 10_000);

  it('子代理调用不影响主循环 MAX_LOOP_TURNS', async () => {
    // 验证：子代理内部调用不消耗主循环的 maxTurns
    // 构造一个只做 spawn_subagent 的主循环，检查不会因子代理消耗而导致 interrupted

    const subModel: ModelClient = {
      async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
        yield fakeChunk({ content: '结论' });
        yield fakeChunk({}, 'stop');
      },
    };

    const spawner = new SubagentSpawner(subModel, { cwd: tmp }, model);
    spawner.register({
      name: 'explore',
      description: '探索',
      allowedTools: ['read_file'],
      maxTurns: 3,
      timeoutMs: 10_000,
      systemPrompt: '你是探索助手。',
    });

    const spawnTool = createSpawnSubagentTool(spawner);
    const registry = new ToolRegistry().register(spawnTool);

    // 主循环只做一次 spawn_subagent 调用就结束
    let calls = 0;
    const mainModel: ModelClient = {
      async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
        calls += 1;
        if (calls === 1) {
          yield fakeChunk({
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: {
                  name: 'spawn_subagent',
                  arguments: JSON.stringify({ agentName: 'explore', prompt: '探索' }),
                },
              },
            ],
          });
          yield fakeChunk({}, 'stop');
        } else {
          yield fakeChunk({ content: '任务完成' });
          yield fakeChunk({}, 'stop');
        }
      },
    };

    const { interrupted } = await runLoop(
      { model, client: mainModel, registry, ctx, maxTurns: 5 },
      [],
      '任务',
    );

    expect(interrupted).toBe(false);
    expect(calls).toBeLessThanOrEqual(2); // 一轮 spawn + 一轮回复
  }, 10_000);
});
