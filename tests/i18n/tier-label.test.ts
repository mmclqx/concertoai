/**
 * 价格档位标注（`tierLabel`）i18n 能力测试（v5.0 K18 / D89）。
 *
 * ## 为什么单独一个文件
 *
 * 这类缺陷的共性是**不报错、不崩、单测全绿**：`en` 用户的整行模板早已切英文，
 * 只有 `{tier}` 这一段是 `models.ts` 里写死的中文三元表达式，于是输出
 * 「📊 Current DeepSeek V4 Flash 空闲价: …」——一眼看去像翻译漏了一处，
 * 实际是「文案住在价格层」的结构问题。断言必须钉在**输出整行**上，
 * 而不是钉在「字典里有这个键」（后者字典齐了也可能没人取）。
 *
 * ## 探针通电约定
 *
 * 「en 下零 CJK」这类断言很容易空转（空字符串、根本没渲染都满足），
 * 因此每个 en 断言都在**同一用例内**先证明 zh 侧确有 CJK（AGENTS 检索/归因类自证）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { priceTierSummary } from '../../src/cli/balance';
import { executeModelCommand } from '../../src/cli/slash/model';
import { configureHolidayCalendar, resetHolidayCalendar } from '../../src/core/holidays';
import { setLocale, tierLabel } from '../../src/i18n';
import { buildAutoPolicyGuide } from '../../src/model/auto';

/** CJK 统一汉字区（en 文案不得命中）。 */
const CJK = /[\u4e00-\u9fff]/;

/** 周三 10:00 → 计价高峰。 */
const PEAK_AT = new Date(2026, 9, 28, 10, 0, 0);
/** 周三 20:00 → 空闲。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

afterEach(() => {
  // AGENTS 明文点名的模块级可变状态：切过 en 必须复位，否则污染同进程其它用例
  setLocale('zh');
  resetHolidayCalendar();
});

describe('tierLabel（档位标注随 locale）', () => {
  it('默认（zh）下是中文标注', () => {
    expect(tierLabel('peak')).toBe('高峰价');
    expect(tierLabel('offpeak')).toBe('空闲价');
  });

  it('en 下是英文标注，且零 CJK（同用例先自证 zh 侧确有中文）', () => {
    setLocale('zh');
    expect(tierLabel('offpeak')).toMatch(CJK); // 探针通电：同一个函数 zh 侧真的输出中文

    setLocale('en');
    expect(tierLabel('peak')).toBe('peak hours');
    expect(tierLabel('offpeak')).toBe('off-peak hours');
    expect(tierLabel('peak')).not.toMatch(CJK);
    expect(tierLabel('offpeak')).not.toMatch(CJK);
  });

  it('切换 locale 立即生效（不缓存旧值 / 不依赖启动期）', () => {
    setLocale('en');
    expect(tierLabel('peak')).toBe('peak hours');
    setLocale('zh');
    expect(tierLabel('peak')).toBe('高峰价');
  });
});

describe('balance 整行跟随 locale（用户报的那条泄漏点）', () => {
  it('en 下整行（含未配置节假日提示）零 CJK，且含 off-peak hours', () => {
    // 先自证：zh 下同一行确实有 CJK，否则下面的「零 CJK」毫无证据力
    setLocale('zh');
    expect(priceTierSummary(OFFPEAK_AT)).toMatch(CJK);

    setLocale('en');
    const line = priceTierSummary(OFFPEAK_AT);
    expect(line).toContain('off-peak hours');
    expect(line).not.toMatch(CJK);
  });

  it('en 下高峰档标注 peak hours（两档都跟随，不是只改了一档）', () => {
    setLocale('en');
    configureHolidayCalendar({ holidays: ['2026-01-01'] }); // 配置了日历 → 不附加提示行
    const line = priceTierSummary(PEAK_AT);
    expect(line).toContain('peak hours');
    expect(line).not.toContain('off-peak hours');
    expect(line).not.toMatch(CJK);
  });

  it('zh 下补了「当前」与模型名之间的空格（v5.0 K18 顺带修正）', () => {
    setLocale('zh');
    expect(priceTierSummary(OFFPEAK_AT)).toContain('📊 当前 DeepSeek V4 Flash 空闲价');
  });
});

describe('同一实现、四处受益（/model · auto 引导 · balance · 状态条）', () => {
  it('/model status 的档位词跟随 locale', async () => {
    setLocale('en');
    const result = await executeModelCommand(
      { type: 'status' },
      {
        currentModel: 'deepseek-v4-flash',
        providerName: 'deepseek',
        confirm: async () => false,
        at: OFFPEAK_AT,
      },
    );
    const text = result.message?.content ?? '';
    // 只验证档位词跟随 locale：`/model` 整段文案仍是中文（已挂账，不在本轮范围），
    // 因此这里**不能**断言整段零 CJK —— 那会让用例替另一个缺口背锅（或反向假绿）。
    expect(text).toContain('当前时段：off-peak hours');
    expect(text).toMatch(CJK); // 反向自证：整段其余部分确实还是中文（挂账事实，改了要回来更新）
  });

  it('auto 引导的档位词跟随 locale（模块内不再有第二份文案）', () => {
    setLocale('en');
    const text = buildAutoPolicyGuide(OFFPEAK_AT).join('\n');
    expect(text).toContain('off-peak hours');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 源码护栏：价格层不得再出现用户可见文案（反向样本自证有牙）
// ══════════════════════════════════════════════════════════════════════

/** 找出源码里写死的档位中文字面量（纯函数，便于反向样本自证）。 */
function findHardcodedTierLabels(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((text, index) => ({ text, lineNo: index + 1 }))
    .filter(({ text }) => /高峰价|空闲价/.test(text))
    .map(({ text, lineNo }) => `${lineNo}: ${text.trim()}`);
}

