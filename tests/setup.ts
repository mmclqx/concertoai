/**
 * 全局测试环境设置（v5.0 T10）。
 *
 * ## 为什么需要这个文件
 *
 * 拒绝复盘记录默认写入 `~/.concertoai/reflections.jsonl`（**开发者的真实 home**）。
 * T9 的审批集成测试会走「按 n 拒绝」的真实路径，于是 `npm test` 把测试产生的记录
 * 直接写进了本机真实复盘文件——实测一次全量跑完多了 16 条 `a.ts` / `b.txt` 垃圾记录
 * （见 09-踩坑记录/2026-10-28-测试污染真实复盘记录.md）。
 *
 * 修法是**默认关闭**：测试进程一律不许写复盘，需要验证写入路径的用例显式传
 * `reflectionsEnabled={true}` 或注入 `appendReflectionForTest`（两者都让意图明确）。
 *
 * ## 为什么用环境变量而不是 mock 文件系统
 *
 * 环境变量是产品**本来就支持**的双轨开关之一（`CONCERTOAI_REFLECTIONS=off`），
 * 让测试走这条真实开关链路，比 mock `node:fs` 更贴近用户实际行为，也不会因为
 * 模块 mock 顺序问题偶发失效。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handoffPath } from '../src/cli/handoff';

process.env.CONCERTOAI_REFLECTIONS = 'off';

/**
 * v5.0 T12：场景提示同理默认关闭。
 *
 * 提示的冷却记录写在 `~/.concertoai/hint-state.json`（**开发者的真实 home**）。
 * T13 的 UI 集成测试会走「真的触发一次提示」的路径，若不关掉，`npm test` 会把
 * 测试产生的冷却时间戳写进本机真实状态文件——后果是**开发者自己用 CLI 时提示被
 * 莫名静音 10 分钟**（比复盘那次更难排查，因为它表现为「功能不生效」）。
 *
 * 需要验证「默认开启」语义的用例显式 `vi.stubEnv('CONCERTOAI_HINTS', '')`
 * 或直接注入 `hintsEnabled: true`（测试意图必须写在用例里，不能靠环境巧合）。
 */
process.env.CONCERTOAI_HINTS = 'off';

/**
 * v5.0 T21：本地指标同理默认关闭（虽然产品默认就是 off，这里显式写一遍更保险）。
 *
 * 需要验证「开启后真的记录」的用例必须显式传 `enabled: true` / `metricsEnabled={true}`
 * 或注入 `appendMetricForTest`（把写入重定向到 tmp），**绝不允许**让测试写进
 * `~/.concertoai/metrics.jsonl`——那会让开发者自己的 doctor 汇总里混进测试数据。
 */
process.env.CONCERTOAI_METRICS = 'off';

