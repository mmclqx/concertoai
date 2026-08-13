/**
 * LSP 服务器主循环（v4.0 M6 / T6.1~T6.3，`concertoai lsp --stdio`）。
 *
 * 协议流：
 * - initialize（Request）→ 能力声明（textDocumentSync:1 + codeActionProvider）；
 * - textDocument/didOpen / didSave（Notification）→ 三来源诊断 → publishDiagnostics；
 * - textDocument/codeAction（Request）→ CodeAction[]（🔧 用 ConcertoAI 修复 / 行删除）；
 * - shutdown（Request）→ 空结果；exit（Notification）→ 退出循环。
 *
 * 设计：
 * - 与 stdio 解耦：注入 input/output 可读可写流（测试用 PassThrough 模拟客户端）；
 * - 文档内存缓存：didOpen/didChange 维护 {uri → text}，didSave 用缓存文本跑静态规则，
 *   lint/type 用磁盘文件路径（biome/tsc 需要真实文件）；
 * - 诊断异步不阻塞主循环：每个事件触发独立的诊断任务，完成后再推 publishDiagnostics
 *   （避免慢 tsc 阻塞后续 didOpen/exit）；
 * - 三来源 runner 可注入（测试 Fake，避免真实 spawn）。
 */

import type { Readable, Writable } from 'node:stream';
import {
  biomeFixEdits,
  type DiagnosticRunner,
  selfHealCodeActions,
  selfHealStaticDiagnostics,
  sortDiagnostics,
  uriToPath,
} from './diagnostics';
import { encodeMessage, FrameReader } from './framing';
import {
  CODE_ACTION_KIND,
  type CodeAction,
  DIAGNOSTIC_SOURCE,
  type InitializeResult,
  JSONRPC_ERROR,
  LSP_METHOD,
  type LspDiagnostic,
  type PublishDiagnosticsParams,
  type ResponseMessage,
  type TextEdit,
} from './protocol';

/** LSP 服务器选项。 */
export interface LspServerOptions {
  /** 工作目录（biome/tsc 执行 cwd）。 */
  cwd: string;
  /** 输入流（stdin）。 */
  input: Readable;
  /** 输出流（stdout）。 */
  output: Writable;
  /** 诊断执行器（测试注入 Fake；缺省子进程）。 */
  runner?: DiagnosticRunner;
  /** lint 修复器（测试注入 Fake，避免真实 biome；缺省 biomeFixEdits）。 */
  lintFix?: (file: string, cwd: string) => Promise<TextEdit[] | undefined>;
  /** 版本号（serverInfo）。 */
  version?: string;
}

/** 文档缓存（didOpen/didChange 更新；didSave 后保留）。 */
interface OpenDocument {
  uri: string;
  text: string;
  version?: number;
}

/** LSP 服务器：帧循环 + 请求分派 + 诊断推送。 */
export class LspServer {
  private readonly options: LspServerOptions;
  private readonly reader = new FrameReader();
  private readonly documents = new Map<string, OpenDocument>();
  private shuttingDown = false;

  constructor(options: LspServerOptions) {
    this.options = options;
  }

  /** 启动主循环：监听输入流 → 帧解码 → 分派（直到 exit）。 */
  async run(): Promise<void> {
    this.options.input.on('data', (chunk: Buffer | string) => {
      this.reader.push(chunk);
      for (const message of this.reader.readMessages()) {
        this.dispatch(message);
      }
    });
    // 等待 exit（不 resolve 过早：客户端断开/exit 通知驱动）
    await new Promise<void>((resolve) => {
      this.options.input.on('end', () => resolve());
      this.options.input.on('close', () => resolve());
      this.options.input.on('error', () => resolve());
    });
  }

