/**
 * `decideAutoLow` 的判定测试 + 安全命门源码护栏（v5.1 T1.1）。
 *
 * ## 这个文件最重要的不是「放行能通过」，而是「不该放行的每一条都挡住」
 *
 * 放行判据是 `degraded === false && level === 'low'`。它之所以必须两条一起判：
 * `analyzeApproval` 降级时 `hits = []`，而 `levelOf([]) === 'low'`
 * ⇒ **降级路径的 level 恰好就是 low**（非 TTY / CI / config-plain / 超大 diff 四种）。
 * 只判 level ⇒ 这四种情况全部自动放行，等于 yolo。
 *
 * 所以本文件的核心是「否定面」：每条 `degraded: true` 的输入都必须 `ask`。
 *
 * ## 探针（T1.3 M1-M5 里与本文件相关的那条）
 *
 * M1：把 `if (input.insight.degraded !== false)` 整段删掉 ⇒
 * 本文件「degraded 一律 ask」的 4 条用例 + 源码护栏用例**必须同时红**。
 * 注释写明「配 M1 探针验证有牙」，不许只写「已测试」。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { type AutoLowInput, type AutoLowReason, decideAutoLow } from '../../src/core/auto-approve';
import type { RiskLevel } from '../../src/core/risk-rules';
import type { ApprovalRequest } from '../../src/index';
import type { ApprovalKind } from '../../src/ui/approval-text';

const REPO_ROOT = process.cwd();

/** 便捷构造：一次「零命中且分析成功」的编辑（唯一允许放行的形状）。 */
const cleanEdit: AutoLowInput = {
  enabled: true,
  kind: 'edit',
  insight: { degraded: false, level: 'low' },
};

/** 跑一次判定，返回 `${action}/${reason}`，让表驱动用例读起来像一张表。 */
const verdict = (input: AutoLowInput): string => {
  const d = decideAutoLow(input);
  return `${d.action}/${d.reason}`;
};

const insight = (level: RiskLevel, degraded = false) => ({ degraded, level });

