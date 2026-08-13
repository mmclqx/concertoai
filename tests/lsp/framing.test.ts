/**
 * LSP 帧编解码测试（v4.0 M6 / T6.3）。
 *
 * 覆盖：
 * - 编码：Content-Length 头 + \r\n\r\n + JSON body（utf8 字节数，中文安全）；
 * - 解码：完整帧 / 半包分块 / 粘包多条 / CRLF 与 LF 变体；
 * - 防御：非法头（缺 Content-Length）丢弃、非法 JSON body 丢弃。
 */

import { describe, expect, it } from 'vitest';
import { encodeMessage, FrameReader } from '../../src/lsp/framing';

describe('encodeMessage', () => {
  it('生成 Content-Length 帧（utf8 字节数，中文安全）', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    const frame = encodeMessage(msg);
    const text = frame.toString('utf8');
    expect(text.startsWith('Content-Length: ')).toBe(true);
    expect(text).toContain('\r\n\r\n');
    // body 是 JSON（不含头）
    const body = text.slice(text.indexOf('\r\n\r\n') + 4);
    expect(JSON.parse(body)).toEqual(msg);
    // Content-Length = body utf8 字节数
    const lengthMatch = text.match(/Content-Length: (\d+)/);
    expect(lengthMatch?.[1]).toBe(String(Buffer.byteLength(body, 'utf8')));
  });
});

describe('FrameReader', () => {
  it('完整帧一次读取', () => {
    const reader = new FrameReader();
    reader.push(encodeMessage({ jsonrpc: '2.0', id: 1, result: 'ok' }));
    const messages = reader.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 1, result: 'ok' });
  });

  it('半包分块：头 + 部分 body 分两次 push，读取两条边界', () => {
    const frame = encodeMessage({ jsonrpc: '2.0', id: 2, method: 'exit' });
    const reader = new FrameReader();
    // 第一次只给一半
    const half = Math.floor(frame.length / 2);
    reader.push(frame.subarray(0, half));
    expect(reader.readMessages()).toHaveLength(0); // 不完整 → 空
    reader.push(frame.subarray(half));
    const messages = reader.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 2, method: 'exit' });
  });

  it('粘包：一次 push 多条 → 全部读出', () => {
    const reader = new FrameReader();
    reader.push(
      Buffer.concat([
        encodeMessage({ jsonrpc: '2.0', id: 1, result: 'a' }),
        encodeMessage({ jsonrpc: '2.0', id: 2, result: 'b' }),
      ]),
    );
    const messages = reader.readMessages();
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it('跨平台：LF-only 帧头（\n\n 分隔）可解析', () => {
    const reader = new FrameReader();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 3, result: 'lf' });
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`;
    reader.push(Buffer.from(frame, 'utf8'));
    const messages = reader.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 3, result: 'lf' });
  });

  it('防御：缺 Content-Length 的帧头被丢弃，后续正常帧仍可读', () => {
    const reader = new FrameReader();
    reader.push(
      Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n', 'ascii'),
    );
    expect(reader.readMessages()).toHaveLength(0);
    // 后续正常帧不受影响
    reader.push(encodeMessage({ jsonrpc: '2.0', id: 4, result: 'after' }));
    const messages = reader.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 4, result: 'after' });
  });

  it('防御：非法 JSON body 被丢弃（不中断会话）', () => {
    const reader = new FrameReader();
    const body = 'not-json{';
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    reader.push(Buffer.from(frame, 'utf8'));
    expect(reader.readMessages()).toHaveLength(0);
    // 后续正常帧可读
    reader.push(encodeMessage({ jsonrpc: '2.0', id: 5, result: 'ok' }));
    expect(reader.readMessages()).toHaveLength(1);
  });
});
