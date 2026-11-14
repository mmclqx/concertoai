/**
 * `.githooks/prepare-commit-msg` 的验收测试（ADR-051 裁决 4 / docs/13）。
 *
 * ## 为什么这个文件必须先存在
 *
 * 加提醒段之前，这个 hook **一条测试都没有**（`tests/` 搜 `prepare-commit-msg` 为 0 命中）。
 * 而它每次提交都在跑、还会**改写提交信息**——改坏了没人发现，只能事后翻 `git log` 才看得见
 * 「trailer 变成 unmarked 了」。所以本文件除了验提醒，还**必须回归 trailer 的三条既有行为**
 * （用例 11-13）：那是 hook 的原有职责，不能被新功能挤坏。
 *
 * ## 测试策略：不 mock 任何东西
 *
 * hook 的全部行为都发生在「一次真实的 `git commit`」里（sh 解释器、git 的钩子时机、
 * stderr 的流向、提交信息的改写）。mock 掉任何一个，测的就不是它了。
 * 所以在 `os.tmpdir()` 里 `git init` 造真仓库，把**真实的 hook 文件**拷进去，真的提交。
 *
 * ## 这组用例守的是一个「可能悄悄为真」的清单
 *
 * | 废实现 | 会被哪条用例抓住 |
 * |---|---|
 * | 提醒写到 stdout（污染管道 / 脚本解析） | #1「只出现在 stderr」 |
 * | `done`/无文件/损坏 也提醒 | #2/#3/#4 负例 |
 * | `blocked` 打印整段 JSON（刷屏） | #5「不含 `{`、≤1 行」 |
 * | 语言不跟随 LUMEN_LOCALE | #8/#9 + #10 等价性表 |
 * | 语言规则漏 `trim()` | #10（`'  en'` 那条，第一版草案真踩了） |
 * | hook 结束非 0（阻断提交） | #1-#14 全部断言 `exit 0` |
 * | 有人把 hook 改成 `commit-msg`（`--no-verify` 就绕过了） | #7 双 marker 对照 |
 * | 新段把 awk 幂等段挤坏 | #13 `--amend` 不叠加 |
 * | 往 hook 里塞 `dedup`（提交从 168ms 变十几秒） | #14 性能预算 |
 *
 * > **编号说明**：上表 `#1–#14` 是 `docs/13` §9.5 的**规划编号**；本文件落地后实际 **18 条**
 * > （规划 14 条 + 补的 4 条负例：`status=done` / 坏 JSON / PATH 无 node / `blocked` 未记原因）。
 * >
 * > **变异探针实测（2026-11-10，P1–P6 + P1b，逐条「改坏 ⇒ 红 ⇒ 复原 ⇒ sha256 一致」）**：
 * > P1 无牙（删 `[ -f "$state_file" ]` 仍 18/18 绿 —— 静默本就由 node 的 try/catch 保证，
 * > 那行只是省一次 node 启动，详见用例 4 注释）；P1b/P2/P4/P5/P6 各红 1 条且红在指定用例。
 * > **P3（`exit 0`→`exit 1`）首次实测只红 13/18**：4 条「期望看到提醒」的用例当时只断言 stderr，
 * > 没断言提交成功，另加性能用例没检查退出码 ⇒ 已全部补上 `expect(...status).toBe(0)`，
 * > 补后重跑 **18/18 红**。这条记录留着，是因为「红了一部分」比「全绿」更容易被当成通过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const HOOK_PATH = path.join(REPO_ROOT, '.githooks', 'prepare-commit-msg');
const REAL_HOOK = fs.readFileSync(HOOK_PATH, 'utf8');

/** 被测 hook 的临时副本路径（每个用例一个仓，互不干扰）。 */
let tmpDirs: string[] = [];

/** 提醒相关的断言锚点（中文 / 英文各一份，避免用「未完成」这种会误伤本文件文案的词）。 */
const ZH_ANCHORS = {
  inProgress: '指令未收尾',
  blocked: 'concertoai: blocked：',
  waiting: '等你确认',
  cmds: ['show', 'dedup', 'update --set-status done'],
};
const EN_ANCHORS = {
  inProgress: 'instruction not finished',
  blocked: 'concertoai: blocked: ',
  waiting: 'waiting for you',
  cmds: ['show', 'dedup', 'update --set-status done'],
};

/**
 * **基线 env：显式钉死 locale，不依赖开发机 shell**（AGENTS「进程级全局状态隔离」硬要求）。
 *
 * hook 的提醒语言由 `LUMEN_LOCALE > LANG` 决定，而本文件的用例要断言「中文提醒」就必须
 * 保证父进程没把 `LUMEN_LOCALE=en` 漏进来。2026-11-10 实测过这个坑：
 * `LUMEN_LOCALE=en npm run test` 时，5 条「期望中文」的用例全红——它们当时 inherits
 * `process.env`，于是在英文环境里拿到了英文输出。「我的环境没踩到」≠「没人会踩到」，
 * 所以这里把它写成**默认值**：用例要英文就显式传 `{ LUMEN_LOCALE: 'en' }` 覆盖。
 */
