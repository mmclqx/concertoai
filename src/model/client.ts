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
 */
export async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state: SseState = { pendingData: '', hasData: false };
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield* handleLine(line, state);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer !== '') {
      yield* handleLine(buffer, state);
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

function isRetryable(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return false;
  }
  if (error instanceof ApiError) {
    return isRetryableStatus(error.status);
  }
  if (error instanceof TimeoutError || error instanceof TypeError) {
    return true;
  }
  return false;
}

export class DeepSeekClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEEPSEEK_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
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
        if (attempt >= this.maxRetries || !isRetryable(error, params.signal)) {
          throw error;
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
          yield JSON.parse(data) as ChatCompletionChunk;
        }
      } catch (error) {
        // 流中中断统一为 AbortError，便于上层区分「用户中断」与「网络错误」；非中断错误原样上抛。
        if (params.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw error;
      }
      return;
    }
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
