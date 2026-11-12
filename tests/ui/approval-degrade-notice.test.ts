/**
 * 发布门 12（v5.1）：「降级时必须说话」的双向验收。
 *
 * ## 这一条为什么阻塞发布
 *
 * v5.1 给用户的承诺是「低风险编辑少按一次 y」。开发期修掉的是「开关被父命令吃掉 ⇒
 * 值丢了」（`19b6c0a`），但还有另一半：**分析降级时开关本就不该生效，而卡片一个字
 * 都不解释**。用户敲了 `--auto-low`、审批框照旧弹、界面没有任何「本次分析已降级」
 * 字样 ⇒ 他无法区分「开关又坏了」和「开关生效但不适用」，只能怀疑自己敲错。
 *
 * 判据（与 `docs/03-开发计划与任务/TASKS.md` 的「🚫 发布门第 12 条」逐条对应）：
 * ① 四种静默降级各给可区分文案 ② plain 卡上必须可见 ③ 否定面：没降级不得出现
 * ④ 文案不含「安全」 ⑤ 真机 PTY（在 `scripts/pty-drive-v51.mjs` S2，不在此文件）
 * ⑥ 双环境 verify（发布门流程，不在此文件）。
 *
 * ## 每条用例都写了「怎么改坏它才红」
 *
 * 这是本仓对判定类护栏的硬要求：只证明「正例通过」等于没测。变异探针见各 `it` 的注释。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApprovalInsight, DegradeReason } from '../../src/core/approval-insight';
import { emptyImpact, parseDiff } from '../../src/core/approval-insight';
import type { Locale } from '../../src/i18n';
import { DICTS, setLocale, t } from '../../src/i18n';
import {
  degradeNotice,
  isPlainApproval,
  renderApprovalLines,
  renderApprovalText,
} from '../../src/ui/approval-text';

/** 四种「整卡走 plain」的静默降级（与 `PLAIN_DEGRADE_NOTICE_KEYS` 的键一一对应）。 */
const SILENT_REASONS = ['config-off', 'error', 'non-tty', 'ci'] as const;

/**
 * 每种原因**必须提到的辨识词**。
 *
 * 光断言「非空」没有牙：把四条全映射到同一个兜底文案（比如一律「分析不可用」），
 * 「非空」照样绿，而用户完全无法据此判断是哪出了问题——这正是判据①要防的形态。
 */
const IDENTIFYING_WORD: Record<(typeof SILENT_REASONS)[number], string> = {
  'config-off': 'approvalInsight=plain',
  error: '失败',
  'non-tty': '不是交互式终端',
  ci: 'CI',
};

/** 四种说明行共有的结论句（判据①的「结论承诺」）。 */
const CONCLUSION = '仍按常规逐个确认';

const BASE = { kind: 'edit' as const, summary: '编辑文件 a.ts', detail: 'const a = 1' };

/** 构造一份降级洞察。 */
function degraded(reason: DegradeReason): ApprovalInsight {
  return {
    level: 'low',
    changeNatures: [],
    hits: [],
    focusLines: [],
    impact: emptyImpact(),
    degraded: true,
    degradeReason: reason,
    elapsedMs: 0,
  };
}

/** 构造一份**未降级**的中风险洞察（判据③的对照组）。 */
function healthyMedium(): ApprovalInsight {
  return {
    level: 'medium',
    changeNatures: ['改动网络请求或超时'],
    hits: [],
    focusLines: [],
    impact: emptyImpact('ok'),
    degraded: false,
    elapsedMs: 1,
  };
}

/**
 * 进程级全局 locale 的现场保护。
 *
 * ⚠️ 这里**不能**在 `afterEach` 里硬写 `setLocale('zh')`（第一版就是这么写的）：
 * 在 `LUMEN_LOCALE=en` 下跑全量时，那等于把全局 locale 从 en 改成 zh 并留给后续文件，
 * 制造一个只在「换环境跑全量」时才现形的顺序依赖——AGENTS 把这类泄漏列为硬伤。
 * 正确做法是**记下进入时的值，退出时原样放回**。
 *
 * 读法用 `t()` 与 `DICTS` 的**身份比较**（字典是常量对象，`t()` 直接返回其中之一），
 * 这样不必为测试给产品加一个 `getLocale()` 导出（发布门 12 只该动呈现层）。
 */
function currentLocaleOf(): Locale {
  return t() === DICTS.en ? 'en' : 'zh';
}

let localeBefore: Locale;

beforeEach(() => {
  localeBefore = currentLocaleOf();
  setLocale('zh');
});

