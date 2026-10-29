#!/usr/bin/env node
/**
 * v5.0 T23.3 手工测试驱动（第 3 部分）：场景 6 / 7 —— **唯一花真钱的两个场景**。
 *
 * | 场景 | 用户动作 | 断言重点 |
 * |---|---|---|
 * | 6 | `concertoai check`（只读体检）→ `concertoai commit`（体检→生成 message→审批→本地提交） | 体检真跑、message 真生成、**审批默认 N**、**只本地不 push**、提交后工作区干净 |
 * | 7 | `concertoai review --fix --severity lenient <单文件>` | 9 维分级真产出、退出码语义、`--fix` 只修建议级、**每次写盘都审批** |
 *
 * ## 花费纪律（用户裁决 2026-10-29）
 * - **单文件、小 diff、`--severity lenient`**；跑前已写 token 估算（见 execution-log-20261029-210500.md §五）；
 * - 跑前跑后各查一次 `concertoai balance`，**按差额记账**；
 * - **单场景超 ¥1 立刻停**（脚本内置 `MAX_COST_PER_SCENARIO = 1`：跑完一个场景就结算，超了后面场景不再跑）。
 *
 * ## 真 Key 的取得与「不泄漏」纪律
 * 本脚本是**唯一允许用真 Key 的 T23.3 脚本**，所以与另两个脚本的口径相反：
 * - 真 Key 从**仓库 `.env` 或 `process.env`** 读一次，**绝不打印、绝不写进任何落盘文件**（transcript 只记长度；
 *   落盘前把输出里的 Key 字面量替换为 `<redacted>`）；
 * - `HOME`/`USERPROFILE` 仍是**临时目录**（不碰开发者真实 `~/.concertoai/`），会话/快照/复盘都不落真实 HOME；
 * - 场景目录是 `mkdtemp` 出来的**独立 git 仓库**（不改本仓库一个字节）。
 *
 * ## 清理（AGENTS 第 17 条）
 * 临时目录 / PTY / 子进程一律 `try/finally` + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 兜底，
 * 幂等 flag、先杀后删、Windows `taskkill /pid <pid> /T /F`（杀前探活）、失败打印残留路径，跑完自证残留 0。
 *
 * 用法：node scripts/t233-scenarios-67.mjs [--only=6|7] [--dump]
 * 前置：npm run build
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty from 'node-pty';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DUMP_ONLY = process.argv.includes('--dump');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg?.slice('--only='.length);

/** 单场景费用熔断阈值（用户裁决：超 ¥1 立刻停）。 */
const MAX_COST_PER_SCENARIO = 1;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-t233-67-'));
const LIVE_TERMS = new Set();
const leftovers = [];

// ── 真 Key（读一次，只留在内存；落盘一律 redact）─────────────────

function readRealKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const envFile = path.join(REPO, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^DEEPSEEK_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const REAL_KEY = readRealKey();
/** 输出脱敏：任何落盘/打印的文本都过这一层（Key 值绝不出现在证据里）。 */
const redact = (s) => (REAL_KEY === undefined ? s : s.split(REAL_KEY).join('<redacted>'));

// ── 清理 ──────────────────────────────────────────────────────

function killTermTree(term) {
  const pid = term?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        term.kill();
      }
    }
  } catch {
    /* 已死 */
  }
  LIVE_TERMS.delete(term);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const term of [...LIVE_TERMS]) {
    try {
      if (process.platform !== 'win32') process.kill(term.pid, 0); // 杀前探活
    } catch {
      LIVE_TERMS.delete(term);
      continue;
    }
    killTermTree(term);
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    leftovers.push(`${ROOT} (${e.code ?? e.message})`);
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', redact(String(e?.stack ?? e)));
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', redact(String(e?.stack ?? e)));
  cleanup();
  process.exit(1);
});

// ── 环境 / 子进程 ─────────────────────────────────────────────

/**
 * 子进程环境。
 *
 * 与场景 1-5 的脚本**刻意不同**：这里**需要**真 Key（用户已授权花真钱）。除此之外仍做隔离：
 * HOME/USERPROFILE 指向临时目录，`CONCERTOAI_HINTS=off`（手工测试不掺提示噪音）。
 * **Key 永不出现在命令行参数里**（只经 env 传递）。
 */
