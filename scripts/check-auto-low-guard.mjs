/**
 * 安全命门源码护栏（v5.1 T1.1 / instruction-state 判据 C2）。
 *
 * 守的是**一句话**：`src/core/auto-approve.ts` 里「放行」必须同时受
 * `degraded` 与 `level === 'low'` 两个条件约束，且 degraded 判断必须在放行之前。
 *
 * ## 为什么要有源码级护栏（单测不是已经覆盖了吗）
 *
 * 单测覆盖的是「当前实现的输入输出」，它可以被**改实现 + 改测试**一起绕过；
 * 而这一条守的是「不许有人图省事把 degraded 那行删掉」——那行删掉后
 * 非 TTY / CI / 超大 diff / 分析降级时 level 恰好都是 low（`levelOf([]) === 'low'`），
 * 于是**任何**操作都会被自动放行，等于 yolo。
 * 变异探针 M1 直接删这行 ⇒ 本脚本必须 exit 1（改坏必红由探针实测，不只写在注释里）。
 *
 * ## 双向验收（AGENTS 硬要求）
 *
 * ① 该红必红：删 degraded 判断 / 把顺序调反 / 删 level 判断 ⇒ 各自 exit 1；
 * ② 不该红必不红：真实仓库 ⇒ exit 0；
 * ③ 不过度放宽：只允许**语义等价**的写法（见下方守卫的匹配规则），
 *    不许写成「文件里出现过 degraded 就算过」——那会让 `degraded` 只出现在注释里也通过
 *    （本条护栏刻意**先剥注释**再匹配）。
 */
import { readFileSync } from 'node:fs';

const TARGET = 'src/core/auto-approve.ts';

/** 剥掉块注释与行注释（避免「注释里提过 degraded」冒充「代码里判过 degraded」）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（`://` 这种不是注释）
}

function fail(message) {
  console.error(`❌ 安全命门护栏未通过：${message}`);
  console.error(`   文件：${TARGET}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(TARGET, 'utf8');
} catch (error) {
  fail(`读不到文件（${error instanceof Error ? error.message : String(error)}）`);
}

const code = stripComments(raw);

// ① 必须存在「degraded 判否」的代码（允许 `.degraded !== false` / `degraded === false` 两种等价写法）
const degradedIndex = (() => {
  const candidates = [
    code.indexOf('degraded !== false'),
    code.indexOf('degraded === false'),
    code.indexOf('!input.insight.degraded'),
    code.indexOf('!insight.degraded'),
  ].filter((i) => i >= 0);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
})();
if (degradedIndex < 0) {
  fail('代码里找不到 degraded 判断（删掉它 ⇒ 非 TTY/CI/大 diff/降级时全部自动放行 = yolo）');
}

// ② 必须存在「level 判 low」的代码
const lowIndex = (() => {
  const candidates = [code.indexOf("level === 'low'"), code.indexOf('level === "low"'), code.indexOf("case 'low'")].filter(
    (i) => i >= 0,
  );
  return candidates.length === 0 ? -1 : Math.min(...candidates);
})();
if (lowIndex < 0) {
  fail("代码里找不到 level === 'low' 判断（放行条件缺失）");
}

// ③ 顺序：degraded 判断必须在 level 判 low 之前（先排除降级，再谈放行）
if (degradedIndex > lowIndex) {
  fail('degraded 判断出现在 level 判 low 之后（顺序反了：降级路径会先被放行）');
}

// ④ 不许出现「无视 degraded 直接放行」的写法：**放行分支**（return 语句）必须晚于 degraded 判断
//    ⚠️ 只认 `return { action: 'allow'` 这种**放行分支**形态；不能搜 `action: 'allow'` ——
//    类型声明 `action: 'allow' | 'ask'` 在文件顶部，会让「顺序」判断永远失败（本条是实测踩到的：
//    第一版就是这么写的，护栏自己把真实仓库判红了）。
const allowIndex = (() => {
  const candidates = [code.indexOf("return { action: 'allow'"), code.indexOf('return { action: "allow"')].filter(
    (i) => i >= 0,
  );
  return candidates.length === 0 ? -1 : Math.min(...candidates);
})();
if (allowIndex < 0) {
  fail("找不到放行分支（return { action: 'allow' }：纯函数被整体改写的可能性，人工确认）");
}
if (allowIndex < degradedIndex) {
  fail('放行分支出现在 degraded 判断之前 ⇒ 降级路径可被放行');
}

console.log('✅ 安全命门护栏通过：degraded 判断 + level===\'low\' 判断都在，且 degraded 在放行之前');
