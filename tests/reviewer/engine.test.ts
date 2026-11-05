/**
 * Reviewer Agent 集成测试（v2.1 M6）。
 *
 * 覆盖：/review 命令解析、引擎结果聚合、报告格式化。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeReviewCommand, parseReviewCommand } from '../../src/cli/slash/review';
import { setLocale } from '../../src/i18n';
import { zh } from '../../src/i18n/zh';
import {
  AGENT_DIMENSIONS,
  ALL_DIMENSIONS,
  CONDENSE_LIMIT,
  classifySubagentFailure,
  createReviewAgents,
  determineReviewAction,
  extractJsonErrorSummary,
  formatTestStatus,
  hasVerifyScript,
  incompleteCount,
  type ReviewIncompleteReason,
  type ReviewReport,
  reviewGroupOfAgentName,
} from '../../src/reviewer';
import { formatContextArtifacts, ReviewerEngine } from '../../src/reviewer/engine';
import type { ReviewDimension, ReviewIssue } from '../../src/reviewer/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-review-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 命令解析 ──────────────────────────────────────────────

describe('parseReviewCommand', () => {
  it('/review → auto 模式', () => {
    expect(parseReviewCommand('/review')).toEqual({ type: 'auto' });
  });

  it('/review --pr → PR 模式', () => {
    expect(parseReviewCommand('/review --pr')).toEqual({ type: 'pr' });
  });

  it('/review src/tools → files 模式', () => {
    expect(parseReviewCommand('/review src/tools')).toEqual({
      type: 'files',
      paths: ['src/tools'],
    });
  });

  it('/review src/a.ts src/b.ts → 多文件', () => {
    const cmd = parseReviewCommand('/review src/a.ts src/b.ts');
    expect(cmd).toEqual({ type: 'files', paths: ['src/a.ts', 'src/b.ts'] });
  });

  it('非 /review 命令 → null', () => {
    expect(parseReviewCommand('hello')).toBeNull();
    expect(parseReviewCommand('/plan task')).toBeNull();
  });
});

// ── 命令执行 ──────────────────────────────────────────────

describe('executeReviewCommand', () => {
  it('auto 模式 → 提示审查范围', () => {
    const result = executeReviewCommand({ type: 'auto' });
    expect(result.handled).toBe(false);
    expect(result.message?.content).toContain('🔍');
    expect(result.message?.content).toContain('最近修改');
  });

  it('PR 模式 → 提示 PR diff', () => {
    const result = executeReviewCommand({ type: 'pr' });
    expect(result.message?.content).toContain('PR diff');
  });

  it('files 模式 → 显示文件列表', () => {
    const result = executeReviewCommand({ type: 'files', paths: ['src/a.ts'] });
    expect(result.message?.content).toContain('src/a.ts');
  });
});

// ── 报告格式化 ────────────────────────────────────────────

describe('ReviewerEngine.formatReport', () => {
  it('空报告 → 显示无问题', () => {
    const report = makeReport([]);
    const text = ReviewerEngine.formatReport(report);
    expect(text).toContain('审查报告');
    expect(text).toContain('未发现明显问题');
  });

  it('含 critical 问题 → 按严重程度分组', () => {
    const issues: ReviewIssue[] = [
      makeIssue('security', 'critical', 'src/a.ts', 'SQL 注入风险'),
      makeIssue('types', 'critical', 'src/b.ts', 'any 滥用'),
      makeIssue('style', 'suggestion', 'src/c.ts', '命名建议'),
    ];
    const report = makeReport(issues);
    const text = ReviewerEngine.formatReport(report);

    expect(text).toContain('🔴 严重问题');
    expect(text).toContain('🟢 改进建议');
    expect(text).toContain('SQL 注入风险');
    expect(text).toContain('any 滥用');
  });

  it('汇总表包含各维度统计', () => {
    const issues: ReviewIssue[] = [makeIssue('types', 'critical', 'src/x.ts', '类型问题')];
    const report = makeReport(issues);
    const text = ReviewerEngine.formatReport(report);

    expect(text).toContain('📊 汇总');
    expect(text).toContain('types');
    expect(text).toContain('1'); // critical count
  });

  /**
   * C4（v5.0 自审发现）：0 问题时「📊 汇总」只剩两行表头，读起来像渲染坏了。
   *
   * 这里的断言分**三种态**，少一种就等于没测：
   * ① 有问题 → 照常出表（不许因为改了 0 问题分支把正常渲染改坏）；
   * ② 0 问题且审完 → 说「9 维均无问题」，且**不出现表头**；
   * ③ 0 问题但没审完 → 说「审查未完成」，且**绝不**说「9 维均无问题」
   *    （否则就是把 K16 修好的「没看 ≠ 干净」又改回假绿）。
   */
  it('C4 ②：0 问题且审完 → 不出空表头，明说「9 维均无问题」', () => {
    const text = ReviewerEngine.formatReport(makeReport([]));
    expect(text).toContain('📊 汇总');
    expect(text).toContain(zh.reviewer.summaryEmpty);
    // 空表头是这条修复的靶子：`| 维度 | 🔴 | 🟡 | 🟢 |` 不许再单独出现
    expect(text).not.toContain('| 维度 | 🔴 | 🟡 | 🟢 |');
    expect(text).not.toContain(zh.reviewer.summaryEmptyIncomplete);
  });

  it('C4 ③：0 问题但审查未完成 → 不许说「9 维均无问题」（把「没看」说成「干净」）', () => {
    const report: ReviewReport = {
      ...makeReport([]),
      incomplete: [
        { group: 'security', dimensions: ['security'], reason: 'unauthorized', detail: '401' },
      ],
    };
    const text = ReviewerEngine.formatReport(report);
    expect(text).toContain(zh.reviewer.summaryEmptyIncomplete);
    expect(text).not.toContain(zh.reviewer.summaryEmpty);
    expect(text).not.toContain('| 维度 | 🔴 | 🟡 | 🟢 |');
  });

  it('C4 ①：有问题时汇总表照旧（修 0 问题分支不许动正常渲染）', () => {
    const text = ReviewerEngine.formatReport(
      makeReport([makeIssue('types', 'critical', 'src/x.ts', '类型问题')]),
    );
    expect(text).toContain('| 维度 | 🔴 | 🟡 | 🟢 |');
    expect(text).not.toContain(zh.reviewer.summaryEmpty);
  });
});