/**
 * **会漂的变量：显式排除**（2026-11-14，候选 4 —— 与上面「钉死 locale」同一个思路，只是把范围补全）。
 *
 * ## 为什么是「抄 + 排除」，而不是「不抄 `process.env`，逐项写」
 *
 * 先取证再定法（候选 4 ⑤）。三条证据都指向「`BASE_ENV` 的本意是**继承必要 + 钉死会漂的**」：
 *
 * 1. **来历**：本常量是 `6e35b0e`（2026-11-10）引入的，提交说明写的是「测试继承开发机
 *    `LUMEN_LOCALE=en` 导致 en 环境 5 红，改为 `BASE_ENV` 钉死 locale」——它是**为钉死而加**的，
 *    不是图省事把父环境倒进来。
 * 2. **用法上它是「底座」**：`commit()` / `commitEmpty()` 里是 `{ ...BASE_ENV, ...env }`，
 *    而 `env` 参数在全部调用点上都是**增量**（`{ CONCERTOAI_AGENT: 'x' }`、`{ PATH: stripped }`）。
 *    底座若不含 `PATH`，每个调用点都得自己重建一份完整环境——这正是 (b) 套在 (a) 场合的形态。
 * 3. **必要性实测**：hook 里 `command -v node` 决定要不要打印提醒、`git rev-parse` 决定状态文件路径，
 *    两者都靠 `PATH`；用例 242「PATH 里没有 node」还专门 `{ ...BASE_ENV, PATH: stripped }` 覆盖它。
 *
 * ## 为什么不改成「白名单只列 PATH/HOME」（本轮实测的坑，必须记下来）
 *
 * Windows 上 `spawnSync(..., { env: {} })` **仍有 11 个变量**：libuv 会补一组必需变量
 * （`PATH` / `SYSTEMROOT` / `WINDIR` / `TEMP` / `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH` /
 * `SYSTEMDRIVE` / `USERNAME` / `USERDOMAIN` / `LOGONSERVER`）。也就是说
 * **「削成空 env 也绿」在 Windows 上是假绿**：本机永远看得见 `PATH`，而 POSIX 的 `spawn` 是按给的
 * 那份 env 原样传（本仓库 CI 是 ubuntu / windows / macos 三平台）⇒ (b) 的做法会在本地全绿、
 * 在 Linux/macOS 上让 hook 的 `command -v node` 失败、提醒段静默、断言「期望中文提醒」的用例整片红。
 * 判据一句话：**「我这台机器上削掉还能跑」不构成证据，能削的是 libuv 补的那一组，不是我抄的这组**。
 *
 * ## 名单为什么包含 `GIT_DIR` 一类（审计「其它泄漏变量」，不是只排一个）
 *
 * 实测：在临时仓库 B 里提交、但 env 带仓库 A 的 `GIT_DIR` ⇒ **提交落到 A**（B 仍是 1 个提交）。
 * 所以这类「定位类」变量泄漏会让用例**在别人仓库里写提交**，而且 exitCode 仍是 0。
 * 名单按「两类会漂」组织：**身份类**（`CONCERTOAI_AGENT`：照 AGENTS 第 30 条办事的人会把它设在
 * 父进程里）+ **定位类**（`GIT_*`：把子进程指到别的仓库/索引）。
 * locale 类（`LUMEN_LOCALE` / `LANG`）不用排——它们在下面被**显式钉空**，比排除更严。
 */
const LEAKY_ENV_KEYS = [
  // 身份类：AGENTS 第 30 条要求提交时声明；泄漏 ⇒ 本该 unmarked 的用例拿到父进程的 id
  'CONCERTOAI_AGENT',
  // 定位类：泄漏 ⇒ git 在别的仓库里操作（实测可见，见上）
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const;

/**
 * 从一个「父环境」造基线 env：**抄 + 钉死 locale + 排除会漂的**。
 *
 * 抽成函数（而不是写成模块级的字面量）是为了让用例能拿一个**构造出来的父环境**验证这件事：
 * 「父进程带 `CONCERTOAI_AGENT` 时基线 env 里不该有它」要能在任何开发机上跑，而不是
 * 「只有那台设了变量的机器上才红」——后者正是候选 4 最初的形态（本机全绿，设了变量才红）。
 */
function baseEnvFrom(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, LUMEN_LOCALE: '', LANG: '' };
  for (const key of LEAKY_ENV_KEYS) delete env[key];
  return env;
}

const BASE_ENV: NodeJS.ProcessEnv = baseEnvFrom(process.env);

