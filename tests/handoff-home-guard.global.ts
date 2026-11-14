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
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handoffPath } from '../src/cli/handoff';

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
const REAL_SESSION_ID = /^\d{8}-\d{6}-\d{3}$/;

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
  return sessionId !== undefined && REAL_SESSION_ID.test(sessionId)
    ? 'external-session'
    : 'test-written';
}

let target = '';
let before = '';
let dirsBefore = -1;

/**
 * 交接单根目录下的子目录数（`~/.concertoai/handoffs/` 下一项目一目录）。
 *
 * ## 这个读数为什么只打印、不判红（边界要说清，别假装覆盖了）
 *
 * 本守卫守的是「**本项目那份文件的内容**不许被测试改掉」——那是 v5.3 N4 的命门
 * （记录一旦是假的，下次进来读到的就是假交接）。而「根目录下多了几个一次性目录」是**另一类**
 * 污染：噪音、不擦证据。实测本机已有 517 个，绝大多数是用例拿 `mkdtempSync` 当 cwd 时
 * 按项目名分出来的目录。把它纳入判红会让一大批既有 UI 用例立刻红，而那需要「给
 * `paths` 加测试专用 home 覆盖」这类改动，超出 A 的范围 ⇒ **登记为候选，不在此处顺手改**。
 * 但读数必须留下：否则「目录从 517 涨到 900」这件事永远没人看见。
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
  // 读数落一行：没有这行，事后无法判断「当时到底在守哪个文件」
  console.log(
    `[handoff-home-guard] 守卫 ${target} ｜ 起始 ${before.slice(0, 16)} ｜ 同级目录 ${dirsBefore} 个 ｜ 探测器自证通过`,
  );
}

export function teardown(): void {
  if (target === '') {
    return;
  }
  const dirsAfter = handoffSubdirCount();
  if (dirsBefore >= 0 && dirsAfter > dirsBefore) {
    // 噪音类污染：不判红（见 `handoffSubdirCount` 的边界说明），但必须把增量摆出来
    console.log(
      `[handoff-home-guard] 注意：本轮在 ~/.concertoai/handoffs 下新增 ${dirsAfter - dirsBefore} 个目录（${dirsBefore} → ${dirsAfter}），属噪音类污染（不擦证据）`,
    );
  }
  const after = shaOf(target);
  const afterText = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const verdict = classifyChange(before, after, afterText);
  if (verdict === 'unchanged') {
    return;
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
  throw new Error(
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
