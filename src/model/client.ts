/**
 * DeepSeek 流式客户端（SSE over fetch）。
 *
 * 设计要点：
 * - 基于原生 fetch + ReadableStream 解析 SSE，正确处理跨 chunk 截断与 UTF-8 多字节边界；
 * - 超时：覆盖到响应头返回（首字节前），超时按可重试错误处理（TimeoutError）；
 * - 重试：仅对「首字节前」失败（429 / 5xx / 网络错误 / 超时）指数退避重试，
 *   响应体一旦开始读取（流中）不再重试；
 * - abort：外部 AbortSignal 可随时中断，中断原因原样上抛且不重试。
 */

import { type UsageMetered, UsageTally, type UsageTotals } from './usage-tally';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** 发送给 API 的最小消息形态（T7 的 loop/types 会做统一映射）。 */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ApiToolCall[];
}

export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** DeepSeek 流式响应中单个 SSE 事件（data 行的 JSON）。 */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'system' | 'user' | 'assistant';
      content?: string | null;
      reasoning_content?: string | null;
      /** 流式 tool_calls 增量片段：name/arguments 跨 chunk 累积拼接。 */
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: Usage | null;
}

/** DeepSeek 返回的 token 用量统计。流式响应中出现在最后一个 chunk（finish_reason=stop）上。 */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 缓存命中的输入 token 数（官方返回，可能缺失）。 */
  prompt_cache_hit_tokens?: number;
  /** 缓存未命中的输入 token 数（官方返回，可能缺失）。 */
  prompt_cache_miss_tokens?: number;
}

/** API 函数定义（DeepSeek function-calling 格式）。 */
export interface DeepSeekApiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamChatParams {
  model: string;
  messages: ApiMessage[];
  /** 可用工具定义（DeepSeek function-calling）。不传则模型按纯文本回复。 */
  tools?: DeepSeekApiTool[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string | string[];
  /** 外部中断信号；中断后上抛 signal.reason（缺省为 AbortError）且不重试。 */
  signal?: AbortSignal;
}

/** 会话循环依赖的模型客户端抽象（测试注入 Fake 实现）。 */
export interface ModelClient {
  streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk>;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** 连接超时（毫秒），覆盖到响应头返回为止。默认 30_000。 */
  timeoutMs?: number;
  /** 对可重试错误的最大重试次数（不含首次尝试）。默认 2。 */
  maxRetries?: number;
  /** 退避基数（毫秒），第 n 次重试前等待 retryDelayMs * 2^(n-1)。默认 500。 */
  retryDelayMs?: number;
  /** 测试注入点。默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 时钟（K15）：usage 就地计价时按「本次请求发生时刻」取价格档位。
   *
   * 默认 `() => new Date()`；测试注入固定时刻，避免「白天高峰价 / 夜间空闲价」
   * 的时间依赖型 flaky（与 `providers/deepseek.ts` 的 `now` 同口径）。
   */
  now?: () => Date;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`DeepSeek API 请求失败（HTTP ${status}）: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`请求在 ${timeoutMs}ms 内未建立连接`);
    this.name = 'TimeoutError';
  }
}

/**
 * 端点不可达（K17）：网络层失败（连接被拒 / DNS 失败 / 连接被重置 / 连接中断）的**唯一**归一类型。
 *
 * ## 为什么必须归一（不许把 `TypeError: fetch failed` 原样抛给用户）
 *
 * K17 实测：`config.providers.deepseek.baseUrl = http://127.0.0.1:9/v1` 时，`concertoai run`
 * 的用户看到的是 `[ConcertoAI] 未处理的 Promise 拒绝` + `undici` 内部帧堆栈，**没有一句中文
 * 说明「连不上你配的端点」**——把「你的配置/网络问题」呈现成「程序崩了」。根因就是 `fetch`
 * 在 Node 里对所有网络层失败统一抛 `TypeError('fetch failed')`（真实原因藏在 `cause` 链里），
 * 客户端原样上抛，上层拿不到任何可归因的结构化信息。
 *
 * ## 刻意保留结构化字段，文案在 CLI 层渲染
 *
 * `url` / `detail` 是**事实**（打到哪个 URL、底层错误码是什么），`message` 只是技术兜底串
 * （日志与 TUI 用）；面向用户的措辞由 `src/cli/fatal-report.ts` 走 i18n 渲染——模型层
 * 不 import i18n（保持 `src/model` 无 i18n 依赖的分层）。
 */
export class EndpointUnreachableError extends Error {
  /** 本次请求的完整 URL（含 `/chat/completions`）：用户据此判断是哪个端点。 */
  readonly url: string;
  /** 端点根地址（= 生效的 `baseUrl`）：提示用户去改哪一项配置。 */
  readonly baseUrl: string;
  /** 底层原因（`ECONNREFUSED` / `ENOTFOUND` / 原始 message 兜底）。 */
  readonly detail: string;

