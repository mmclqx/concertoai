/**
 * 审计日志测试（v3.0 M5 / T5.2）。
 *
 * 覆盖验收标准：
 * - append/exportJson：JSONL 追加写入 → 读回保序（seq 自增 + 时间戳 + kind + detail）；
 * - 损坏行跳过（审计不因单行损坏中断）；
 * - 性能基准（§6.1）：单条写入 < 10ms（注入 tmp 路径，避免污染 ~/.concertoai/audit/）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogger } from '../../src/observable';

let tmp: string;
let logFile: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-audit-'));
  logFile = path.join(tmp, 'audit.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('AuditLogger 追加 / 导出', () => {
  it('append 后 exportJson 保序读回（seq 自增 + ts + kind + detail）', async () => {
    const logger = new AuditLogger(logFile);
    await logger.append({ kind: 'message', detail: { id: 'm1', from: 'orchestrator' } });
    await logger.append({ kind: 'state-change', detail: { from: 'pending', to: 'in_progress' } });
    await logger.append({ kind: 'approval', detail: { approved: true } });

    const { entries } = await logger.exportJson();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0]?.kind).toBe('message');
    expect(entries[1]?.kind).toBe('state-change');
    expect(typeof entries[0]?.ts).toBe('number');
    expect(entries[2]?.detail).toEqual({ approved: true });
  });

  it('损坏行跳过，不影响其余记录', async () => {
    const logger = new AuditLogger(logFile);
    await logger.append({ kind: 'message', detail: { id: 'ok' } });
    // 追加一行损坏内容（直接写文件模拟外部损坏）
    const { appendFileSync } = await import('node:fs');
    appendFileSync(logFile, '{broken json}\n', 'utf8');
    await logger.append({ kind: 'rollback', detail: { taskId: 't1' } });

    const { entries, skipped } = await logger.exportJson();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind)).toEqual(['message', 'rollback']);
    // v3.2 M3 / T3.2：损坏行计数返回（不再静默）
    expect(skipped).toBe(1);
  });

  it('文件不存在时 exportJson 返回空数组且 skipped=0', async () => {
    const logger = new AuditLogger(path.join(tmp, 'not-exists.jsonl'));
    expect(await logger.exportJson()).toEqual({ entries: [], skipped: 0 });
  });

  it('path getter 返回日志文件路径', () => {
    const logger = new AuditLogger(logFile);
    expect(logger.path).toBe(logFile);
  });
});

describe('AuditLogger 性能基准（§6.1）', () => {
  it('单条写入 < 10ms', async () => {
    const logger = new AuditLogger(logFile);
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      await logger.append({ kind: 'message', detail: { i } });
    }
    const elapsed = performance.now() - start;
    expect(elapsed / 5).toBeLessThan(10); // 平均单条 < 10ms
    const { entries } = await logger.exportJson();
    expect(entries).toHaveLength(5);
  });
});
