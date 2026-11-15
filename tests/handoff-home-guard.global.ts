/**
 * 套件级护栏：**跑完整个 `npm test` 之后，开发者真实 home 里本项目那份交接单必须一字未变**
 * （v5.3 A，2026-11-14）。
 *
 * ## 为什么这条判据必须放在 globalSetup，不能放在某个用例里
 *
 * 第一版把它写成 `tests/ui/handoff-isolation.test.tsx` 里的一个用例（「先读 sha → 渲染 → 再读 sha」），
 * 变异探针 M1（把 `tool-step.test.tsx` 改回 `cwd: process.cwd()` + 不钉家目录）**实测仍全绿**——
 * 而真实文件在同一轮里被覆盖了（5799B → 460B，sha `552e480a…` → `20695dcd…`）。
 *
 * 原因就一句话：**vitest 的文件是并行跑的，用例只看得见自己那一路的顺序**。
 * 那个用例在自己的 worker 里比对完了，污染是在**另一个 worker**里发生的。
 * 「本条绿」于是变成了对「套件干净」的假证明——正是 AGENTS「判据要放在真正能看见事实的那一层」。
 * 套件级不变式就只能在套件级钩子里验：**开始前快照、结束后比对**，与文件顺序、并行度无关。
 *
 * ## 探测器必须自证有牙（AGENTS「探针通电」）
 *
 * 「没变」这条断言有个天然的废实现形态：探测器恒返回同一个值 ⇒ 永远绿。
 * 所以 `setup` 里先对**合成样本**跑一遍「创建 + 改内容」，两次 sha 都必须被检测到不同；
 * 检测不出来就直接 throw（宁可不跑，也不给假绿）。
 *
 * ## sha 变了 **不等于** 测试干的（2026-11-14 实测，必须归因）
 *
 * 第一版判据是「sha 变了 ⇒ 红」。实测当场被打脸：本轮 verify 启动前 3 分钟，文件被
 * **开发者自己的 chat 会话**改写过（`> 会话: 20261115-001903-259`、`> 退出原因: max-turns`）——
 * 那是交接单的**正常用法**（App 每轮收尾都会刷新快照）。于是一个人「边开 chat 边跑 verify」
 * 就会看到假红。AGENTS 的判据句写得很清楚：**按规范做事反而假红，比不做事更糟**。
 *
 * 所以判据拆成两步：先判「变没变」，变了再**归因**——`> 会话:` 是真实会话 id
 * （`YYYYMMDD-HHMMSS-xxx`，由 `SessionStore.create` 生成）⇒ 外部会话写的 ⇒ 只告警不判红；
 * 否则（`无` / 假 id / 压根没有这一行）⇒ 只能是测试写的 ⇒ 判红。
 * 归因函数是**纯函数并配了双向用例**（`tests/cli/handoff-home-guard.test.ts`），不是靠注释自证。
 *
 * ## v5.3 B4（2026-11-15）：从「守一个文件」扩到「守根目录」
 *
 * 本文件现在还守**根目录本身**：`~/.concertoai/handoffs/` 下本轮**新增**的每个目录都必须能归因，
 * 归因不过 ⇒ 判红。两个判据（文件内容 / 目录新增）互相独立，各自 throw。
 *
 * 「能归因」= 会话 id 形状合法 **且** 该 id 在真实 `~/.concertoai/sessions/` 下真有 `.jsonl`。
 * **只查形状不够**：实测测试自己就能造出形状合法的 id（`auto-low-approval.test.tsx`
 * 用真 `SessionStore` 建会话），只查形状会把它们免罪 —— 那正好是本轮要堵的假阴性。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handoffPath } from '../src/cli/handoff';
import {
  isRealSessionIdShape,
  type SessionFileState,
  sessionFileState,
} from '../src/store/session';

/** 「当前进程 cwd 对应的项目」在**真实** home 下的交接单落点（globalSetup 里 env 还没被任何用例改过）。 */
function projectHandoffPath(): string {
  return handoffPath(process.cwd());
}

