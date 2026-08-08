/**
 * MCP 客户端：单个 MCP 服务的 stdio 连接、握手、工具发现与调用。
 *
 * 设计要点：
 * - stdio transport：spawn 子进程，stdin 写 JSON-RPC 请求，stdout 逐行读响应；
 * - 每行一个完整的 JSON-RPC 消息（newline-delimited JSON）；
 * - 请求经自增 id 与 pending Map 关联，支持并发请求；
 * - 握手：initialize → initialized 通知，握手完成前暂存其他请求；
 * - 连接断开/超时自动清理，错误以结构化 McpClientError 抛出；
 * - 生命周期：connect() → listTools() / callTool() → disconnect()。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  CallToolParams,
  CallToolResult,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  ListToolsResult,
  MCPServerConfig,
  MCPToolDef,
} from './types';
import { MCP_CLIENT_NAME, MCP_CLIENT_VERSION, MCP_PROTOCOL_VERSION } from './types';

// ── 错误类型 ──

export class McpClientError extends Error {
  constructor(
    message: string,
    public readonly serverName: string,
    public readonly code?: number,
  ) {
    super(`[MCP ${serverName}] ${message}`);
    this.name = 'McpClientError';
  }
}

// ── 内部状态 ──

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 请求超时默认值（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

// ── 客户端实现 ──

export class McpClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private cachedTools: MCPToolDef[] | null = null;
  private debug: (msg: string) => void;

  constructor(private readonly config: MCPServerConfig) {
    // 默认静默；设置 MCP_DEBUG=1 环境变量可启用调试输出
    this.debug = process.env.MCP_DEBUG === '1' ? (msg) => console.error(msg) : () => {};
  }

  get serverName(): string {
    return this.config.name;
  }

  // ── 连接生命周期 ──

  /** 启动子进程并完成 MCP 握手。幂等：已连接时直接返回。 */
  async connect(): Promise<void> {
    if (this.process !== null) {
      return;
    }
    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      // Windows 兼容：shell: true 仅在 command 不含空格时安全
      shell: false,
    });

    this.process = proc;

    // 进程意外退出
    proc.on('exit', (code, signal) => {
      const reason = signal !== null ? `信号 ${signal}` : `退出码 ${code}`;
      const err = new McpClientError(`进程意外退出（${reason}）`, this.config.name);
      if (this.initReject !== null) {
        this.initReject(err);
      }
      this.rejectAllPending(err);
      this.process = null;
      this.initialized = false;
    });

    proc.on('error', (err) => {
      const wrapped = new McpClientError(`进程错误: ${err.message}`, this.config.name);
      if (this.initReject !== null) {
        this.initReject(wrapped);
      }
      this.rejectAllPending(wrapped);
      this.process = null;
    });

    // stderr 仅在调试模式下输出（避免污染终端）
    if (proc.stderr !== null) {
      let stderrBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') {
            this.debug(`[MCP ${this.config.name}] ${line}`);
          }
        }
      });
    }

    // stdout 逐行解析 JSON-RPC 消息
    if (proc.stdout === null) {
      throw new McpClientError('MCP 服务进程 stdout 不可用', this.config.name);
    }
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed === '') {
        return;
      }
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
        this.handleMessage(msg);
      } catch {
        this.debug(`[MCP ${this.config.name}] 无法解析响应: ${trimmed.slice(0, 200)}`);
      }
    });

    // 执行握手
    await this.handshake();
  }

  /** 断开连接：终止子进程并清理状态。 */
  disconnect(): void {
    this.initialized = false;
    this.cachedTools = null;
    if (this.process !== null) {
      // 先尝试温和退出
      this.process.stdin?.end();
      this.process.kill('SIGTERM');
      // 500ms 后强杀
      setTimeout(() => {
        if (this.process !== null && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 500);
      this.process = null;
    }
    this.rejectAllPending(new McpClientError('客户端已断开', this.config.name));
  }

  /** 客户端是否已连接并就绪。 */
  get connected(): boolean {
    return this.initialized;
  }

  // ── 工具操作 ──

  /** 获取服务提供的工具列表（连接时缓存，后续调用用缓存）。 */
  async listTools(): Promise<MCPToolDef[]> {
    if (this.cachedTools !== null) {
      return this.cachedTools;
    }
    await this.ensureConnected();
    const result = await this.sendRequest<ListToolsResult>('tools/list');
    this.cachedTools = result.tools;
    return this.cachedTools;
  }

  /** 调用服务提供的工具。 */
  async callTool(params: CallToolParams): Promise<CallToolResult> {
    await this.ensureConnected();
    return this.sendRequest<CallToolResult>(
      'tools/call',
      params as unknown as Record<string, unknown>,
    );
  }

  // ── 内部方法 ──

  /** 确保已连接，未连接时自动连接。 */
  private async ensureConnected(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.connect();
  }

  /** MCP 握手：initialize → initialized。 */
  private async handshake(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // 挂载 init 回调，供进程意外退出时 reject
    const initPromise = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    try {
      // 握手请求与进程存活竞速：进程先死则 reject
      await Promise.race([
        initPromise.then(() => {
          throw new McpClientError('握手期间进程退出', this.config.name);
        }),
        this.sendRequest('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: MCP_CLIENT_NAME,
            version: MCP_CLIENT_VERSION,
          },
        }),
      ]);
      // 握手完成，发送 initialized 通知（无需等待响应）
      this.sendNotification('notifications/initialized', {});
      this.initialized = true;
      this.initResolve?.();
    } catch (error) {
      this.initReject?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /** 发送 JSON-RPC 请求并等待响应。 */
  private sendRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (this.process === null || this.process.stdin === null) {
      return Promise.reject(new McpClientError('未连接', this.config.name));
    }

    const id = this.nextId;
    this.nextId += 1;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const payload = JSON.stringify(request);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpClientError(`请求超时（${method}, ${timeoutMs}ms）`, this.config.name));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      try {
        this.process?.stdin?.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new McpClientError(
            `写入失败: ${error instanceof Error ? error.message : String(error)}`,
            this.config.name,
          ),
        );
      }
    });
  }

  /** 发送 JSON-RPC 通知（无需响应）。 */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (this.process === null || this.process.stdin === null) {
      return;
    }
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const payload = JSON.stringify(notification);
    try {
      this.process.stdin.write(`${payload}\n`);
    } catch {
      // 通知发送失败可忽略（不阻塞主流程）
    }
  }

  /** 处理来自 stdout 的 JSON-RPC 响应/通知。 */
  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // 响应消息（有 id）
    if ('id' in msg && msg.id !== null && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending === undefined) {
        return; // 已超时或未知 id
      }
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error !== undefined) {
        pending.reject(
          new McpClientError(
            `服务器错误: ${msg.error.message} (code ${msg.error.code})`,
            this.config.name,
            msg.error.code,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 通知消息（无 id）—— 当前版本忽略
  }

  /** 断开时拒绝所有待处理请求。 */
  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