function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LUMEN_LOCALE: 'zh', ...extra };
  if (REAL_KEY !== undefined) env.DEEPSEEK_API_KEY = REAL_KEY;
  else delete env.DEEPSEEK_API_KEY;
  return env;
}

function makeEnv(name) {
  const base = path.join(ROOT, name);
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.concertoai'), { recursive: true });
  return { base, dir, home };
}

/**
 * git 身份（**必须传给被测子进程**，不只是传给脚本自己的 `git()` 辅助）。
 *
 * 实测踩到（2026-10-29）：只给辅助函数设 `GIT_AUTHOR_*`，被测的 `concertoai commit` 子进程
 * 里没有身份 → 审批通过后 `git commit` 报 `Author identity unknown`，界面回一串**英文原始错误**
 * （还带截断的 `Omit --gl…`）。这不是产品缺陷，是**测试 fixture 缺配置**；顺带记一条 UX 观察（K9）。
 */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'T233 Test',
  GIT_AUTHOR_EMAIL: 't233@example.test',
  GIT_COMMITTER_NAME: 'T233 Test',
  GIT_COMMITTER_EMAIL: 't233@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};

function runCli(args, dir, home, extraEnv = {}) {
  const r = spawnSync(NODE, [CLI, ...args], {
    cwd: dir,
    env: childEnv(home, extraEnv),
    encoding: 'utf8',
    timeout: 240000,
  });
  return { status: r.status, out: redact(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
}

/** 读余额（单位元）。查询本身不消耗 token。 */
function balance(dir, home) {
  const r = runCli(['balance'], dir, home);
  const m = r.out.match(/¥\s*([\d.]+)/);
  return m === null ? undefined : Number(m[1]);
}

const strip = (s) => redact(s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
const GATE_GRACE_MS = 30000;

/**
 * 跑一次 TUI。`after` 是就绪门（等它出现才发键）；审批这类**等模型**的步骤给更长 grace。
 * `answer` 为 `{ after, write }` 的步骤会在门开后自动回车（用于审批 y）。
 */
function runTui(dir, home, steps, totalMs, extraEnv = {}, cliArgs = []) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI, ...cliArgs], {
      cwd: dir,
      cols: 120,
      rows: 50,
      env: childEnv(home, extraEnv),
      name: 'xterm-256color',
    });
    LIVE_TERMS.add(term);
    let raw = '';
    const startedAt = Date.now();
    const pending = [...steps];
    const gateMisses = [];
    const pump = () => {
      while (pending.length > 0) {
        const step = pending[0];
        const elapsed = Date.now() - startedAt;
        if (elapsed < step.atMs) return;
        const grace = step.graceMs ?? GATE_GRACE_MS;
        if (step.after !== undefined && !step.after.test(raw)) {
          if (elapsed < step.atMs + grace) return;
          gateMisses.push(step.write);
        }
        pending.shift();
        try {
          term.write(step.write);
        } catch {
          /* dead */
        }
      }
    };
    term.onData((d) => {
      raw += d;
      pump();
    });
    const tick = setInterval(pump, 120);
    let exitCode;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(tick);
      resolve({ raw: strip(raw), gateMisses, exitCode });
    };
    const done = setTimeout(() => {
      killTermTree(term);
      finish();
    }, totalMs);
    term.onExit((e) => {
      exitCode = e?.exitCode;
      clearTimeout(done);
      setTimeout(finish, 150);
    });
  });
}

// ── 断言 ──────────────────────────────────────────────────────

const results = [];
const transcript = [];
const costs = [];
const LOG = path.join(REPO, '.git', 't233-67-progress.log');
fs.writeFileSync(LOG, '');
function say(line) {
  const safe = redact(line);
  console.log(safe);
  try {
    fs.appendFileSync(LOG, `${safe}\n`);
  } catch {
    /* ignore */
  }
}
function check(scenario, name, cond, detail = '') {
  results.push({ scenario, name, pass: cond === true, detail: redact(detail) });
  say(`${cond ? 'PASS' : 'FAIL'} | 场景${scenario} | ${name}${detail ? ` | ${detail}` : ''}`);
}
function note(line) {
  say(`OBSERVE | ${line}`);
}