/** `absent` 表示文件当前不存在——「从无到有」同样是变化，所以用字符串而不是 null。 */
function shaOf(file: string): string {
  return existsSync(file)
    ? createHash('sha256').update(readFileSync(file)).digest('hex')
    : 'absent';
}

/**
 * 真实会话 id 的形状：`YYYYMMDD-HHMMSS-mmm`——由 `newSessionId()`（`src/store/session.ts:239`）
 * 用 `padStart(2)` / `padStart(3)` 拼出来，故**位数是定长**的（年月日 8 + 时分秒 6 + 毫秒 3）。
 * 交接单头部的 `> 会话:` 若匹配它，说明那次写来自一个**真实 CLI 会话**（开发者自己开着 chat）。
 *
 * 写成定长而不是 `\d{3,}`：放宽容错就等于放宽「什么样算真实会话」——
 * 而这条判据的用途是**免罪**（不判红），宽一寸就是把测试写的假 id 也放过去。
 */
// v5.3 B4：正则搬进 `src/store/session.ts`（`isRealSessionIdShape`），与 `newSessionId()`
// 同文件维护——复制一份到测试里，迟早与生成逻辑不同步（本仓库对「同一事实多处解析」有硬规定）。

/** 从交接单正文里取 `> 会话:` 的值（取不到给 `undefined`）。 */
export function sessionIdOf(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^>\s*会话:\s*(.*)$/.exec(line);
    if (m !== null) {
      // `m[1]` 在 tsc 眼里是 `string | undefined`（`noUncheckedIndexedAccess` 的保守推断），
      // 但捕获组必然存在 ⇒ 用 `?? ''` 表达「取不到就当空」，而不是 `!`
      const value = (m[1] ?? '').trim();
      return value === '' || value === '无' ? undefined : value;
    }
  }
  return undefined;
}

/**
 * 归因：真实 home 那份交接单被改了，**是谁改的**？
 *
 * - `unchanged`：sha 相同，什么也没发生（绝大多数轮次走这里）；
 * - `external-session`：新内容的 `> 会话:` 是真实会话 id ⇒ 开发者自己的 chat 写的，**不许判红**
 *   （那是交接单的正常用法：App 每轮收尾都会刷新快照）；
 * - `test-written`：`> 会话:` 缺失 / 是 `无` / 是假 id ⇒ 只可能是测试写的，**判红**。
 *
 * ## 为什么这条判据要双向验（AGENTS 判定类护栏）
 *
 * 只测「测试写的会红」时，一个「恒返回 `test-written`」的废实现在所有正例上都过——
 * 而那正好把「边开 chat 边跑 verify」的人全判红。故用例里两个方向都要有，
 * 且各配一条「不该红的真不红」样本。
 */
export function classifyChange(
  beforeSha: string,
  afterSha: string,
  afterText: string | undefined,
): 'unchanged' | 'external-session' | 'test-written' {
  if (beforeSha === afterSha) {
    return 'unchanged';
  }
  if (afterText === undefined) {
    return 'test-written';
  }
  const sessionId = sessionIdOf(afterText);
  return sessionId !== undefined && isRealSessionIdShape(sessionId)
    ? 'external-session'
    : 'test-written';
}

/**
 * 归因「这一轮**新建**的交接单目录」是谁造的（v5.3 B4，2026-11-15）。
 *
 * ## 为什么「会话 id 形状对」不够（实测打脸过）
 *
 * 旧规则是「`> 会话:` 匹配真实 id 形状 ⇒ 外部会话 ⇒ 不判红」。
 * 2026-11-15 实测发现 **测试自己就能造出形状合法的 id**：
 * `tests/ui/auto-low-approval.test.tsx` 用真实 `SessionStore` 建会话，写出的交接单
 * `> 会话: 20261115-120449-301` 形状完全合法，而真实 `~/.concertoai/sessions/` 下
 * **没有对应 `.jsonl`**。若只按形状归因，这 5 个目录会被**免罪**（假阴性）。
 *
 * ⇒ 判据必须**交叉核验**：形状对 **且** 该 id 在真实会话目录里真的存在文件，
 * 才算「开发者自己开着 chat 写的」。
 */
