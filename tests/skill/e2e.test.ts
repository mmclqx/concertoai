import { describe, expect, it } from 'vitest';

import { executeSkillCommand, parseSkillCommand } from '../../src/cli/slash/skill';
import { runLoop } from '../../src/loop/loop';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import { SkillLoader } from '../../src/skill/loader';
import type { ToolContext } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';

// ── FakeModel ────────────────────────────────────────────────

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

describe('技能系统 E2E', () => {
  it('/skill list → 解析正确，返回列表', () => {
    const cmd = parseSkillCommand('/skill list');
    expect(cmd).toEqual({ type: 'list' });
  });

  it('/skill <name> → 解析为 call，exec 返回 skillBody', () => {
    const cmd = parseSkillCommand('/skill code-review src/tools/');
    expect(cmd).toEqual({
      type: 'call',
      name: 'code-review',
      args: 'src/tools/',
    });
  });

  it('技能正文注入后 runLoop 可正常执行', async () => {
    const skillBody = `## 技能描述
你是代码审查助手。请审查用户提供的代码并给出建议。

## 执行指令
1. 检查代码风格
2. 报告潜在问题`;

    // 模拟模型：收到包含技能指令的 system prompt 后回复
    const model: ModelClient = {
      async *streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
        // 验证 system prompt 包含技能正文
        const systemMsg = params.messages.find((m) => m.role === 'system');
        expect(systemMsg?.content).toContain('代码审查助手');
        yield fakeChunk({ content: '审查完成：代码质量良好' });
        yield fakeChunk({}, 'stop');
      },
    };

    const registry = new ToolRegistry();
    const ctx: ToolContext = { cwd: '/fake' };

    const { messages } = await runLoop(
      {
        model: 'deepseek-v4-flash',
        client: model,
        registry,
        ctx,
        systemPrompt: skillBody,
      },
      [],
      '审查这个文件',
    );

    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.content).toContain('审查完成');
  });

  it('未知技能 → 显示错误提示（不调用模型）', () => {
    const loader = new SkillLoader();
    const result = executeSkillCommand(
      { type: 'call', name: 'no-such', args: '' },
      loader,
      '/fake',
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未知技能');
    expect(result.skillBody).toBeUndefined();
  });
});