afterEach(() => {
  // 逐字复原（不是「复位成 zh」）：用例做了什么都不许漏给下一个文件
  setLocale(localeBefore);
});

describe('判据① 四种静默降级各给可区分的说明行', () => {
  it('四种都返回非空文案，且各自提到自己的成因（正例自证 + 键位映射）', () => {
    // 正例自证：先确认字典真的被读到（否则下面的断言可能全在跟 undefined 比）
    expect(typeof degradeNotice('config-off')).toBe('string');

    for (const reason of SILENT_REASONS) {
      const text = degradeNotice(reason);
      expect(text, `${reason} 没有文案`).toBeTruthy();
      // 改坏方式：把某个键映射成另一个 —— 这条会红在「辨识词对不上」
      expect(text, `${reason} 的文案没提到自己的成因`).toContain(IDENTIFYING_WORD[reason]);
    }
  });

  it('四条文案互不相同（映射退化成同一句兜底 ⇒ 红）', () => {
    const texts = SILENT_REASONS.map((r) => degradeNotice(r) ?? '');
    // 改坏方式：四条全返回 `dict.degradeError` —— 这条立刻红（Set 只剩 1 个元素）
    expect(new Set(texts).size).toBe(SILENT_REASONS.length);
  });

  it('每条都以「仍按常规逐个确认」收尾（结论承诺：降级只影响放行、不影响询问）', () => {
    for (const reason of SILENT_REASONS) {
      // 改坏方式：只报原因、不报结论 —— 用户会以为「降级 = 放行变宽了」
      expect(degradeNotice(reason), reason).toContain(CONCLUSION);
    }
  });

  it('阶梯自证：本该说话的 4 种有值，其余一律无值', () => {
    // 有值侧
    for (const reason of SILENT_REASONS) {
      expect(degradeNotice(reason), reason).toBeDefined();
    }
    // 无值侧（每一条都是一个独立的废实现：给它编文案就等于说谎）
    // - huge-diff：rich 卡已有「共 N 行改动，风险分析已跳过」的告知行，重复一遍是噪音
    expect(degradeNotice('huge-diff')).toBeUndefined();
    // - timeout：`DegradeReason` 里的死成员，生产路径从不产出（超时落在 impact.status 上）。
    //   给它写文案 = 写一句永远不会显示的话。改坏方式：把它加进映射表 ⇒ 这条红。
    expect(degradeNotice('timeout')).toBeUndefined();
    // - undefined：没有洞察 = 我们不知道有没有降级，此时一个字都不许多说
    expect(degradeNotice(undefined)).toBeUndefined();
  });
});

describe('判据② 说明行在 plain 卡上必须可见', () => {
  it('四种降级的行序都是 title → notice → detail → buttons', () => {
    for (const reason of SILENT_REASONS) {
      const lines = renderApprovalLines({ ...BASE, insight: degraded(reason) });
      // 改坏方式：把 notice 塞到 detail 之后 / 干脆不 push ⇒ 行序断言红
      expect(
        lines.map((l) => l.role),
        reason,
      ).toEqual(['title', 'notice', 'detail', 'buttons']);
    }
  });

  it('notice 行文本与纯函数输出一致，且整段文本里能找到它', () => {
    for (const reason of SILENT_REASONS) {
      const lines = renderApprovalLines({ ...BASE, insight: degraded(reason) });
      const noticeLine = lines.find((l) => l.role === 'notice');
      expect(noticeLine?.text, reason).toBe(degradeNotice(reason));
      // 端到端可读性：用户看到的整段文本里必须有这句（不只看结构体）
      expect(renderApprovalText({ ...BASE, insight: degraded(reason) }), reason).toContain(
        CONCLUSION,
      );
    }
  });

  it('说明行排在详情之前（用户读 diff 前就该知道这一卡的分析没生效）', () => {
    const lines = renderApprovalLines({ ...BASE, insight: degraded('non-tty') });
    const noticeIndex = lines.findIndex((l) => l.role === 'notice');
    const detailIndex = lines.findIndex((l) => l.role === 'detail');
    // 改坏方式：把 push 挪到 detail 之后 ⇒ 这条红（用户得读完几十行 diff 才看到结论）
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(detailIndex);
  });

  it('四种都不再「静默」：IsPlain 仍为 true（只加了一行字，没改变降级判定）', () => {
    for (const reason of SILENT_REASONS) {
      // 反向护栏：别为了「说话」把降级判定改掉——呈现层的活儿只能在呈现层干
      expect(isPlainApproval({ ...BASE, insight: degraded(reason) }), reason).toBe(true);
    }
  });
});

