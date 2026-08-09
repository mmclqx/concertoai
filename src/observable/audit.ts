/**
 * 审计日志（v3.0 M5 / T5.2）。
 *
 * 记录所有 Agent 交互（消息 / 状态变更 / 审批 / 回滚），JSONL 追加写入，
 * 异步不阻塞主流程，可导出为 JSON。满足「所有决策可追溯、可审计」（§3.3）。
 *
 * 关键设计：
 * - JSONL 追加写（fs.promises.appendFile，O_APPEND 模式），复用 v2.1 会话存储风格；
 * - 单条写入异步不阻塞主流程；性能基准（§6.1）单条 < 10ms，由单测断言；
 * - 每条带自增 seq + 时间戳 ts，导出时保序。
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** 审计条目类型：消息 / 状态变更 / 审批 / 回滚。 */
export type AuditKind = 'message' | 'state-change' | 'approval' | 'rollback';

/** 一条审计记录。 */
export interface AuditEntry {
  /** 自增序号（同文件内唯一且有序）。 */
  seq: number;
  /** 时间戳（epoch 毫秒）。 */
  ts: number;
  /** 条目类型。 */
  kind: AuditKind;
  /** 详情（AgentMessage / TaskStateChange / 审批结果 / 回滚事件等结构化对象）。 */
  detail: unknown;
}

/** 默认审计目录（~/.lumen/audit/）。 */
export function defaultAuditDir(): string {
  return path.join(homedir(), '.lumen', 'audit');
}

/**
 * JSONL 审计日志写入器。
 *
 * @param file 日志文件路径（默认 ~/.lumen/audit/<yyyyMMdd-HHmmss>.jsonl；测试可注入 tmp 路径）。
 */
export class AuditLogger {
  private seq = 0;
  private readonly file: string;
  /** 已写入文件路径（供导出/测试断言）。 */
  get path(): string {
    return this.file;
  }

  constructor(file?: string) {
    if (file !== undefined) {
      this.file = file;
    } else {
      mkdirSync(defaultAuditDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this.file = path.join(defaultAuditDir(), `${stamp}.jsonl`);
    }
  }

  /** 异步追加一条审计记录（O_APPEND，不阻塞主流程）。 */
  async append(entry: Omit<AuditEntry, 'seq' | 'ts'>): Promise<void> {
    const line = JSON.stringify({ seq: ++this.seq, ts: Date.now(), ...entry });
    await appendFile(this.file, `${line}\n`, 'utf8');
  }

  /** 读回全部审计记录（按 seq 升序）。损坏行跳过。 */
  async exportJson(): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        entries.push(parsed);
      } catch {
        // 损坏行跳过（审计不因单行损坏中断）
      }
    }
    return entries.sort((a, b) => a.seq - b.seq);
  }
}
