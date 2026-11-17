/**
 * `/model` 与 auto 引导的 i18n 护栏（v5.6，收 K18 的半成品）。
 *
 * ## 这四条各自防什么（不是重复）
 *
 * - **G1（en 零 CJK）**：防「改了一半」。K18 只把档位词换成了英文，包着它的模板全是中文，
 *   于是 en 用户看到 `当前时段：off-peak hours（输入 ¥1/百万…` —— 一半英文一半中文。
 *   单看「有没有英文」看不出来，**必须数 CJK 字符**。
 * - **G2（zh 仍是中文）**：防「两边都改成英文」——那样 G1 会绿而中文用户全炸。
 *   没有 G2 的 G1 是单边判据（AGENTS「判定类护栏必须双向」）。
 * - **G3（键非空）**：防漏填（空串会让屏幕少一行，且 G1 也绿 —— 没中文啊）。
 * - **G4（双语不同 + 占位符一致）**：v5.4 候选 3 实测补的那条 —— 只比「是否不同」时，
 *   en 少一个 `{占位符}` 也能全绿，而后果是英文用户看不到某个数字（如「有几个未核验」）。
 *
 * ## 为什么 `LUMEN_LOCALE=en npm test` **不能**代替本文件
 *
 * `currentLocale` 的默认值是 `zh`，只有 CLI 启动时 `setLocale()` 才跟随环境变量。
 * 用例进程里没有 CLI 启动 ⇒ 只设环境变量跑测试**读到的仍是中文**（v5.3 已登记的惰性）。
 * 所以这里必须显式 `setLocale('en')`，并在 `afterEach` 无条件复位。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveModel } from '../../src/cli/common';
import { executeModelCommand, parseModelCommand } from '../../src/cli/slash/model';
import { fmt, setLocale, t } from '../../src/i18n';
import { buildAutoPolicyGuide, buildUpgradeHint } from '../../src/model/auto';

/** 周三 20:00 → 空闲档（固定时刻，避免时间依赖）。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g;
const countCjk = (s: string) => (s.match(CJK) ?? []).length;

const ctx = {
  currentModel: 'deepseek-v4-flash',
  providerName: 'deepseek',
  confirm: async () => true,
  at: OFFPEAK_AT,
};

/**
 * 跑一遍「用户会看到的 /model 全部输出」。
 *
 * 覆盖 6 个入口：status / list / auto / 未知模型 / 升级确认问题 / 入口层 resolveModel 提示。
 * 少一个入口就少一处保护 —— 实测 `resolveModel` 那两句就是**在被漏掉之后**才发现的
 * （auto.test.ts 红出来的），故它必须进这个列表。
 */
async function allModelOutputs(): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];

  const status = await executeModelCommand({ type: 'status' }, ctx);
  out.push({ name: 'status', text: status.message?.content ?? '' });

  const list = await executeModelCommand({ type: 'list' }, ctx);
  out.push({ name: 'list', text: list.message?.content ?? '' });

  const auto = await executeModelCommand({ type: 'auto' }, ctx);
  out.push({ name: 'auto', text: auto.message?.content ?? '' });

  const unknown = parseModelCommand('/model bogus-xyz');
  out.push({ name: 'unknown', text: unknown && unknown.type === 'unknown' ? unknown.message : '' });

  let asked = '';
  await executeModelCommand(
    { type: 'switch', modelId: 'deepseek-v4-pro' },
    {
      ...ctx,
      confirm: async (q: string) => {
        asked = q;
        return false;
      },
    },
  );
  out.push({ name: 'confirm', text: asked });

  const cancelled = await executeModelCommand(
    { type: 'switch', modelId: 'deepseek-v4-pro' },
    { ...ctx, confirm: async () => false },
  );
  out.push({ name: 'cancelled', text: cancelled.message?.content ?? '' });

  const downgrade = await executeModelCommand(
    { type: 'switch', modelId: 'deepseek-v4-flash' },
    { ...ctx, currentModel: 'deepseek-v4-pro' },
  );
  out.push({ name: 'downgrade', text: downgrade.message?.content ?? '' });

  const same = await executeModelCommand({ type: 'switch', modelId: 'deepseek-v4-flash' }, ctx);
  out.push({ name: 'same', text: same.message?.content ?? '' });

  const otherProvider = await executeModelCommand(
    { type: 'switch', modelId: 'deepseek-v4-pro' },
    { ...ctx, providerName: 'ollama' },
  );
  out.push({ name: 'otherProvider', text: otherProvider.message?.content ?? '' });

  out.push({ name: 'autoGuide', text: buildAutoPolicyGuide(OFFPEAK_AT).join('\n') });
  out.push({ name: 'upgradeHint', text: buildUpgradeHint('deepseek-v4-flash', OFFPEAK_AT) ?? '' });

  // 入口层 resolveModel 的两句话都走 console.error，这里捕获。
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    captured.push(a.map(String).join(' '));
  };
  try {
    resolveModel('auto');
    try {
      resolveModel('bogus-xyz-model'); // 未知模型会 process.exit(1)
    } catch {
      /* process.exit 在测试里是抛错 */
    }
  } finally {
    console.error = origErr;
  }
  out.push({ name: 'resolveModel', text: captured.join('\n') });

  return out;
}

