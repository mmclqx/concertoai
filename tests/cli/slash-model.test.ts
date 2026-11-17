/**
 * `/model` 斜杠命令测试（v5.0 T6）。
 *
 * 安全红线（比功能更重要的三条）：
 * 1. **升级方向必须确认**，且确认回调异常/返回 false 一律保持原模型（fail-closed）；
 * 2. **降级方向直接生效**（省钱方向不需要给用户增加摩擦）；
 * 3. **非 deepseek Provider 拒绝切换**（不在价格表内的模型切换无意义，不能假装成功）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  executeModelCommand,
  type ModelCommandContext,
  parseModelCommand,
} from '../../src/cli/slash/model';
import { t, tierLabel } from '../../src/i18n';

/**
 * 期望值一律**与产品同源**（`t().modelCmd.*`），不再抄中文字面量。
 *
 * 为什么必须这样（v5.6）：原先这些断言写的是 `toContain('¥1/百万')`。
 * 产品本地化后，同一个断言在 `LUMEN_LOCALE=en` 下**必然红** ——
 * 因为 en 说的是 `¥1M`。数字是通用的，**单位是文案**：
 * `¥` 保留（价格是人民币，不能改美元），`/百万` ↔ `M` 必须跟着语言走。
 *
 * 所以下面的断言形态是 `¥1${litAfter(statusPrice, 'input')}`：
 * 数字 `1` 写死（它是价格表事实），单位从模板里取（它是文案）。
 */

/** 当前语言下的 `/model` 文案组。 */
const c = () => t().modelCmd;

/**
 * 取模板中 `{key}` 之后、到「停顿字符」之前的字面文字。
 *
 * 例：`statusPrice` 里 `{input}` 之后，zh 是 `/百万`、en 是 `M`
 * ⇒ 断言 `¥1${litAfter(tpl,'input',/[ ·]/)}` 两种语言都成立且都不抄文案。
 */