type Repo = {
  dir: string;
  git: (args: string[], extra?: { env?: NodeJS.ProcessEnv }) => ReturnType<typeof spawnSync>;
  gitDir: () => string;
  writeState: (data: unknown) => void;
  commit: (
    message: string,
    extraArgs?: string[],
    env?: NodeJS.ProcessEnv,
  ) => ReturnType<typeof spawnSync>;
  commitEmpty: (message: string, env?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
};

/**
 * 造一个真仓库：真 hook（默认用仓库里的那份）+ 可选的 pre-commit 对照组。
 * `hookBody` 可替换，用于「删掉某段」的变异探针。
 */
function makeRepo(opts: { hookBody?: string; withPreCommit?: boolean } = {}): Repo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githooks-'));
  tmpDirs.push(dir);
  const git = (args: string[], extra: { env?: NodeJS.ProcessEnv } = {}) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', ...extra });

  git(['init', '-q']);
  git(['config', 'user.email', 'githooks-test@example.com']);
  git(['config', 'user.name', 'githooks-test']);
  git(['config', 'commit.gpgsign', 'false']);
  // 关掉 autocrlf，避免 hook 被检出成 CRLF（POSIX 上会坏；这里恒为 LF 更接近 .gitattributes 的意图）
  git(['config', 'core.autocrlf', 'false']);

  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.githooks', 'prepare-commit-msg'),
    opts.hookBody ?? REAL_HOOK,
    'utf8',
  );
  if (opts.withPreCommit) {
    fs.writeFileSync(
      path.join(dir, '.githooks', 'pre-commit'),
      '#!/bin/sh\necho "PRE_RAN" >> "$(git rev-parse --git-dir)/marker.txt"\nexit 0\n',
      'utf8',
    );
  }
  git(['config', 'core.hooksPath', '.githooks']);
  git(['commit', '-q', '--allow-empty', '-m', 'chore: baseline']);

  const gitDir = () => String(git(['rev-parse', '--git-dir']).stdout ?? '').trim();
  const writeState = (data: unknown) => {
    const p = path.join(dir, gitDir(), 'concertoai-current-instruction.json');
    fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };
  let seq = 0;
  const commit = (message: string, extraArgs: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    seq += 1;
    fs.writeFileSync(path.join(dir, `f${seq}.txt`), String(seq), 'utf8');
    git(['add', '-A']);
    return git(['commit', ...extraArgs, '-m', message], { env: { ...BASE_ENV, ...env } });
  };
  /** 空提交：hook 照样跑，但省掉写文件 + add（等价性表要连跑 20 次，省一半时间）。 */
  const commitEmpty = (message: string, env: NodeJS.ProcessEnv = {}) =>
    git(['commit', '--allow-empty', '-m', message], { env: { ...BASE_ENV, ...env } });

  return { dir, git, gitDir, writeState, commit, commitEmpty };
}

const stderrOf = (r: ReturnType<typeof spawnSync>) => String(r.stderr ?? '');
const stdoutOf = (r: ReturnType<typeof spawnSync>) => String(r.stdout ?? '');

/** 有 CJK 字符即判「含中文」（用码点区间，不依赖具体文案）。 */
const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s);

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

// ── 正例 / 负例：什么时候提醒、提醒什么 ────────────────────────

