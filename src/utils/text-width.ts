/**
 * 终端显示宽度工具（v5.0 T9）。
 *
 * ## 为什么不能用 `String.length`
 *
 * `'超时'.length === 2`，但终端里占 **4 个字符格**；`'⚠️'.length === 2`（含 VS16），
 * 实际占 **2 格**。审批卡的 diff 行如果按 `.length` 截断，中文/emoji 行必然溢出边框，
 * 把整个 Ink 布局挤歪（比不截断更难看）。
 *
 * ## 口径（与主流终端一致的近似）
 *
 * | 类别 | 宽度 |
 * |---|---|
 * | CJK / 全角（汉字、假名、韩文、全角标点） | 2 |
 * | emoji（含 VS16 序列，如 `⚠️`） | 2（变体选择符 0） |
 * | 组合附加符号（U+0300-U+036F 等）、零宽字符 | 0 |
 * | 控制字符（`\u0000-\u001f`、`\u007f`） | 0 |
 * | ANSI 转义序列（`\x1b[32m`） | 0 |
 * | 其余 ASCII / 拉丁 | 1 |
 *
 * 纯函数，无 IO、无依赖（可被非 Ink 路径复用）。
 */

/**
 * ANSI 转义序列（SGR / 光标移动等；diff 上色后会出现在行内，宽度必须算 0）。
 *
 * 用**字面量正则**（不是 `new RegExp`拼接）——项目红线：热路径禁止动态构造正则以避免
 * `lastIndex` 残留与转义歧义；ESC(0x1b) 是本规则要匹配的目标字符，故显式豁免 lint。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 ANSI 转义必须以 ESC(0x1b) 开头
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** 去掉 ANSI 转义序列（宽度计算与快照断言用）。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** 是否为需要占 2 格的宽字符码点。 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区（汉字）
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f000 && cp <= 0x1f2ff) || // 麻将/扑克等 emoji 块
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji 主体（🚀📦…）
    (cp >= 0x2600 && cp <= 0x27bf) || // 杂项符号（⚠✅❌… 带 VS16 时仍按 2 计）
    (cp >= 0x2b00 && cp <= 0x2bff) // 箭头/星形符号
  );
}

/** 宽度为 0 的码点（组合符号 / 变体选择符 / 零宽字符 / 控制字符）。 */
function isZeroWidthCodePoint(cp: number): boolean {
  return (
    cp === 0 ||
    (cp >= 0x01 && cp <= 0x1f) ||
    cp === 0x7f ||
    (cp >= 0x300 && cp <= 0x36f) || // 组合用附加符号
    (cp >= 0x200b && cp <= 0x200f) || // 零宽空格 / 方向标记
    (cp >= 0x20d0 && cp <= 0x20f0) || // 组合符号补充
    (cp >= 0xfe00 && cp <= 0xfe0f) || // 变体选择符（含 VS16：⚠️ 的第二个码点）
    cp === 0xfeff || // BOM / 零宽不换行空格
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // emoji 肤色修饰符
  );
}

/**
 * 计算字符串在终端里的显示宽度（格数）。
 *
 * 注意：**逐码点**遍历（`for…of`），不用 `charCodeAt`——emoji 是代理对，
 * 按 UTF-16 单字节遍历会把一个 emoji 算成 2 个错误宽度。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const cp = char.codePointAt(0);
    if (cp === undefined || isZeroWidthCodePoint(cp)) {
      continue;
    }
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/** 省略号（宽度 1；中文环境下也按 1 格，`…` 是 U+2026 而非全角）。 */
export const ELLIPSIS = '…';

/**
 * 按**显示宽度**折行（不是截断）。
 *
 * 用于**解释性文字**（`[?]` 说明、影响面描述、风险点）：这些内容被截断就等于信息丢失，
 * 用户看不到「3 个文件读取失败已跳过」「只是建议重点关注，不是结论」这类关键限定语。
 *
 * - 逐码点按显示宽度硬折（**不做词边界处理**：中文无空格、diff/路径也不该被拆散语义）；
 * - `maxLines` 限制总行数（防止异常输入把卡片撑爆）；装不下时最后一行补省略号，
 *   让用户知道「还有内容没显示」，而不是以为文案本来就这么短；
 * - 空串返回空数组（调用方不需要额外的空判断）。
 */
export function wrapToWidth(text: string, width: number, maxLines = 3): string[] {
  if (text === '' || width <= 0 || maxLines <= 0) {
    return [];
  }
  const lines: string[] = [];
  let current = '';
  let used = 0;
  let dropped = false;
  for (const char of stripAnsi(text)) {
    const cp = char.codePointAt(0);
    const charWidth =
      cp === undefined || isZeroWidthCodePoint(cp) ? 0 : isWideCodePoint(cp) ? 2 : 1;
    if (used + charWidth > width) {
      lines.push(current);
      current = '';
      used = 0;
      if (lines.length >= maxLines) {
        dropped = true;
        break;
      }
    }
    current += char;
    used += charWidth;
  }
  if (!dropped && current !== '') {
    lines.push(current);
  }
  while (lines.length > maxLines) {
    lines.pop();
    dropped = true;
  }
  if (dropped && lines.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = truncateToWidth(`${lines[lastIndex] ?? ''}${ELLIPSIS}`, width);
  }
  return lines;
}

/**
 * 按**显示宽度**截断（超宽时末尾补省略号），保证「截断后宽度 ≤ width」。
 *
 * - `width <= 0` → 返回空串（不抛错，调用方可能在极端窄终端下运行）；
 * - 不需要截断时原样返回（不做任何字符替换，避免破坏 diff 前缀）；
 * - ANSI 序列会被计入 0 宽度但它本身无法被「切一半」，故本函数用于**已上色前的纯文本**。
 */
export function truncateToWidth(text: string, width: number, ellipsis: string = ELLIPSIS): string {
  if (width <= 0) {
    return '';
  }
  if (displayWidth(text) <= width) {
    return text;
  }
  const budget = width - displayWidth(ellipsis);
  if (budget <= 0) {
    return ellipsis.slice(0, Math.max(0, width));
  }
  let out = '';
  let used = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const charWidth =
      cp === undefined || isZeroWidthCodePoint(cp) ? 0 : isWideCodePoint(cp) ? 2 : 1;
    if (used + charWidth > budget) {
      break;
    }
    out += char;
    used += charWidth;
  }
  return `${out}${ellipsis}`;
}