// ── git 辅助（临时仓库，不碰本仓库）──────────────────────────

function git(dir, args) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T233 Test',
      GIT_AUTHOR_EMAIL: 't233@example.test',
      GIT_COMMITTER_NAME: 'T233 Test',
      GIT_COMMITTER_EMAIL: 't233@example.test',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const actualDirs = {};

const run = async () => {
  say(`真 Key：${REAL_KEY === undefined ? '未找到（场景 6/7 会走降级路径，如实记录）' : `已读取（长度 ${REAL_KEY.length}，值不回显）`}`);

  // ═════════ 场景 6：check → commit（单文件小 diff）═════════
  if (ONLY === undefined || ONLY === '6') {
    const { dir, home } = makeEnv('s6');
    actualDirs.s6 = { dir, home };
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 's6demo', version: '1.0.0', scripts: { verify: 'node -e "process.exit(0)"' } }, null, 2),
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'calc.js'), 'export function sum(a, b) {\n  return a - b;\n}\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 规则\n\n- 这是 T23.3 手工测试项目（commit 场景）\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');

    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
    const initCommit = git(dir, ['commit', '-q', '-m', 'chore: 初始提交']);
    check(6, '临时仓库就绪（git init + 基线提交成功）', initCommit.status === 0, initCommit.out.slice(0, 120));

    // 单文件、小 diff：只改一行
    fs.writeFileSync(path.join(dir, 'src', 'calc.js'), 'export function sum(a, b) {\n  return a + b;\n}\n');

    const before = balance(dir, home);

    // ① check（只读体检；零模型调用）
    const chk = runCli(['check'], dir, home);
    transcript.push({ scenario: '6-check', raw: chk.out, exit: chk.status, dir });
    if (DUMP_ONLY) console.log(chk.out);
    check(6, 'check 真跑 verify 并给出「可以提交」结论', /可以提交|全部通过/.test(chk.out), `exit=${chk.status}`);
    check(6, 'check 只读（不改工作区：仍有未暂存改动）', git(dir, ['status', '--porcelain']).out.includes('src/calc.js'));

    // ② commit（PTY）：**先验证「暂存区空」这一失败路径**（首版脚本漏了这步 →
    // 后面 4 条断言全部找不到文字，因为产品按设计在这里就停手了；见报告「脚本自身的缺陷」）
    const empty = await runTui(dir, home, [{ atMs: 800, write: 'n', graceMs: 20000 }], 30000, {}, ['commit']);
    transcript.push({ scenario: '6-commit-empty', raw: empty.raw, gateMisses: empty.gateMisses, exit: empty.exitCode, dir });
    if (DUMP_ONLY) console.log(empty.raw);
    check(6, '暂存区空时明确停手（不偷偷 add / 不自动提交）', /暂存区是空的/.test(empty.raw) && empty.exitCode !== 0, `exit=${empty.exitCode}`);
    check(6, '暂存区空时给的是能照做的指引（git add）', /git add/.test(empty.raw), empty.raw.match(/💡[^\r\n]*/)?.[0] ?? '');

    // 用户按指引把改动放进暂存区（这一步是**用户行为**，不是产品代劳）
    git(dir, ['add', '-A']);

    // ③ commit（PTY：审批 message）——先看默认是否安全（不发 y，验证「默认拒绝」不提交）
    const refuse = await runTui(
      dir,
      home,
      [
        { atMs: 800, write: 'n', after: /提交这条 message/, graceMs: 150000 },
        { atMs: 1600, write: '\r', after: /提交这条 message/, graceMs: 150000 },
        { atMs: 120000, write: '\u0003' },
      ],
      150000,
      {},
      ['commit'],
    );
    transcript.push({ scenario: '6-commit-refuse', raw: refuse.raw, gateMisses: refuse.gateMisses, dir });
    if (DUMP_ONLY) console.log(refuse.raw);
    check(6, 'commit 先体检再给 message（体检结果可见）', /体检通过|先体检/.test(refuse.raw));
    check(6, 'commit 展示将提交的文件清单（用户能核对待提交内容）', /将提交|个文件/.test(refuse.raw), refuse.raw.match(/📦[^\r\n]*/)?.[0] ?? '');
    check(6, 'commit 生成 message 前先报 token 成本（不闷声花钱）', /tokens/.test(refuse.raw), refuse.raw.match(/💡 将调用模型[^\r\n]*/)?.[0] ?? '');
    check(6, '回答 n → 明确「一条都没提交」', /已取消|一条都没提交/.test(refuse.raw));
    const afterRefuse = git(dir, ['log', '--oneline']).out.split('\n').filter(Boolean).length;
    check(6, '回答 n 后真的没有新提交（审批默认 N 有牙）', afterRefuse === 1, `提交数 ${afterRefuse}`);

    // ③ commit（真正批准 y）：这次要能看到「已提交」+ message 带证据
    const approve = await runTui(
      dir,
      home,
      [
        { atMs: 800, write: 'y', after: /提交这条 message/, graceMs: 150000 },
        { atMs: 1600, write: '\r', after: /提交这条 message/, graceMs: 150000 },
        { atMs: 120000, write: '\u0003' },
      ],
      150000,
      GIT_IDENTITY,
      ['commit'],
    );
    transcript.push({ scenario: '6-commit-approve', raw: approve.raw, gateMisses: approve.gateMisses, dir });
    if (DUMP_ONLY) console.log(approve.raw);
    check(6, '批准后提交成功（界面「已提交」）', /已提交/.test(approve.raw));
    check(6, '界面明说「只做了本地提交，没有推送」（安全边界可见）', /没有推送/.test(approve.raw));

    const log1 = git(dir, ['log', '-1', '--format=%B']);
    const count = git(dir, ['log', '--oneline']).out.split('\n').filter(Boolean).length;
    transcript.push({ scenario: '6-gitlog', raw: log1.out, count, dir });
    check(6, '新提交真的落地（提交数 2）', count === 2, `提交数 ${count}`);
    check(6, 'message 带真实文件证据（提到 calc）', /calc/.test(log1.out), log1.out.split('\n')[0] ?? '');
    check(6, '提交后工作区干净（没有漏文件）', git(dir, ['status', '--porcelain']).out === '', git(dir, ['status', '--porcelain']).out.slice(0, 80));
    check(6, '没有产生任何远程交互（无 remote 配置）', git(dir, ['remote', '-v']).out === '');

    const after = balance(dir, home);
    costs.push({ scenario: 6, before, after });
    const delta6 = before !== undefined && after !== undefined ? Number((before - after).toFixed(4)) : undefined;
    note(`场景 6 费用：¥${before} → ¥${after}（差 ${delta6 ?? 'n/a'}，估算 ≈¥0.001，阈值 ¥${MAX_COST_PER_SCENARIO}）`);
    if (delta6 !== undefined && delta6 > MAX_COST_PER_SCENARIO) {
      say(`🛑 场景 6 超出 ¥${MAX_COST_PER_SCENARIO} 熔断阈值 —— 停止后续场景（用户裁决）。`);
      finish();
      return;
    }
  }

  // ═════════ 场景 7：review --fix --severity lenient（单文件）═════════
  if (ONLY === undefined || ONLY === '7') {
    const { dir, home } = makeEnv('s7');
    actualDirs.s7 = { dir, home };
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 's7demo', version: '1.0.0', type: 'module', scripts: { verify: 'node -e "process.exit(0)"' } }, null, 2),
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    // 单文件、小 diff、含「建议级」可修点（命名与注释不一致 / 无意义包装函数）
    const target = path.join(dir, 'src', 'calc.js');
    fs.writeFileSync(
      target,
      [
        '// 计算两个数的差（注释与实现不符）',
        'export function sum(a, b) {',
        '  const result = a - b;',
        '  return result;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 规则\n\n- 这是 T23.3 手工测试项目（review 场景）\n');
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: 初始提交']);

    const before = balance(dir, home);

    // 只审单文件（用户裁决：单文件、小 diff、lenient）。
    // **必须用 PTY 直跑 CLI 动词**：在 chat 里敲 `concertoai review …` 会被当普通需求发给模型
    // （那既不是被测对象，也会白花钱）。
    // 步骤设计：① 等报告出现 → 答 y 批准写盘（--fix 每次写盘必审批）→ ② 等结束。
    const rev = await runTui(
      dir,
      home,
      [
        // 报告出来后 `--fix` 才会弹审批；用「批准这次修复写盘」当就绪门
        { atMs: 3000, write: 'y', after: /批准这次修复写盘/, graceMs: 240000 },
      ],
      300000,
      {},
      ['review', '--fix', '--severity', 'lenient', 'src/calc.js'],
    );
    transcript.push({ scenario: '7-review-fix', raw: rev.raw, gateMisses: rev.gateMisses, exit: rev.exitCode, dir });
    if (DUMP_ONLY) console.log(rev.raw);

    check(7, '审查范围明确（用户知道审了什么）', /审查范围/.test(rev.raw), rev.raw.match(/📂[^\r\n]*/)?.[0] ?? '');
    check(7, '9 维分级真的产出（A 严重 / B 中等 / C 建议）', /9 维分级/.test(rev.raw) && /：A\d+/.test(rev.raw), rev.raw.match(/[^\r\n]*9 维分级[^\r\n]*/)?.[0] ?? '');
    check(7, '每维给出证据位置（不是空口结论）', /证据\s+\S+:\d+|无问题/.test(rev.raw));
    check(7, '给出退出码结论（0 无 A 级 / 1 有 A 级）', /退出码\s*[01]/.test(rev.raw), rev.raw.match(/结论：[^\r\n]*/)?.[0] ?? '');
    check(7, '退出码与结论一致', (rev.raw.includes('退出码 0') && rev.exitCode === 0) || (rev.raw.includes('退出码 1') && rev.exitCode === 1), `exit=${rev.exitCode}`);
    check(7, '`--fix` 修复范围如实说明（只修建议级，严重/中等转人工）', /修复范围/.test(rev.raw) && /建议级/.test(rev.raw), rev.raw.match(/🔧 --fix[^\r\n]*/)?.[0] ?? '');
    // 两种合法结局都要留证据：真弹了审批 → 必须看到结果行；没可修点 → 必须明说没改动
    const approvalShown = /批准这次修复写盘/.test(rev.raw);
    check(
      7,
      '--fix 每条写盘都走审批（弹审批框）或如实说没有可自动修的点',
      approvalShown ? /修复结果/.test(rev.raw) : /没有可自动修的问题/.test(rev.raw),
      approvalShown ? '出现审批框 → 已答复 y' : '无自动修点',
    );
    if (approvalShown) {
      check(7, '批准后给出修复结果三数（已修 / 需人工 / 已回滚）', /已修\s*\d+/.test(rev.raw), rev.raw.match(/修复结果：[^\r\n]*/)?.[0] ?? '');
    }

    const after = balance(dir, home);
    costs.push({ scenario: 7, before, after });
    const delta7 = before !== undefined && after !== undefined ? Number((before - after).toFixed(4)) : undefined;
    note(`场景 7 费用：¥${before} → ¥${after}（差 ${delta7 ?? 'n/a'}，估算 ≈¥0.015，阈值 ¥${MAX_COST_PER_SCENARIO}）`);
    if (delta7 !== undefined && delta7 > MAX_COST_PER_SCENARIO) {
      say(`🛑 场景 7 超出 ¥${MAX_COST_PER_SCENARIO} 熔断阈值 —— 停止（用户裁决）。`);
    }
  }

  finish();
};

function finish() {
  cleanup();
  const failed = results.filter((r) => !r.pass);
  say(`\n合计 ${results.length} 条断言；PASS ${results.length - failed.length}；FAIL ${failed.length}`);
  say(`清理自证：PTY 残留 ${LIVE_TERMS.size} / 临时目录存在 ${fs.existsSync(ROOT)} / 清理失败 ${leftovers.length}`);
  if (leftovers.length) say(`残留：${leftovers.join(', ')}`);
  say(`费用记账：${costs.map((c) => `场景${c.scenario} ¥${c.before}→¥${c.after}`).join(' · ') || '（未跑真 Key 场景）'}`);

  fs.writeFileSync(
    path.join(REPO, '.git', 't233-67-transcript.json'),
    JSON.stringify(
      { results, transcript, actualDirs, costs, root: ROOT, cleaned: !fs.existsSync(ROOT), keyRedacted: REAL_KEY !== undefined },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await run();
