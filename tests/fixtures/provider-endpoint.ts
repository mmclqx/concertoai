/**
 * K14 测试夹具：**自定义端点**（企业代理 / 自建中转 / Ollama 网关）的假 fetch。
 *
 * ## 为什么做成夹具而不是每个用例各写一遍
 *
 * K14 的病是「静默换端点」，唯一有牙的断言是「**请求打到了哪个 URL**」。
 * 三动词（review / commit / fix）的端到端用例都要这条证据，各写一份 SSE 拼装
 * 既容易漂移（一处改了别处忘了），也容易把「拼错了的 SSE」误判成「端点没被读到」。
 *
 * ## 为什么默认返回 401
 *
 * 401 让调用链**必然走错误分支**：不需要我编一份「看起来像审查结果」的假输出，
 * 用例就只聚焦一件事——`fetch` 收到的 URL 是什么。
 * 需要「量到 usage 并打成本行」的用例用 `sseChatFetch()`（返回合法 SSE + usage）。
 */

/** 记录下来的请求（URL + body，便于断言模型/端点都传对了）。 */
export interface RecordedRequest {
  url: string;
  body: unknown;
}

/**
 * `fetch` 的第一个参数类型（`string | URL | Request`）。
 *
 * 直接写 `RequestInfo` 会红：本项目的 tsconfig 不带 DOM lib（Node 环境），
 * `RequestInfo` 是 DOM 类型别名。用 `Parameters<typeof fetch>[0]` 拿到的就是
 * Node 类型里真实存在的那个联合类型，不依赖 lib 配置。
 */
type FetchInput = Parameters<typeof fetch>[0];

/** 假 fetch 句柄。 */
export interface FakeFetch {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
}

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * 必然 401 的假 fetch（不联网、不花钱）。
 *
 * 用途：断言「请求真的打到配置里的 baseUrl」+ 调用链的错误分支行为。
 */
export function unauthorizedFetch(): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: FetchInput, init?: RequestInit) => {
    requests.push({
      url: urlOf(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response('{"error":{"message":"probe: 401 from fake endpoint"}}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** 一条 SSE 事件（`data: <json>` + 空行）。 */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 返回**合法 SSE** 的假 fetch：一段文本 + 一条 usage + `[DONE]`。
 *
 * usage 是必须的：K15 的成本回执只有在客户端真的量到 usage 时才会打出来，
 * 而 K14 要断言的是「这行在自定义端点下会标注非账单」——两者必须在同一个用例里闭环。
 */
export function sseChatFetch(
  options: { content: string; promptTokens?: number } = { content: 'ok' },
): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: FetchInput, init?: RequestInit) => {
    requests.push({
      url: urlOf(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const body = [
      sseEvent({
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta: { content: options.content }, finish_reason: null }],
      }),
      sseEvent({
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: options.promptTokens ?? 1000,
          completion_tokens: 200,
          prompt_cache_hit_tokens: 0,
        },
      }),
      'data: [DONE]\n\n',
    ].join('');
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}