/**
 * C5（v5.0 自审发现）：未完成行的 detail 内嵌整段响应体 JSON，
 * 形如 `认证失败（…）（DeepSeek API 请求失败（HTTP 401）: {"error":{"message":"…"}}）`。
 *
 * 这一组用例的核心判据是「**提炼失败必须回落原文**」——所以每条正向用例都配一条
 * 否定面（不可解析 / 没有 message / 形状不认识 → 必须 `undefined`，由调用方回落），
 * 否则一个「恒返回原文」的废实现也能让正向断言全绿（等于没测）。
 */
describe('C5：响应体 JSON 压成一句话（extractJsonErrorSummary）', () => {
  /** 真实形态（DeepSeek 401）：message 有诊断价值，type/param/code 是噪音。 */
  const REAL_401 =
    'DeepSeek API 请求失败（HTTP 401）: {"error":{"message":"Authentication Fails, Your api key is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"},"request_id":"req-abc123"}';

  it('正例：取 error.message，并保留唯一有排查价值的短字段 request_id', () => {
    const got = extractJsonErrorSummary(REAL_401);
    expect(got).toBeDefined();
    expect(got?.summary).toContain('Authentication Fails');
    expect(got?.summary).toContain('req-abc123');
    // raw 必须是被替换掉的那段 JSON 原文（调用方用它做整段替换）
    expect(got?.raw.startsWith('{')).toBe(true);
    expect(got?.raw.endsWith('}')).toBe(true);
    expect(got?.raw).toContain('authentication_error');
  });

  it('正例：顶层 message（没有 error 包裹）也认', () => {
    expect(extractJsonErrorSummary('{"message":"model not found"}')?.summary).toBe(
      'model not found',
    );
  });

  it('否定面：非 JSON 文本 / 伪 JSON / 无 message / 数组 / 空 message → 一律 undefined（回落原文）', () => {
    const negatives = [
      'fetch failed', // 纯文字网络错误
      'HTTP 401: Authentication Fails', // 半结构化文本
      '{"error":', // 截断的伪 JSON（JSON.parse 必炸）
      '{"foo":1,"bar":2}', // 是 JSON 但没有 message
      '[{"message":"x"}]', // 数组不是错误体
      '{"error":{"message":"   "}}', // message 全是空白
      '{"error":{"message":123}}', // message 不是字符串
    ];
    for (const text of negatives) {
      expect(extractJsonErrorSummary(text), `不该从「${text}」里提炼出东西`).toBeUndefined();
    }
  });

  it('有牙：detail 从「整段 JSON」变成一句话，且仍有 160 字预算兜底', () => {
    const { detail, reason } = classifySubagentFailure(REAL_401);
    expect(reason).toBe('unauthorized');
    // ① 结构噪音必须消失（这条是 C5 的靶子：`"type":"authentication_error"` 等）
    expect(detail).not.toContain('authentication_error');
    expect(detail).not.toContain('"param"');
    // ② 原因与排查线索必须留下（压缩不等于丢弃）
    expect(detail).toContain('Authentication Fails');
    expect(detail).toContain('req-abc123');
    // ③ 明显更短：原文 200+ 字，压完应该在 100 字内（这条挡「把 JSON 原样截断」的假修复）
    expect(detail.length).toBeLessThan(100);
    expect(detail.length).toBeLessThanOrEqual(CONDENSE_LIMIT + 1);
  });

  it('不可解析的输入仍按 160 字截断（否定面：新逻辑不许把老兜底弄丢）', () => {
    const { detail } = classifySubagentFailure(`HTTP 401 ${'x'.repeat(400)}`);
    expect(detail.length).toBeLessThanOrEqual(CONDENSE_LIMIT + 1);
    expect(detail.endsWith('…')).toBe(true);
  });
});

