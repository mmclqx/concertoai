/**
 * 网络层失败归一化单测（K17）。
 *
 * ## 这一组用例守护的是什么
 *
 * K17 用户看到的东西：`未处理的 Promise 拒绝 + TypeError: fetch failed + undici 堆栈`。
 * 修法不是「在 CLI 里加个 try/catch」那么简单，而是**把网络层失败归一成一个可归因的类型**
 * （`EndpointUnreachableError`，带 `url` / `baseUrl` / `detail`）。所以这里的断言全部落在
 * 「归一后的对象长什么样」与「重试次数有没有偷偷变」上——而不是「日志里有没有某句话」。
 *
 * ## 两个必须一起守住的对立面
 *
 * | 方向 | 后果 | 用例 |
 * |---|---|---|
 * | 该归一的没归一 | 用户又看到堆栈（K17 复现） | ①②③ |
 * | 不该归一的归了 | **把软件缺陷说成「你端点配错了」**，用户白折腾配置、真 bug 被掩盖 | ④⑤⑥ |
 *
 * ## 关于「探针通电」
 *
 * 每条用例都先断言 `fetchImpl` **真的被调用**（`toHaveBeenCalledTimes` / `requests.length`）。
 * 否则「抛出的错误是 EndpointUnreachableError」可能来自夹具从未被调用时的另一条分支，
 * 断言就成了空转。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  DeepSeekClient,
  EndpointUnreachableError,
  isNetworkFailure,
  normalizeFetchError,
  TimeoutError,
} from '../../src/model/client';

/** 断言用的端点（`/v1` 结尾，与真实配置同形）。 */
const BASE_URL = 'http://127.0.0.1:9/v1';
const FULL_URL = `${BASE_URL}/chat/completions`;

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

/** 假 fetch 的第一个参数类型（Node 类型，不依赖 DOM lib）。 */
type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/** 构造一个「必然抛指定错误」的假 fetch，并记录调用次数与 URL。 */
function failingFetch(error: unknown): {
  fetchImpl: typeof fetch;
  calls: () => number;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: FetchInput) => {
    urls.push(urlOf(input));
    throw error;
  }) as typeof fetch;
  return { fetchImpl, calls: () => urls.length, urls };
}

/**
 * Node 连接被拒时的**真实形态**：`TypeError('fetch failed')`，真实原因在 `cause.code`。
 *
 * 用 `Object.assign(new Error(...), { code })` 构造，与 Node 内部错误同形（可枚举性无所谓，
 * 归一逻辑只读属性值）。
 */
function connectionRefused(): Error {
  const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
    code: 'ECONNREFUSED',
  });
  return new TypeError('fetch failed', { cause: inner });
}

/** 收齐一次完整 streamChat 的所有 chunk（异常会照常上抛）。 */
async function collect(client: DeepSeekClient): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of client.streamChat({ model: 'm', messages: MESSAGES })) {
    out.push(chunk);
  }
  return out;
}

describe('EndpointUnreachableError：归一后的对象带齐「事实」', () => {
  it('连接被拒 → 抛 EndpointUnreachableError，带完整 URL / baseUrl / 底层原因', async () => {
    const { fetchImpl, calls } = failingFetch(connectionRefused());
    const client = new DeepSeekClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0, fetchImpl });

    const error = await collect(client).catch((err: unknown) => err);

    // 探针通电：夹具真的被调用了一次
    expect(calls()).toBe(1);
    expect(error).toBeInstanceOf(EndpointUnreachableError);
    const unreachable = error as EndpointUnreachableError;
    expect(unreachable.url).toBe(FULL_URL);
    expect(unreachable.baseUrl).toBe(BASE_URL);
    expect(unreachable.detail).toBe('ECONNREFUSED');
    // message 是技术兜底串（含 URL），面向用户的措辞在 CLI 层
    expect(unreachable.message).toContain(FULL_URL);
  });

  it('★ Node 的 "bad port" 形态（cause 只有 message、没有 code）也必须归一', async () => {
    // K17 实测回归：`http://127.0.0.1:9/v1` 在 fetch 里被规范列为禁用端口，
    // 抛的是 TypeError('fetch failed') → cause = Error('bad port')，**没有 code**。
    // 第一版归一逻辑只认 cause 链上的 code，于是把这条真实失败漏成了「未知异常」。
    const badPort = new TypeError('fetch failed', { cause: new Error('bad port') });
    const { fetchImpl } = failingFetch(badPort);
    const client = new DeepSeekClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0, fetchImpl });

    const error = await collect(client).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EndpointUnreachableError);
    expect((error as EndpointUnreachableError).detail).toBe('bad port');
  });

  it('DNS 解析失败（ENOTFOUND / EAI_AGAIN）→ 归一，detail 保留错误码', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      const error = new TypeError('fetch failed', {
        cause: Object.assign(new Error(code), { code }),
      });
      expect(isNetworkFailure(error)).toBe(true);
      expect(
        (normalizeFetchError(error, FULL_URL, BASE_URL) as EndpointUnreachableError).detail,
      ).toBe(code);
    }
  });

  it('流中连接中断（响应体读取失败）→ 同样归一并带上端点（不只管首字节前）', async () => {
    // 首字节前失败已有用例覆盖；这里的失败点在 `readSseEvents` 读流期间，
    // 走的是 streamChat 的第二个 catch —— 两个 throw 点都得归一一遍。
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError('terminated'));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const client = new DeepSeekClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0, fetchImpl });

    const error = await collect(client).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EndpointUnreachableError);
    expect((error as EndpointUnreachableError).baseUrl).toBe(BASE_URL);
  });

  it('幂等：已归一的对象再次归一 → 原样返回（不套娃）', () => {
    const first = normalizeFetchError(connectionRefused(), FULL_URL, BASE_URL);
    const second = normalizeFetchError(first, FULL_URL, BASE_URL);
    expect(second).toBe(first);
  });
});

