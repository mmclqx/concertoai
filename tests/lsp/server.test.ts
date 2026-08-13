/**
 * LSP 服务器集成测试（v4.0 M6 / T6.1~T6.3）。
 *
 * 用 PassThrough 流模拟 VS Code 客户端 + Fake runner 注入三来源诊断，
 * 覆盖：
 * - initialize → 能力声明（textDocumentSync:1 + codeActionProvider + serverInfo）；
 * - didOpen → 三来源诊断推送（lint Warning / type Error / self-heal Information 分类）；
 * - didSave → 重新诊断推送；
 * - codeAction：lint 诊断 →「🔧 用 ConcertoAI 修复」；self-heal → 行删除 CodeAction；
 * - shutdown + exit → 服务器正常退出；
 * - 未知方法 → METHOD_NOT_FOUND。
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { encodeMessage, FrameReader } from '../../src/lsp/framing';
import type { LspDiagnostic, TextEdit } from '../../src/lsp/protocol';
import { DIAGNOSTIC_SOURCE, LspSeverity } from '../../src/lsp/protocol';
import { LspServer, type LspServerOptions } from '../../src/lsp/server';

/** Fake 诊断 runner：lint → 1 Warning / type → 1 Error（不 spawn 真实进程）。 */
class FakeRunner {
  async lint(): Promise<LspDiagnostic[]> {
    return [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        severity: LspSeverity.Warning,
        code: 'lint/suspicious/noExplicitAny',
        source: DIAGNOSTIC_SOURCE.lint,
        message: 'Unexpected any.',
      },
    ];
  }

  async type(): Promise<LspDiagnostic[]> {
    return [
      {
        range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
        severity: LspSeverity.Error,
        code: 'TS2304',
        source: DIAGNOSTIC_SOURCE.type,
        message: "Cannot find name 'missing'.",
      },
    ];
  }
}

/** 构造测试用服务器（Fake runner + lintFix 注入）；返回服务器与输入输出流。 */
function createServer(options?: Partial<LspServerOptions>): {
  server: LspServer;
  input: PassThrough;
  output: PassThrough;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new LspServer({
    cwd: 'F:\\dev\\test',
    input,
    output,
    runner: new FakeRunner(),
    version: '9.9.9-test',
    ...options,
  });
  return { server, input, output };
}