describe('进度提醒：in_progress 时提醒（只写 stderr）', () => {
  it('status=in_progress ⇒ 打出进度与三个命令，且提交成功（提醒不阻断）', () => {
    /**
     * 证据力说明（2026-11-10 实测，别高估这条）：
     * 下面「stdout 不含提醒」那条断言在 git 语境下**恒真** —— 实测表明 git 跑 hook 时
     * 会把 hook 的 stdout 合并进 stderr（连"无重定向"的变体 stdout 都是空的）。
     * 所以它不是对实现的约束，只是冒烟。**真正有约束力的是下一条用例**
     * 「提醒不得进入提交信息」——那才是「写错地方」会造成的实际危害。
     */
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 2,
      steps: [
        { id: 1, status: 'done' },
        { id: 2, status: 'in_progress' },
      ],
    });
    const c = r.commit('feat: probe');
    expect(c.status).toBe(0); // 提醒绝不阻断提交

    const err = stderrOf(c);
    expect(err).toContain(ZH_ANCHORS.inProgress);
    expect(err).toContain('1/2'); // done/total
    expect(err).toContain('currentStep=2');
    for (const cmd of ZH_ANCHORS.cmds) expect(err).toContain(cmd);

    // 提醒不该污染 stdout（脚本/管道只读 stdout）
    expect(stdoutOf(c)).not.toContain(ZH_ANCHORS.inProgress);
    // 提交真的落库
    expect(r.git(['log', '-1', '--format=%s']).stdout).toContain('feat: probe');
  });

  it('**提醒不得进入提交信息**（写进 msg_file 会污染历史，且永远改不掉）', () => {
    /**
     * 这才是「输出写错地方」的实际危害：hook 拿到的 `$1` 就是提交信息文件，
     * 一旦有人图省事把提醒 `>> "$msg_file"`，那行字就会永久留在版本库里。
     *
     * 配变异探针验证有牙：把 hook 里的 `err(...)` 改成往 `"$msg_file"` 追加 ⇒ 本用例红
     * （探针 P6）。
     */
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 1,
      steps: [{ id: 1, status: 'pending' }],
    });
    const c = r.commit('feat: probe', [], { CONCERTOAI_AGENT: 'clean-msg-probe' });
    expect(c.status).toBe(0);

    const body = String(r.git(['log', '-1', '--format=%B']).stdout ?? '');
    // 提醒的每一类文案都不许出现在提交信息里
    expect(body).not.toContain(ZH_ANCHORS.inProgress);
    expect(body).not.toContain('concertoai:');
    expect(body).not.toContain('currentStep=');
    // 正例对照：提交信息该有的东西仍在（否则上面三条可能是「提交信息为空」凑巧满足）
    expect(body).toContain('feat: probe');
    expect(body).toContain('Agent: clean-msg-probe');
  });

  it('status=done ⇒ **静默**（不制造噪音）', () => {
    const r = makeRepo();
    r.writeState({ schemaVersion: 1, status: 'done', steps: [{ id: 1, status: 'done' }] });
    const c = r.commit('feat: probe');
    expect(c.status).toBe(0);
    expect(stderrOf(c)).not.toContain(ZH_ANCHORS.inProgress);
  });

  it('状态文件不存在（首次运行 / 新克隆）⇒ **静默**，提交成功', () => {
    /**
     * 探针实测（2026-11-10，如实记）：把 `[ -f "$state_file" ]` 改成 `true`
     * （即无条件启动 node）⇒ 本用例**仍然绿**（探针 P1 无牙）。
     * 原因：静默由 node 里的 `try/catch` 保证（读不到文件抛错被吞），那行 `[ -f ]`
     * 只是**省一次 node 启动**的性能优化（实测省 ~50-70ms），不是行为护栏。
     * 所以这条用例守的是「无文件不报错」这个外部行为，别误以为它在钉那行判断。
     */
    const r = makeRepo();
    const c = r.commit('feat: probe');
    expect(c.status).toBe(0);
    expect(stderrOf(c)).not.toContain(ZH_ANCHORS.inProgress);
  });

  it('PATH 里没有 node ⇒ **静默**且提交成功（hook 不能成为新故障源）', () => {
    /**
     * 这条守的是 `if command -v node ...` 那道判断：删掉它 ⇒ `node -e` 会以
     * 「command not found」写进 stderr，静默被打破 ⇒ 本用例红（探针 P1b）。
     *
     * 注意：`[ -f "$state_file" ]` 那条判断**没有**用例能钉住（探针 P1 实测无牙）——
     * 它只是省一次 node 启动的性能优化，静默本身由 node 里的 try/catch 保证。
     */
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 1,
      steps: [{ id: 1, status: 'pending' }],
    });

    // 拼一个不含 node 目录的 PATH（git 靠自身 exec-path 找 sh.exe，不依赖 PATH）
    const nodeDir = path.dirname(process.execPath);
    const strippedPath = String(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((p) => p && path.resolve(p) !== path.resolve(nodeDir))
      .join(path.delimiter);

    fs.writeFileSync(path.join(r.dir, 'n1.txt'), 'n', 'utf8');
    r.git(['add', '-A']);
    const c = r.git(['commit', '-m', 'feat: no-node'], {
      env: { ...BASE_ENV, PATH: strippedPath, CONCERTOAI_AGENT: 'no-node-probe' },
    });

    expect(c.status).toBe(0); // 没 node 也必须能提交
    const err = stderrOf(c);
    expect(err).not.toContain(ZH_ANCHORS.inProgress);
    expect(err).not.toContain('not found'); // 不许把「找不到 node」漏到用户脸上
    // 提交与 trailer 都不受影响
    expect(String(r.git(['log', '-1', '--format=%B']).stdout ?? '')).toContain(
      'Agent: no-node-probe',
    );
  });

  it('状态文件是坏 JSON ⇒ **静默**（catch 吞掉），提交成功', () => {
    const r = makeRepo();
    fs.writeFileSync(
      path.join(r.dir, r.gitDir(), 'concertoai-current-instruction.json'),
      '{ 这不是 JSON',
      'utf8',
    );
    const c = r.commit('feat: probe');
    expect(c.status).toBe(0);
    expect(stderrOf(c)).not.toContain(ZH_ANCHORS.inProgress);
  });
});

// ── blocked：一句话，不打 JSON ────────────────────────────────

