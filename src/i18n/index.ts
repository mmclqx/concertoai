/**
 * i18n 入口：语言解析 + 当前字典。
 *
 * - 字典：zh（默认）/ en（结构同构，en.test.ts 断言键一致）；
 * - 语言选择：CLI --lang > LUMEN_LOCALE > LANG（zh/en 前缀）> 配置文件 > 默认 'zh'；
 * - 用法：`import { fmt, t } from '../i18n'`，文案用 `t().errors.noApiKey`。
 */

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
