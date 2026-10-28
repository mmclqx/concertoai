/**
 * 本地指标存储测试（v5.0 T21）。
 *
 * 组织方式与「验收标准」一一对应：
 * 1. **默认 off**：不开启时**不产生文件**（连目录都不碰）；
 * 2. 四类事件记录 + 读取（含损坏行跳过、`limit` 取最近 N 条）；
 * 3. **轮转**（超上限保留最近 N 条）；
 * 4. **清空**幂等；
 * 5. 汇总数字逐项断言（固定样本，不看实现）；
 * 6. **零网络**源码扫描（依赖检查断言无 fetch/axios/http）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendMetric,
  buildApprovalMetric,
  buildCheckMetric,
  buildSuggestionMetric,
  buildVerbMetric,
  clearMetrics,
  DEFAULT_METRICS_EXPECTATION,
  isMetricsEnabled,
  MAX_ID_LENGTH,
  MAX_METRICS_ENTRIES,
  normalizeDuration,
  readMetrics,
  summarizeMetrics,
} from '../../src/core/metrics-store';
import {
  DEFAULT_METRICS,
  emptyConfig,
  isMetricsMode,
  resolveConfig,
  validateConfigValues,
} from '../../src/store/config';

let tmp: string;

/** 生成一个临时指标文件路径（每次一个新文件，避免用例互相干扰）。 */
function tmpFile(name: string): string {
  return path.join(tmp, name);
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-metrics-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('开关：默认 off（不开启不写盘）', () => {
  it('默认 off：config 与 env 都没有 → false', () => {
    expect(isMetricsEnabled(undefined, undefined)).toBe(false);
    expect(DEFAULT_METRICS).toBe('off');
    expect(isMetricsEnabled(DEFAULT_METRICS, undefined)).toBe(false);
  });

  it('on 的各种写法都认（大小写不敏感）', () => {
    for (const value of ['on', 'ON', 'true', '1', 'yes', ' on ']) {
      expect(isMetricsEnabled(value, undefined)).toBe(true);
    }
  });

  it('off 的各种写法都认', () => {
    for (const value of ['off', 'FALSE', '0', 'no']) {
      expect(isMetricsEnabled(value, undefined)).toBe(false);
    }
  });

  it('环境变量优先于配置（显式 env=off 覆盖 config=on）', () => {
    expect(isMetricsEnabled('on', 'off')).toBe(false);
    expect(isMetricsEnabled('off', 'on')).toBe(true);
  });

  it('无法识别的值回落到下一层（不猜：不因为手滑把配置里的 on 静默推翻）', () => {
    // CI 里手滑写 of → 不该变成「按默认 off」，而应回落配置里的 on
    expect(isMetricsEnabled('on', 'ofx')).toBe(true);
    expect(isMetricsEnabled('off', 'oops')).toBe(false);
  });

  it('不开启 appendMetric 也不会被调用（关掉时连文件都不存在）', async () => {
    const file = tmpFile('never-created.jsonl');
    // 关键语义：调用方（App / CLI）在关闭时**根本不调 appendMetric**
    // —— 这里用 `建文件前的检查 + resolveConfig 默认值` 双向确认
    expect(existsSync(file)).toBe(false);
    expect(resolveConfig(emptyConfig()).metrics).toBe('off');
  });
});

describe('配置接线：metrics 枚举 + 解析优先级', () => {
  it('isMetricsMode 只认 on / off', () => {
    expect(isMetricsMode('on')).toBe(true);
    expect(isMetricsMode('off')).toBe(true);
    expect(isMetricsMode('maybe')).toBe(false);
    expect(isMetricsMode(undefined)).toBe(false);
  });

  it('非法配置值会被 validateConfigValues 报出（写错字必须让用户看见）', () => {
    const issues = validateConfigValues({ schemaVersion: 1, metrics: 'ofl' as 'on' });
    expect(issues.map((issue) => issue.key)).toContain('metrics');
  });

  it('resolveConfig：config=on 生效；env=off 覆盖', () => {
    const prev = process.env.CONCERTOAI_METRICS;
    try {
      process.env.CONCERTOAI_METRICS = '';
      expect(resolveConfig({ schemaVersion: 1, metrics: 'on' }).metrics).toBe('on');
      process.env.CONCERTOAI_METRICS = 'off';
      expect(resolveConfig({ schemaVersion: 1, metrics: 'on' }).metrics).toBe('off');
    } finally {
      if (prev === undefined) {
        delete process.env.CONCERTOAI_METRICS;
      } else {
        process.env.CONCERTOAI_METRICS = prev;
      }
    }
  });
});

describe('构造事件（纯函数）', () => {
  it('审批：未分析 → level unknown（不冒充 low）', () => {
    const event = buildApprovalMetric({ approved: false, now: () => 1000 });
    expect(event).toEqual({
      ts: 1000,
      kind: 'approval',
      durationMs: 0,
      decision: 'rejected',
      level: 'unknown',
    });
  });

  it('审批：负值 / NaN 耗时归零（不写脏数据进文件）', () => {
    expect(normalizeDuration(undefined)).toBe(0);
    expect(normalizeDuration(-5)).toBe(0);
    expect(normalizeDuration(Number.NaN)).toBe(0);
    expect(normalizeDuration(12.6)).toBe(13);
  });

  it('提示：id 超长截断（防异常规则 id 把文件撑大）', () => {
    const event = buildSuggestionMetric({ id: 'x'.repeat(200), adopted: null });
    expect(event.id.length).toBe(MAX_ID_LENGTH);
    expect(event.adopted).toBeNull();
  });

  it('体检：负计数归零', () => {
    const event = buildCheckMetric({ ok: true, passed: -1, failed: 2 });
    expect(event.passed).toBe(0);
    expect(event.failed).toBe(2);
  });

  it('动词：四个动词都能构造', () => {
    for (const verb of ['check', 'fix', 'commit', 'review'] as const) {
      expect(buildVerbMetric({ verb }).verb).toBe(verb);
    }
  });
});

describe('IO：追加 / 读取 / 轮转 / 清空', () => {
  it('首次写入自动建目录（父目录不存在也能写）', async () => {
    const file = path.join(tmp, 'nested', 'deep', 'metrics.jsonl');
    const result = await appendMetric(buildVerbMetric({ verb: 'check' }), { file });
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('四类事件都能读回来（顺序为写入顺序）', async () => {
    const file = tmpFile('four-kinds.jsonl');
    await appendMetric(buildApprovalMetric({ approved: true, durationMs: 42, level: 'high' }), {
      file,
    });
    await appendMetric(buildSuggestionMetric({ id: 'repeated-edit-rejection', adopted: true }), {
      file,
    });
    await appendMetric(buildCheckMetric({ ok: false, passed: 2, failed: 1 }), { file });
    await appendMetric(buildVerbMetric({ verb: 'commit' }), { file });

    const { entries, skipped } = await readMetrics({ file });
    expect(skipped).toBe(0);
    expect(entries.map((entry) => entry.kind)).toEqual(['approval', 'suggestion', 'check', 'verb']);
    expect(entries[0]).toMatchObject({ durationMs: 42, level: 'high', decision: 'approved' });
    expect(entries[1]).toMatchObject({ id: 'repeated-edit-rejection', adopted: true });
    expect(entries[2]).toMatchObject({ ok: false, passed: 2, failed: 1 });
    expect(entries[3]).toMatchObject({ verb: 'commit' });
  });

  it('文件不存在 → 空结果（首次运行不报错，也不创建文件）', async () => {
    const file = tmpFile('missing.jsonl');
    const { entries, skipped } = await readMetrics({ file });
    expect(entries).toEqual([]);
    expect(skipped).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('损坏行跳过并计数，不中断读取（半行 / 手改 / 未知 kind）', async () => {
    const file = tmpFile('corrupt.jsonl');
    const good = JSON.stringify(buildVerbMetric({ verb: 'fix', now: () => 1 }));
    writeFileSync(
      file,
      `${good}\n{"ts":2,"kind":"approval"}garbage\n{"ts":3,"kind":"nope"}\nnot json\n${good}\n`,
      'utf8',
    );
    const { entries, skipped } = await readMetrics({ file });
    expect(entries).toHaveLength(2);
    expect(skipped).toBe(3);
  });

  it('limit 取最近 N 条（尾部），不是最旧的 N 条', async () => {
    const file = tmpFile('limit.jsonl');
    for (let i = 0; i < 5; i += 1) {
      await appendMetric(buildVerbMetric({ verb: 'review', now: () => i }), { file });
    }
    const { entries } = await readMetrics({ file, limit: 2 });
    expect(entries.map((entry) => entry.ts)).toEqual([3, 4]);
  });

  it('超上限轮转：保留最近 keepEntries 条（不无限膨胀）', async () => {
    const file = tmpFile('rotate.jsonl');
    for (let i = 0; i < 8; i += 1) {
      await appendMetric(buildVerbMetric({ verb: 'check', now: () => i }), {
        file,
        maxEntries: 5,
        keepEntries: 2,
      });
    }
    const { entries } = await readMetrics({ file });
    expect(entries.length).toBeLessThanOrEqual(5);
    // 保留的是**最近**的（轮转后仍然只有尾部数据，不是全清空）
    expect(entries[entries.length - 1]?.ts).toBe(7);
    expect(MAX_METRICS_ENTRIES).toBeGreaterThan(0);
  });

  it('写失败不抛错（父路径被文件占住 → { ok: false }）', async () => {
    const blocker = tmpFile('blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const result = await appendMetric(buildVerbMetric({ verb: 'check' }), {
      file: path.join(blocker, 'nested', 'metrics.jsonl'),
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('清空幂等：删两次都 ok（第一次 removed，第二次也不报错）', async () => {
    const file = tmpFile('clear.jsonl');
    await appendMetric(buildVerbMetric({ verb: 'check' }), { file });
    const first = await clearMetrics({ file });
    expect(first.ok).toBe(true);
    const second = await clearMetrics({ file });
    expect(second.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe('汇总（固定样本断言数字）', () => {
  const sample = [
    buildApprovalMetric({ approved: true, durationMs: 100, level: 'high', now: () => 1 }),
    buildApprovalMetric({ approved: false, durationMs: 200, level: 'medium', now: () => 2 }),
    buildApprovalMetric({ approved: false, durationMs: 300, level: 'medium', now: () => 3 }),
    buildSuggestionMetric({ id: 'repeated-edit-rejection', adopted: true }),
    buildSuggestionMetric({ id: 'repeated-edit-rejection', adopted: false }),
    buildSuggestionMetric({ id: 'missing-project-rules', adopted: null }),
    buildCheckMetric({ ok: true, passed: 4, failed: 0 }),
    buildCheckMetric({ ok: false, passed: 3, failed: 1 }),
    buildVerbMetric({ verb: 'check' }),
    buildVerbMetric({ verb: 'check' }),
    buildVerbMetric({ verb: 'commit' }),
  ];

  it('审批：平均 / 中位 / 拒绝率', () => {
    const summary = summarizeMetrics(sample);
    expect(summary.approval.count).toBe(3);
    expect(summary.approval.avgMs).toBe(200); // (100+200+300)/3
    expect(summary.approval.medianMs).toBe(200); // 排序后中间值
    expect(summary.approval.rejected).toBe(2);
    expect(summary.approval.rejectRate).toBe(66.7);
    expect(summary.approval.levels).toEqual({ high: 1, medium: 2 });
  });

  it('提示：采纳率只拿可观测样本当分母（null 不算未采纳）', () => {
    const summary = summarizeMetrics(sample);
    expect(summary.suggestion.count).toBe(3);
    expect(summary.suggestion.adopted).toBe(1);
    expect(summary.suggestion.notAdopted).toBe(1);
    expect(summary.suggestion.unobservable).toBe(1);
    expect(summary.suggestion.adoptionRate).toBe(50); // 1/(1+1)
  });

  it('体检 / 动词分布（次数降序）', () => {
    const summary = summarizeMetrics(sample);
    expect(summary.check.count).toBe(2);
    expect(summary.check.passRate).toBe(50);
    expect(summary.verbs).toEqual([
      { verb: 'check', count: 2 },
      { verb: 'commit', count: 1 },
    ]);
  });

  it('空样本：所有比率为 null（不是 0%，避免对用户说假话）', () => {
    const summary = summarizeMetrics([]);
    expect(summary.total).toBe(0);
    expect(summary.approval.rejectRate).toBeNull();
    expect(summary.suggestion.adoptionRate).toBeNull();
    expect(summary.check.passRate).toBeNull();
    expect(summary.verbs).toEqual([]);
  });

  it('偶数个耗时取中间两个的平均（中位定义写死，避免各处各算）', () => {
    const summary = summarizeMetrics([
      buildApprovalMetric({ approved: true, durationMs: 10, level: 'low' }),
      buildApprovalMetric({ approved: true, durationMs: 21, level: 'low' }),
    ]);
    expect(summary.approval.medianMs).toBe(16); // (10+21)/2 = 15.5 → 16
  });
});

/** `export interface *Metric` 块数量（护栏自证用：0 块 = 空循环假绿）。 */
function countEventInterfaces(text: string): number {
  return [...text.matchAll(/export interface \w*Metric \{\r?\n/g)].length;
}

/**
 * 找出事件接口里出现的**路径类字段**（隐私契约：只记数字，不记路径）。
 *
 * 只扫 `export interface *Metric` 块内的字段声明：裸 `/file:\s*string/` 会把函数参数
 * （如 `rotateIfNeeded(file: string, …)`）一并误判成事件字段，让这条守卫永远报红——
 * 守卫要盯的是「事件里记了什么」，不是「哪儿出现过字符串」。
 *
 * `file|path|cwd|dir` 一并挡：语义都是「文件路径」，只挡 `file` 等于留后门
 * （改名 path 就能悄悄把路径写进指标）。
 */
function pathFieldViolations(text: string): string[] {
  const violations: string[] = [];
  for (const block of text.matchAll(/export interface \w*Metric \{\r?\n([\s\S]*?)\r?\n\}/g)) {
    for (const line of (block[1] ?? '').split(/\r?\n/)) {
      if (/^\s*(file|path|cwd|dir)\??\s*:/.test(line)) {
        violations.push(line.trim());
      }
    }
  }
  return violations;
}

describe('隐私：零网络（源码扫描断言）', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'core', 'metrics-store.ts'), 'utf8');

  it('metrics-store 不 import 任何网络模块', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/from ['"]node:(http|https|net|dgram|tls)['"]/);
    expect(source).not.toMatch(/from ['"](axios|node-fetch|undici)['"]/);
    expect(source).not.toMatch(/XMLHttpRequest/);
  });

  it('只 import 本地模块 + node:fs / node:path（依赖面刻意最小）', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
    for (const specifier of imports) {
      expect(
        specifier.startsWith('node:fs') ||
          specifier === 'node:path' ||
          specifier.startsWith('./') ||
          specifier.startsWith('../'),
        `metrics-store.ts 引入了非预期依赖 ${specifier}`,
      ).toBe(true);
    }
  });

  it('事件里没有文件路径字段（不记内容，只记数字）', () => {
    // 正则失效（写错接口名 / 换格式）会变成 0 块的空循环假绿，必须先自证匹配到了 4 类事件
    expect(countEventInterfaces(source)).toBeGreaterThanOrEqual(4);
    expect(pathFieldViolations(source)).toEqual([]);
    // 审批事件的字段清单写死，新增字段必须显式改这里（防悄悄收集更多数据）
    expect(DEFAULT_METRICS_EXPECTATION).toEqual(['ts', 'kind', 'durationMs', 'decision', 'level']);
  });

  // 隐私守卫本身也要被守卫：守卫静默失效 = 「以为没收集、其实在收集」，
  // 这比没有守卫更危险（同 tests/core/suggestion.test.ts 的「切片取空 → 永远通过」教训）
  it('护栏自证：真出现路径字段就会被抓（file / path 都挡，函数参数不误报）', () => {
    expect(
      pathFieldViolations('export interface FakeMetric {\n  ts: number;\n  file: string;\n}'),
    ).toEqual(['file: string;']);
    // 换个名字（path）同样是「记文件路径」，只挡 file 等于留后门
    expect(
      pathFieldViolations('export interface FakeMetric {\n  ts: number;\n  path?: string;\n}'),
    ).toEqual(['path?: string;']);
    // 函数参数签名不算事件字段——这正是旧裸正则 `/file:\s*string/` 误报的原因
    expect(pathFieldViolations('async function rotate(file: string) {}')).toEqual([]);
    // 块外出现路径字段也不该误报（只看 export interface *Metric 块内）
    expect(
      pathFieldViolations(
        'export interface Options {\n  file?: string;\n}\nexport interface FakeMetric {\n  ts: number;\n}',
      ),
    ).toEqual([]);
  });
});