  constructor(url: string, baseUrl: string, detail: string, cause?: unknown) {
    super(`无法连接 ${url}（${detail}）`, cause !== undefined ? { cause } : undefined);
    this.name = 'EndpointUnreachableError';
    this.url = url;
    this.baseUrl = baseUrl;
    this.detail = detail;
  }
}

/**
 * 系统 / undici 的网络层错误码集合（用于把 `cause` 链里的原因认出来）。
 *
 * 只收「连不上端点」这一类：DNS 解析失败、连接被拒、连接被重置、不可达、连接超时。
 * **不收** `ERR_INVALID_URL` 这类「配置写错但不是网络」的码——那属于另一类问题，
 * 混进来会让用户按网络去排查一个拼错的 URL。
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * `fetch` 网络层失败的 message 特征（没有 `code` 时的兜底判据：Node 的 undici 报
 * `fetch failed`，流被切断时报 `terminated`，代理场景可能报 `socket hang up`）。
 *
 * 刻意**不收**裸 `TypeError`：程序 bug 也是 `TypeError`，把它归成「你端点配错了」
 * 就是「把软件缺陷的失败说成用户的错」（AGENTS 第 33 条的反面）。
 */
const NETWORK_MESSAGE_PATTERN =
  /fetch failed|terminated|socket hang up|other side closed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo/i;

/** 沿 `cause` 链找第一个错误码（深度上限 4，防自引用）。 */
function findNetworkCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || error === null || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return code;
  }
  return findNetworkCode((error as { cause?: unknown }).cause, depth + 1);
}

/** 沿 `cause` 链拼出可读原因：优先错误码，取不到就用最内层 message，再兜底外层 message。 */
function describeCause(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || typeof error !== 'object') {
    return '未知原因';
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') {
    return code;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    return describeCause(cause, depth + 1);
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : '未知原因';
}

/**
 * 把整条 `cause` 链上的 message 拼成一段文本（判据用）。
 *
 * 为什么必须看**整条链**而不只看最内层：Node 的 undici 对不同失败给的层级不同——
 * 连接被拒时 `TypeError('fetch failed')` → `cause.code = 'ECONNREFUSED'`；
 * 而「端口被 fetch 规范列为禁用端口」时是 `TypeError('fetch failed')` → `cause = Error('bad port')`
 * （**没有 code**）。只认最内层 message 会把后者漏成「未知异常」（K17 实测踩到：
 * 探针用 `127.0.0.1:9` 正好撞上 bad port 分支，第一版归一没命中）。
 */
function collectCauseText(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || typeof error !== 'object') {
    return '';
  }
  const message = (error as { message?: unknown }).message;
  const own = typeof message === 'string' ? message : '';
  const inner = collectCauseText((error as { cause?: unknown }).cause, depth + 1);
  return inner === '' ? own : `${own} ${inner}`;
}

/**
 * 判断一个异常是否属于「网络层连不上端点」。
 *
 * 判据三层，任一命中即算（**不靠类型猜**）：
 * ① `cause` 链里出现已知网络错误码；② `cause` 链（含外层）的 message 命中网络特征串；
 * ③ 已经是归一后的类型。
 *
 * 明确排除：`ApiError`（服务端有回应，属另一类）、`TimeoutError`（有自己的语义与文案）、
 * `AbortError`（用户主动中断，不是缺陷也不是配置问题）。
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof EndpointUnreachableError) {
    return true;
  }
  if (error instanceof ApiError || error instanceof TimeoutError) {
    return false;
  }
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return false;
  }
  if (findNetworkCode(error) !== undefined) {
    return true;
  }
  return NETWORK_MESSAGE_PATTERN.test(collectCauseText(error));
}

/**
 * 把网络层异常归一成 `EndpointUnreachableError`（非网络异常原样返回）。
 *
 * 调用点只有两处（都在 `streamChat`）：① 响应头返回前的 fetch 失败（重试判据之前归一，
 * 保证 `isRetryable` 看到的是归一后的类型）；② 响应体流读取失败（流中断时不重试，直接归一上抛）。
 * 这样「归一」只写一遍，四个花钱链路（loop / autofix / commit-message / self-heal）与
 * 三动词（review / commit / fix）拿到的都是同一个可归因类型。
 */
export function normalizeFetchError(error: unknown, url: string, baseUrl: string): unknown {
  if (!isNetworkFailure(error) || error instanceof EndpointUnreachableError) {
    return error;
  }
  return new EndpointUnreachableError(url, baseUrl, describeCause(error), error);
}

interface SseState {
  /** 当前事件累积的 data 行（多行以 \n 拼接）。 */
  pendingData: string;
  /** 当前事件是否已包含 data 行。 */
  hasData: boolean;
}

function* handleLine(line: string, state: SseState): Generator<string> {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text === '') {
    // 空行 = 事件分隔符
    if (state.hasData) {
      yield state.pendingData;
      state.pendingData = '';
      state.hasData = false;
    }
    return;
  }
  if (text.startsWith('data:')) {
    const payload = text.slice(5).replace(/^ /, '');
    if (payload !== '') {
      state.pendingData = state.hasData ? `${state.pendingData}\n${payload}` : payload;
      state.hasData = true;
    }
  }
  // 其余行（event: / id: / 注释行等）忽略
}

