/**
 * `doctor --metrics` 汇总测试（v5.0 T21）。
 *
 * 走**真实 CLI 入口**（`runDoctorCommand`）而不是只测渲染纯函数：这条链路的坑一半在
 * 「有没有接上 flag」，只测 `formatMetricsSummary` 会漏掉「`--metrics` 没传也打印指标」
 * 或「传了没打印」这类接线错误。
 *
 * 边缘路径覆盖（AGENTS 测试要求）：
 * ① 第一次运行（指标文件不存在 / 开关默认 off）
 * ② 没有数据时**不许假报统计**（不打印 `0%`、不打印「拒绝率」）
 * ③ 损坏行（手改文件 / 写入被打断）不崩、并如实报跳过条数
 * ④ 关掉开关但历史上存过数据 → 两个事实同时说清（关是关，历史还在）
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor';

let tmp: string;
let log: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-doctor-metrics-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log?.mockRestore();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** 余额查询 stub（避免 doctor 里其他诊断走真实网络）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBalance = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

/** 把事件写成指标 JSONL（= 用户真实磁盘上的形态）。 */
function writeMetrics(file: string, lines: string[]): void {
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

const output = (): string => (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');

/** 跑一次 doctor，复用统一的注入（配置/会话目录/余额 stub 全在 tmp）。 */
async function runDoctor(extra: {
  metrics?: boolean;
  metricsFile?: string;
  metricsEnabled?: boolean;
}): Promise<number> {
  return runDoctorCommand({
    apiKey: 'k',
    configPath: path.join(tmp, 'config.json'),
    sessionDir: path.join(tmp, 'sessions'),
    fetchImpl: async () => jsonResponse(okBalance),
    ...extra,
  });
}

describe('doctor --metrics：开关与接线', () => {
  it('没传 --metrics → 一个字都不打印（默认体检不被打扰）', async () => {
    await runDoctor({});
    expect(output()).not.toContain('本地体验指标');
  });

  it('传了 --metrics → 打印标题、开关状态与存储位置', async () => {
    const file = path.join(tmp, 'metrics.jsonl');
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: true });
    const out = output();
    expect(out).toContain('本地体验指标');
    expect(out).toContain('已开启（本地 JSONL，零上传）');
    expect(out).toContain(`存储位置：${file}`);
  });
});

describe('doctor --metrics：第一次运行（文件不存在 / 默认 off）', () => {
  it('文件不存在 + 未开启 → 说「没有数据」并给开启命令，不打印假统计', async () => {
    const file = path.join(tmp, 'missing.jsonl');
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: false });
    const out = output();
    expect(out).toContain('未开启（默认关闭；开启：concertoai config set metrics on）');
    expect(out).toContain('暂无指标数据（开启后随使用自动累积）');
    // 诚实红线：没有样本时绝不打印比率（0% 会被读成「一次都没通过」）
    expect(out).not.toContain('拒绝率');
    expect(out).not.toContain('通过率');
    expect(out).not.toContain('采纳率');
    expect(out).not.toContain('0%');
  });

  it('指标为空/未开启不算环境故障：退出码仍由其他诊断决定（这里全绿 → 0）', async () => {
    const code = await runDoctor({
      metrics: true,
      metricsFile: path.join(tmp, 'missing.jsonl'),
      metricsEnabled: false,
    });
    expect(code).toBe(0);
  });
});

describe('doctor --metrics：有数据时的逐项数字', () => {
  it('审批 / 提示 / 体检 / 动词四类数字都按固定样本渲染', async () => {
    const file = path.join(tmp, 'metrics.jsonl');
    writeMetrics(file, [
      '{"ts":1,"kind":"approval","durationMs":10,"decision":"approved","level":"low"}',
      '{"ts":2,"kind":"approval","durationMs":20,"decision":"rejected","level":"medium"}',
      '{"ts":3,"kind":"approval","durationMs":30,"decision":"approved","level":"low"}',
      '{"ts":4,"kind":"suggestion","id":"repeated-edit-rejection","adopted":true}',
      '{"ts":5,"kind":"suggestion","id":"slow-approval","adopted":null}',
      '{"ts":6,"kind":"check","ok":true,"passed":5,"failed":0}',
      '{"ts":7,"kind":"verb","verb":"commit"}',
    ]);
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: true });
    const out = output();
    // 3 条审批：平均 (10+20+30)/3=20，中位 20，拒绝 1/3 → 33.3%
    expect(out).toContain('审批：3 次 ｜ 平均 20ms ｜ 中位 20ms ｜ 拒绝率 33.3%');
    // 2 条提示：只有 1 条可观测（null 那条如实报「无法观测 1 条」，不当未采纳）
    expect(out).toContain('提示：2 条 ｜ 可观测 1 条 ｜ 采纳率 100%（无法观测 1 条）');
    expect(out).toContain('体检：1 次 ｜ 通过率 100%');
    expect(out).toContain('动词使用：commit×1');
  });

  it('提示全部无法观测 → 采纳率说「无法评估」，不硬算 0%', async () => {
    const file = path.join(tmp, 'metrics.jsonl');
    writeMetrics(file, [
      '{"ts":1,"kind":"suggestion","id":"run-init-in-other-terminal","adopted":null}',
    ]);
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: true });
    const out = output();
    expect(out).toContain('采纳率无法评估（这份数据里没有可观测的行为）');
    expect(out).not.toContain('采纳率 0%');
  });

  it('只有动词事件 → 没有审批时就不出现审批行（不给空类目凑数）', async () => {
    const file = path.join(tmp, 'metrics.jsonl');
    writeMetrics(file, ['{"ts":1,"kind":"verb","verb":"review"}']);
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: true });
    const out = output();
    expect(out).toContain('动词使用：review×1');
    expect(out).not.toContain('审批：');
  });
});

describe('doctor --metrics：损坏行与开关历史', () => {
  it('损坏行被跳过并如实报条数（手改文件 / 写入被打断）', async () => {
    const file = path.join(tmp, 'metrics.jsonl');
    writeMetrics(file, [
      '{"ts":1,"kind":"verb","verb":"fix"}',
      '{"ts":2,"kind":"verb"', // 半行
      '{"kind":"approval","durationMs":10,"decision":"approved","level":"low"}', // 缺 ts
    ]);
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: true });
    const out = output();
    expect(out).toContain('跳过 2 条损坏行');
    expect(out).toContain('动词使用：fix×1'); // 坏行不影响好行
  });

  it('开关关掉但有历史数据 → 两个事实都说（关是关，历史仍可复盘）', async () => {
    const file = path.join(tmp, 'metrics.jsonl');
    writeMetrics(file, [
      '{"ts":1,"kind":"approval","durationMs":100,"decision":"rejected","level":"high"}',
    ]);
    await runDoctor({ metrics: true, metricsFile: file, metricsEnabled: false });
    const out = output();
    expect(out).toContain('未开启（默认关闭；开启：concertoai config set metrics on）');
    expect(out).toContain('审批：1 次');
  });
});
