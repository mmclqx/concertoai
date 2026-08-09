/**
 * JSONL 会话存储：~/.concertoai/sessions/<id>.jsonl，每行一条 ChatMessage。
 *
 * - 行结构可续接：append 只追加，resume 读回完整上下文；
 * - 宽松读取：空行跳过，损坏行跳过并计数（容忍手动编辑与追加中断留下的半行）；
 * - id 只允许 [\w.-]，防路径穿越；
 * - 进程内互斥：同一会话 id 的写入串行化（withLock），并发 append 不交错；
 * - v2.1 性能优化：O_APPEND 原子追加（不再全量读改写），大会话追加 O(1)；
 * - 跨进程冲突检测（尽力而为）：写后校验文件大小，被外部并发修改时抛 SessionConflictError。
 */

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage } from '../loop/types';
import { sessionsDir } from './paths';

/** 默认会话目录：~/.concertoai/sessions/。 */
export const DEFAULT_SESSION_DIR = sessionsDir();

/** 会话 id 允许的字符集（防路径穿越）。 */
const ID_RE = /^[\w.-]+$/;
/** 列表摘要中首条 user 消息的截断长度。 */
const SUMMARY_MAX_CHARS = 40;

function isEexist(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 跨进程写入冲突：会话文件在写入期间被其他进程修改，本次写入未保存。 */
export class SessionConflictError extends Error {
  constructor(id: string) {
    super(`会话文件被其他进程并发修改，本次写入未保存: ${id}`);
    this.name = 'SessionConflictError';
  }
}

/**
 * 追加冲突检测（尽力而为）：追加后文件大小与「写入前大小 + 本次写入字节」不符，
 * 说明写入期间有外部写者介入（本进程的读快照已被覆盖）。
 */
export function isAppendConflict(
  beforeSize: number | null,
  afterSize: number,
  writtenBytes: number,
): boolean {
  return beforeSize !== null && afterSize !== beforeSize + writtenBytes;
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

  /** 进程内互斥：同一会话 id 的写入串行化（promise 链），并发 append 不交错。 */
  private readonly locks = new Map<string, Promise<unknown>>();

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // 链上存「吞掉错误」的版本，避免一次失败卡死后续写入
    this.locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * 锁内追加：O_APPEND 追加写 + 写后冲突校验。
   * - v2.1 性能优化：不再「读全文件 → 拼接 → rename 覆盖」（大会话每次追加 O(n) 全量重写），
   *   改为 O_APPEND 原子追加（单次 write，O(1)），中断最多留下半行（读取端宽容跳过）；
   * - 文件不存在时视为空文件自动创建；冲突（外部并发写入）抛 SessionConflictError。
   */
  private async appendLocked(file: string, id: string, lines: string): Promise<void> {
    const writtenBytes = Buffer.byteLength(lines, 'utf8');
    let beforeSize: number | null = null;
    try {
      const st = await stat(file);
      beforeSize = st.size;
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
    // O_APPEND：追加到末尾，不覆盖已有内容；Node 对单次 write 原子追加
    await appendFile(file, lines, 'utf8');
    const after = await stat(file);
    if (isAppendConflict(beforeSize, after.size, writtenBytes)) {
      throw new SessionConflictError(id);
    }
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

  /** 追加一条消息（文件不存在时自动创建）。原子写入 + 进程内互斥 + 写后冲突校验。 */
  async append(id: string, message: ChatMessage): Promise<void> {
    await this.ensureDir();
    const file = this.resolve(id);
    await this.withLock(id, () => this.appendLocked(file, id, `${JSON.stringify(message)}\n`));
  }

  /** 批量追加（一次锁内批量原子写入）。 */
  async appendAll(id: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.ensureDir();
    const file = this.resolve(id);
    const lines = messages.map((m) => `${JSON.stringify(m)}\n`).join('');
    await this.withLock(id, () => this.appendLocked(file, id, lines));
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
          const full = path.join(this.dir, file);
          const st = await stat(full);
          // v2.1 性能优化：不再走 read()（JSON.parse 每一行），改为单遍扫描——
          // 非空行计数得到 messageCount，解析到首条 user 消息即停止（首条 user
          // 几乎总出现在文件开头几行），大会话可省去数千次 JSON.parse。
          let messageCount = 0;
          let firstUser: string | null = null;
          const raw = await readFile(full, 'utf8');
          for (const line of raw.split('\n')) {
            if (line.trim() === '') {
              continue;
            }
            messageCount += 1;
            if (firstUser === null) {
              try {
                const msg = JSON.parse(line) as ChatMessage;
                if (msg.role === 'user' && typeof msg.content === 'string') {
                  firstUser = msg.content;
                }
              } catch {
                // 损坏行跳过（与 read() 行为一致，不阻断计数）
              }
            }
          }
          return {
            id,
            createdAt: st.mtimeMs,
            messageCount,
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
