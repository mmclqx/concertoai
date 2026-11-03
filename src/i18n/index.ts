/**
 * i18n 入口：语言解析 + 当前字典。
 *
 * - 字典：zh（默认）/ en（结构同构，en.test.ts 断言键一致）；
 * - 语言选择：CLI --lang > LUMEN_LOCALE > LANG（zh/en 前缀）> 配置文件 > 默认 'zh'；
 * - 用法：`import { fmt, t } from '../i18n'`，文案用 `t().errors.noApiKey`。
 */

// 仅类型导入（编译期擦除）：让 tierLabel 的签名沿用价格层自己的类型，
// 同时**不引入运行时环**（models.ts 不反向 import i18n，见 D89）。
import type { PriceTier } from '../model/models';
import { en } from './en';
import type { ZhDict } from './zh';
import { fmt, zh } from './zh';

export { fmt };

/** 字典的结构类型：叶节点均为 string（zh/en 各自字面量均可赋值）。 */
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

export type Dict = DeepStringify<ZhDict>;
export type Locale = 'zh' | 'en';

/** 全部可用字典（键结构一致）。 */
export const DICTS: Record<Locale, Dict> = { zh, en };

/** 把用户偏好解析为受支持的语言；未知值回退 zh。 */
export function resolveLocale(preferred: string | undefined): Locale {
  const value = preferred?.trim().toLowerCase();
  if (value === 'en' || value?.startsWith('en')) {
    return 'en';
  }
  return 'zh';
}

let currentLocale: Locale = 'zh';

/** 设置全局语言（启动时按配置调用一次；进程内不再变化）。 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/** 获取当前语言的文案字典。 */
export function t(): Dict {
  return DICTS[currentLocale];
}

/**
 * 价格档位 → 当前语言的标注（状态条 / balance / `/model` / auto 引导共用）。
 *
 * v5.0 K18 / D89：原先实现在 `model/models.ts`（写死「高峰价 / 空闲价」），
 * 于是 `en` 用户的模板已切英文、唯独档位词仍是中文。文案是**呈现层事实**，
 * 归 i18n 单一来源；价格层（models.ts）保持零 i18n 依赖。
 */
export function tierLabel(tier: PriceTier): string {
  return tier === 'peak' ? t().tierLabel.peak : t().tierLabel.offpeak;
}