describe('判据③ 否定面：没降级时不得出现这句结论', () => {
  it('未降级的中风险 rich 卡全文不含「仍按常规逐个确认」', () => {
    const text = renderApprovalText({ ...BASE, insight: healthyMedium() });
    // 改坏方式：无条件 push notice（不看 degradeReason）⇒ 这条红。
    // 为什么必须钉死：对所有弹框都加「已降级」= 对所有弹框都说「分析坏了」，
    // 用户会学会无视这一行，等于把护栏自己废掉。
    expect(text).not.toContain(CONCLUSION);
  });

  it('insight=null 仍是严格三行（v4.1.1 原貌，T11-a 的承诺不许破）', () => {
    const lines = renderApprovalLines({ ...BASE, insight: null });
    // 改坏方式：无 insight 时也 push 兜底文案 ⇒ 红（我们并不知道有没有降级，多写一个字都是猜）
    expect(lines.map((l) => l.role)).toEqual(['title', 'detail', 'buttons']);
  });

  it('rich=false 且无 insight 时同样严格三行', () => {
    const lines = renderApprovalLines({ ...BASE, insight: null, rich: false });
    expect(lines.map((l) => l.role)).toEqual(['title', 'detail', 'buttons']);
  });
});

describe('判据④ 文案纪律', () => {
  it('四条文案都不含「安全」（未分析 ≠ 安全，延续 D93）', () => {
    for (const reason of SILENT_REASONS) {
      // 改坏方式：写成「已安全降级」「安全兜底」⇒ 红。
      // 降级只说明「这次没有分析结论」，说成「安全」就是把否定证据当保证卖。
      expect(degradeNotice(reason), reason).not.toContain('安全');
    }
  });

  it('en 侧四条均无中文（换环境不漏中文，且与 zh 同样带结论承诺）', () => {
    setLocale('en');
    for (const reason of SILENT_REASONS) {
      const text = degradeNotice(reason) ?? '';
      // 改坏方式：en.ts 漏键（typecheck 会先拦）/ 从 zh 复制过来 ⇒ 这条红
      expect(text, `${reason} 的英文文案漏了`).toBeTruthy();
      expect(text, `${reason} 的英文文案混入 CJK`).not.toMatch(/[\u4e00-\u9fff]/);
      expect(text.toLowerCase(), `${reason} 的英文文案没给结论`).toContain('as usual');
    }
  });
});

describe('同源护栏：判定集合与文案键必须来自同一张表', () => {
  it('PLAIN_DEGRADE_REASONS 由 PLAIN_DEGRADE_NOTICE_KEYS 派生，不是另写一份字面量', () => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'ui', 'approval-text.ts'), 'utf8');
    // 先剥注释再断言（本项目既有护栏的通行做法）：注释里解释这段逻辑是**说明**，
    // 不剥的话护栏会逼人删掉好注释——那是不该有的激励。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // 正例自证（探针通电）：先证明「文件真读到了、关键符号在」，否则下面两条可能空转
    expect(code).toContain('PLAIN_DEGRADE_NOTICE_KEYS');
    expect(code).toContain('export function degradeNotice');

    // 判定集合必须派生（否则「新增一种降级 ⇒ 也走 plain ⇒ 忘了写文案」会再次静默）
    expect(code).toContain('Object.keys(PLAIN_DEGRADE_NOTICE_KEYS)');
    // 否定面：不许再出现手写的字面量集合
    // 改坏方式：把派生换回 `new Set(['config-off', 'error', 'non-tty', 'ci'])` ⇒ 这条红，
    // 而上面「四种都有文案」的用例仍然全绿——那正是这个护栏存在的理由。
    expect(code).not.toMatch(/new Set\(\s*\[\s*'config-off'/);
  });
});

describe('与 T11-a 的兼容：plain 卡在「没有降级事实」时逐字节未变', () => {
  it('同一输入下，改动前后三行原文完全一致（防止顺手改坏原貌承诺）', () => {
    const text = renderApprovalText({ ...BASE, insight: null, rich: false });
    expect(text.split('\n')).toEqual([
      '编辑文件: 编辑文件 a.ts',
      'const a = 1',
      '批准 (y / Enter) / 拒绝 (n / Esc)',
    ]);
  });

  it('detail 里的 diff 仍原样输出（新增的 notice 行不吃掉它）', () => {
    const detail = '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;';
    const lines = renderApprovalLines({ ...BASE, detail, insight: degraded('error') });
    expect(lines.find((l) => l.role === 'detail')?.text).toBe(detail);
    expect(parseDiff(detail).length).toBeGreaterThan(0); // 自证：这份 detail 确实可解析
  });
});
