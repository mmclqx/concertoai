/**
 * `concertoai audit export`（v3.1 M5 / T5.3）：审计日志导出。
 *
 * 遍历 ~/.concertoai/audit/*.jsonl，每个文件复用 `AuditLogger.exportJson()` 读取，
 * 合并后按 seq 保序输出 JSON 数组：
 * - 默认打印到 stdout；
 * - `--out <file>` 写入指定文件（目录不存在自动创建）；
 * - 无审计文件时输出「暂无审计日志」并非错误退出（退出码 0）。
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type AuditEntry, AuditLogger } from '../observable';
import { auditDir } from '../store/paths';

export interface RunAuditCommandOptions {
  /** 导出目标文件（--out）；缺省打印 stdout。 */
  out?: string;
  /** 审计目录（测试注入；缺省 ~/.concertoai/audit/）。 */
  dir?: string;
}

/**
 * 导出全部审计日志为保序 JSON 数组。
 * @returns 退出码（0 = 成功/无日志；非 0 = 异常）
 */
export async function runAuditCommand(options: RunAuditCommandOptions): Promise<number> {
  const dir = options.dir ?? auditDir();
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    files = [];
  }

  if (files.length === 0) {
    console.log('暂无审计日志。');
    return 0;
  }

  // 合并全部 JSONL（复用 AuditLogger.exportJson：读回 + 损坏行跳过），按 seq 保序
  const entries: AuditEntry[] = [];
  for (const file of files) {
    const logger = new AuditLogger(path.join(dir, file));
    entries.push(...(await logger.exportJson()));
  }
  entries.sort((a, b) => a.seq - b.seq);

  const json = JSON.stringify(entries, null, 2);
  if (options.out !== undefined) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, json, 'utf8');
    console.log(`✅ 审计日志已导出到 ${options.out}（${entries.length} 条）。`);
  } else {
    console.log(json);
  }
  return 0;
}
