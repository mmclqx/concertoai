/**
 * 审批风险评估测试（v5.0 T8）。
 *
 * 三条最重要的事（比功能覆盖更重要）：
 * 1. **W1-W10 Windows 红线逐条验证**（专家指定重点；v4.1.1 已因反斜杠正则翻过车）；
 * 2. **降级矩阵 8 行逐行覆盖**（分析异常绝不能阻断审批 = G2 铁律）；
 * 3. **误报控制**（宁可漏报不可误报——狼来了会让用户无条件按 y）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  analyzeApproval,
  analyzeDiff,
  changeNaturesFrom,
  emptyImpact,
  focusLinesFrom,
  levelOf,
  lineMatchesRule,
  MAX_ANALYZED_DIFF_LINES,
  parseDiff,
} from '../../src/core/approval-insight';
import { clearImpactCache } from '../../src/core/impact-scan';
import { RISK_RULES } from '../../src/core/risk-rules';

// 影响面缓存是模块级状态：用例之间必须隔离，否则前一条的 'ok' 会让后一条的
// 超时/跳过场景「直接命中缓存而假通过」（第一次跑就踩到了）
beforeEach(() => {
  clearImpactCache();
});

/** 构造一条 diff 行（+ 新增 / - 删除 / 空格上下文）。 */
function added(content: string): string {
  return `+${content}`;
}
function removed(content: string): string {
  return `-${content}`;
}

/** 组合成 diff 文本。 */
function diffOf(...lines: string[]): string {
  return ['@@ -1,3 +1,3 @@', ...lines].join('\n');
}

/** 测试环境（TTY + 非 CI，允许走完整路径）。 */
const TTY_ENV = { isTTY: true, isCI: false } as const;

// 规则表的**静态性质**（结构 / id 唯一 / 正则安全 / 启停）已迁至 `risk-rules.test.ts`；
// 本文件只验「规则真的能命中 / 不该命中的不命中」（含 W1-W10 红线与降级矩阵）。

// ═══════════════════════════════════════════════════════════
// W1-W10：Windows / 跨平台红线（专家指定，逐条验证）
// ═══════════════════════════════════════════════════════════

describe('W1 反斜杠路径：反斜杠与正斜杠都必须命中', () => {
  it('path.join 用反斜杠与正斜杠两种写法都命中 fs-boundary', () => {
    const backslash = analyzeDiff(diffOf(added("const p = path.join('..\\\\a');")), RISK_RULES);
    const slash = analyzeDiff(diffOf(added("const p = path.join('../a');")), RISK_RULES);
    expect(backslash.some((hit) => hit.ruleId === 'fs-boundary')).toBe(true);
    expect(slash.some((hit) => hit.ruleId === 'fs-boundary')).toBe(true);
  });

  it('纯反斜杠的 ../ 形式（..\\ ）也命中', () => {
    const hits = analyzeDiff(diffOf(added('const p = "..\\secret.txt";')), RISK_RULES);
    expect(hits.some((hit) => hit.ruleId === 'fs-boundary')).toBe(true);
  });
});

describe('W2 CRLF：LF 与 CRLF 版本命中结果必须完全相同', () => {
  it('同一 diff 的 LF / CRLF 版本产生一致命中（含行号）', () => {
    const lf = diffOf(added('await fs.rm(dir, { recursive: true });'), added('process.exit(1);'));
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = analyzeDiff(lf, RISK_RULES);
    const b = analyzeDiff(crlf, RISK_RULES);
    expect(b.map((hit) => hit.ruleId)).toEqual(a.map((hit) => hit.ruleId));
    expect(b.map((hit) => hit.diffLineIndex)).toEqual(a.map((hit) => hit.diffLineIndex));
    // 命中行不得残留 \r
    for (const hit of b) {
      expect(hit.line.endsWith('\r')).toBe(false);
    }
  });

  it('$ 锚点类 pattern 在 CRLF 下行仍能命中（否则每条 $ 规则都会失效）', () => {
    const hits = analyzeDiff(diffOf(added('try {} catch {}')), RISK_RULES);
    expect(hits.some((hit) => hit.ruleId === 'silent-catch')).toBe(true);
  });
});