describe('进度提醒：blocked 只打一句话（用户裁决 Q3）', () => {
  it('blocked + 原因 ⇒ 一行「concertoai: blocked：<原因>，等你确认」，**不打 JSON**', () => {
    const r = makeRepo();
    const reason = '缺 API Key，等你给';
    r.writeState({
      schemaVersion: 1,
      status: 'blocked',
      blockedReason: reason,
      instruction: '这段指令原文不应该出现在提醒里',
      doneCriteria: [{ id: 'C1', check: 'echo hi' }],
      steps: [{ id: 1, status: 'pending' }],
    });
    const c = r.commit('fix: probe');
    expect(c.status).toBe(0);
    const err = stderrOf(c);

    expect(err).toContain(ZH_ANCHORS.blocked);
    expect(err).toContain(reason.slice(0, 60));
    expect(err).toContain(ZH_ANCHORS.waiting);

    // 「不打全 JSON」的三条硬断言
    expect(err).not.toContain('{');
    expect(err).not.toContain('这段指令原文不应该出现在提醒里');
    expect(err).not.toContain('doneCriteria');
    // blocked 只打 1 行（in_progress 才是 2 行）
    const remindLines = err.split('\n').filter((l) => l.startsWith('concertoai: blocked'));
    expect(remindLines.length).toBe(1);
  });

  it('blocked 但没记原因 ⇒ 仍打一行「（未记录原因）」，不崩', () => {
    const r = makeRepo();
    r.writeState({ schemaVersion: 1, status: 'blocked', steps: [] });
    const c = r.commit('fix: probe');
    expect(c.status).toBe(0);
    const err = stderrOf(c);
    expect(err).toContain(ZH_ANCHORS.blocked);
    expect(err).toContain('未记录原因');
    expect(err).toContain(ZH_ANCHORS.waiting);
  });

  it('blocked 原因超长 ⇒ 截断到 60 字，不刷屏', () => {
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'blocked',
      blockedReason: '很长的原因'.repeat(40),
      steps: [],
    });
    const c = r.commit('fix: probe');
    expect(c.status).toBe(0);
    const line = stderrOf(c)
      .split('\n')
      .find((l) => l.startsWith('concertoai: blocked'));
    expect(line).toBeTruthy();
    expect(String(line).length).toBeLessThan(60 + 60); // 前缀 + 60 字 + 后缀余量，仍远小于 200 字原文
  });
});

// ── --no-verify：绕不过（用户补充要求） ───────────────────────

describe('进度提醒：--no-verify 也绕不过（用户补充的验收项）', () => {
  it('**--no-verify 提交时提醒照样出现**（含 pre-commit 对照组）', () => {
    /**
     * 为什么必须有对照组：`--no-verify` **若压根没生效**，「prepare-commit-msg 仍跑了」
     * 这条断言也会绿 —— 那就成了空转。所以同时装一个 `pre-commit` 写 marker，
     * 先证明「`--no-verify` 真把 pre-commit 绕过了」，再断言 prepare-commit-msg 仍在。
     *
     * 实测基线（git 2.45.1.windows.1）：
     *   普通提交     → marker = PRE_RAN + PCM_RAN
     *   --no-verify → marker = PCM_RAN（PRE 消失）
     *
     * 配变异探针验证有牙：把 hook 从 `prepare-commit-msg` 改名成 `commit-msg` ⇒ 本用例红
     * （commit-msg 会被 --no-verify 绕过）。
     */
    const r = makeRepo({ withPreCommit: true });

    // 为了拿到 prepare-commit-msg 的 marker，往 hook 末尾（exit 0 之前）插一行埋点
    const hooked = REAL_HOOK.replace(
      'exit 0',
      'echo "PCM_RAN" >> "$(git rev-parse --git-dir)/marker.txt"\nexit 0',
    );
    expect(hooked).not.toBe(REAL_HOOK); // 替换必须真的命中
    fs.writeFileSync(path.join(r.dir, '.githooks', 'prepare-commit-msg'), hooked, 'utf8');

    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 1,
      steps: [{ id: 1, status: 'pending' }],
    });

    const markerFile = path.join(r.dir, r.gitDir(), 'marker.txt');
    const readMarkers = () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : '';

    // ① 普通提交：两个钩子都跑
    const normal = r.commit('feat: normal');
    expect(normal.status).toBe(0);
    const normalMarkers = readMarkers();
    expect(normalMarkers).toContain('PRE_RAN');
    expect(normalMarkers).toContain('PCM_RAN');
    expect(stderrOf(normal)).toContain(ZH_ANCHORS.inProgress);

    // 清空 marker，准备第二次
    fs.writeFileSync(markerFile, '', 'utf8');

    // ② --no-verify：pre-commit 被绕过，prepare-commit-msg 不走
    const skipped = r.commit('feat: no-verify', ['--no-verify'], {
      CONCERTOAI_AGENT: 'no-verify-probe',
    });
    expect(skipped.status).toBe(0);
    const skippedMarkers = readMarkers();

    // 对照（关键）：证明 --no-verify 真的生效了，否则下面两条断言没有证据力
    expect(skippedMarkers).not.toContain('PRE_RAN');
    // 断言主体：prepare-commit-msg 绕不过
    expect(skippedMarkers).toContain('PCM_RAN');
    // 用户真正关心的事实：提醒照样出现
    expect(stderrOf(skipped)).toContain(ZH_ANCHORS.inProgress);
    // 且 trailer 仍写入（提醒没破坏身份机制）
    expect(r.git(['log', '-1', '--format=%B']).stdout).toContain('Agent: no-verify-probe');
  });
});