/**
 * 找出「从价格层取档位标注」的旧 import（迁移回退即违规）。
 *
 * 按**整段 import 语句**匹配（不是逐行）：多行具名导入（`import {\n a,\n tierLabel,\n} from '…'`）
 * 恰恰是最容易被写回去的形态，逐行正则会漏掉它 = 护栏空转。
 */
function findOldTierLabelImports(source: string): string[] {
  const pattern = /import\s+(?:type\s+)?\{[^}]*\btierLabel\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/g;
  const hits: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const from = match[1] ?? '';
    if (from === './models' || from.endsWith('model/models')) {
      hits.push(match[0].replace(/\s+/g, ' ').trim());
    }
  }
  return hits;
}

/** 读源码（路径相对仓库根，与其它源码护栏用例同口径）。 */
function readSource(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), 'utf8');
}

describe('源码护栏（D89：文案归 i18n，价格层零 i18n 依赖）', () => {
  it('models.ts 不再含「高峰价 / 空闲价」字面量', () => {
    expect(findHardcodedTierLabels(readSource('src/model/models.ts'))).toEqual([]);
  });

  it('护栏有牙：旧写法必须被判违规（反向样本）', () => {
    expect(
      findHardcodedTierLabels(
        "export function tierLabel(tier) {\n  return tier === 'peak' ? '高峰价' : '空闲价';\n}",
      ),
    ).toEqual(["2: return tier === 'peak' ? '高峰价' : '空闲价';"]);
  });

  it('models.ts 不 import i18n（价格层只谈事实，不谈怎么说）', () => {
    const source = readSource('src/model/models.ts');
    expect(source).not.toMatch(/from '\.\.\/i18n/);
    // 反向自证：真写了会被抓
    expect("import { t } from '../i18n';").toMatch(/from '\.\.\/i18n/);
  });

  it('四个调用点统一从 i18n 取 tierLabel，无人再从 model/models 取', () => {
    const consumers = [
      'src/cli/balance.ts',
      'src/cli/slash/model.ts',
      'src/model/auto.ts',
      'src/ui/StatusBar.tsx',
    ];
    for (const file of consumers) {
      const source = readSource(file);
      expect(findOldTierLabelImports(source)).toEqual([]);
      expect(source).toContain('tierLabel');
    }
    // 反向自证：旧 import 形态会被抓（返回的是 import 语句本体，不含结尾分号）
    expect(
      findOldTierLabelImports("import { getModel, tierLabel } from '../../model/models';"),
    ).toEqual(["import { getModel, tierLabel } from '../../model/models'"]);
  });
});
