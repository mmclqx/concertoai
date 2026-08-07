/**
 * JSONL 会话存储：~/.lumen/sessions/<id>.jsonl，每行一条 ChatMessage。
 *
 * - 行结构可续接：append 只追加，resume 读回完整上下文；
 * - 宽松读取：空行跳过，损坏行跳过并计数（容忍手动编辑）；
 * - id 只允许 [\w.-]，防路径穿越。
 */

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ChatMessage } from '../loop/types';

/** 默认会话目录：~/.lumen/sessions/。 */
export const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.lumen', 'sessions');

/** 会话 id 允许的字符集（防路径穿越）。 */
const ID_RE = /^[\w.-]+$/;
/** 列表摘要中首条 user 消息的截断长度。 */
const SUMMARY_MAX_CHARS = 40;

function isEexist(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  messageCount: number;
  /** 会话中第一条 user 消息（截断版，供列表展示）。 */
  firstUserMessage: string | null;
}

export class SessionStore {
  constructor(private readonly dir: string = DEFAULT_SESSION_DIR) {}

  get directory(): string {
    return this.dir;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private resolve(id: string): string {
    if (!ID_RE.test(id)) {
      throw new Error(`非法的会话 id: ${id}`);
    }
    return path.join(this.dir, `${id}.jsonl`);
  }

  /**
   * 创建新会话并写入初始消息，返回会话 id。
   * id 为时间戳（含毫秒）；同毫秒碰撞时用排他创建（wx）检测并换新 id 重试。
   */
  async create(messages: ChatMessage[]): Promise<string> {
    await this.ensureDir();
    const content = messages.map((m) => JSON.stringify(m)).join('\n');
    const body = content === '' ? '' : `${content}\n`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = newSessionId();
      const file = this.resolve(id);
      try {
        await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
        return id;
      } catch (error) {
        if (!isEexist(error)) {
          throw error;
        }
        // 同毫秒 id 碰撞 → 换新 id 重试
      }
    }
    throw new Error('创建会话失败：id 碰撞过多');
  }

  /** 追加一条消息（文件不存在时自动创建）。 */
  async append(id: string, message: ChatMessage): Promise<void> {
    await this.ensureDir();
    const file = this.resolve(id);
    await appendFile(file, `${JSON.stringify(message)}\n`, 'utf8');
  }

  /** 批量追加。 */
  async appendAll(id: string, messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      await this.append(id, message);
    }
  }

  /** 读回会话全部消息；文件不存在时抛错（ENOENT）。 */
  async read(id: string): Promise<{ messages: ChatMessage[]; skippedLines: number }> {
    const file = this.resolve(id);
    const raw = await readFile(file, 'utf8');
    const messages: ChatMessage[] = [];
    let skippedLines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        skippedLines += 1;
      }
    }
    return { messages, skippedLines };
  }

  /** 列出全部会话（最新在前）。 */
  async list(): Promise<SessionSummary[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir);
    const summaries = await Promise.all(
      entries
        .filter((e) => e.endsWith('.jsonl'))
        .map(async (file) => {
          const id = file.slice(0, -'.jsonl'.length);
          const st = await stat(path.join(this.dir, file));
          const { messages } = await this.read(id);
          const firstUser = messages.find((m) => m.role === 'user')?.content ?? null;
          return {
            id,
            createdAt: st.mtimeMs,
            messageCount: messages.length,
            firstUserMessage: firstUser === null ? null : firstUser.slice(0, SUMMARY_MAX_CHARS),
          };
        }),
    );
    // 时间戳 id 天然按创建时间有序，按 id 字典序降序（最新在前）
    // 避免依赖文件系统 mtime 精度（Windows 毫秒级写入不稳定，append 还会刷新 mtime）
    summaries.sort((a, b) => b.id.localeCompare(a.id));
    return summaries;
  }
}

function newSessionId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}