// ── L3：语言跟随 LUMEN_LOCALE ────────────────────────────────

describe('进度提醒：语言跟随 LUMEN_LOCALE（用户裁决 Q1 = L3）', () => {
  it('LUMEN_LOCALE=en ⇒ 英文提醒，且**不含任何 CJK 字符**', () => {
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 1,
      steps: [{ id: 1, status: 'pending' }],
    });
    const c = r.commit('feat: probe', [], { LUMEN_LOCALE: 'en' });
    expect(c.status).toBe(0);
    const err = stderrOf(c);
    expect(err).toContain(EN_ANCHORS.inProgress);
    expect(err).toContain('step 0/1');
    expect(err).toContain('currentStep=1');
    for (const cmd of EN_ANCHORS.cmds) expect(err).toContain(cmd);
    expect(hasCjk(err)).toBe(false); // 全英文
  });

  it('LUMEN_LOCALE=en 时 blocked 也是英文', () => {
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'blocked',
      blockedReason: 'missing API key',
      steps: [],
    });
    const c = r.commit('feat: probe', [], { LUMEN_LOCALE: 'en' });
    expect(c.status).toBe(0);
    const err = stderrOf(c);
    expect(err).toContain(EN_ANCHORS.blocked);
    expect(err).toContain('missing API key');
    expect(err).toContain(EN_ANCHORS.waiting);
    expect(hasCjk(err)).toBe(false);
  });

  it('未设 LUMEN_LOCALE / 设为 zh ⇒ 中文提醒（反向自证：证明上面两条不是恒英文）', () => {
    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 1,
      steps: [{ id: 1, status: 'pending' }],
    });
    // 显式清掉，避免继承开发机环境
    const c = r.commit('feat: probe', [], { LUMEN_LOCALE: 'zh', LANG: 'zh_CN.UTF-8' });
    expect(c.status).toBe(0);
    expect(stderrOf(c)).toContain(ZH_ANCHORS.inProgress);
    expect(hasCjk(stderrOf(c))).toBe(true);
  });

  // 超时必须显式放宽：这条要连跑 20 次**真实 git commit**（每次都要起 sh + node），
  // 默认 5000ms 会超（实测 ~5.0-6.7s）。这是端到端用例的固有成本，不用 mock 换速度——
  // 换了就测不到「hook 里的语言判定」了，只会测到「测试里抄的那份规则」。
  it('**语言规则等价性表**：hook 复刻 vs src/i18n 的 resolveLocale，20 条输入结果必须一致', () => {
    /**
     * 为什么这条最重要：hook 里不能 `import src/i18n`（提交时 `dist/` 可能未构建），
     * 所以语言规则是**复刻**。复刻就会漂移（AGENTS 第 33 条：同一事实两处各解析一次）。
     * 本用例把「真实规则」抄成函数放在测试里，与 hook 的实际输出逐条比对。
     *
     * 配变异探针验证有牙：把 hook 里 `.trim()` 删掉 ⇒ `'  en'` 那条红
     * （第一版草案正是这样，被这张表抓出来的）。
     */
    // 真实规则：src/i18n/index.ts:30-36 逐字抄写
    const resolveLocale = (preferred: string | undefined): 'zh' | 'en' => {
      const value = preferred?.trim().toLowerCase();
      if (value === 'en' || value?.startsWith('en')) return 'en';
      return 'zh';
    };

    const cases: Array<string | undefined> = [
      undefined,
      '',
      '   ',
      'en',
      'EN',
      'en_US.UTF-8',
      'EN_us.UTF-8',
      ' en',
      'en ',
      '  en  ',
      'ent',
      'english',
      'zh',
      'ZH_CN.UTF-8',
      ' fr ',
      'fr',
      'e n',
      'zh en',
      'en zh',
      'zh_CN.UTF-8 ',
    ];
    expect(cases.length).toBe(20);

    const r = makeRepo();
    r.writeState({
      schemaVersion: 1,
      status: 'in_progress',
      currentStep: 1,
      steps: [{ id: 1, status: 'pending' }],
    });

    for (const input of cases) {
      const env: NodeJS.ProcessEnv = { LANG: '' };
      if (input === undefined) env.LUMEN_LOCALE = '';
      else env.LUMEN_LOCALE = input;
      // 每次提交都会打印提醒 → 用 stderr 判语言（空提交即可，hook 照样跑）
      const c = r.commitEmpty('chore: locale probe', env);
      expect(c.status).toBe(0); // 语言判定再怎么错也不许阻断提交
      const err = stderrOf(c);
      const hookSaidEn = err.includes(EN_ANCHORS.inProgress);
      const hookSaidZh = err.includes(ZH_ANCHORS.inProgress);
      const expected = resolveLocale(input === undefined ? undefined : input);
      const label = `输入 ${JSON.stringify(input)}`;
      if (expected === 'en') {
        expect(
          hookSaidEn,
          `${label} 期望英文，实际 stderr=${JSON.stringify(err.slice(0, 120))}`,
        ).toBe(true);
        expect(hookSaidZh, `${label} 不应出现中文提醒`).toBe(false);
      } else {
        expect(
          hookSaidZh,
          `${label} 期望中文，实际 stderr=${JSON.stringify(err.slice(0, 120))}`,
        ).toBe(true);
        expect(hookSaidEn, `${label} 不应出现英文提醒`).toBe(false);
      }
    }
  }, 60_000);
});