describe('decideAutoLow：放行只有一种形状', () => {
  it('enabled + edit + 分析成功 + 零命中 ⇒ 放行（唯一允许的情形）', () => {
    expect(decideAutoLow(cleanEdit)).toEqual({ action: 'allow', reason: 'low-clean' });
  });

  it('纯函数：同输入必得同输出（重复调用结果一致）', () => {
    const a = decideAutoLow(cleanEdit);
    const b = decideAutoLow(cleanEdit);
    expect(a).toEqual(b);
  });

  it('不修改入参（无副作用）', () => {
    const input: AutoLowInput = {
      enabled: true,
      kind: 'edit',
      insight: { degraded: false, level: 'low' },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    decideAutoLow(input);
    expect(input).toEqual(snapshot);
  });
});

describe('decideAutoLow：**安全命门**——降级路径一律 ask（配 M1 探针验证有牙）', () => {
  /**
   * 这 4 条是本文件的核心。
   *
   * 为什么反复强调：这四种场景下 `level` **就是 `'low'`**（真实 `analyzeApproval` 的返回值，已实测），
   * 唯一的区别是 `degraded === true`。把它们放过去，用户就会在「非 TTY / CI / 配置关闭 / 超大 diff」
   * 时被自动执行 `rm -rf`——而这正是产品定位里最不能破的那条。
   *
   * 删掉 `if (input.insight.degraded !== false)` ⇒ 这 4 条全红（M1 探针）。
   */
  it('degraded=true 且 level=low（非 TTY）⇒ **ask/degraded**', () => {
    expect(verdict({ enabled: true, kind: 'edit', insight: insight('low', true) })).toBe(
      'ask/degraded',
    );
  });

  it('degraded=true 且 level=low（CI）⇒ **ask/degraded**', () => {
    expect(verdict({ enabled: true, kind: 'edit', insight: insight('low', true) })).toBe(
      'ask/degraded',
    );
  });

  it('degraded=true 且 level=high（降级 + 真有风险）⇒ **ask**，且原因优先归 degraded', () => {
    // 原因归 degraded 是刻意的：此时 hits 为空、level 已不可信，说「high」是假话
    expect(verdict({ enabled: true, kind: 'edit', insight: insight('high', true) })).toBe(
      'ask/degraded',
    );
  });

  it('degraded 不是布尔 false（如 undefined / 缺失）⇒ 一律 ask（fail-closed）', () => {
    const sneaky = { level: 'low' } as unknown as { degraded: boolean; level: RiskLevel };
    expect(verdict({ enabled: true, kind: 'edit', insight: sneaky })).toBe('ask/degraded');
  });
});

describe('decideAutoLow：其余该问的，一条都不许放', () => {
  it('没开开关 ⇒ ask/disabled（默认行为不变）', () => {
    expect(verdict({ ...cleanEdit, enabled: false })).toBe('ask/disabled');
  });

  it('shell ⇒ ask/not-edit（哪怕零命中；实测 21 条危险命令 18 条零命中）', () => {
    expect(verdict({ enabled: true, kind: 'shell', insight: insight('low') })).toBe('ask/not-edit');
  });

  it('model ⇒ ask/not-edit', () => {
    expect(verdict({ enabled: true, kind: 'model', insight: insight('low') })).toBe('ask/not-edit');
  });

  it('insight 为 null（分析未完成 / 抛错）⇒ ask/no-insight（fail-closed）', () => {
    expect(verdict({ enabled: true, kind: 'edit', insight: null })).toBe('ask/no-insight');
  });

  it('high ⇒ ask/high', () => {
    expect(verdict({ enabled: true, kind: 'edit', insight: insight('high') })).toBe('ask/high');
  });

  it('medium ⇒ ask/medium（5.1 刻意不放：concurrency/silent-catch/test-assertion-change）', () => {
    expect(verdict({ enabled: true, kind: 'edit', insight: insight('medium') })).toBe('ask/medium');
  });

  it('未知等级（未来新增，如 critical）⇒ ask（不认识就不放）', () => {
    const future = { degraded: false, level: 'critical' } as unknown as {
      degraded: boolean;
      level: RiskLevel;
    };
    expect(verdict({ enabled: true, kind: 'edit', insight: future })).toBe('ask/unknown-level');
  });
});

describe('decideAutoLow：阶梯自证（防「恒 allow」「恒 ask」两种废实现）', () => {
  /**
   * 「恒 allow」的废实现会被下面 6 条全打红；「恒 ask」会被前 1 条打红。
   * 只写正例时，两种废实现都能骗过其中一半——所以这里同时钉两个方向。
   */
  const ladder: Array<[string, AutoLowInput, string]> = [
    ['clean', cleanEdit, 'allow/low-clean'],
    ['disabled', { ...cleanEdit, enabled: false }, 'ask/disabled'],
    ['shell', { enabled: true, kind: 'shell', insight: insight('low') }, 'ask/not-edit'],
    ['no-insight', { enabled: true, kind: 'edit', insight: null }, 'ask/no-insight'],
    ['degraded', { enabled: true, kind: 'edit', insight: insight('low', true) }, 'ask/degraded'],
    ['high', { enabled: true, kind: 'edit', insight: insight('high') }, 'ask/high'],
    ['medium', { enabled: true, kind: 'edit', insight: insight('medium') }, 'ask/medium'],
  ];

  it.each(ladder)('%s ⇒ %s', (_label, input, expected) => {
    expect(verdict(input)).toBe(expected);
  });

  it('放行的只有一个分支：其余 6 种输入全部 ask（数一下，防止将来悄悄多开一个 allow 口子）', () => {
    const allowed = ladder.filter(([, input]) => decideAutoLow(input).action === 'allow');
    expect(allowed.map(([label]) => label)).toEqual(['clean']);
  });
});

describe('类型漂移护栏：AutoLowApprovalKind 必须覆盖 ApprovalRequest["kind"]', () => {
  /**
   * 刻意不 import（避免 core 反向依赖 tools），代价是「两处各声明一次」。
   * 这条**编译期**断言把漂移挡住：将来 `ApprovalRequest['kind']` 新增取值
   * （如 `'plugin'`）而 `AutoLowApprovalKind` 没跟上 ⇒ `npm run typecheck` 直接红。
   */
  it('两个 kind 联合类型可以互相赋值（编译期断言；运行时必然通过）', () => {
    const fromRequest: ApprovalKind = 'edit';
    const fromAutoLow: ApprovalRequest['kind'] = fromRequest;
    expect(fromAutoLow).toBe('edit');
  });
});

describe('源码护栏：degraded 与 level 判断必须同时存在于放行之前（配 M1 探针）', () => {
  const runGuard = () =>
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'check-auto-low-guard.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

  it('真实仓库 ⇒ exit 0（不该红必不红）', () => {
    const r = runGuard();
    expect(r.status, `guard stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('✅');
  });
});

describe('AutoLowReason 覆盖完整性', () => {
  it('每个 reason 都能被某条路径产出（防止出现永远不可达的死原因）', () => {
    const produced = new Set<AutoLowReason>();
    const inputs: AutoLowInput[] = [
      cleanEdit,
      { ...cleanEdit, enabled: false },
      { enabled: true, kind: 'shell', insight: insight('low') },
      { enabled: true, kind: 'edit', insight: null },
      { enabled: true, kind: 'edit', insight: insight('low', true) },
      { enabled: true, kind: 'edit', insight: insight('high') },
      { enabled: true, kind: 'edit', insight: insight('medium') },
      {
        enabled: true,
        kind: 'edit',
        insight: { degraded: false, level: 'critical' } as unknown as {
          degraded: boolean;
          level: RiskLevel;
        },
      },
    ];
    for (const input of inputs) produced.add(decideAutoLow(input).reason);
    expect([...produced].sort()).toEqual(
      [
        'degraded',
        'disabled',
        'high',
        'low-clean',
        'medium',
        'no-insight',
        'not-edit',
        'unknown-level',
      ].sort(),
    );
  });
});