export function classifyNewDir(
  sample: { name: string; sessionId?: string },
  sessionState: (id: string) => SessionFileState,
): 'external-session' | 'test-written' {
  if (sample.sessionId !== undefined && isRealSessionIdShape(sample.sessionId)) {
    /**
     * ## 为什么只认 `exists`（v5.4 候选 1）
     *
     * 这里问的是同一个事实源（`sessionFileState`），但**取向与 prune 相反**：
     * - 护栏的代价是「多一条假红」⇒ 读不到就判红（宁可误报，让人来看一眼）；
     * - prune 的代价是「删掉唯一证据」⇒ 读不到必须保留。
     *
     * 这正是「统一事实来源、取向各自保守」。原来这里用 `catch { return false }`
     * 把读不到吞成「不存在」，结论恰好也对，但**靠的是意外而不是判断**——
     * 三态化之后 `unknown` 走的是显式分支，将来谁改 prune 也不会顺手把这里改坏。
     */
    if (sessionState(sample.sessionId) === 'exists') {
      return 'external-session';
    }
  }
  return 'test-written';
}

/**
 * 把「新增目录名单」判成「可放行 / 必须判红」（**纯函数**，两个依赖都注入 ⇒ 可阶梯自证）。
 *
 * ## 为什么要单独抽出来（而不是留在 teardown 里）
 *
 * `teardown` 是套件级钩子，直接调它的测试成本高且互相污染；而这段逻辑恰恰是 B4 的
 * **主判据**——「新增目录不许来自测试」。留在钩子里时它只有一条端到端探针（M1）覆盖，
 * 而端到端探针报红时看不出**是哪条规则失效**。抽成纯函数后每个分支都能单独断言。
 *
 * @param added 本轮新增的目录名
 * @param sessionIdOfDir 目录名 ⇒ `> 会话:` 值（读不到给 undefined）
 * @param sessionExists 会话 id ⇒ 真实会话目录里有没有 `.jsonl`
 */
export function classifyAddedDirs(
  added: readonly string[],
  sessionIdOfDir: (name: string) => string | undefined,
  sessionState: (id: string) => SessionFileState,
): { offenders: string[]; allowed: string[] } {
  const offenders: string[] = [];
  const allowed: string[] = [];
  for (const name of added) {
    const verdict = classifyNewDir({ name, sessionId: sessionIdOfDir(name) }, sessionState);
    if (verdict === 'test-written') {
      offenders.push(name);
    } else {
      allowed.push(name);
    }
  }
  return { offenders, allowed };
}

/**
 * 真实会话目录里这个 id 的状态（v5.4 候选 1：改为**共用事实源**）。
 *
 * 原来这里有一份自己的 `realSessionFileExists`（`existsSync` + `catch { return false }`），
 * 与 `handoff prune` 各判各的——同一个事实两处解析，迟早不同步。
 * 现在统一问 `sessionFileState()`；本文件只负责**按护栏的保守方向**解读：
 * 不是 `exists` 就判红（含 `unknown`：读不到时宁可误报，让人来看一眼）。
 */
function realSessionState(id: string): SessionFileState {
  return sessionFileState(id, path.join(os.homedir(), '.concertoai', 'sessions'));
}