// ── 上下文工件格式化（v3.0 I2 修复）───────────────────────
describe('formatContextArtifacts（Reviewer 可见上下文代码工件）', () => {
  it('无工件（undefined / 空数组）→ 返回空字符串', () => {
    expect(formatContextArtifacts(undefined)).toBe('');
    expect(formatContextArtifacts([])).toBe('');
  });

  it('含 code 工件 → 生成带路径的内联代码块', () => {
    const text = formatContextArtifacts([
      { type: 'code', path: 'src/a.ts', content: 'export const a = 1;' },
    ]);
    expect(text).toContain('上下文代码工件');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('export const a = 1;');
  });

  it('无路径工件 → 标记为「无路径工件」', () => {
    const text = formatContextArtifacts([{ type: 'file', content: 'plain' }]);
    expect(text).toContain('无路径工件');
    expect(text).toContain('plain');
  });

  it('多个工件 → 逐个分隔', () => {
    const text = formatContextArtifacts([
      { type: 'code', path: 'src/a.ts', content: 'aaa' },
      { type: 'code', path: 'src/b.ts', content: 'bbb' },
    ]);
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
  });
});

// ── K16 未完成记账（v5.0 线上崩溃回归，2026-10-30）─────────

/**
 * 这一组用例的存在理由：K16 的第一版修复**带着 `TypeError` 提交，而且 verify 全绿**。
 *
 * 因为 2225 条用例里没有一条走到「子代理失败」这条路径——屏幕上的绿不能证明那条路是通的。
 * 所以这里逐条钉死五件事：名字→分组映射、维度计数、原因分类、三态文案、判定动作。
 */
