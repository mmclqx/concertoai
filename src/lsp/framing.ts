/**
 * LSP stdio 帧编解码（v4.0 M6 / T6.3，跨平台）。
 *
 * LSP 传输层 = Content-Length 帧：
 * ```
 * Content-Length: <bytes>\r\n
 * \r\n
 * <JSON body>
 * ```
 * - 编码（encodeMessage）：JSON.stringify → Content-Length 头 + 空行 + body；
 * - 解码（FrameReader）：从可读流增量读取，按头字段解析正文长度，跨平台
 *   处理 \r\n（帧头）与 \n（POSIX 编辑器写文件场景）——读取时剥离 \r；
 * - 边界：Content-Length 与实际 body 字节数（utf8）严格一致，防止粘包/半包；
 * - 编码/解码均为纯函数 + 流状态机，可独立测试（不依赖真实 stdio）。
 */

// ── 编码 ──────────────────────────────────────────────────────

/**
 * 编码一条 JSON-RPC 消息为 Content-Length 帧。
 * 使用 Buffer.byteLength（utf8 字节数，非字符数）保证跨平台一致。
 */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

// ── 解码（流状态机）──────────────────────────────────────────

/** 帧读取状态。 */
enum FrameState {
  /** 读取头（Content-Length 行）。 */
  Header = 'Header',
  /** 读取空行分隔（\r\n\r\n 或 \n\n）。 */
  Separator = 'Separator',
  /** 读取正文。 */
  Body = 'Body',
}

/** 帧读取器：从任意可读流增量解码 LSP 消息（处理半包/粘包）。 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private state: FrameState = FrameState.Header;
  private contentLength = 0;

  /** 向读取器追加数据（可读流 data 事件回调）。 */
  push(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
    ]);
  }

  /** 尝试从缓冲中取出全部完整消息；不足一条时返回空数组（等待更多数据）。 */
  readMessages(): unknown[] {
    const messages: unknown[] = [];
    for (;;) {
      const message = this.tryReadOne();
      if (message === undefined) {
        return messages;
      }
      messages.push(message);
    }
  }

  /** 尝试读取一条消息；缓冲不足返回 undefined（不消费部分数据）。 */
  private tryReadOne(): unknown | undefined {
    if (this.state === FrameState.Header || this.state === FrameState.Separator) {
      const headerEnd = this.indexOfHeaderEnd();
      if (headerEnd < 0) {
        return undefined;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
      // 消费头 + 分隔（含 \r\n 或 \n 变体）
      const consumed = this.consumeHeader(headerText, headerEnd);
      if (consumed < 0) {
        // 头非法（缺 Content-Length）→ 丢弃该帧头，等待下一条（防御）
        this.buffer = this.buffer.subarray(headerEnd + 2);
        this.state = FrameState.Header;
        return undefined;
      }
      this.buffer = this.buffer.subarray(consumed);
      this.state = FrameState.Body;
    }

    // Body：等足 contentLength 字节
    if (this.buffer.length < this.contentLength) {
      return undefined;
    }
    const body = this.buffer.subarray(0, this.contentLength).toString('utf8');
    this.buffer = this.buffer.subarray(this.contentLength);
    this.state = FrameState.Header;
    this.contentLength = 0;

    try {
      return JSON.parse(body) as unknown;
    } catch {
      // 正文非法 JSON → 丢弃（防御：不中断整个 LSP 会话）
      return undefined;
    }
  }

  /** 查找头结束位置：`\r\n\r\n`（标准）或 `\n\n`（宽松）；返回分隔起始索引或 -1。 */
  private indexOfHeaderEnd(): number {
    const crlf = this.buffer.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
    if (crlf >= 0) {
      return crlf;
    }
    const lf = this.buffer.indexOf(Buffer.from('\n\n', 'ascii'));
    return lf;
  }

  /**
   * 解析头并返回消费字节数（头 + 分隔）。
   * 仅接受 `Content-Length: <n>`（大小写不敏感，容忍空白）；其他头忽略。
   * 缺少 Content-Length → 返回 -1（调用方丢弃该帧头）。
   */
  private consumeHeader(headerText: string, headerEnd: number): number {
    let length: number | undefined;
    for (const line of headerText.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      const m = trimmed.match(/^Content-Length:\s*(\d+)\s*$/i);
      if (m !== undefined && m !== null) {
        length = Number(m[1]);
      }
    }
    if (length === undefined) {
      return -1;
    }
    this.contentLength = length;
    // 分隔长度：\r\n\r\n = 4 字节 / \n\n = 2 字节
    const separatorLen = this.buffer
      .subarray(headerEnd, headerEnd + 4)
      .equals(Buffer.from('\r\n\r\n', 'ascii'))
      ? 4
      : 2;
    return headerEnd + separatorLen;
  }
}
