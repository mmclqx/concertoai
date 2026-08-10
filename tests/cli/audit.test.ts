/**
 * audit export 测试（v3.1 M5 / T5.3）。
 *
 * 覆盖验收标准：
 * - 保序 JSON 数组导出（多文件合并按 seq 排序）；
 * - --out 写入指定文件（目录不存在自动创建）；
 * - 无审计文件 → 「暂无审计日志」并非错误退出（退出码 0）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAuditCommand } from '../../src/cli/audit';
import { AuditLogger } from '../../src/observable';

let tmp: string;
let auditDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
  auditDir = path.join(tmp, 'audit');
  mkdirSync(auditDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 写一个审计文件并追加若干条记录。 */
async function writeAuditFile(name: string, kinds: string[]): Promise<void> {
  const logger = new AuditLogger(path.join(auditDir, name));
  for (const kind of kinds) {
    await logger.append({ kind: kind as 'message', detail: { label: kind } });
  }
}

describe('audit export', () => {
  it('无审计文件 → 输出「暂无审计日志」且退出码 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runAuditCommand({ dir: path.join(tmp, 'empty') });
    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('暂无审计日志');
    log.mockRestore();
  });

  it('默认输出保序 JSON 数组（多文件按 seq 合并）', async () => {
    await writeAuditFile('a.jsonl', ['message']);
    await writeAuditFile('b.jsonl', ['state-change', 'approval']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runAuditCommand({ dir: auditDir });
    expect(code).toBe(0);
    const printed = String(log.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(printed) as Array<{ seq: number; kind: string }>;
    expect(parsed).toHaveLength(3);
    // 保序：seq 升序
    expect(parsed.map((e) => e.seq)).toEqual([1, 1, 2]);
    expect(parsed.map((e) => e.kind)).toEqual(['message', 'state-change', 'approval']);
    log.mockRestore();
  });

  it('--out 写入文件（目录不存在自动创建）', async () => {
    await writeAuditFile('a.jsonl', ['message', 'approval']);
    const out = path.join(tmp, 'nested', 'out', 'audit.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runAuditCommand({ dir: auditDir, out });
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as Array<{ seq: number }>;
    expect(parsed).toHaveLength(2);
    expect(log.mock.calls[0]?.[0]).toContain('已导出');
    log.mockRestore();
  });

  it('损坏行跳过（复用 AuditLogger.exportJson 宽松读取）', async () => {
    writeFileSync(path.join(auditDir, 'a.jsonl'), '{bad json}\n', 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runAuditCommand({ dir: auditDir });
    expect(code).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0] ?? '[]')) as unknown[];
    expect(parsed).toHaveLength(0);
    log.mockRestore();
  });
});