// ── trailer 回归：hook 的原有职责（不能被新段挤坏） ────────────

describe('trailer 回归（hook 原有职责，用户裁决 Q2 明确要求）', () => {
  it('已声明 CONCERTOAI_AGENT ⇒ 末行 `Agent: <id>`', () => {
    const r = makeRepo();
    expect(r.commit('feat: probe', [], { CONCERTOAI_AGENT: 'concertoai-loop' }).status).toBe(0);
    const body = String(r.git(['log', '-1', '--format=%B']).stdout ?? '');
    expect(body).toContain('Agent: concertoai-loop');
    // 只应有一行 Agent（防叠加）
    expect(body.split('\n').filter((l) => l.startsWith('Agent: ')).length).toBe(1);
  });

  it('未声明 ⇒ `Agent: unmarked` + 两行 ASCII 告警（stderr）', () => {
    /**
     * 这里**不再**写 `const env = { ...BASE_ENV }; delete env.CONCERTOAI_AGENT;`——
     * 那种写法在候选 4 之前是**无效的**：`commit()` 内部是 `{ ...BASE_ENV, ...env }`，
     * 从副本里删掉的键会被 `BASE_ENV` 原样注回来。现在「没有身份」由 `baseEnvFrom` 保证
     * （见 `LEAKY_ENV_KEYS`），「父进程设了变量也不影响本用例」由下面那条专门的用例钉住。
     */
    const r = makeRepo();
    const c = r.commit('feat: probe', [], {});
    expect(c.status).toBe(0);
    const body = String(r.git(['log', '-1', '--format=%B']).stdout ?? '');
    expect(body).toContain('Agent: unmarked');
    const err = stderrOf(c);
    expect(err).toContain('agent identity NOT declared');
    expect(err).toContain('CONCERTOAI_AGENT');
  });

  it('`--amend` 后 `Agent:` 行仍只有 1 行（幂等，防叠加）', () => {
    /**
     * 配变异探针验证有牙：删掉 awk 幂等段 ⇒ 本用例红（`--amend` 会叠出两行 Agent）。
     */
    const r = makeRepo();
    expect(r.commit('feat: probe', [], { CONCERTOAI_AGENT: 'agent-a' }).status).toBe(0);
    const amend = r.git(['commit', '--amend', '--no-edit'], {
      env: { ...BASE_ENV, CONCERTOAI_AGENT: 'agent-a' },
    });
    expect(amend.status).toBe(0);
    const body = String(r.git(['log', '-1', '--format=%B']).stdout ?? '');
    expect(body.split('\n').filter((l) => l.startsWith('Agent: ')).length).toBe(1);
  });
});

// ── 基线 env 的隔离性（候选 4：设了 CONCERTOAI_AGENT 的开发者不该看到假红） ──

