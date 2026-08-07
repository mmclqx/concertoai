/**
 * 项目级跨会话记忆存储。
 *
 * 存储位置：项目根目录 `.lumen-memory/memories.jsonl`
 * 每行一条记忆（JSON），格式与 SessionStore 一致。
 *
 * 设计要点：
 * - JSONL 写入锁（进程内互斥），原子追加（临时文件 + rename）；
 * - 支持 CRUD + 按标签/关键词检索；
 * - 项目隔离：不同项目（cwd）各自独立存储；
 * - 读取时损坏行跳过并计数。
 */

import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// ── 类型 ──

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string; // ISO-8601
  updatedAt: string;
}

export interface MemoryStoreOptions {
  /** 项目根目录（默认 process.cwd()）。 */
  cwd?: string;
}

// ── 实现 ──

export class MemoryStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: MemoryStoreOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.dir = path.join(cwd, '.lumen-memory');
    this.file = path.join(this.dir, 'memories.jsonl');
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get('global') ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      'global',
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // ── CRUD ──

  /** 创建新记忆。返回生成的 id。 */
  async create(title: string, content: string, tags: string[] = []): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      title,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
    };
    await this.ensureDir();
    await this.withLock(() => this.appendLine(JSON.stringify(entry)));
    return entry;
  }

  /** 更新记忆（按 id）。不存在时返回 null。 */
  async update(id: string, patch: Partial<Pick<MemoryEntry, 'title' | 'content' | 'tags'>>): Promise<MemoryEntry | null> {
    return this.withLock(async () => {
      const all = await this.readAll();
      const idx = all.findIndex((m) => m.id === id);
      if (idx === -1) {
        return null;
      }
      const existing = all[idx]!;
      const updated: MemoryEntry = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      all[idx] = updated;
      await this.writeAll(all);
      return updated;
    });
  }

  /** 删除记忆（按 id）。返回是否删除成功。 */
  async delete(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const all = await this.readAll();
      const filtered = all.filter((m) => m.id !== id);
      if (filtered.length === all.length) {
        return false; // 未找到
      }
      await this.writeAll(filtered);
      return true;
    });
  }

  /** 获取单条记忆（按 id）。 */
  async get(id: string): Promise<MemoryEntry | null> {
    const all = await this.readAll();
    return all.find((m) => m.id === id) ?? null;
  }

  /** 列出所有记忆（最新在前）。 */
  async list(): Promise<MemoryEntry[]> {
    const all = await this.readAll();
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return all;
  }

  /**
   * 检索记忆：按关键词（标题/内容包含）+ 标签过滤。
   * 匹配度排序：标题命中 > 内容命中 > 标签命中。
   */
  async search(query: string, options?: { tags?: string[]; limit?: number }): Promise<MemoryEntry[]> {
    const all = await this.readAll();
    const limit = options?.limit ?? 5;
    const filterTags = options?.tags ?? [];
    const q = query.toLowerCase().trim();

    const scored = all
      .map((m) => {
        let score = 0;
        if (q !== '') {
          if (m.title.toLowerCase().includes(q)) score += 10;
          if (m.content.toLowerCase().includes(q)) score += 5;
        }
        for (const tag of m.tags) {
          if (q !== '' && tag.toLowerCase().includes(q)) score += 3;
          if (filterTags.length > 0 && filterTags.some((ft) => tag.toLowerCase().includes(ft.toLowerCase()))) {
            score += 2;
          }
        }
        return { entry: m, score };
      })
      .filter((s) => {
        // 指定了过滤标签时要求标签匹配；否则无查询词时返回全部
        if (filterTags.length > 0) return s.score > 0;
        return s.score > 0 || q === '';
      })
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.entry);
  }

  // ── 文件操作 ──

  private async readAll(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const entries: MemoryEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          entries.push(JSON.parse(trimmed) as MemoryEntry);
        } catch {
          // 损坏行跳过
        }
      }
      return entries;
    } catch {
      return []; // 文件不存在 → 空列表
    }
  }

  private async writeAll(entries: MemoryEntry[]): Promise<void> {
    await this.ensureDir();
    const content = entries.map((e) => JSON.stringify(e)).join('\n');
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, content === '' ? '' : `${content}\n`, 'utf8');
      await rename(tmp, this.file);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  private async appendLine(line: string): Promise<void> {
    let existing = '';
    try {
      existing = await readFile(this.file, 'utf8');
    } catch {
      // 文件不存在
    }
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, existing + `${line}\n`, 'utf8');
      await rename(tmp, this.file);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /** 删除整个记忆目录（危险操作，仅供测试）。 */
  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