/**
 * ═══ v5.3 B4：套件级**默认隔离**（第四层，2026-11-15）═══
 *
 * ## 为什么还需要这一层（前三层为什么不够）
 *
 * | 层 | 管什么 | 为什么管不住 B4 |
 * |---|---|---|
 * | ① 用例侧双钉 `cwd` + `HOME`（v5.3 A） | 「谁把家目录钉错了」 | B4 里**没人钉错**：每个用例都钉到了自己的临时 cwd，写的是**全局根** |
 * | ② 套件级 sha 守卫（v5.3 A） | 「本项目那份文件的内容」 | 目录增长不是「内容被改」，sha 判据天生看不见 |
 * | ③ 静态护栏（v5.3 A） | 「挂载真 App 却用 `cwd: process.cwd()`」 | 对「合法的临时 cwd」无能为力 |
 *
 * 实测形态：`tests/ui/*.test.tsx` 各自 `mkdtemp` 一个 cwd 再渲染真 `App`，
 * `handoffPath(cwd)` = `os.homedir()/.concertoai/handoffs/<cwd 末段>-<hash>` ——
 * **每个用例都写对了自己那一份**，于是全局根目录每跑一次全量 +43 个（本机累计 1162 个）。
 * 只有把「根」换掉才根治，这层就是干这个。
 *
 * ## 为什么用环境变量，而**不是**「函数签名级开关」（我原先的推断，已被实测推翻）
 *
 * 2026-11-15 实测：把 `HOME`/`USERPROFILE` 指到临时目录跑全量 ⇒ **2781 全绿、真实 home +0、
 * 0 处既有断言要改**（`paths.test.ts` / `config.test.ts` / `session.test.ts` 等都是
 * 「两侧都用 `os.homedir()`」，一起变临时 ⇒ 仍然相等；`slash-skill.test.ts` 的
 * `vi.spyOn(os,'homedir')` 也照旧有效）。
 * 反观签名级 override：会打断上述 4 个文件的**绝对值断言**、`spyOn` 那套要重做、
 * 且覆盖不到「以后有人直接调 `os.homedir()`」的新写盘点。
 * ⇒ 环境变量覆盖面更全、既有测试零改动、子进程还自动继承。
 *
 * ## 探针通电（不然这就是「setup 里设了两个变量」而已）
 *
 * 三条自证，任一不成立直接 throw（宁可不跑，也不给假绿）：
 * 1. `os.homedir()` 现在就是临时目录 —— 注入**真的被读到**；
 * 2. `handoffPath(cwd)` 落在临时目录内 —— 走**真实代码路径**（不是拿常量自证）；
 * 3. `DEFAULT_CONFIG_PATH`（**模块加载期常量**）落在临时目录内 —— 证明
 *    「setup 的 env 设置发生在 `config.ts` 被 import **之前**」。
 *    第 3 条是唯一能证明**顺序**的判据：只查 1、2 的话，把 env 设晚一点也照样绿
 *    （配变异探针 M5：把 config 的 import 提前到 env 设置之前 ⇒ 只有第 3 条红）。
 *
 * ## 代价（明说，不假装没有）
 *
 * 这是「进程级全局扰动」，属 AGENTS「注入 / 全局扰动类验证必须先自证探针通电」范围：
 * 靠上面三条 canary 自证，且 `globalSetup`（`tests/handoff-home-guard.global.ts`）
 * **跑在独立上下文**，读的仍是开发者的真实 home —— 两边互不干扰，正好一边隔离、一边守门。
 */
const ISOLATED_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccai-test-home-'));

/**
 * 旧值快照：`HOME` / `USERPROFILE` **两侧都设**（POSIX 读 `HOME`，Windows 读 `USERPROFILE`；
 * 只钉当前平台那一侧，等于换平台就静默失效 —— v5.3 A 的 M2 探针教训）。
 */
const HOME_KEYS = ['HOME', 'USERPROFILE'] as const;
const PREV_HOME = new Map<string, string | undefined>();
for (const key of HOME_KEYS) {
  PREV_HOME.set(key, process.env[key]);
  process.env[key] = ISOLATED_HOME;
}
process.on('exit', () => {
  try {
    rmSync(ISOLATED_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 清不掉留给系统临时目录清理，不阻塞测试退出 */
  }
});

function canaryFail(reason: string): never {
  throw new Error(
    [
      '测试隔离 canary 失败（v5.3 B4）：这一轮「没写真实 home」不可信，直接失败。',
      `  原因：${reason}`,
      `  隔离目录：${ISOLATED_HOME}`,
      '  这说明 tests/setup.ts 的默认隔离没生效——别把它当噪音，它是唯一阻止',
      '  `npm test` 往开发者 ~/.concertoai/handoffs 里塞目录的机制。',
    ].join('\n'),
  );
}

if (os.homedir() !== ISOLATED_HOME) {
  canaryFail(`os.homedir() = ${os.homedir()}，不是隔离目录（env 没被读到）`);
}

const probeHandoff = handoffPath(process.cwd());
if (!probeHandoff.startsWith(ISOLATED_HOME)) {
  canaryFail(`handoffPath() 落在隔离目录外：${probeHandoff}`);
}

// 第 3 条：**动态 import** 是刻意的 —— 静态 import 会在本文件顶部执行，
// 那时 env 还没设，`DEFAULT_CONFIG_PATH` 会定格到真实 home（= M5 的形态）。
const { DEFAULT_CONFIG_PATH } = await import('../src/store/config');
if (!DEFAULT_CONFIG_PATH.startsWith(ISOLATED_HOME)) {
  canaryFail(
    `DEFAULT_CONFIG_PATH 定格在 ${DEFAULT_CONFIG_PATH}（模块加载期常量没吃到隔离 env）` +
      '—— 说明 setup 的 env 设置晚于 config.ts 的 import（顺序被改坏了）',
  );
}