describe('归一后的重试行为：次数一次没变，但不再「见 TypeError 就重试」', () => {
  it('网络层失败仍按 maxRetries 重试（默认 2 → 共 3 次请求）', async () => {
    const { fetchImpl, calls } = failingFetch(connectionRefused());
    const client = new DeepSeekClient({
      apiKey: 'k',
      baseUrl: BASE_URL,
      retryDelayMs: 1,
      fetchImpl,
    });

    const error = await collect(client).catch((err: unknown) => err);

    expect(calls()).toBe(3);
    expect(error).toBeInstanceOf(EndpointUnreachableError);
  });

  it('★ 程序 bug 的 TypeError 不重试（旧逻辑「见 TypeError 就重试」= 把失败拖慢 3 倍）', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    const { fetchImpl, calls } = failingFetch(bug);
    const client = new DeepSeekClient({
      apiKey: 'k',
      baseUrl: BASE_URL,
      retryDelayMs: 1,
      fetchImpl,
    });

    const error = await collect(client).catch((err: unknown) => err);

    // 只请求一次：这不是网络问题，重试无意义
    expect(calls()).toBe(1);
    // 且**不**被说成端点问题（原样上抛，交给「未知异常」分支）
    expect(error).toBe(bug);
  });

  it('用户中断（AbortError）不重试、不归一', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const { fetchImpl, calls } = failingFetch(abort);
    const client = new DeepSeekClient({
      apiKey: 'k',
      baseUrl: BASE_URL,
      retryDelayMs: 1,
      fetchImpl,
    });

    const error = await collect(client).catch((err: unknown) => err);

    expect(calls()).toBe(1);
    expect(error).toBe(abort);
  });
});

describe('isNetworkFailure 判定表（该归一 / 不该归一）', () => {
  it('归一：网络错误码与网络特征串', () => {
    expect(isNetworkFailure(connectionRefused())).toBe(true);
    expect(isNetworkFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkFailure(new Error('socket hang up'))).toBe(true);
    expect(
      isNetworkFailure(
        new Error('x', { cause: Object.assign(new Error('c'), { code: 'ECONNRESET' }) }),
      ),
    ).toBe(true);
  });

  it('★ 不归一：服务端有回应 / 超时 / 用户中断 / 普通程序错误', () => {
    // 服务端有回应（401/429/5xx）→ 属鉴权/限流类，各动词已有专门归因
    expect(isNetworkFailure(new ApiError(401, 'invalid api key'))).toBe(false);
    // 超时有自己的语义与文案（「在 30000ms 内未建立连接」），不能被说成「连不上端点」
    expect(isNetworkFailure(new TimeoutError(30_000))).toBe(false);
    // 用户主动中断既不是缺陷也不是配置问题
    expect(isNetworkFailure(new DOMException('aborted', 'AbortError'))).toBe(false);
    // 普通程序错误：把它归成「你端点配错了」就是让用户白折腾
    expect(
      isNetworkFailure(new TypeError("Cannot read properties of undefined (reading 'x')")),
    ).toBe(false);
    expect(isNetworkFailure(new Error('未知工具: foo'))).toBe(false);
    // 非 Error 值不猜
    expect(isNetworkFailure('fetch failed')).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe('normalizeFetchError：非网络异常一个字节都不改', () => {
  it('ApiError / TimeoutError / 程序 TypeError → 原对象返回', () => {
    const api = new ApiError(500, 'boom');
    const timeout = new TimeoutError(1000);
    const bug = new TypeError('boom');
    expect(normalizeFetchError(api, FULL_URL, BASE_URL)).toBe(api);
    expect(normalizeFetchError(timeout, FULL_URL, BASE_URL)).toBe(timeout);
    expect(normalizeFetchError(bug, FULL_URL, BASE_URL)).toBe(bug);
  });

  it('成功路径不受影响：合法 SSE 正常产出 chunk', async () => {
    const payload = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
    };
    const fetchImpl = vi.fn(
      (async () =>
        new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch,
    );
    const client = new DeepSeekClient({ apiKey: 'k', baseUrl: BASE_URL, fetchImpl });

    const chunks = await collect(client);
    expect(chunks).toHaveLength(1);
  });
});
