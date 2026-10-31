import { describe, expect, it, vi } from 'vitest';

import type { ChatCompletionChunk } from '../../src/model/client';
import { DeepSeekClient, readSseEvents, TimeoutError } from '../../src/model/client';
import { costFor } from '../../src/model/models';

/** 构造一个 SSE 事件行（单条 data，以空行收尾）。 */
function chunkEvent(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 构造一个**带 usage** 的 SSE 事件行（DeepSeek 把 usage 挂在最后一个 chunk 上）。
 *
 * K15 的记账点就在这个字段上，所以它必须能被夹具独立控制 —— 用 `chunkEvent` 拼不出来。
 */
function usageEvent(usage: Record<string, number>, finishReason: string | null = 'stop'): string {
  const payload = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
    usage,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 将文本按字节切成 N 块（每块一个字节 = 最严格的跨块边界）。 */
function bytesOf(text: string): Uint8Array[] {
  return Array.from(new TextEncoder().encode(text), (b) => new Uint8Array([b]));
}

function sseResponse(chunks: Uint8Array[] | string[], status = 200): Response {
  const encoder = new TextEncoder();
  const encoded: Uint8Array[] =
    typeof chunks[0] === 'string'
      ? (chunks as string[]).map((c) => encoder.encode(c))
      : (chunks as Uint8Array[]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of encoded) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** 取响应体，避免测试中出现非空断言。 */
function sseBody(parts: string[] | Uint8Array[]): ReadableStream<Uint8Array> {
  const body = sseResponse(parts).body;
  if (body === null) {
    throw new Error('测试夹具：响应体不应为空');
  }
  return body;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return (input, init) => handler(String(input), init ?? {});
}

function collect(chunks: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  return (async () => {
    for await (const chunk of chunks) {
      out.push(chunk);
    }
    return out;
  })();
}

const baseMessages = [{ role: 'user' as const, content: '你好' }];

describe('readSseEvents', () => {
  it('解析完整 SSE 流：逐事件产出 data payload，[DONE] 原样产出', async () => {
    const events: string[] = [];
    for await (const e of readSseEvents(sseBody(['data: {"a":1}\n\ndata: [DONE]\n\n']))) {
      events.push(e);
    }
    expect(events).toEqual(['{"a":1}', '[DONE]']);
  });

  it('跨 chunk 逐字节切分（含中文多字节边界）仍正确解析', async () => {
    const full = `${chunkEvent({ content: '中文内容跨块测试' })}data: [DONE]\n\n`;
    const events: string[] = [];
    for await (const e of readSseEvents(sseBody(bytesOf(full)))) {
      events.push(e);
    }
    expect(events).toEqual([
      `{"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"中文内容跨块测试"},"finish_reason":null,"logprobs":null}]}`,
      '[DONE]',
    ]);
  });

  it('容忍 \\r\\n 行尾', async () => {
    const events: string[] = [];
    for await (const e of readSseEvents(sseBody(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n']))) {
      events.push(e);
    }
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('多个 data: 行按标准 SSE 拼接为一条 payload；event:/注释行被忽略', async () => {
    const events: string[] = [];
    for await (const e of readSseEvents(
      sseBody(['event: message\ndata: {"a":1}\ndata: {"b":2}\n\n: 注释行\n\n']),
    )) {
      events.push(e);
    }
    expect(events).toEqual(['{"a":1}\n{"b":2}']);
  });

  it('流结束无尾随空行时 flush 残余事件', async () => {
    const events: string[] = [];
    for await (const e of readSseEvents(sseBody(['data: {"a":1}']))) {
      events.push(e);
    }
    expect(events).toEqual(['{"a":1}']);
  });

  it('空 payload（data: 后无内容）被忽略', async () => {
    const events: string[] = [];
    for await (const e of readSseEvents(sseBody(['data:\n\ndata: {"a":1}\n\n']))) {
      events.push(e);
    }
    expect(events).toEqual(['{"a":1}']);
  });
});

describe('DeepSeekClient.streamChat', () => {
  it('流式产出全部 chunk，遇 [DONE] 提前结束', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([
          chunkEvent({ content: '你' }),
          chunkEvent({ content: '好' }),
          chunkEvent({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'test-key', maxRetries: 0, fetchImpl });
    const chunks = await collect(
      client.streamChat({ model: 'deepseek-v4-flash', messages: baseMessages }),
    );

    expect(chunks.map((c) => c.choices[0]?.delta.content)).toEqual(['你', '好', undefined]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('无 [DONE] 的流自然结束不报错', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => sseResponse([chunkEvent({ content: 'x' })])));
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 0, fetchImpl });
    const chunks = await collect(client.streamChat({ model: 'm', messages: baseMessages }));
    expect(chunks).toHaveLength(1);
  });

  it('发送正确的请求头、URL 与请求体（stream: true）', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => sseResponse(['data: [DONE]\n\n'])));
    const client = new DeepSeekClient({ apiKey: 'secret', maxRetries: 0, fetchImpl });
    await collect(
      client.streamChat({
        model: 'deepseek-v4-pro',
        messages: baseMessages,
        temperature: 0.7,
        maxTokens: 128,
      }),
    );

    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('测试夹具：fetch 未被调用');
    }
    const [url, init] = firstCall;
    if (init === undefined) {
      throw new Error('测试夹具：fetch 未传入 init');
    }
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    });
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      model: 'deepseek-v4-pro',
      stream: true,
      temperature: 0.7,
      max_tokens: 128,
    });
    expect(sent.messages).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('自定义 baseUrl 生效', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => sseResponse(['data: [DONE]\n\n'])));
    const client = new DeepSeekClient({
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      maxRetries: 0,
      fetchImpl,
    });
    await collect(client.streamChat({ model: 'm', messages: baseMessages }));
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.com/v1/chat/completions');
  });

  it('HTTP 429 退避重试后成功', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(
      fakeFetch(async () => {
        calls += 1;
        if (calls <= 2) {
          return new Response('rate limited', { status: 429 });
        }
        return sseResponse(['data: [DONE]\n\n']);
      }),
    );
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 3, retryDelayMs: 1, fetchImpl });
    const chunks = await collect(client.streamChat({ model: 'm', messages: baseMessages }));
    expect(chunks).toHaveLength(0);
    expect(calls).toBe(3);
  });

  it('重试耗尽后抛出 ApiError（带状态码与响应体）', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => new Response('bad gateway', { status: 502 })));
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 1, retryDelayMs: 1, fetchImpl });
    await expect(
      collect(client.streamChat({ model: 'm', messages: baseMessages })),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      body: 'bad gateway',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('连接超时抛 TimeoutError，且按策略重试后成功', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(
      fakeFetch(async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          // 第一次：永不返回，但响应 signal 中断
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        }
        return sseResponse(['data: [DONE]\n\n']);
      }),
    );
    const client = new DeepSeekClient({
      apiKey: 'k',
      maxRetries: 1,
      retryDelayMs: 1,
      timeoutMs: 50,
      fetchImpl,
    });
    const chunks = await collect(client.streamChat({ model: 'm', messages: baseMessages }));
    expect(chunks).toHaveLength(0);
    expect(calls).toBe(2);
  });

  it('maxRetries 为 0 时超时直接抛 TimeoutError', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 0, timeoutMs: 50, fetchImpl });
    await expect(
      collect(client.streamChat({ model: 'm', messages: baseMessages })),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('用户 abort 立即中断、原因上抛且不重试', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 3, fetchImpl });
    const controller = new AbortController();
    const gen = client.streamChat({
      model: 'm',
      messages: baseMessages,
      signal: controller.signal,
    });
    const pending = gen.next();
    controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('abort 前已中断的信号直接上抛，不发起请求', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => sseResponse(['data: [DONE]\n\n'])));
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 3, fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(client.streamChat({ model: 'm', messages: baseMessages, signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('流中中断：统一抛 AbortError，且不重试', async () => {
    const encoder = new TextEncoder();
    let first = true;
    const fetchImpl = vi.fn(
      fakeFetch(async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(encoder.encode(chunkEvent({ content: '前半' })));
            } else {
              controller.error(new TypeError('terminated'));
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 3, fetchImpl });
    const controller = new AbortController();
    const gen = client.streamChat({
      model: 'm',
      messages: baseMessages,
      signal: controller.signal,
    });
    const firstChunk = await gen.next();
    expect(firstChunk.value?.choices[0]?.delta.content).toBe('前半');
    controller.abort();
    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('空响应体抛错', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => new Response(null, { status: 200 })));
    const client = new DeepSeekClient({ apiKey: 'k', maxRetries: 0, fetchImpl });
    await expect(
      collect(client.streamChat({ model: 'm', messages: baseMessages })),
    ).rejects.toThrow('空响应体');
  });

  it('API 错误响应体透传进 ApiError', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(
        async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'bad', maxRetries: 0, fetchImpl });
    await expect(
      collect(client.streamChat({ model: 'm', messages: baseMessages })),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });
});