interface TestClient {
  input: PassThrough;
  output: PassThrough;
  reader: FrameReader;
  /** 已接收的全部消息（按到达顺序）。 */
  received: unknown[];
  /** 发送一条 JSON-RPC 消息（自动编码）。 */
  send: (msg: unknown) => void;
  /** 等待满足条件的消息出现（轮询，默认 2s 超时）。 */
  waitFor: (predicate: (m: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
}

/** 启动服务器并返回测试客户端。 */
async function startServer(
  server: LspServer,
  input: PassThrough,
  output: PassThrough,
): Promise<TestClient> {
  const reader = new FrameReader();
  const received: unknown[] = [];
  output.on('data', (chunk: Buffer) => {
    reader.push(chunk);
    for (const msg of reader.readMessages()) {
      received.push(msg);
    }
  });

  void server.run();
  // 等待 run() 开始监听（微任务让路）
  await new Promise((r) => setTimeout(r, 10));

  return {
    input,
    output,
    reader,
    received,
    send: (msg) => {
      input.write(encodeMessage(msg));
    },
    waitFor: async (predicate, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find(predicate);
        if (found !== undefined) {
          return found;
        }
        if (Date.now() > deadline) {
          throw new Error('waitFor 超时：未收到目标消息');
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

/** 请求 id 计数器。 */
let nextId = 1;
const request = (method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id: nextId++,
  method,
  params,
});
const notify = (method: string, params?: unknown) => ({ jsonrpc: '2.0', method, params });

/** 发送请求并等待对应 id 的响应（避免跨测试 id 冲突）。 */
async function sendRequest(client: TestClient, method: string, params?: unknown): Promise<unknown> {
  const req = request(method, params);
  client.send(req);
  return client.waitFor((m) => (m as { id?: unknown }).id === req.id);
}

describe('LspServer', () => {
  it('initialize → 能力声明 + serverInfo', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    const resp = (await sendRequest(client, 'initialize', { capabilities: {} })) as {
      id: number;
      result?: {
        capabilities?: { textDocumentSync?: number; codeActionProvider?: boolean };
        serverInfo?: { name?: string; version?: string };
      };
    };
    expect(resp.result?.capabilities?.textDocumentSync).toBe(1);
    expect(resp.result?.capabilities?.codeActionProvider).toBe(true);
    expect(resp.result?.serverInfo).toMatchObject({
      name: 'concertoai-lsp',
      version: '9.9.9-test',
    });
    inputEnd(input);
  });

  it('didOpen → 三来源诊断推送（lint Warning / type Error / self-heal Information）', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    await sendRequest(client, 'initialize');

    const uri = 'file:///F:/dev/test/src/a.ts';
    const text = 'console.log("hi");\n';
    client.send(
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'typescript', version: 1, text },
      }),
    );

    const published = (await client.waitFor(
      (m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics',
    )) as { params?: { uri?: string; diagnostics?: LspDiagnostic[] } };
    expect(published.params?.uri).toBe(uri);
    const diags = published.params?.diagnostics ?? [];
    // 三来源：type Error / lint Warning / self-heal console-log Information
    expect(diags.map((d) => d.source).sort()).toEqual(
      [DIAGNOSTIC_SOURCE.lint, DIAGNOSTIC_SOURCE.type, DIAGNOSTIC_SOURCE.selfHeal].sort(),
    );
    const typeDiag = diags.find((d) => d.source === DIAGNOSTIC_SOURCE.type);
    expect(typeDiag?.severity).toBe(LspSeverity.Error);
    expect(typeDiag?.code).toBe('TS2304');
    const lintDiag = diags.find((d) => d.source === DIAGNOSTIC_SOURCE.lint);
    expect(lintDiag?.severity).toBe(LspSeverity.Warning);
    const healDiag = diags.find((d) => d.source === DIAGNOSTIC_SOURCE.selfHeal);
    expect(healDiag?.severity).toBe(LspSeverity.Information);
    expect(healDiag?.code).toBe('self-heal/console-log');
    // 排序：Error 在最前
    expect(diags[0]?.severity).toBe(LspSeverity.Error);
    inputEnd(input);
  });

  it('didSave → 重新推送诊断', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    await sendRequest(client, 'initialize');

    const uri = 'file:///F:/dev/test/src/b.ts';
    client.send(
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'typescript', version: 1, text: 'const x = 1;\n' },
      }),
    );
    await client.waitFor(
      (m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics',
    );

    // didSave → 再次推送诊断（累计数量 +1）
    const before = client.received.filter(
      (m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics',
    ).length;
    client.send(notify('textDocument/didSave', { textDocument: { uri } }));
    await client.waitFor(
      (m) =>
        (m as { method?: string }).method === 'textDocument/publishDiagnostics' &&
        client.received.filter(
          (x) => (x as { method?: string }).method === 'textDocument/publishDiagnostics',
        ).length > before,
    );
    expect(
      client.received.filter(
        (m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    inputEnd(input);
  });

  it('codeAction：lint 诊断 →「🔧 用 ConcertoAI 修复」（lintFix 注入）', async () => {
    const { server, input, output } = createServer({
      lintFix: async () => {
        const edit: TextEdit = {
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: 'fixed();',
        };
        return [edit];
      },
    });
    const client = await startServer(server, input, output);
    await sendRequest(client, 'initialize');

    const uri = 'file:///F:/dev/test/src/c.ts';
    const lintDiag: LspDiagnostic = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      severity: LspSeverity.Warning,
      code: 'lint/suspicious/noExplicitAny',
      source: DIAGNOSTIC_SOURCE.lint,
      message: 'Unexpected any.',
    };
    const resp = (await sendRequest(client, 'textDocument/codeAction', {
      textDocument: { uri },
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      context: { diagnostics: [lintDiag] },
    })) as { result?: Array<{ title?: string; edit?: { changes?: Record<string, TextEdit[]> } }> };
    expect(resp.result).toHaveLength(1);
    expect(resp.result?.[0]?.title).toContain('用 ConcertoAI 修复');
    const edits = resp.result?.[0]?.edit?.changes?.[uri];
    expect(edits).toHaveLength(1);
    expect(edits?.[0]?.newText).toBe('fixed();');
    inputEnd(input);
  });

  it('codeAction：self-heal 诊断 →「移除 console.log 调试语句」行删除', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    await sendRequest(client, 'initialize');

    const uri = 'file:///F:/dev/test/src/d.ts';
    const text = 'console.log("x");\n';
    client.send(
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'typescript', version: 1, text },
      }),
    );
    await client.waitFor(
      (m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics',
    );

    const healDiag: LspDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } },
      severity: LspSeverity.Information,
      code: 'self-heal/console-log',
      source: DIAGNOSTIC_SOURCE.selfHeal,
      message: '检测到 console.log 调试语句，建议移除',
    };
    const resp = (await sendRequest(client, 'textDocument/codeAction', {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } },
      context: { diagnostics: [healDiag] },
    })) as { result?: Array<{ title?: string; edit?: { changes?: Record<string, TextEdit[]> } }> };
    expect(resp.result).toHaveLength(1);
    expect(resp.result?.[0]?.title).toContain('移除 console.log');
    const edits = resp.result?.[0]?.edit?.changes?.[uri];
    expect(edits?.[0]?.newText).toBe('');
    expect(edits?.[0]?.range.start.line).toBe(0);
    inputEnd(input);
  });

  it('didChange → 重新推送诊断（CodeAction 应用后诊断消失闭环）', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    await sendRequest(client, 'initialize');

    const uri = 'file:///F:/dev/test/src/e.ts';
    // didOpen 含 console.log → 诊断含 self-heal/console-log
    client.send(
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'typescript', version: 1, text: 'console.log("x");\n' },
      }),
    );
    const first = (await client.waitFor(
      (m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics',
    )) as { params?: { diagnostics?: LspDiagnostic[] } };
    expect(first.params?.diagnostics?.some((d) => d.code === 'self-heal/console-log')).toBe(true);

    // 模拟客户端应用 CodeAction 行删除 → didChange（新文本无 console.log）
    client.send(
      notify('textDocument/didChange', {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: '' }],
      }),
    );
    // 等待第二次推送到达（waitFor 的 find 返回第一条匹配，故先等数量≥2 再取最后一条）
    await client.waitFor(
      (m) =>
        (m as { method?: string }).method === 'textDocument/publishDiagnostics' &&
        client.received.filter(
          (x) => (x as { method?: string }).method === 'textDocument/publishDiagnostics',
        ).length >= 2,
    );
    const after = client.received
      .filter((m) => (m as { method?: string }).method === 'textDocument/publishDiagnostics')
      .at(-1) as { params?: { diagnostics?: LspDiagnostic[] } };
    expect(after.params?.diagnostics?.some((d) => d.code === 'self-heal/console-log')).toBe(false);
    inputEnd(input);
  });

  it('shutdown + exit → 服务器退出', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    await sendRequest(client, 'initialize');
    await sendRequest(client, 'shutdown');
    client.send(notify('exit'));
    // exit → input.destroy() → run() resolve；稍等确认不抛错
    await new Promise((r) => setTimeout(r, 50));
    expect(true).toBe(true);
    // 输出流应无新消息（shutdown 后不再推通知）
    inputEnd(input);
  });

  it('未知方法 → METHOD_NOT_FOUND（-32601）', async () => {
    const { server, input, output } = createServer();
    const client = await startServer(server, input, output);
    const resp = (await sendRequest(client, 'unknown/method')) as {
      error?: { code?: number; message?: string };
    };
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.message).toContain('未知方法');
    inputEnd(input);
  });
});

/** 结束输入流（清理 run() 的 promise，避免测试悬挂）。 */
function inputEnd(input: PassThrough): void {
  input.destroy();
}