  /** 分派一条消息（Request → 响应；Notification → 处理）。 */
  private dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      this.sendError('unknown', JSONRPC_ERROR.INVALID_REQUEST, '非法消息');
      return;
    }
    const msg = message as { id?: number | string; method?: string; params?: unknown };
    if (typeof msg.method !== 'string') {
      this.sendError(msg.id ?? 'unknown', JSONRPC_ERROR.INVALID_REQUEST, '缺少 method');
      return;
    }
    const isRequest = msg.id !== undefined;
    switch (msg.method) {
      case LSP_METHOD.initialize:
        this.handleInitialize(msg.id as number | string);
        return;
      case LSP_METHOD.shutdown:
        this.shuttingDown = true;
        this.sendResult(msg.id as number | string, null);
        return;
      case LSP_METHOD.exit:
        if (isRequest) {
          this.sendResult(msg.id as number | string, null);
        }
        // 退出循环：结束输入监听（run 的 promise 由 input close/end resolve）
        this.options.input.destroy();
        return;
      case LSP_METHOD.didOpen:
        this.handleDidOpen(msg.params);
        return;
      case LSP_METHOD.didChange:
        this.handleDidChange(msg.params);
        return;
      case LSP_METHOD.didSave:
        this.handleDidSave(msg.params);
        return;
      case LSP_METHOD.codeAction:
        void this.handleCodeAction(msg.id as number | string, msg.params);
        return;
      case LSP_METHOD.initialized:
        return; // 通知，无需处理
      default:
        if (isRequest) {
          this.sendError(
            msg.id as number | string,
            JSONRPC_ERROR.METHOD_NOT_FOUND,
            `未知方法: ${msg.method}`,
          );
        }
    }
  }

  // ── 处理器 ────────────────────────────────────────────────

  /** initialize → 能力声明。 */
  private handleInitialize(id: number | string): void {
    const result: InitializeResult = {
      capabilities: {
        textDocumentSync: 1,
        codeActionProvider: true,
      },
      serverInfo: { name: 'concertoai-lsp', version: this.options.version ?? '0.0.0' },
    };
    this.sendResult(id, result);
  }

  /** didOpen：缓存文档 + 推送诊断。 */
  private handleDidOpen(params: unknown): void {
    const p = params as { textDocument?: { uri?: string; text?: string; version?: number } };
    const td = p.textDocument;
    if (td?.uri === undefined || td.text === undefined) {
      return;
    }
    this.documents.set(td.uri, { uri: td.uri, text: td.text, version: td.version });
    void this.diagnoseAndPublish(td.uri);
  }

  /** didChange（full sync：contentChanges[0].text 为全文）。 */
  private handleDidChange(params: unknown): void {
    const p = params as {
      textDocument?: { uri?: string; version?: number };
      contentChanges?: Array<{ text?: string }>;
    };
    const uri = p.textDocument?.uri;
    const doc = uri !== undefined ? this.documents.get(uri) : undefined;
    const text = p.contentChanges?.at(-1)?.text;
    if (doc === undefined || uri === undefined || text === undefined) {
      return;
    }
    doc.text = text;
    doc.version = p.textDocument?.version;
    // 内容变更也触发诊断：CodeAction 应用后（VS Code 发 didChange）诊断自动刷新，
    // 满足「修复完成后诊断消失」（T6.2 验收）。进行中合并：同一 uri 已有诊断任务则跳过。
    this.diagnoseAndPublish(uri);
  }

  /** didSave：保存即诊断（lint / type / self-heal 三来源）。 */
  private handleDidSave(params: unknown): void {
    const p = params as { textDocument?: { uri?: string } };
    const uri = p.textDocument?.uri;
    if (uri === undefined) {
      return;
    }
    // 更新缓存（didSave 的 text 可选；无 text 时保留 didChange 缓存）
    const saveText = (params as { text?: string }).text;
    const doc = this.documents.get(uri);
    if (doc !== undefined && saveText !== undefined) {
      doc.text = saveText;
    }
    void this.diagnoseAndPublish(uri);
  }

  /** codeAction：为关联诊断生成修复（lint → biome fix；self-heal R1/R3 → 行删除）。 */
  private async handleCodeAction(id: number | string, params: unknown): Promise<void> {
    const p = params as {
      textDocument?: { uri?: string };
      context?: { diagnostics?: LspDiagnostic[] };
    };
    const uri = p.textDocument?.uri;
    const diags = p.context?.diagnostics ?? [];
    if (uri === undefined) {
      this.sendResult(id, []);
      return;
    }
    const actions: CodeAction[] = [];
    const doc = this.documents.get(uri);
    const filePath = uriToPath(uri);

    // 1. lint 诊断：「🔧 用 ConcertoAI 修复」（biome check --write 副本 → 整文件替换）
    const lintDiags = diags.filter((d) => d.source === DIAGNOSTIC_SOURCE.lint);
    if (lintDiags.length > 0) {
      const edits = await (this.options.lintFix ?? biomeFixEdits)(filePath, this.options.cwd);
      if (edits !== undefined && edits.length > 0) {
        actions.push({
          title: '🔧 用 ConcertoAI 修复',
          kind: CODE_ACTION_KIND.quickfix,
          diagnostics: lintDiags,
          edit: { changes: { [uri]: edits } },
        });
      }
    }

    // 2. self-heal R1/R3：行删除修复（基于缓存文本；无缓存则跳过）
    const healDiags = diags.filter((d) => d.source === DIAGNOSTIC_SOURCE.selfHeal);
    if (healDiags.length > 0 && doc !== undefined) {
      const changes = selfHealCodeActions(doc.text, healDiags);
      const edits = changes.current;
      if (edits !== undefined && edits.length > 0) {
        // 按诊断拆分：每条诊断一个独立 CodeAction（标题区分）
        for (const diag of healDiags) {
          const lineEdit = edits.find(
            (e: TextEdit) => e.range.start.line === diag.range.start.line,
          );
          if (lineEdit === undefined) {
            continue;
          }
          const title =
            diag.code === 'self-heal/unused-import'
              ? '移除未使用的 import'
              : '移除 console.log 调试语句';
          actions.push({
            title,
            kind: CODE_ACTION_KIND.quickfix,
            diagnostics: [diag],
            edit: { changes: { [uri]: [lineEdit] } },
          });
        }
      }
    }

    this.sendResult(id, actions);
  }

  // ── 诊断推送 ──────────────────────────────────────────────

  /** 诊断进行中的文档集合（同一 uri 合并，避免 didChange 高频触发子进程排队）。 */
  private readonly diagnosing = new Set<string>();
  /** 诊断进行中又有新触发 → 标记 pending，完成后再跑一次（用最新缓存）。 */
  private readonly pendingDiagnostics = new Set<string>();

  /**
   * 对文档执行三来源诊断并推送 publishDiagnostics（异步，不阻塞主循环）。
   * 同一 uri 已有诊断任务进行中 → 标记 pending，当前任务完成后再跑一次
   * （保证最后一次内容变更最终被反映，且不并发多个子进程）。
   */
  private diagnoseAndPublish(uri: string): void {
    if (this.diagnosing.has(uri)) {
      this.pendingDiagnostics.add(uri);
      return;
    }
    this.diagnosing.add(uri);
    void this.runDiagnostics(uri).finally(() => {
      this.diagnosing.delete(uri);
      if (this.pendingDiagnostics.delete(uri)) {
        this.diagnoseAndPublish(uri);
      }
    });
  }

  /** 执行三来源诊断并推送（实际异步体）。 */
  private async runDiagnostics(uri: string): Promise<void> {
    const filePath = uriToPath(uri);
    const doc = this.documents.get(uri);
    const text = doc?.text;

    // 并发执行 lint/type（子进程慢）；self-heal 静态同步
    const [lintDiags, typeDiags] = await Promise.all([
      this.options.runner?.lint(filePath, this.options.cwd) ?? Promise.resolve([]),
      this.options.runner?.type(filePath, this.options.cwd) ?? Promise.resolve([]),
    ]);
    const selfHealDiags = text !== undefined ? selfHealStaticDiagnostics(text) : [];

    const all = sortDiagnostics([...lintDiags, ...typeDiags, ...selfHealDiags]);
    const params: PublishDiagnosticsParams = {
      uri,
      diagnostics: all,
      version: doc?.version,
    };
    this.sendNotification(LSP_METHOD.publishDiagnostics, params);
  }

  // ── 输出 ──────────────────────────────────────────────────

  /** 发送响应（成功）。 */
  private sendResult(id: number | string, result: unknown): void {
    const response: ResponseMessage = { jsonrpc: '2.0', id, result };
    this.write(response);
  }

  /** 发送响应（错误）。 */
  private sendError(id: number | string, code: number, message: string): void {
    const response: ResponseMessage = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    this.write(response);
  }

  /** 发送通知。 */
  private sendNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** 写帧到输出流（同步 Buffer 写入，保证顺序）。 */
  private write(message: unknown): void {
    if (this.shuttingDown && (message as ResponseMessage).id === undefined) {
      return; // shutdown 后不再推通知（诊断）
    }
    this.options.output.write(encodeMessage(message));
  }
}