function litAfter(template: string, key: string, stop: RegExp): string {
  const parts = template.split(`{${key}}`);
  if (parts.length < 2) return '';
  const rest = parts[1] as string;
  const m = stop.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

/** 取模板里第一个占位符之前的字面部分（「输出里包含这句话」类断言用）。 */
function head(template: string): string {
  const i = template.indexOf('{');
  return i < 0 ? template : template.slice(0, i);
}

/** 周三 20:00 → 空闲（固定时刻，避免时间依赖）。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

/** 构造执行上下文（默认 deepseek + 空闲时刻）。 */
function makeCtx(overrides: Partial<ModelCommandContext> = {}): ModelCommandContext {
  return {
    currentModel: 'deepseek-v4-flash',
    providerName: 'deepseek',
    confirm: async () => true,
    at: OFFPEAK_AT,
    ...overrides,
  };
}

describe('parseModelCommand', () => {
  it('非 /model 输入返回 null（不误拦普通对话）', () => {
    expect(parseModelCommand('你好')).toBeNull();
    expect(parseModelCommand('/modellist')).toBeNull();
    expect(parseModelCommand('/review')).toBeNull();
  });

  it('/model → status；/model list → list；/model auto → auto', () => {
    expect(parseModelCommand('/model')).toEqual({ type: 'status' });
    expect(parseModelCommand('  /model  ')).toEqual({ type: 'status' });
    expect(parseModelCommand('/model list')).toEqual({ type: 'list' });
    expect(parseModelCommand('/model auto')).toEqual({ type: 'auto' });
    expect(parseModelCommand('/model AUTO')).toEqual({ type: 'auto' });
  });

  it('/model <id> → switch（含 trim）', () => {
    expect(parseModelCommand('/model deepseek-v4-pro')).toEqual({
      type: 'switch',
      modelId: 'deepseek-v4-pro',
    });
    expect(parseModelCommand('/model   deepseek-v4-pro  ')).toEqual({
      type: 'switch',
      modelId: 'deepseek-v4-pro',
    });
  });

  it('未知模型 → unknown（带可用清单，不静默吞掉）', () => {
    const cmd = parseModelCommand('/model gpt-5');
    expect(cmd?.type).toBe('unknown');
    if (cmd?.type === 'unknown') {
      expect(cmd.message).toContain(head(c().unknownModel));
      expect(cmd.message).toContain('deepseek-v4-flash');
      expect(cmd.message).toContain('auto');
    }
  });
});

describe('executeModelCommand：查看类命令', () => {
  it('/model 显示当前模型 + 当前时段单价', async () => {
    const result = await executeModelCommand({ type: 'status' }, makeCtx());
    expect(result.handled).toBe(true);
    const content = result.message?.content ?? '';
    expect(content).toContain('DeepSeek V4 Flash');
    // 档位词走 i18n（K18 已建立的单一来源），不再写死「空闲价」。
    // 字面量必须是 `PriceTier` 的真值 `'offpeak'`（小写 p）：写成 `'offPeak'` 时
    // `tierLabel()` 走 `tier === 'peak' ? … : …` 的 else 分支**恰好也返回空闲档文案**，
    // 于是运行时照样绿、只有 typecheck 能抓到 —— 这类「碰巧对的字面量」必须让 tsc 咬住。
    expect(content).toContain(tierLabel('offpeak'));
    // 价格单位按 locale：zh `/百万`、en `M`。数字 1 是价格表事实，单位是文案。
    expect(content).toContain(`¥1${litAfter(c().statusPrice, 'input', /[ ·]/)}`);
    expect(result.nextModel).toBeUndefined(); // 查看不改变模型
  });

  it('/model list 列出全部模型并标记当前', async () => {
    const result = await executeModelCommand({ type: 'list' }, makeCtx());
    const content = result.message?.content ?? '';
    expect(content).toContain('deepseek-v4-flash');
    expect(content).toContain('deepseek-v4-pro');
    expect(content).toContain(c().listCurrentMark);
    expect(result.nextModel).toBeUndefined();
  });

  it('/model auto 启用预设：返回起始模型 + 策略说明含「不会自动升级」', async () => {
    const result = await executeModelCommand(
      { type: 'auto' },
      makeCtx({ currentModel: 'deepseek-v4-pro' }),
    );
    expect(result.handled).toBe(true);
    expect(result.nextModel).toBe('deepseek-v4-flash');
    // autoNoAutoUpgrade 无占位符 ⇒ head() 返回整句（「不会自动升级…」那句）
    expect(result.message?.content).toContain(head(c().autoNoAutoUpgrade));
    expect(result.message?.content).toContain(head(c().autoEnabled));
  });

  it('/model auto 不需要确认（设初值不是花钱动作）', async () => {
    const confirm = vi.fn(async () => true);
    await executeModelCommand({ type: 'auto' }, makeCtx({ confirm }));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('executeModelCommand：切换（成本方向决定是否确认）', () => {
  it('升级 flash→pro → 先确认，确认后切换', async () => {
    // 显式声明参数类型：否则 mock.calls 被推断成 []（无参数元组），取不到提问文案
    const confirm = vi.fn(async (_question: string) => true);
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({ confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    // 确认文案必须含成本对比（不能只问「是否切换」）
    const question = String(confirm.mock.calls[0]?.[0] ?? '');
    expect(question).toContain(head(c().costCompare));
    // 倍数单位按 locale：zh `3.9 倍`、en `3.9x`。数字 3.9 由价格表算出，单位是文案。
    expect(question).toContain(`3.9${litAfter(c().costCompare, 'ratio', /[）)]/)}`);
    expect(result.nextModel).toBe('deepseek-v4-pro');
    expect(result.message?.content).toContain(head(c().switchedUpgrade));
  });

  it('升级时用户拒绝（返回 false）→ 保持原模型', async () => {
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({ confirm: async () => false }),
    );
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain(head(c().upgradeCancelled));
    expect(result.message?.content).toContain(head(c().costCompare));
  });

  it('【fail-closed】确认回调抛错（审批中断/Esc）→ 不切换', async () => {
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({
        confirm: async () => {
          throw new Error('审批被中断');
        },
      }),
    );
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain(head(c().upgradeCancelled));
  });

  it('降级 pro→flash → 不需要确认，直接生效', async () => {
    const confirm = vi.fn(async () => true);
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-flash' },
      makeCtx({ currentModel: 'deepseek-v4-pro', confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result.nextModel).toBe('deepseek-v4-flash');
    expect(result.message?.content).toContain(head(c().switchedDowngrade));
  });

  it('已是当前模型 → 不重复切换、只提示', async () => {
    const confirm = vi.fn(async () => true);
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-flash' },
      makeCtx({ confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain(head(c().alreadyCurrent));
  });

  it('非 deepseek Provider → 明确拒绝并给出正确命令', async () => {
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({ providerName: 'ollama' }),
    );
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain('ollama');
    expect(result.message?.content).toContain('provider switch');
  });

  it('未知命令 → 回显错误但不崩', async () => {
    // 这里的 message 是「上游已经拼好的句子」，本用例只验证 execute 会原样回显，
    // 故用产品模板拼出同一句（而不是抄字面量），en 下同样成立。
    const upstream = head(c().unknownModel);
    const result = await executeModelCommand({ type: 'unknown', message: upstream }, makeCtx());
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain(upstream);
  });
});

describe('/model 状态里的升级提示：只说不动手', () => {
  it('flash 上状态文本含升级提示与成本倍数（命令可复制）', async () => {
    const result = await executeModelCommand({ type: 'status' }, makeCtx());
    const content = result.message?.content ?? '';
    expect(content).toContain('💡');
    expect(content).toContain('/model deepseek-v4-pro');
    // 「需确认」这件事必须说出来。zh 是「倍成本，需确认后生效」，en 是
    // 「x, applies after you confirm」—— 取 `{ratio}` 到收尾括号之间整段，两种语言都覆盖到。
    expect(content).toContain(litAfter(c().upgradeHint, 'ratio', /[)）]/));
    // 提示不等于切换：状态命令绝不改变模型
    expect(result.nextModel).toBeUndefined();
  });

  it('pro（已最高档）状态文本无升级提示，仍保留用法行', async () => {
    const result = await executeModelCommand(
      { type: 'status' },
      makeCtx({ currentModel: 'deepseek-v4-pro' }),
    );
    const content = result.message?.content ?? '';
    expect(content).not.toContain('💡');
    expect(content).toContain(c().statusUsage);
  });
});