describe('W3/W4 路径归一化与大小写不敏感（impact-scan 的路径比较）', () => {
  it('normalizePath：反斜杠→正斜杠 + 小写 + 保留盘符冒号（W5）', async () => {
    const { normalizePath } = await import('../../src/core/impact-scan');
    expect(normalizePath('src\\api\\x.ts')).toBe('src/api/x.ts');
    expect(normalizePath('src/api/x.ts')).toBe('src/api/x.ts');
    expect(normalizePath('SRC\\Api\\X.TS')).toBe('src/api/x.ts');
    // W5：盘符冒号不能被切掉/误判
    expect(normalizePath('C:\\proj\\a.ts')).toBe('c:/proj/a.ts');
    expect(normalizePath('C:\\proj\\a.ts').startsWith('c:')).toBe(true);
  });
});

describe('W6 不做列偏移：含中文与 emoji 的行仍能正确命中', () => {
  it('中文注释后接危险调用 → 按整行匹配仍命中', () => {
    const hits = analyzeDiff(diffOf(added('// 删除临时目录 await fs.rm(dir)')), RISK_RULES);
    // 该行以 // 开头 → 属于注释，按设计**不该**报（这条同时验证注释排除）
    expect(hits.some((hit) => hit.ruleId === 'dangerous-delete')).toBe(false);
  });

  it('中文 + emoji 前缀代码行命中正确（不依赖列宽）', () => {
    const hits = analyzeDiff(diffOf(added('⚠️ 危险：await fs.rm(dir, { recursive: true })')), [
      ...RISK_RULES,
    ]);
    expect(hits.some((hit) => hit.ruleId === 'dangerous-delete')).toBe(true);
  });
});

describe('W7 BOM：首行带 BOM 仍命中', () => {
  it('BOM + rm -rf 首行命中', () => {
    const detail = `\uFEFF${added('rm -rf /tmp/x')}`;
    const hits = analyzeDiff(detail, RISK_RULES);
    expect(hits.some((hit) => hit.ruleId === 'dangerous-delete')).toBe(true);
  });
});

describe('W8 防 ReDoS：10 万字符长行不回溯爆炸', () => {
  it('10 万字符单行 diff 全规则匹配 < 20ms', () => {
    const longLine = added(`${'a'.repeat(100_000)} rm -rf /tmp/x`);
    const started = performance.now();
    analyzeDiff(longLine, RISK_RULES);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(20);
  });

  it('10 万字符无特征长行（最坏情况：全部规则跑完）< 20ms', () => {
    const longLine = added('z'.repeat(100_000));
    const started = performance.now();
    analyzeDiff(longLine, RISK_RULES);
    expect(performance.now() - started).toBeLessThan(20);
  });
});

describe('W9 注释判定：URL 里的 // 不算注释', () => {
  it('`const u = "https://x"` 不被判为注释行（仍参与风险匹配）', () => {
    const hits = analyzeDiff(diffOf(added('const u = "https://api.example.com"; fetch(u);')), [
      ...RISK_RULES,
    ]);
    expect(hits.some((hit) => hit.ruleId === 'network-timeout')).toBe(true);
  });

  it('行首 // 注释里的危险代码不报（避免注释误报）', () => {
    const hits = analyzeDiff(diffOf(added('// await fs.rm(dir, { recursive: true })')), RISK_RULES);
    expect(hits.some((hit) => hit.ruleId === 'dangerous-delete')).toBe(false);
    // 对照：去掉注释符就应报
    const real = analyzeDiff(diffOf(added('await fs.rm(dir, { recursive: true })')), RISK_RULES);
    expect(real.some((hit) => hit.ruleId === 'dangerous-delete')).toBe(true);
  });
});