describe('基线 env：继承必要 + 排除会漂的（候选 4）', () => {
  it('父进程 env 带 `CONCERTOAI_AGENT` ⇒ **本用例仍得到 `Agent: unmarked`**', () => {
    /**
     * 这条用例守的是 AGENTS「进程级全局状态隔离」条款 ④ 的判据句：
     * **按规范做事反而假红，比不做事更糟**——第 30 条要求每次提交都设 `CONCERTOAI_AGENT`，
     * 那么「设了它之后这条验证仍须通过」就是硬要求。
     *
     * 为什么必须用 `baseEnvFrom({...})` 构造父环境，而不是直接跑：本机开发者的 shell 里
     * 通常**没有**这个变量，直接跑永远绿——那正是这个缺陷活了 4 天没被发现的原因
     * （`set CONCERTOAI_AGENT=… && npm run verify` 才红 1 条）。
     *
     * 配变异探针验证有牙（2026-11-14 实测）：把 `baseEnvFrom` 里的
     * `for (const key of LEAKY_ENV_KEYS) delete env[key];` 删掉（回到 `{ ...process.env, … }`）
     * ⇒ 本用例红（拿到 `Agent: leaked-from-parent`）；还原 ⇒ 绿。
     */
    const r = makeRepo();
    const pollutedParent = { ...process.env, CONCERTOAI_AGENT: 'leaked-from-parent' };
    const env = baseEnvFrom(pollutedParent);
    expect(
      env.CONCERTOAI_AGENT,
      '基线 env 不该继承身份变量（继承 ⇒ 本例与所有「未声明」用例都失效）',
    ).toBeUndefined();

    const c = r.commit('feat: probe', [], env);
    expect(c.status).toBe(0);
    const body = String(r.git(['log', '-1', '--format=%B']).stdout ?? '');
    expect(body).toContain('Agent: unmarked');
    expect(body).not.toContain('leaked-from-parent');
    expect(stderrOf(c)).toContain('agent identity NOT declared');
  });

  it('基线 env 仍继承必要变量（`PATH` / 家目录）——防有人把它改成「不抄 process.env」', () => {
    /**
     * 这一半守的是候选 4 ⑤ 的「两法不可混用」：若有人把基线 env 改成
     * `{ LUMEN_LOCALE: '', LANG: '' }`（「不抄 `process.env`，逐项写」）——
     * **在 Windows 上它照样全绿**（libuv 会给子进程补 `PATH` 等 11 个必需变量，实测见常量注释），
     * 所以端到端用例抓不住；必须**显式断言**它继承了什么，否则这个错误只在 Linux/macOS CI 上炸。
     * 判据：把 libuv 补的那一组当成自己的继承结果，就是「探针空转」。
     */
    expect(
      BASE_ENV.PATH,
      'PATH 必须继承：hook 里 `command -v node` 与 `git rev-parse` 都靠它',
    ).toBeTruthy();
    expect(BASE_ENV.PATH, 'PATH 不得被钉空').toBe(process.env.PATH);
    // 家目录：`HOME`（POSIX）/ `USERPROFILE`（Windows），任一存在即可（CI 三平台都要过）
    expect(
      BASE_ENV.HOME ?? BASE_ENV.USERPROFILE,
      '家目录必须继承：git 找不到 HOME 时行为会变',
    ).toBeTruthy();
    // locale 仍然钉死（welcome 回归：v5.0 T22 的原始诉求不能被这次改动挤掉）
    expect(BASE_ENV.LUMEN_LOCALE).toBe('');
    expect(BASE_ENV.LANG).toBe('');
  });
});

// ── 性能预算：防有人往 hook 里塞重活 ─────────────────────────

describe('性能预算（防后人往 hook 里塞 dedup / verify）', () => {
  it('有状态文件 vs 无状态文件，提交耗时中位差 < 300ms', () => {
    /**
     * 实测基线（本机）：无状态 168ms / 有状态 202ms，净增 34ms。
     * 阈值取 300ms 是**宽松**的（≈9 倍余量）：只为拦住「有人往 hook 里塞 dedup / verify」
     * 这种量级的改动（那会是几秒~十几秒），不拦正常的机器抖动。
     */
    const timeCommit = (withState: boolean): number[] => {
      const r = makeRepo();
      if (withState) {
        r.writeState({
          schemaVersion: 1,
          status: 'in_progress',
          currentStep: 1,
          steps: [{ id: 1, status: 'pending' }],
        });
      }
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        fs.writeFileSync(path.join(r.dir, `p${i}.txt`), String(i), 'utf8');
        r.git(['add', '-A']);
        const t0 = process.hrtime.bigint();
        const cr = r.git(['commit', '-m', `perf ${i}`], {
          env: { ...BASE_ENV, CONCERTOAI_AGENT: 'perf' },
        });
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        // 提交失败时测到的是「失败耗时」，没有意义 ⇒ 顺手钉住「性能用例里的提交必须成功」
        expect(cr.status, `第 ${i} 次计时提交失败：${String(cr.stderr ?? '').slice(0, 200)}`).toBe(
          0,
        );
      }
      times.sort((a, b) => a - b);
      return times;
    };

    // 不返回 `number | undefined`：本项目开着 noUncheckedIndexedAccess，
    // 用「取不到就 throw」替代 `?? 0`——静默给 0 会让「净增」变成负数，测试反而更绿。
    const median = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)];
      if (mid === undefined) throw new Error('median 至少需要 1 个样本');
      return mid;
    };
    const without = median(timeCommit(false));
    const withState = median(timeCommit(true));
    const delta = withState - without;
    // 打印出来，便于在 CI 日志里核对（断言失败时也有上下文）
    console.log(
      `[githooks perf] 无状态 ${without.toFixed(0)}ms ｜ 有状态 ${withState.toFixed(0)}ms ｜ 净增 ${delta.toFixed(0)}ms`,
    );
    expect(delta).toBeLessThan(300);
  });
});