beforeEach(() => {
  setLocale('zh');
});

afterEach(() => {
  // 无条件复位：`setLocale` 是模块级全局状态（AGENTS「进程级全局状态隔离」）。
  // 不复位会让同一 worker 里的后续用例读到 en ⇒ 红的原因变成「测试写法」而不是产品缺陷。
  setLocale('zh');
});

describe('/model 文案 i18n 护栏', () => {
  it('G1：en 下全部入口输出 CJK = 0（K18 那类「半英半中」不许再现）', async () => {
    setLocale('en');
    const outputs = await allModelOutputs();

    // 探针通电：入口必须真的产出了内容，否则「零 CJK」是空转（全都空串也零 CJK）
    for (const o of outputs) {
      expect(o.text.length, `入口 ${o.name} 输出为空 —— 零 CJK 就没意义了`).toBeGreaterThan(0);
    }

    const offenders = outputs
      .map((o) => ({ name: o.name, cjk: countCjk(o.text), sample: o.text.split('\n')[0] }))
      .filter((o) => o.cjk > 0);
    expect(offenders, `en 下仍有 CJK 的入口：${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it('G2：zh 下同一批入口仍是中文（双向：防「两边都改英文」）', async () => {
    setLocale('zh');
    const outputs = await allModelOutputs();
    const silent = outputs.filter((o) => countCjk(o.text) === 0).map((o) => o.name);
    expect(silent, `zh 下这些入口一个中文都没有（文案丢了？）：${JSON.stringify(silent)}`).toEqual(
      [],
    );
  });

  it('G3：`modelCmd` 每个键 zh/en 都非空（防漏填：空串会让屏幕少一行，而 G1 仍绿）', () => {
    const zhKeys = Object.keys(t().modelCmd);
    expect(zhKeys.length, 'modelCmd 键数变了？见执行日志 28 条').toBe(28);
    setLocale('en');
    const enKeys = Object.keys(t().modelCmd);
    expect(enKeys).toEqual(zhKeys);
    for (const k of zhKeys) {
      expect(zhKeys.includes(k)).toBe(true);
      // en 侧非空：注意 en 可能含 `¥`/`tokens`（单位有意保留），但不许是空串。
      // `?? ''`：noUncheckedIndexedAccess 下下标访问是 `string | undefined`；
      // 缺失键落成空串 ⇒ 长度 0 ⇒ 下面照样红（**不能**写成 `[k]!`，那会让缺失悄悄通过）。
      expect(((t().modelCmd as Record<string, string>)[k] ?? '').length).toBeGreaterThan(0);
    }
    setLocale('zh');
    for (const k of zhKeys) {
      expect(((t().modelCmd as Record<string, string>)[k] ?? '').length).toBeGreaterThan(0);
    }
  });

  it('G4：zh/en 文案不同，且**占位符集合一致**（en 少一个 {占位符} ⇒ 英文用户看不到那个数字）', () => {
    setLocale('zh');
    const zhDict = { ...t().modelCmd } as Record<string, string>;
    setLocale('en');
    const enDict = { ...t().modelCmd } as Record<string, string>;
    setLocale('zh');

    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    const problems: string[] = [];
    for (const k of Object.keys(zhDict)) {
      if (zhDict[k] === enDict[k]) problems.push(`${k}: zh 与 en 完全相同（忘了翻译？）`);
      const zp = placeholders(zhDict[k] ?? '').join(',');
      const ep = placeholders(enDict[k] ?? '').join(',');
      if (zp !== ep) problems.push(`${k}: 占位符不一致 zh=[${zp}] en=[${ep}]`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('G4b（正例自证）：fmt 真的能把占位符填进去 —— 否则上面几条「模板不同」没有意义', () => {
    setLocale('en');
    const rendered = fmt(t().modelCmd.statusCurrent, { label: 'X', id: 'y' });
    expect(rendered).toContain('X');
    expect(rendered).toContain('y');
    expect(rendered).not.toContain('{label}');
    expect(rendered).not.toContain('{id}');
  });
});