/**
 * 将 SSE 字节流解析为 data 行 payload 序列。
 *
 * - TextDecoder(stream: true) 保证 UTF-8 多字节字符跨 chunk 截断时不产生乱码；
 * - 按 \n 切行、容忍 \r\n；空行作为事件分隔符，多个 data: 行拼接为一条 payload；
 * - 流结束时 flush 尚未以空行收尾的残余事件。
 *
 * v2.1 性能优化：用 cursor 下标逐行消费，仅在每 chunk 末尾 compact 一次，
 * 替代旧实现对每行 buffer.slice(0, newline) + buffer.slice(newline + 1) 的双重复制
 * （SSE 高频小 chunk 场景下字符串复制从 O(行数 × 缓冲区) 降为 O(缓冲区)）。
 */
export async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state: SseState = { pendingData: '', hasData: false };
  let buffer = '';
  let cursor = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n', cursor);
      while (newline !== -1) {
        const line = buffer.slice(cursor, newline);
        cursor = newline + 1;
        yield* handleLine(line, state);
        newline = buffer.indexOf('\n', cursor);
      }
      // compact：丢弃已消费的前缀，避免 buffer 随流增长（每 chunk 至多一次复制）
      if (cursor > 0) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
    }
    if (cursor < buffer.length) {
      yield* handleLine(buffer.slice(cursor), state);
    }
    if (state.hasData) {
      yield state.pendingData;
      state.pendingData = '';
      state.hasData = false;
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 失败是否可重试。
 *
 * K17：网络层失败归一成 `EndpointUnreachableError` 之后仍**必须可重试**（语义与原
 * `TypeError` 等价，重试次数一次没变）；同时刻意不再「见 `TypeError` 就重试」——
 * 归一后还能以 `TypeError` 出现的只剩**程序 bug**，对 bug 重试只是把失败拖慢 3 倍。
 */
function isRetryable(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return false;
  }
  if (error instanceof ApiError) {
    return isRetryableStatus(error.status);
  }
  if (error instanceof TimeoutError || error instanceof EndpointUnreachableError) {
    return true;
  }
  return false;
}

export class DeepSeekClient implements ModelClient, UsageMetered {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  /**
   * 成本计量累加器（K15）：**唯一**捕获 usage 的点。
   *
   * 为什么在 client：4 条花钱链路（loop / autofix / commit-message / self-heal）
   * 拿到的都是同一个 client 实例，单点累加就能覆盖全部，不需要各自透传。
   */
  private readonly tally = new UsageTally();

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEEPSEEK_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 本次 client 生命周期内的累计用量与成本（纯数据快照）。
   *
   * 拿不到 usage 时 `measured === false`：调用方必须说「未统计」，
   * 不能把 0 当成「免费」报给用户。
   */
  usageTotals(): UsageTotals {
    return this.tally.snapshot();
  }

  /** 清零累计（产品侧暂不使用；保留给「分两段统计」的场景）。 */
  resetUsageTotals(): void {
    this.tally.reset();
  }

  /**
   * 流式对话补全。逐 chunk 产出直到 [DONE] 或流自然结束。
   * 首字节前失败按策略重试；流开始后的错误（含 JSON 损坏、网络中断）直接上抛。
   */
  async *streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: true,
      ...(params.tools !== undefined && params.tools.length > 0 ? { tools: params.tools } : {}),
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
      stop: params.stop,
    });

    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, body, params.signal);
      } catch (error) {
        // K17：先归一（`TypeError: fetch failed` → `EndpointUnreachableError`），再判重试——
        // 这样「重试耗尽后抛给用户的那个错误」与「可重试判据看到的错误」是同一个类型。
        const normalized = normalizeFetchError(error, url, this.baseUrl);
        if (attempt >= this.maxRetries || !isRetryable(normalized, params.signal)) {
          throw normalized;
        }
        attempt += 1;
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        if (attempt < this.maxRetries && isRetryableStatus(response.status)) {
          attempt += 1;
          await sleep(this.retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new ApiError(response.status, text);
      }
      if (response.body === null) {
        throw new Error('DeepSeek API 返回了空响应体');
      }

      try {
        for await (const data of readSseEvents(response.body)) {
          if (data === '[DONE]') {
            return;
          }
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          // K15：usage 就地记账（在 yield 之前记，用户中断也已产生的 token 不会漏账）
          this.recordUsage(chunk, params.model);
          yield chunk;
        }
      } catch (error) {
        // 流中中断统一为 AbortError，便于上层区分「用户中断」与「网络错误」；
        // 非中断错误先做网络层归一（K17：断流也是「连不上端点」的一种，原文案无从归因）。
        if (params.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw normalizeFetchError(error, url, this.baseUrl);
      }
      return;
    }
  }

  /** 记录单个 chunk 携带的 usage（绝大多数 chunk 没有，只管记录不改变流）。 */
  private recordUsage(chunk: ChatCompletionChunk, model: string): void {
    if (chunk.usage === undefined || chunk.usage === null) {
      return;
    }
    this.tally.add(chunk.usage, model, this.now());
  }

  private async fetchWithTimeout(
    url: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new TimeoutError(this.timeoutMs)),
      this.timeoutMs,
    );
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