describe('reviewGroupOfAgentName（子代理名 → 分组；K16 崩溃根因）', () => {
  it('createReviewAgents 的 5 个名字全部能解析，且维度合计正好覆盖 9 维', () => {
    const agents = createReviewAgents('');
    expect(agents).toHaveLength(5);

    const groups = agents.map((def) => reviewGroupOfAgentName(def.name));
    // 任何一个 undefined 都会让 AGENT_DIMENSIONS[group] 变 undefined → incompleteCount 里崩
    expect(groups.filter((group) => group === undefined)).toEqual([]);

    const dims = groups.flatMap((group) => (group === undefined ? [] : AGENT_DIMENSIONS[group]));
    expect(dims).toHaveLength(ALL_DIMENSIONS.length);
    expect(new Set(dims)).toEqual(new Set(ALL_DIMENSIONS));
  });

  it('5 个名字 → 各自分组（逐个钉死「剥掉 review- 前缀后与键相等」）', () => {
    expect(reviewGroupOfAgentName('review-architecture-style')).toBe('architecture-style');
    expect(reviewGroupOfAgentName('review-types-errors')).toBe('types-errors');
    expect(reviewGroupOfAgentName('review-tests-docs')).toBe('tests-docs');
    expect(reviewGroupOfAgentName('review-security')).toBe('security');
    expect(reviewGroupOfAgentName('review-performance-maintainability')).toBe(
      'performance-maintainability',
    );
  });

  it('反向自证：不带前缀 / 双前缀 / 空 / 未知名 / 大小写不符 → undefined（不猜、不兜底命中）', () => {
    // 「不剥前缀直接查表」正是那次崩溃的写法：这些值必须查不到，否则未知名字会被当成已知
    expect(reviewGroupOfAgentName('architecture-style')).toBeUndefined();
    expect(reviewGroupOfAgentName('review-review-security')).toBeUndefined();
    expect(reviewGroupOfAgentName('review-')).toBeUndefined();
    expect(reviewGroupOfAgentName('')).toBeUndefined();
    expect(reviewGroupOfAgentName('review-bogus')).toBeUndefined();
    expect(reviewGroupOfAgentName('REVIEW-security')).toBeUndefined();
  });
});

describe('incompleteCount（K16 爆点：这里曾经抛 TypeError）', () => {
  it('按维度计：一个组覆盖 2 维就算 2', () => {
    const report = makeReport([]) as ReviewReport;
    report.incomplete = [
      {
        group: 'architecture-style',
        dimensions: ['architecture', 'style'],
        reason: 'unauthorized',
        detail: 'HTTP 401',
      },
      { group: 'security', dimensions: ['security'], reason: 'network', detail: 'ECONNREFUSED' },
    ];
    expect(incompleteCount(report)).toBe(3);
  });

  it('没有 incomplete → 0（不是 NaN、不崩）', () => {
    expect(incompleteCount(makeReport([]) as ReviewReport)).toBe(0);
  });

  it('防御：dimensions 意外为 undefined → 记 0，绝不抛（报告少一行也好过整条命令崩）', () => {
    const report = makeReport([]) as ReviewReport;
    report.incomplete = [
      {
        group: 'security',
        // 复现 K16 那次的真实值：`AGENT_DIMENSIONS[未剥前缀的名字]` === undefined
        dimensions: undefined as unknown as ReviewDimension[],
        reason: 'unauthorized',
        detail: 'HTTP 401',
      },
    ];
    expect(() => incompleteCount(report)).not.toThrow();
    expect(incompleteCount(report)).toBe(0);
  });
});

describe('classifySubagentFailure（未完成原因分类 → 决定用户下一步做什么）', () => {
  const cases: Array<[string, string, ReviewIncompleteReason]> = [
    ['401 认证失败', 'HTTP 401: Authentication Fails, Your api key is invalid', 'unauthorized'],
    ['403 无权限', 'HTTP 403: Forbidden', 'unauthorized'],
    ['402 余额不足', 'HTTP 402: Insufficient Balance', 'quota'],
    ['子代理超时', '子代理超时（60000ms 无响应）', 'timeout'],
    ['连接被拒', 'connect ECONNREFUSED 127.0.0.1:443', 'network'],
    ['DNS 解析失败', 'getaddrinfo ENOTFOUND api.deepseek.com', 'network'],
    // 这条曾经被误判成 network：原文含「子代理」二字，而旧 network 正则里有裸「代理」
    ['轮数上限（含「子代理」三个字）', '子代理达到 5 轮上限，结论可能不完整', 'turn-limit'],
    ['无法归类的乱码', '？？？', 'error'],
  ];

  it.each(cases)('%s', (_label, error, expected) => {
    expect(classifySubagentFailure(error).reason).toBe(expected);
  });

  it('空 / undefined → error，且给「未提供错误详情」而不是空串', () => {
    expect(classifySubagentFailure(undefined)).toEqual({
      reason: 'error',
      detail: '未提供错误详情',
    });
    expect(classifySubagentFailure('')).toEqual({ reason: 'error', detail: '未提供错误详情' });
  });

  it('detail 压成一行并截断到 160 字内（报告里不许灌一整段 JSON / 堆栈）', () => {
    const { detail } = classifySubagentFailure(`HTTP 401 ${'x'.repeat(400)}`);
    expect(detail.length).toBeLessThanOrEqual(161);
    expect(detail.endsWith('…')).toBe(true);
    expect(detail).not.toContain('\n');
  });
});