/**
 * usage 记账（K15）：`DeepSeekClient` 是**唯一**捕获 usage 的地方。
 *
 * ## 为什么这些断言值钱
 *
 * 修 K15 之前，产品层从来没有把「这次花了多少」交出来，脚本只能拿余额差去猜，
 * 而余额只有 2 位小数 + 结算延迟 → 实测花 ¥2.11 仍打印「差 0」，熔断闸门全程静默。
 * 所以这里不仅要断言「记到了数」，还要断言**「记不到时敢说记不到」**：
 * `measured: false` 才是让调用方闭嘴说「未统计」的那根开关。
 */
describe('DeepSeekClient usage 记账（K15）', () => {
  const AT = new Date('2026-10-31T10:00:00+08:00');

  it('探针通电：带 usage 的流真的被记下来（未记账则后续断言全是空转）', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([
          chunkEvent({ content: '好' }),
          usageEvent({ prompt_tokens: 1200, completion_tokens: 300, prompt_cache_hit_tokens: 200 }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', fetchImpl, now: () => AT });
    // 记账前：没量过（不是「花了 0 元」）
    expect(client.usageTotals().measured).toBe(false);
    await collect(client.streamChat({ model: 'deepseek-v4-flash', messages: baseMessages }));
    const totals = client.usageTotals();
    expect(totals.measured).toBe(true);
    expect(totals.calls).toBe(1);
    expect(totals.input).toBe(1200);
    expect(totals.output).toBe(300);
    expect(totals.cacheHit).toBe(200);
    expect(totals.cost).toBeCloseTo(costFor('deepseek-v4-flash', 1200, 300, 200, AT), 12);
  });

  it('无 usage 的流（mock / 老服务端）→ measured=false，绝不伪造 ¥0', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([chunkEvent({ content: 'x' }, 'stop'), 'data: [DONE]\n\n']),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', fetchImpl, now: () => AT });
    await collect(client.streamChat({ model: 'deepseek-v4-flash', messages: baseMessages }));
    const totals = client.usageTotals();
    expect(totals.measured).toBe(false);
    expect(totals.calls).toBe(0);
  });

  it('计价用**本次请求的模型**，不是默认模型（串价会让复核口径失真）', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([
          usageEvent({ prompt_tokens: 1_000_000, completion_tokens: 0 }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', fetchImpl, now: () => AT });
    await collect(client.streamChat({ model: 'deepseek-v4-pro', messages: baseMessages }));
    expect(client.usageTotals().cost).toBeCloseTo(
      costFor('deepseek-v4-pro', 1_000_000, 0, 0, AT),
      12,
    );
  });

  it('未定价模型：token 记下、金额标为未计价（不许把 0 当全款）', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([usageEvent({ prompt_tokens: 10, completion_tokens: 5 }), 'data: [DONE]\n\n']),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', fetchImpl, now: () => AT });
    await collect(client.streamChat({ model: 'custom-endpoint-model', messages: baseMessages }));
    const totals = client.usageTotals();
    expect(totals.input).toBe(10);
    expect(totals.priced).toBe(false);
    expect(totals.unknownModels).toEqual(['custom-endpoint-model']);
  });

  it('多次调用累加（审查的 5 个子代理共用同一 client）', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([
          usageEvent({ prompt_tokens: 100, completion_tokens: 10 }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', fetchImpl, now: () => AT });
    for (let i = 0; i < 3; i += 1) {
      await collect(client.streamChat({ model: 'deepseek-v4-flash', messages: baseMessages }));
    }
    const totals = client.usageTotals();
    expect(totals.calls).toBe(3);
    expect(totals.input).toBe(300);
    expect(totals.output).toBe(30);
  });

  it('请求失败（401）不产生账单，也不会把 total 变成 NaN', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })),
    );
    const client = new DeepSeekClient({ apiKey: 'bad', maxRetries: 0, fetchImpl, now: () => AT });
    await expect(
      collect(client.streamChat({ model: 'deepseek-v4-flash', messages: baseMessages })),
    ).rejects.toMatchObject({ name: 'ApiError' });
    const totals = client.usageTotals();
    expect(totals.measured).toBe(false);
    expect(Number.isFinite(totals.cost)).toBe(true);
  });

  it('resetUsageTotals 清零（「分两段统计」的出口，回到未量过）', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () =>
        sseResponse([usageEvent({ prompt_tokens: 10, completion_tokens: 1 }), 'data: [DONE]\n\n']),
      ),
    );
    const client = new DeepSeekClient({ apiKey: 'k', fetchImpl, now: () => AT });
    await collect(client.streamChat({ model: 'deepseek-v4-flash', messages: baseMessages }));
    expect(client.usageTotals().measured).toBe(true);
    client.resetUsageTotals();
    expect(client.usageTotals().measured).toBe(false);
  });
});