/** 读某个交接单目录的会话 id（目录不存在 / 没有 handoff.md ⇒ `undefined`）。 */
function sessionIdOfDir(name: string): string | undefined {
  const file = path.join(path.dirname(path.dirname(target)), name, 'handoff.md');
  try {
    return sessionIdOf(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

let target = '';
let before = '';
let dirsBefore = -1;
/** 起始时的目录**名单**（B4：光有数量判不出「新增的是哪一个」，也就无法归因）。 */
let namesBefore: string[] = [];

/**
 * 交接单根目录下的子目录数（`~/.concertoai/handoffs/` 下一项目一目录）。
 *
 * ## 读数沿革（别把这段当历史噪音，它写着判据为什么变过）
 *
 * v5.3 A 时这里**只打印、不判红**：当时还没有测试侧隔离，把它纳入判红会让一大批
 * 既有 UI 用例立刻红（它们各自 `mkdtemp` 当 cwd，合法地写进真实 home 根目录）。
 * v5.3 B4（2026-11-15）落地「套件级默认隔离」后，前提变了：**真实 home 不该再有新增**。
 * 于是本文件 teardown 里改为「新增目录必须能归因，否则判红」——判据升级的依据是
 * 隔离到位，而不是「我想更严」。
 */
function handoffSubdirCount(): number {
  try {
    // 两级：<handoffs>/<项目 key>/handoff.md ⇒ 数的是 `<handoffs>/` 下的项目目录数
    // （第一次写成了 `path.dirname(target)`，数出来恒为 1——那是项目目录里的文件数，读数当场打脸）
    return readdirSync(path.dirname(path.dirname(target))).length;
  } catch {
    return -1;
  }
}

/** 同上，但返回**名单**（B4 归因需要知道「新增的是哪一个」）。 */
function handoffSubdirNames(): string[] {
  try {
    return readdirSync(path.dirname(path.dirname(target))).sort();
  } catch {
    return [];
  }
}

export function setup(): void {
  // ── 探测器自证：创建 + 改内容，两次都必须被看见 ───────────────
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-guard-selftest-'));
  const probe = path.join(dir, 'handoff.md');
  try {
    const created = shaOf(probe); // absent
    writeFileSync(probe, 'first', 'utf8');
    const afterCreate = shaOf(probe);
    writeFileSync(probe, 'second', 'utf8');
    const afterEdit = shaOf(probe);
    if (created === afterCreate || afterCreate === afterEdit) {
      throw new Error(
        '交接单 home 守卫的探测器**没有牙**（创建/改内容都没被检测出来）⇒ 本轮的「没变」不可信，直接失败',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  target = projectHandoffPath();
  before = shaOf(target);
  dirsBefore = handoffSubdirCount();
  namesBefore = handoffSubdirNames();
  // 读数落一行：没有这行，事后无法判断「当时到底在守哪个文件」
  console.log(
    `[handoff-home-guard] 守卫 ${target} ｜ 起始 ${before.slice(0, 16)} ｜ 同级目录 ${dirsBefore} 个 ｜ 探测器自证通过`,
  );
}

export function teardown(): void {
  if (target === '') {
    return;
  }
  /**
   * ═══ B4 判据（2026-11-15 起生效）：新增目录**必须能归因** ═══
   *
   * A 轮这里只是 `console.log`（「噪音类污染，只打印不判红」）。B4 落地后规则改了：
   * 测试侧已有「套件级默认隔离」（`tests/setup.ts`），所以**本轮真实 home 一个新目录都不该有**；
   * 若还有新增，只可能是「某个用例绕过了隔离」——那是必须红的事（它会把 1162 这个数字继续推高）。
   *
   * 归因沿用「不驱逐正常用法」原则：开发者一边开着 chat 一边跑 verify 是**正常用法**，
   * 那种新增带真实会话 id 且该 id 在真实会话目录里有文件 ⇒ 只打印读数、不判红。
   * 判据一旦放宽（只看 id 形状）就会被测试自己造的合法 id 蒙混过关，故必须交叉核验。
   */
  const namesAfter = handoffSubdirNames();
  const added = namesAfter.filter((n) => !namesBefore.includes(n));
  // ⚠️ 判据本体在 `classifyAddedDirs`（纯函数、可单测）；这里只做「取名单 + 传依赖 + 打印 + 判红」。
  // 接线由 `handoff-home-guard.test.ts` 的源码护栏钉住（否则纯函数全绿而调用点没用它 = A 轮 M-C 形态）。
  const { offenders, allowed } = classifyAddedDirs(added, sessionIdOfDir, realSessionState);
  if (added.length > 0) {
    console.log(
      `[handoff-home-guard] 注意：本轮在 ~/.concertoai/handoffs 下新增 ${added.length} 个目录（${dirsBefore} → ${handoffSubdirCount()}）`,
    );
    for (const name of allowed) {
      console.log(`  （外部会话，不判红）${name} ｜ 会话: ${sessionIdOfDir(name) ?? '(无)'}`);
    }
    for (const name of offenders) {
      console.log(`  （测试写的，判红）${name} ｜ 会话: ${sessionIdOfDir(name) ?? '(无)'}`);
    }
  }
  const after = shaOf(target);
  const afterText = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const verdict = classifyChange(before, after, afterText);

  /**
   * ## 两个判据合并报错，而不是谁先谁后 `throw`
   *
   * B4 加进「目录新增」判据后，一次污染往往**同时**触发两条（真 App 用例既新建了目录、
   * 又把内容写成了 `> 会话: 无`）。若按代码顺序先 `throw` 目录那条，内容那条的读数就永远不出现——
   * 而修的人需要的是「两条都给我看」。故先收集，再一次性抛出。
   */
  const problems: string[] = [];

  if (offenders.length > 0) {
    problems.push(
      [
        '测试套件往开发者真实 home 的 handoffs 目录里**新建了目录**（v5.3 B4）。',
        `  新增 ${offenders.length} 个：${offenders.slice(0, 10).join(', ')}${offenders.length > 10 ? ' …' : ''}`,
        `  根目录: ${path.dirname(path.dirname(target))}`,
        '  为什么这必须红：测试侧已有「套件级默认隔离」（tests/setup.ts 把 HOME/USERPROFILE',
        '  指到临时目录），所以真实 home **一个新目录都不该有**。有新增说明某个用例绕过了它',
        '  （例如用例自己在 beforeAll 里把 HOME 改回来了、或直接 `os.homedir()` 拼路径）。',
        '  正常用法（开发者一边开着 chat 一边跑 verify）不会红：那种新增带真实会话 id，',
        '  且该 id 在 ~/.concertoai/sessions 下真有 .jsonl —— 归因会放行。',
      ].join('\n'),
    );
  }

  if (verdict === 'external-session') {
    /**
     * 归因结论：那次写来自**真实 CLI 会话**（开发者自己开着 chat）。
     * 交接单每轮收尾都会刷新，这是正常用法 ⇒ **不许判红**（AGENTS：「按规范做事反而假红，
     * 比不做事更糟」）。但也不能静默：留下一行读数，否则下次真出问题时会误以为「守卫跑过且干净」。
     */
    console.log(
      `[handoff-home-guard] 本轮交接单被外部会话刷新（> 会话: ${sessionIdOf(afterText ?? '') ?? '(未知)'}）⇒ 不判红。若想拿到「测试有没有写真实 home」的干净读数，请关掉 chat 后重跑。`,
    );
    // 内容判据放行，但目录判据可能仍未通过 ⇒ 不能在这里 return
  } else if (verdict === 'test-written') {
    problems.push(
      [
        '测试套件改动了开发者真实 home 的交接单（v5.3 A 的命门：交接单的可信度）。',
        `  文件: ${target}`,
        `  之前: ${before}`,
        `  之后: ${after}`,
        '  最常见成因：某个用例渲染了真 `App` 却把 `cwd` 指向仓库根、且没有钉住家目录',
        '  （`handoffsDir()` = `os.homedir()/.concertoai/handoffs`，调用期读 homedir）。',
        '  修法见 tests/ui/tool-step.test.tsx 头注释：`cwd` 与 USERPROFILE/HOME 都要钉到临时目录。',
      ].join('\n'),
    );
  }

  if (problems.length === 0) {
    return;
  }
  /**
   * ## 为什么光 throw 不够（2026-11-14 实测）
   *
   * globalSetup 的 teardown 抛错，vitest 只打一行 `error during close …`，
   * **退出码仍是 0**（实测：`npx vitest run tests/ui/tool-step.test.tsx` 输出 8/8 passed + 我们的
   * 报错行，`echo %ERRORLEVEL%` 仍是 0）。也就是说「喊了但没拦住」——而 CI/`npm run verify`
   * 只看退出码 ⇒ 等于没有护栏。
   * 所以先显式把退出码钉成 1，再 throw（throw 保留报错文本，exitCode 负责让它真的红）。
   */
  process.exitCode = 1;
  throw new Error(problems.join('\n\n'));
}