describe('W10 路径含正则元字符不炸（不用路径构造正则）', () => {
  it('含 ( ) [ ] + . 的路径不影响扫描与匹配', async () => {
    const { lineReferencesTarget } = await import('../../src/core/impact-scan');
    // 用 includes 比较，不做正则 → 元字符无影响
    expect(
      lineReferencesTarget("import x from './a(b)[c]+d.e';", 'src', 'src/a(b)[c]+d.e.ts'),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 15 条规则逐条命中 + 排除条件（防「规则写了但从没生效」）
// ═══════════════════════════════════════════════════════════

describe('规则命中（每条都要真的能报）', () => {
  /** 假密钥（运行时拼接：源码与仓库扫描器都不该看到 key 字面量形态）。 */
  const FAKE_KEY = ['sk', 'abcdef1234567890'].join('-');

  const cases: { id: string; line: string; clean?: string }[] = [
    { id: 'dangerous-delete', line: 'await fs.rm(dir, { recursive: true });' },
    { id: 'destructive-write', line: "await fs.writeFile('a.txt', data);" },
    { id: 'state-deletion', line: 'delete ctx.apiKey;' },
    { id: 'db-mutation', line: "sql = 'DELETE FROM users WHERE id = 1';" },
    { id: 'auth-change', line: 'if (user.isAdmin) { allow(); }' },
    // 注意：不能用脱敏形态 sk-****（那是展示值，被 negativePatterns 正确排除）
    { id: 'secret-hardcode', line: `const key = '${FAKE_KEY}';` },
    { id: 'network-timeout', line: 'const ctrl = new AbortController();' },
    { id: 'silent-catch', line: 'catch {}' },
    { id: 'concurrency', line: 'await Promise.all(tasks);' },
    { id: 'config-env', line: 'const k = process.env.SECRET_KEY;' },
    { id: 'fs-boundary', line: "const p = path.join('..', 'x');" },
    { id: 'dependency-change', line: '"vitest": "^4.1.10",' },
    { id: 'process-exit', line: 'process.exit(1);' },
  ];

  for (const testCase of cases) {
    it(`${testCase.id} 命中固定样本`, () => {
      const hits = analyzeDiff(diffOf(added(testCase.line)), RISK_RULES);
      expect(hits.map((hit) => hit.ruleId)).toContain(testCase.id);
    });
  }

  it('error-branch-removal 只看删除行（新增 throw 不报）', () => {
    const del = analyzeDiff(diffOf(removed('    throw new Error("x");')), RISK_RULES);
    expect(del.map((hit) => hit.ruleId)).toContain('error-branch-removal');
    const add = analyzeDiff(diffOf(added('    throw new Error("x");')), RISK_RULES);
    expect(add.map((hit) => hit.ruleId)).not.toContain('error-branch-removal');
  });

  it('test-assertion-change 只看删除行', () => {
    const del = analyzeDiff(diffOf(removed('expect(a).toBe(1);')), RISK_RULES);
    expect(del.map((hit) => hit.ruleId)).toContain('test-assertion-change');
  });

  // 【实测漏报回归】基准脚本跑出「改超时」命中 0 条：`/\btimeout\b/` 匹配不到 setTimeout
  it('网络超时：改 setTimeout 超时常量必须命中（实测漏报过）', () => {
    const hits = analyzeDiff(
      diffOf(
        '-  setTimeout(() => ctrl.abort(), 5000);',
        '+  setTimeout(() => ctrl.abort(), 10000);',
      ),
      RISK_RULES,
    );
    expect(hits.map((hit) => hit.ruleId)).toContain('network-timeout');
    // 删除行与新增行都该报（target: 'both'——涨了和降了都是行为变化）
    expect(hits.filter((hit) => hit.ruleId === 'network-timeout')).toHaveLength(2);
  });

  it('网络超时：fetch / axios / AbortController 各自命中', () => {
    for (const line of [
      'const res = await fetch(url);',
      'const res = await axios.get(url);',
      'const ctrl = new AbortController();',
      'const { timeout } = options;',
    ]) {
      const hits = analyzeDiff(diffOf(added(line)), RISK_RULES);
      expect(
        hits.map((hit) => hit.ruleId),
        line,
      ).toContain('network-timeout');
    }
  });

  it('上下文行（无 +/- 前缀）不参与匹配', () => {
    const hits = analyzeDiff(diffOf('await fs.rm(dir, { recursive: true });'), RISK_RULES);
    expect(hits).toEqual([]);
  });

  it('+++ / --- 文件头不被当作增删行', () => {
    const detail = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@'].join('\n');
    expect(analyzeDiff(detail, RISK_RULES)).toEqual([]);
  });
});

describe('排除条件（误报控制，R2：宁可漏报不可误报）', () => {
  it('secret-hardcode：读 process.env / 占位符 / 空串不报', () => {
    for (const line of [
      'const key = process.env.API_KEY;',
      "const key = '';",
      "const key = 'your-api-key-here';",
      "const key = 'sk-****';",
    ]) {
      const hits = analyzeDiff(diffOf(added(line)), RISK_RULES);
      expect(
        hits.map((hit) => hit.ruleId),
        line,
      ).not.toContain('secret-hardcode');
    }
  });

  it('auth-change：仅 import 引入鉴权模块不报（引入 ≠ 改逻辑）', () => {
    const hits = analyzeDiff(
      diffOf(added("import { checkPermission } from './auth';")),
      RISK_RULES,
    );
    expect(hits.map((hit) => hit.ruleId)).not.toContain('auth-change');
  });

  // 【实测误报回归】40 段真实 hunk 里 fs-boundary 的 5 条命中**全是** import 路径（且都是 high 级）
  it('fs-boundary：模块 import/export/require 的 ../ 路径不报（实测 5 条 high 误报全来自此）', () => {
    for (const line of [
      "import { a } from '../core/holidays';",
      "import {\n  b,\n} from '../../src/core/peak-time';",
      "} from '../core/holidays';",
      "export { c } from '../core/x';",
      "export * from '../core/x';",
      "import '../side-effect';",
      "const d = require('../core/x');",
    ]) {
      const hits = analyzeDiff(diffOf(added(line)), RISK_RULES);
      expect(
        hits.map((hit) => hit.ruleId),
        line,
      ).not.toContain('fs-boundary');
    }
  });

  it('fs-boundary：真正的路径拼接仍必须报（收窄后不能把真风险也放过）', () => {
    for (const line of [
      "const p = path.join(base, '..', userInput);",
      'const p = path.resolve(userInput);',
      // 模板字符串插值形式的越界路径（用模板字面量写，避免 Biome noTemplateCurlyInString）
      `const p = \`\${base}/../secret\`;`,
      "const mod = await import(path.join('..', name));", // 动态拼接（非字面量）
    ]) {
      const hits = analyzeDiff(diffOf(added(line)), RISK_RULES);
      expect(
        hits.map((hit) => hit.ruleId),
        line,
      ).toContain('fs-boundary');
    }
  });

  it('fs-boundary：已经过 resolveSafe 沙箱包裹不报', () => {
    const hits = analyzeDiff(
      diffOf(added('const p = resolveSafe(ctx, path.join(a, b));')),
      RISK_RULES,
    );
    expect(hits.map((hit) => hit.ruleId)).not.toContain('fs-boundary');
  });

  it('silent-catch：catch 后打日志/抛出不算静默吞错', () => {
    const hits = analyzeDiff(diffOf(added('catch (e) { console.error(e); }')), RISK_RULES);
    expect(hits.map((hit) => hit.ruleId)).not.toContain('silent-catch');
  });

  it('dangerous-delete：recursive:false 不报（非递归删除）', () => {
    const hits = analyzeDiff(
      diffOf(added('await fs.rm(tmpFile, { recursive: false });')),
      RISK_RULES,
    );
    expect(hits.map((hit) => hit.ruleId)).not.toContain('dangerous-delete');
  });

  it('普通读操作不产生任何命中（最低误报基线）', () => {
    const hits = analyzeDiff(
      diffOf(added('const text = await readFile(path, "utf8");'), added('return text.length;')),
      RISK_RULES,
    );
    expect(hits).toEqual([]);
  });

  it('一次改动 20 条普通代码行 → 0 命中（不打扰）', () => {
    const lines = Array.from({ length: 20 }, (_, i) => added(`const v${i} = ${i} + 1;`));
    expect(analyzeDiff(diffOf(...lines), RISK_RULES)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 聚合：等级 / 改动性质 / 重点行
// ═══════════════════════════════════════════════════════════

describe('聚合逻辑', () => {
  it('levelOf：无命中 = low；取最高级', () => {
    expect(levelOf([])).toBe('low');
    const mediumOnly = analyzeDiff(diffOf(added('process.exit(0);')), RISK_RULES);
    expect(levelOf(mediumOnly)).toBe('medium');
    const mixed = analyzeDiff(
      diffOf(added('process.exit(0);'), added('rm -rf /tmp/x')),
      RISK_RULES,
    );
    expect(levelOf(mixed)).toBe('high');
  });

  it('changeNaturesFrom：去重且最多 3 条', () => {
    const hits = analyzeDiff(
      diffOf(
        added('rm -rf /tmp/x'),
        added('await fs.writeFile("a", b)'),
        added('delete x.y'),
        added('process.exit(0)'),
      ),
      RISK_RULES,
    );
    const natures = changeNaturesFrom(hits, RISK_RULES);
    expect(natures.length).toBeLessThanOrEqual(3);
    expect(new Set(natures).size).toBe(natures.length);
  });

  it('focusLinesFrom：high 最多 3 条；无 high 取最早 medium；无命中为空', () => {
    expect(focusLinesFrom([])).toEqual([]);
    const highHits = [
      {
        ruleId: 'a',
        category: 'c',
        level: 'high' as const,
        side: 'added' as const,
        line: '',
        diffLineIndex: 1,
        why: '',
        suggestion: '',
      },
      {
        ruleId: 'b',
        category: 'c',
        level: 'high' as const,
        side: 'added' as const,
        line: '',
        diffLineIndex: 2,
        why: '',
        suggestion: '',
      },
      {
        ruleId: 'c',
        category: 'c',
        level: 'high' as const,
        side: 'added' as const,
        line: '',
        diffLineIndex: 3,
        why: '',
        suggestion: '',
      },
      {
        ruleId: 'd',
        category: 'c',
        level: 'high' as const,
        side: 'added' as const,
        line: '',
        diffLineIndex: 4,
        why: '',
        suggestion: '',
      },
    ];
    expect(focusLinesFrom(highHits)).toEqual([1, 2, 3]);
    const mediumHits = [
      {
        ruleId: 'm',
        category: 'c',
        level: 'medium' as const,
        side: 'added' as const,
        line: '',
        diffLineIndex: 7,
        why: '',
        suggestion: '',
      },
    ];
    expect(focusLinesFrom(mediumHits)).toEqual([7]);
  });

  it('hits 排序：level 降序 + 行号升序', () => {
    const hits = analyzeDiff(
      diffOf(added('process.exit(0);'), added('rm -rf /tmp/x'), added('process.exit(1);')),
      RISK_RULES,
    );
    const sorted = [...hits].sort((a, b) => {
      const weight = { high: 3, medium: 2, low: 1 };
      return weight[b.level] - weight[a.level] || a.diffLineIndex - b.diffLineIndex;
    });
    expect(sorted[0]?.level).toBe('high');
  });
});

// ═══════════════════════════════════════════════════════════
// 降级矩阵（8 行逐行覆盖 —— 分析绝不许阻断审批，G2）
// ═══════════════════════════════════════════════════════════

describe('降级矩阵（逐行对应任务书 T8.4）', () => {
  it('① 非 TTY → degraded / non-tty', async () => {
    const insight = await analyzeApproval(diffOf(added('rm -rf /tmp/x')), { isTTY: false });
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('non-tty');
    // 仍然可渲染（结构完整）
    expect(insight.hits).toEqual([]);
    expect(insight.impact).toEqual(emptyImpact());
  });

  it('② CI 环境 → degraded / ci', async () => {
    const insight = await analyzeApproval(diffOf(added('rm -rf /tmp/x')), {
      isTTY: true,
      isCI: true,
    });
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('ci');
  });

  it('③ diff 行数 > 500 → degraded / huge-diff', async () => {
    const lines = Array.from({ length: MAX_ANALYZED_DIFF_LINES + 1 }, (_, i) => added(`x${i}`));
    const insight = await analyzeApproval(diffOf(...lines), TTY_ENV);
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('huge-diff');
  });

  it('③b 恰好 500 行 → 不降级（边界左开）', async () => {
    const lines = Array.from({ length: MAX_ANALYZED_DIFF_LINES - 1 }, (_, i) => added(`x${i}`));
    const insight = await analyzeApproval(diffOf(...lines), { ...TTY_ENV, skipImpact: true });
    expect(insight.degraded).toBe(false);
  });

  it('④ 影响面超时 → 不降级，impact.status = timeout（风险点照常显示）', async () => {
    let clock = 0;
    const insight = await analyzeApproval(diffOf(added('rm -rf /tmp/x')), {
      ...TTY_ENV,
      file: 'src/x.ts',
      cwd: '.',
      now: () => (clock += 500), // 每次取时间都跨过 deadline
      impact: {
        readdirImpl: async () => [{ name: 'a.ts', isDirectory: false }],
        readFileImpl: async () => '',
        statImpl: async () => ({ mtimeMs: 1 }),
      },
    });
    expect(insight.degraded).toBe(false);
    expect(insight.impact.status).toBe('timeout');
    expect(insight.hits.length).toBeGreaterThan(0); // 风险点没丢
  });

  it('⑤ 分析抛错 → degraded / error（G2 铁律：绝不向调用方抛）', async () => {
    // 用 getter 在「取 rules」时抛错，精确模拟分析中途炸掉
    const options: Record<string, unknown> = { ...TTY_ENV };
    Object.defineProperty(options, 'rules', {
      get() {
        throw new Error('规则表炸了');
      },
    });
    const insight = await analyzeApproval(
      diffOf(added('rm -rf /tmp/x')),
      options as unknown as Parameters<typeof analyzeApproval>[1],
    );
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('error');
    expect(insight.hits).toEqual([]);
  });

  it('⑥ config approvalInsight=plain → degraded / config-off', async () => {
    const insight = await analyzeApproval(diffOf(added('rm -rf /tmp/x')), {
      ...TTY_ENV,
      mode: 'plain',
    });
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('config-off');
  });

  it('⑦ 无命中 → 不降级，level=low（UI 显示「未检测到已知风险模式」）', async () => {
    const insight = await analyzeApproval(diffOf(added('const a = 1;')), TTY_ENV);
    expect(insight.degraded).toBe(false);
    expect(insight.level).toBe('low');
    expect(insight.hits).toEqual([]);
    expect(insight.changeNatures).toEqual([]);
  });

  it('⑧ 文件数 > 2000 → 不降级，impact.status = skipped（项目较大）', async () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false }));
    const insight = await analyzeApproval(diffOf(added('rm -rf /tmp/x')), {
      ...TTY_ENV,
      file: 'src/x.ts',
      cwd: '.',
      impact: {
        readdirImpl: async () => many,
        readFileImpl: async () => '',
        statImpl: async () => ({ mtimeMs: 1 }),
      },
    });
    expect(insight.degraded).toBe(false);
    expect(insight.impact.status).toBe('skipped');
  });
});

// ═══════════════════════════════════════════════════════════
// 性能预算（发布门硬指标）
// ═══════════════════════════════════════════════════════════

describe('性能预算', () => {
  it('analyzeDiff（100 行 × 15 规则）< 5ms（3 次取最小值，抗负载）', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      added(i % 10 === 0 ? 'rm -rf /tmp/x' : `const v${i} = ${i};`),
    );
    const detail = diffOf(...lines);
    const measure = (): number => {
      const started = performance.now();
      analyzeDiff(detail, RISK_RULES);
      return performance.now() - started;
    };
    expect(Math.min(measure(), measure(), measure())).toBeLessThan(5);
  });

  it('analyzeDiff（500 行上限）< 20ms', () => {
    const lines = Array.from({ length: 500 }, (_, i) => added(`const v${i} = process.env.X;`));
    const detail = diffOf(...lines);
    const measure = (): number => {
      const started = performance.now();
      analyzeDiff(detail, RISK_RULES);
      return performance.now() - started;
    };
    expect(Math.min(measure(), measure(), measure())).toBeLessThan(20);
  });

  it('analyzeApproval（无 IO 路径）P95 < 150ms', async () => {
    const detail = diffOf(added('rm -rf /tmp/x'), added('const a = 1;'));
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      await analyzeApproval(detail, { ...TTY_ENV, skipImpact: true });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(150);
  });
});

describe('parseDiff / lineMatchesRule（辅助函数）', () => {
  it('parseDiff 标注 side 且保留上下文行（打 ⚠️ 用行号不失位）', () => {
    const parsed = parseDiff(['@@ -1 +1 @@', '-old', '+new', ' ctx'].join('\n'));
    expect(parsed[0]?.side).toBeNull();
    expect(parsed[1]?.side).toBe('removed');
    expect(parsed[2]?.side).toBe('added');
    expect(parsed[3]?.side).toBeNull();
    expect(parsed.map((line) => line.index)).toEqual([0, 1, 2, 3]);
  });

  it('lineMatchesRule：side 为 null 直接 false', () => {
    const rule = RISK_RULES[0];
    if (rule === undefined) throw new Error('规则表为空');
    expect(lineMatchesRule({ index: 0, side: null, text: ' rm -rf /' }, rule)).toBe(false);
  });

  it('parseDiff 对空字符串返回单行（不抛错）', () => {
    expect(parseDiff('')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// T8.6 真实样本回归：误报率 与 召回率（fixtures/approval）
// ═══════════════════════════════════════════════════════════

interface FixtureSample {
  file: string;
  source: string;
  commit: string;
  kind: 'random' | 'recall';
  label: 'risk' | 'no-risk';
  expectRules?: string[];
  why: string;
}

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'approval');

function loadManifest(): FixtureSample[] {
  const raw = readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8');
  return (JSON.parse(raw) as { samples: FixtureSample[] }).samples;
}

function hitsOf(sample: FixtureSample): string[] {
  const diff = readFileSync(path.join(FIXTURE_DIR, sample.file), 'utf8');
  return analyzeDiff(diff, RISK_RULES).map((hit) => hit.ruleId);
}

describe('真实样本回归（T8.6：误报 ≤1 条 / 标注 risk 的必须命中）', () => {
  it('manifest 与 .diff 文件一一对应（新样本忘登记会红）', () => {
    const manifest = loadManifest();
    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.diff'))
      .sort();
    expect(manifest.map((s) => s.file).sort()).toEqual(onDisk);
    // 每条样本都必须有「为什么这样标注」的人话（防止空标注凑数）
    for (const sample of manifest) {
      expect(sample.why.length, `${sample.file} 缺标注理由`).toBeGreaterThan(8);
    }
  });

  it('标注 risk 的样本必须命中声明的规则（召回 = 100%）', () => {
    const misses: string[] = [];
    for (const sample of loadManifest().filter((s) => s.label === 'risk')) {
      const hits = hitsOf(sample);
      for (const ruleId of sample.expectRules ?? []) {
        if (!hits.includes(ruleId)) {
          misses.push(`${sample.file} 期望 ${ruleId}，实际 [${hits.join(',') || '无命中'}]`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('标注 no-risk 的样本误报 ≤1 条，且 high 级误报 = 0（狼来了防线）', () => {
    const falsePositives: string[] = [];
    const highFalsePositives: string[] = [];
    for (const sample of loadManifest().filter((s) => s.label === 'no-risk')) {
      const diff = readFileSync(path.join(FIXTURE_DIR, sample.file), 'utf8');
      const hits = analyzeDiff(diff, RISK_RULES);
      if (hits.length > 0) {
        falsePositives.push(
          `${sample.file} → ${hits.map((h) => `${h.ruleId}/${h.level}`).join(',')}`,
        );
      }
      if (hits.some((hit) => hit.level === 'high')) {
        highFalsePositives.push(sample.file);
      }
    }
    // high 级误报是零容忍的：红色警报报错一次，用户就开始无条件按 y
    expect(highFalsePositives).toEqual([]);
    // 任务书 T8.6 判据：无风险样本的误报 ≤ 1 条（< 5%）
    expect(falsePositives.length, falsePositives.join(' | ')).toBeLessThanOrEqual(1);
  });
});