describe('formatTestStatus / hasVerifyScript（K7：没脚本 ≠ 测试挂了）', () => {
  // locale 是模块级可变状态：用前钉死、用完复位（AGENTS 第 3 条）
  beforeEach(() => {
    setLocale('zh');
  });
  afterEach(() => {
    setLocale('zh');
  });

  it('通过 → ✅ 通过', () => {
    const report = { ...makeReport([]), testPassed: true } as ReviewReport;
    expect(formatTestStatus(report)).toContain('✅ 通过');
  });

  it('失败 → ❌ 失败', () => {
    const report = { ...makeReport([]), testPassed: false } as ReviewReport;
    expect(formatTestStatus(report)).toContain('❌ 失败');
  });

  it('未运行 + no-verify-script → 明说「项目未定义 verify 脚本」，且不出现「失败」', () => {
    const report = {
      ...makeReport([]),
      testPassed: null,
      testNotRunReason: 'no-verify-script',
    } as ReviewReport;
    const text = formatTestStatus(report);
    expect(text).toContain('未运行');
    expect(text).toContain('verify 脚本');
    expect(text).not.toContain('失败');
  });

  it('未运行（无具体原因）→ 只说「未运行」', () => {
    const report = { ...makeReport([]), testPassed: null } as ReviewReport;
    expect(formatTestStatus(report)).toBe('未运行');
  });

  it('hasVerifyScript：有 verify 脚本 → true；没有 / 空白 / 坏 JSON → false（读文件判定，不解析 npm 输出）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-verify-script-'));
    try {
      expect(hasVerifyScript(dir)).toBe(false); // 连 package.json 都没有

      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
        'utf8',
      );
      expect(hasVerifyScript(dir)).toBe(false); // 有 package.json 但没 verify

      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { verify: 'npm test' } }),
        'utf8',
      );
      expect(hasVerifyScript(dir)).toBe(true);

      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { verify: '   ' } }),
        'utf8',
      );
      expect(hasVerifyScript(dir)).toBe(false); // 空白脚本视同没有

      writeFileSync(path.join(dir, 'package.json'), '{ 坏 JSON', 'utf8');
      expect(hasVerifyScript(dir)).toBe(false); // 坏文件不崩，按「没有」处理
    } finally {
      // Windows EBUSY：带重试删，删不掉就如实抛（不静默留垃圾，AGENTS 第 17 条）
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

describe('determineReviewAction（审查不完整一律 reject，三档 severity 都不豁免）', () => {
  it.each(['strict', 'normal', 'lenient'] as const)('%s：不完整 + 零问题 → reject', (severity) => {
    expect(determineReviewAction([], { severity, incomplete: true })).toBe('reject');
  });

  it('反向自证：同样「零问题 + 测试通过」，incomplete=false 时是 approve（证明旗标确实起作用）', () => {
    expect(
      determineReviewAction([], { severity: 'normal', testPassed: true, incomplete: false }),
    ).toBe('approve');
  });
});

// ── 辅助函数 ──────────────────────────────────────────────

function makeIssue(
  dimension: ReviewDimension,
  severity: 'critical' | 'medium' | 'suggestion',
  file: string,
  title: string,
): ReviewIssue {
  return {
    dimension,
    severity,
    file,
    line: 42,
    title,
    description: `${title} 的详细描述`,
    suggestion: severity === 'suggestion' ? `修复 ${title}` : undefined,
  };
}

function makeReport(issues: ReviewIssue[]) {
  const summary = {} as Record<
    ReviewDimension,
    { critical: number; medium: number; suggestion: number }
  >;
  const dims: ReviewDimension[] = [
    'architecture',
    'style',
    'types',
    'errors',
    'tests',
    'security',
    'performance',
    'maintainability',
    'docs',
  ];
  for (const dim of dims) {
    summary[dim] = { critical: 0, medium: 0, suggestion: 0 };
  }
  for (const issue of issues) {
    summary[issue.dimension][issue.severity] += 1;
  }

  return {
    scope: 'src/tools/read.ts',
    timestamp: new Date().toISOString(),
    testPassed: true,
    issues,
    summary,
    durationMs: 1234,
  };
}
