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

import { type Dirent, readdirSync, statSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage } from '../loop/types';
import { sessionsDir } from './paths';

/** 默认会话目录：~/.concertoai/sessions/。 */
export const DEFAULT_SESSION_DIR = sessionsDir();

/** 会话 id 允许的字符集（防路径穿越）。 */
const ID_RE = /^[\w.-]+$/;

/**
 * 会话 id 是否合法（唯一判定源，供 CLI 层在**读盘之前**先说人话）。
 *
 * 为什么导出一个函数而不是把正则复制一份到调用方：复制出来的第二份迟早与这份不同步，
 * 而「哪条命令被放行」这种安全问题历史上已经踩过一次（见 AGENTS 编辑距离那条）。
 */
export function isValidSessionId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * 会话 id 是否是**本程序真实生成**的形状：`YYYYMMDD-HHMMSS-mmm`（定长 8-6-3）。
 *
 * ## 为什么不复用 `isValidSessionId`
 *
 * 那个只做**安全校验**（`^[\w.-]+$`，防路径穿越），几乎任何字符串都通过。
 * 而这里的用途相反：判定「这条记录是不是一次真实会话留下的**证据**」——
 * 判据一旦放宽，测试自己造出来的 id 就会被当成真实会话（v5.3 B4 实测：
 * 测试能造出形状合法的 id，见 `handoffHomeGuard` 的交叉核验）。
 * 故这里是**定长**匹配，与 `newSessionId()` 逐段对应（`padStart(2)` / `padStart(3)`）。
 */
export function isRealSessionIdShape(id: string): boolean {
  return /^\d{8}-\d{6}-\d{3}$/.test(id);
}
/** 列表摘要中首条 user 消息的截断长度。 */
const SUMMARY_MAX_CHARS = 40;

/**
 * 「某个会话 id 的 `.jsonl` 在不在」的**三态**答案（v5.4 候选 1）。
 *
 * ## 为什么不能是 boolean
 *
 * 这个问题的答案直接决定**要不要删用户磁盘上的交接单**（`handoff prune`）。
 * 而 boolean 把两件事压成了一个 `false`：
 * - `absent`：查得到、确实没有；
 * - `unknown`：**根本读不到**（权限 / 路径被占 / IO 错）。
 *
 * 两者对「删」的含义正相反：查无 ⇒ 这份交接单不构成证据，可以清；
 * 读不到 ⇒ 什么都不知道，**必须保留**。压成 boolean 就等于把 IO 错当成「已确认不存在」，
 * 那正是历史上最贵的一句话（`docs/09-踩坑记录/2026-10-31-成本熔断闸门恒不响.md`：
 * 「读不到」必须与「值 = 0」分开）。
 *
 * ## 为什么判定里不许用 `existsSync`
 *
 * 实测（Windows Node 22）：当父路径是个普通文件时，`existsSync(p)` 返回 **false**、
 * 而 `statSync(p)` 抛 **ENOENT**、`readdirSync(p)` 抛 **ENOTDIR** —— `existsSync`
 * **把错误吞成 false**，用它就不可能分出 `absent` 与 `unknown`。
 * 故本函数每一步都看错误码。
 */
export type SessionFileState = 'exists' | 'absent' | 'unknown';

/** 取 Node 的错误码（非 Error 对象给 `undefined`）。 */
function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * 查某个会话 id 的 `.jsonl` 是否存在（三态）。
 *
 * 布局兼容两种：`<root>/<id>.jsonl`（当前）与 `<root>/<projectKey>/<id>.jsonl`
 * （T2.4 项目隔离矩阵）。任一命中即 `exists`。
 *
 * @param id 会话 id（调用方应已用 `isRealSessionIdShape` 判过形状）
 * @param root 会话根目录，默认 `~/.concertoai/sessions/`（**调用期**取 homedir，便于测试注入）
 */
export function sessionFileState(id: string, root: string = sessionsDir()): SessionFileState {
  // ① 根目录本身：不存在 ⇒ 一定 absent；存在但不是目录 / 其它错 ⇒ unknown（不是「没有」）
  try {
    if (!statSync(root).isDirectory()) {
      return 'unknown';
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unknown';
  }
  // ② 当前布局：<root>/<id>.jsonl
  try {
    statSync(path.join(root, `${id}.jsonl`));
    return 'exists';
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return 'unknown';
    }
  }
  // ③ 项目隔离布局：<root>/<projectKey>/<id>.jsonl
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // 根 stat 成功却列不出来 ⇒ 读不到，**不是**「没有」
    return 'unknown';
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      statSync(path.join(root, entry.name, `${id}.jsonl`));
      return 'exists';
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return 'unknown';
      }
    }
  }
  return 'absent';
}

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
    if (!isValidSessionId(id)) {
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
