#!/usr/bin/env node
/**
 * v5.0 T23.3 手工测试：**真实 Key 场景**（2026-10-29，用户显式授权）。
 *
 * 只跑任务书里必须打真模型的两段，且**按用户口径收紧**：
 * - **单文件、小 diff**（避免长上下文烧钱）；
 * - `review --severity lenient`（按用户指定）；
 * - **跑之前先打 token 估算表**；跑完按 **CLI 自己报的「本次消耗」行**记账
 *   （响应 `usage` 的本地累加，见 `src/model/usage-tally.ts`），余额差只作量级对账；
 * - **单场景超 ¥1 立刻停**（`COST_LIMIT_CNY`，可用 `T233_COST_LIMIT` 注入更小值做闸门自证），
 *   剩余场景标记「因超预算跳过」；**读不到成本行 → fail-closed 停手**（K15：
 *   不可度量 ≠ 没花钱，旧口径「余额差 = 0」正是把它当成了没花钱）。
 *
 * | 场景 | 内容 | 模型调用 |
 * |---|---|---|
 * | 6 | `concertoai check`（本地）→ `concertoai commit --yes`（模型写 message） | 1 次 |
 * | 7 | `concertoai review --severity lenient`（5 并行子代理）+ `review --fix`（非 TTY fail-closed） | 5 次 |
 *
 * ## 与 mock 脚本的关系（AGENTS 第 31 条「探针自证」的变体）
 * mock 脚本要**剔除**真实 Key；本脚本**只**给真实 Key（从 `.env` / 环境变量读，绝不打印明文）。
 * 两个方向都不能靠「默认继承 process.env」——拼 env 必须显式。
 *
 * ## 隔离
 * 项目目录 + HOME 全在临时目录；真实 Key **只经环境变量传入**，不写进任何临时文件；
 * 清理 `try/finally` + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 兜底，跑完自证残留 0。
 *
 * 用法：node scripts/real-key-t233.mjs [--dry-run]   （--dry-run 只打估算表，不调模型）
 * 前置：npm run build
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { get_encoding } from 'tiktoken';

import { gateDecision, parseCostLine, totalGateDecision } from './lib/cost-gate.mjs';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 单场景成本上限（用户口径：超 ¥1 立刻停）。
 *
 * 可用 `T233_COST_LIMIT` 注入更小的值做**闸门自证**（一次读数在默认阈值下继续、
 * 在注入值下必停）；纯函数版本的用例在 `tests/scripts/cost-gate.test.ts`，
 * `npm test` 每次都会重跑，不花一分钱。
 */
const COST_LIMIT_CNY = Number(process.env.T233_COST_LIMIT ?? 1);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-t233real-'));

let cleaned = false;
const leftovers = [];
function cleanup() {
  if (cleaned) return;
  cleaned = true;
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
  console.error('[uncaught]', e);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e);
  cleanup();
  process.exit(1);
});

// ── 断言/记录框架 ─────────────────────────────────────────────

const results = [];
const transcript = [];
const LOG = path.join(REPO, '.git', 't233real-progress.log');
fs.writeFileSync(LOG, '');
function say(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    /* ignore */
  }
}
function check(scenario, name, cond, detail = '') {
  results.push({ scenario, name, pass: cond === true, detail });
  say(`${cond ? 'PASS' : 'FAIL'} | 场景${scenario} | ${name}${detail ? ` | ${detail}` : ''}`);
}
function note(line) {
  say(`OBSERVE | ${line}`);
}

// ── Key（真实的，绝不落盘/不打印）──────────────────────────────

/** 读真实 Key：环境变量优先，其次仓库 `.env`（只取键值，不回显）。 */
function readRealKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: 'env' };
  }
  const envFile = path.join(REPO, '.env');
  if (!fs.existsSync(envFile)) {
    return { key: undefined, source: 'none' };
  }
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/);
    if (m?.[1] !== undefined) {
      return { key: m[1].replace(/^["']|["']$/g, ''), source: '.env' };
    }
  }
  return { key: undefined, source: 'none' };
}

const { key: REAL_KEY, source: KEY_SOURCE } = readRealKey();
const mask = (k) => (k.length <= 8 ? '****' : `${k.slice(0, 5)}****${k.slice(-4)}`);

// ── 环境（显式拼，不靠继承）────────────────────────────────────

function childEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LUMEN_LOCALE: 'zh', DEEPSEEK_API_KEY: REAL_KEY };
  delete env.CONCERTOAI_HINTS;
  delete env.CONCERTOAI_NO_NODE_WARN;
  return env;
}

function makeProject(name) {
  const base = path.join(ROOT, name);
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.concertoai'), { recursive: true });
  return { base, dir, home };
}

function runCli(args, dir, home, extraEnv = {}) {
  const r = spawnSync(NODE, [CLI, ...args], {
    cwd: dir,
    env: { ...childEnv(home), ...extraEnv },
    encoding: 'utf8',
    input: '',
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 读余额（不打模型，只查账户接口）。失败返回 undefined，不编数字。**只作事后对账**。 */
function readBalance(dir, home) {
  const r = runCli(['balance'], dir, home);
  const m = r.out.match(/CNY[^0-9]*([\d.]+)/) ?? r.out.match(/¥\s*([\d.]+)/);
  const value = m?.[1] !== undefined ? Number(m[1]) : undefined;
  return { value, raw: r.out.trim().split(/\r?\n/)[0] ?? '' };
}

/**
 * 从一次 CLI 运行输出里读出「这次花了多少」（K15 修法 ③：唯一权威口径）。
 *
 * 判据 = CLI 打的「本次消耗」行（响应 `usage` 的本地累加），**不是**余额差。
 * 读不到 → `{ measured: false }` 交给闸门 fail-closed，绝不补成 0。
 * 本脚本用 `runCli`（spawnSync，非 PTY）跑，输出不折行；`parseCostLine` 的
 * 折行兜底留给 PTY 场景（`scripts/t233-scenarios-67.mjs`）。
 */
function readingOfRun(raw, label) {
  const parsed = parseCostLine(raw);
  if (!parsed.ok) return { measured: false, label, reason: parsed.reason };
  return { measured: true, label, cost: parsed.cost, raw: parsed.raw };
}

/** 钱数显示（6 位小数：与 CLI 成本行同档，小额也看得见）。 */
const money = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `¥${value.toFixed(6)}` : '未知（未度量）';

const sha = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
};

// ── token 估算（BPE 精确计数已知文本 + 未知名目按经验值给区间）──

let enc;
try {
  enc = get_encoding('o200k_base');
} catch {
  enc = undefined;
}
const tokenCount = (text) => (enc === undefined ? Math.ceil(text.length / 3) : enc.encode(text).length);

/** 价格（T7 官方核对值：flash 空闲价 输入 ¥1/M、输出 ¥4.5/M）。 */
const PRICE_IN = 1 / 1_000_000;
const PRICE_OUT = 4.5 / 1_000_000;

const SCENARIO6_FILE = `// 修复：登录失败时不再泄露「用户是否存在」
function login(user, pass) {
  const ok = check(user, pass);
  return ok ? { ok: true } : { ok: false, error: '用户名或密码不正确' };
}

function check(user, pass) {
  return user === 'admin' && pass === 'secret';
}

module.exports = { login };
`;
const SCENARIO7_FILE = `// 待审查：故意留几个可改进点（不写死密钥、不发网络请求）
const cache = {};

function loadUser(id, db) {
  if (cache[id]) return cache[id];
  const row = db.get(id);
  cache[id] = row;
  return row;
}

function parseIds(text) {
  return text.split(',').map((s) => Number(s));
}

function formatUser(user) {
  console.log('loading user', user.id);
  return user.name + ' <' + user.email + '>';
}

export { loadUser, parseIds, formatUser };
`;

const run = async () => {
  // ═══════════════ 0. 前置自证（探针通电）═══════════════
  if (REAL_KEY === undefined) {
    say('❌ 未找到真实 Key（环境变量 DEEPSEEK_API_KEY 与仓库 .env 都没有）——本脚本只跑真 Key 场景，无法继续。');
    process.exit(2);
  }
  say(`Key 来源=${KEY_SOURCE} 打码=${mask(REAL_KEY)}（本脚本只经环境变量传给子进程，不写任何临时文件）`);
  check(
    0,
    '探针通电：读到了真实 Key（来源与打码值见上一行）',
    REAL_KEY.length >= 20 && (KEY_SOURCE === 'env' || KEY_SOURCE === '.env'),
    `length=${REAL_KEY.length} source=${KEY_SOURCE}`,
  );

  const { dir: probeDir, home: probeHome } = makeProject('probe');
  const balanceBefore = readBalance(probeDir, probeHome);
  say(`余额（跑前）：${balanceBefore.value ?? '读取失败'} ｜ ${balanceBefore.raw}`);
  check(0, '探针通电：余额接口能读到数字（余额只用于事后对账，不参与停手判定）', balanceBefore.value !== undefined, `raw=${balanceBefore.raw}`);

  // ═══════════════ 1. token 估算表（跑之前先写，用户口径）═══════════════
  const s6Input = tokenCount(SCENARIO6_FILE);
  const s7InputPerAgent = tokenCount(SCENARIO7_FILE) + 400; // +400 ≈ 每维系统提示与输出格式模板
  // 场景 7 实测是 **2 轮 × 5 个子代理**：`review`（只读）+ `review --fix`（非 TTY 下会先跑完审查再拒修复，
  // 见报告「已知问题 K8」）——估算按实际轮次算，不按「我以为的 1 轮」算。
  const s7Rounds = 2;
  const s7Agents = 5;
  const estimate = [
    { scenario: 6, calls: 1, inputTokens: s6Input + 300, outputTokens: 300 },
    { scenario: 7, calls: s7Agents * s7Rounds, inputTokens: s7InputPerAgent * s7Agents * s7Rounds, outputTokens: 250 * s7Agents * s7Rounds },
  ].map((e) => ({
    ...e,
    cny: Number((e.inputTokens * PRICE_IN + e.outputTokens * PRICE_OUT).toFixed(4)),
  }));

  say('\n── token 估算（跑之前；按 flash 空闲价 ¥1/M 输入、¥4.5/M 输出）──');
  for (const e of estimate) {
    say(
      `场景${e.scenario}：${e.calls} 次调用 ｜ 输入 ≈${e.inputTokens} tokens ｜ 输出 ≈${e.outputTokens} tokens ｜ 预估 ≈¥${e.cny}`,
    );
  }
  const totalEstimate = estimate.reduce((s, e) => s + e.cny, 0);
  say(`合计预估 ≈¥${totalEstimate}（上限 ¥${COST_LIMIT_CNY}/场景，超了立刻停）\n`);
  check(0, '估算在预算内（每场景预估 < ¥1）', estimate.every((e) => e.cny < COST_LIMIT_CNY), `合计 ≈¥${totalEstimate}`);

  if (DRY_RUN) {
    say('（--dry-run：只打估算表，不调用模型）');
    cleanup();
    process.exit(0);
  }

  const spent = new Map();

  // ═══════════════ 场景 6：check → commit（模型写 message）═══════════════
  {
    const { dir, home } = makeProject('s6');
    say('── 场景 6：concertoai check → concertoai commit --yes ──');
    git(['init', '-q'], dir);
    git(['config', 'user.name', 'T233 Tester'], dir);
    git(['config', 'user.email', 't233@example.com'], dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 't233commit',
          version: '1.0.0',
          scripts: {
            build: 'node -e "process.exit(0)"',
            lint: 'node -e "process.exit(0)"',
            typecheck: 'node -e "process.exit(0)"',
            test: 'node -e "process.exit(0)"',
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(dir, 'login.js'), SCENARIO6_FILE);
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'chore: 初始化'], dir);
    // 真正要提交的改动：单文件小 diff
    fs.writeFileSync(path.join(dir, 'login.js'), `${SCENARIO6_FILE}// 补充：错误码集中管理\n`);

    const balBefore = readBalance(dir, home);
    const checkRun = runCli(['check'], dir, home);
    // 第一次 commit：暂存区是空的。设计上**非交互环境不代答「自动 add -A」**（默认 N）
    const commitNoStage = runCli(['commit', '--yes'], dir, home);
    // 按 CLI 的指引把改动放进暂存区，再走真正的提交（模型写 message）
    git(['add', 'login.js'], dir);
    const commitRun = runCli(['commit', '--yes'], dir, home);
    const balAfter = readBalance(dir, home);
    const delta =
      balBefore.value !== undefined && balAfter.value !== undefined
        ? Number((balBefore.value - balAfter.value).toFixed(4))
        : undefined;
    // 花费读数（K15）：只认有模型调用的那次 `commit`（`commitNoStage` 在调模型前就停手）
    const reading6 = readingOfRun(commitRun.out, '6-commit');
    const gate6 = gateDecision(reading6, COST_LIMIT_CNY, '场景 6');
    spent.set(6, { local: gate6.cost, balanceDelta: delta });
    transcript.push({
      scenario: '6',
      cwd: dir,
      check: checkRun,
      commitNoStage,
      commit: commitRun,
      balBefore,
      balAfter,
      delta,
      reading6,
      gate6,
    });

    check(6, 'check 在干净项目上判「可以提交」（exit 0）', checkRun.status === 0, `exit=${checkRun.status}`);
    check(6, 'check 四段分类都跑了（build/lint/typecheck/test）', /build/i.test(checkRun.out) && /lint/i.test(checkRun.out) && /typecheck/i.test(checkRun.out) && /test/i.test(checkRun.out));
    // 边缘路径②（失败怎么办）：暂存区空 → 不自动 add、不改任何东西、给出可执行指引
    check(6, '暂存区空时不自动 `add -A`（exit 1，不偷偷提交）', commitNoStage.status !== 0, `exit=${commitNoStage.status}`);
    check(6, '暂存区空时给的是「能照做」的指引（git add）', /git add/.test(commitNoStage.out), commitNoStage.out.trim().split(/\r?\n/).slice(-1)[0] ?? '');
    check(6, 'commit 调模型前先报 token 估算（成本可预期）', /tokens?|Token/.test(commitRun.out), (commitRun.out.match(/[^\n]*[Tt]okens?[^\n]*/)?.[0] ?? '').trim());
    check(6, 'commit 成功（exit 0）', commitRun.status === 0, `exit=${commitRun.status}`);
    const log = git(['log', '-1', '--format=%s%n%n%b'], dir);
    check(6, '真的产生了提交，且提交信息是模型写的（不是兜底模板）', log.status === 0 && log.out.trim() !== '' && !/model-failed|model-empty|no-client/.test(commitRun.out), log.out.split('\n')[0] ?? '');
    check(6, '提交信息遵守规范前缀（type(scope): subject）', /^[a-z]+(\([^)]+\))?: .+/.test(log.out.trim().split('\n')[0] ?? ''), log.out.trim().split('\n')[0] ?? '');
    check(6, '模型失败时如实说是哪一种降级（本次不应出现）', !/model-failed|model-empty|no-client/.test(commitRun.out));
    check(6, '没有越权推送（仓库无 remote，且未出现 push）', (git(['remote', '-v'], dir).out.trim() === '') && !/git push/.test(commitRun.out));
    check(6, '工作区已干净（该提交的都提交了）', git(['status', '--porcelain'], dir).out.trim() === '');
    // K15：成本必须**可度量**（CLI 自报的本地累加），且必须在阈值内
    check(
      6,
      '成本可度量：`commit` 打出「本次消耗」行（K15 修法生效）',
      reading6.measured,
      reading6.measured ? money(reading6.cost) : `读不到（${reading6.reason}）`,
    );
    note(
      `场景 6 实际消耗：本地累加 ${money(gate6.cost)} ｜ 余额差 ¥${delta ?? '未能读出'}` +
        `（余额只有 2 位小数 + 结算延迟，只作量级对账，不参与停手判定）`,
    );
    if (gate6.stop) {
      say(`⛔ ${gate6.reason} → 立刻停手，剩余场景标记为「因超预算/不可度量跳过」`);
      check(6, '预算闸门生效（读数超阈值或读不到 → 停手）', true, gate6.reason);
      finish(estimate, spent, true);
      return;
    }
  }

  // ═══════════════ 场景 7：review --severity lenient（+ --fix 非 TTY fail-closed）═══════════════
  {
    const { dir, home } = makeProject('s7');
    say('\n── 场景 7：concertoai review --severity lenient ──');
    git(['init', '-q'], dir);
    git(['config', 'user.name', 'T233 Tester'], dir);
    git(['config', 'user.email', 't233@example.com'], dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 't233review', version: '1.0.0', type: 'module' }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'users.js'), 'export const PLACEHOLDER = 1;\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'chore: 初始化'], dir);
    // 单文件改动 → 默认范围（git 改动文件）只会有 1 个文件
    fs.writeFileSync(path.join(dir, 'users.js'), SCENARIO7_FILE);

    const beforeHash = sha(path.join(dir, 'users.js'));
    const balBefore = readBalance(dir, home);
    const review = runCli(['review', '--severity', 'lenient'], dir, home);
    const fixRun = runCli(['review', '--severity', 'lenient', '--fix'], dir, home);
    const afterHash = sha(path.join(dir, 'users.js'));
    const balAfter = readBalance(dir, home);
    const delta =
      balBefore.value !== undefined && balAfter.value !== undefined
        ? Number((balBefore.value - balAfter.value).toFixed(4))
        : undefined;
    /**
     * 花费读数（K15）：**两次运行各一笔账**。
     *
     * `review` 跑 5 个并行子代理；`review --fix` 在非 TTY 下是「先跑完整轮审查再拒修复」
     * （已知问题 K8：这一轮钱是白花的）—— 两行都要累加，才叫「本场景花了多少」。
     */
    const readings7 = [readingOfRun(review.out, '7-review'), readingOfRun(fixRun.out, '7-review-fix')];
    const gate7 = totalGateDecision(readings7, COST_LIMIT_CNY);
    spent.set(7, { local: gate7.total, balanceDelta: delta });
    transcript.push({
      scenario: '7',
      cwd: dir,
      review,
      fix: fixRun,
      balBefore,
      balAfter,
      delta,
      readings7,
      gate7,
      beforeHash,
      afterHash,
    });

    check(7, 'review 打印了审查范围（用户知道审了什么）', /范围|审查|检查/.test(review.out) && /users\.js/.test(review.out));
    check(7, 'review 给出 9 维分级结论（不是一句「没问题」）', /architecture|架构/.test(review.out) && /security|安全/.test(review.out) && /(tests|测试)/.test(review.out));
    check(7, 'review 的问题带 `文件:行号` 证据（G7）', /users\.js:\d+/.test(review.out), (review.out.match(/users\.js:\d+/g) ?? []).slice(0, 3).join(' '));
    check(7, 'review 退出码与结论一致（无 critical → 0）', review.status === 0 || /critical|🔴/.test(review.out), `exit=${review.status}`);
    check(7, 'review --fix 在非交互终端拒绝写盘（fail-closed）', /需要交互式终端/.test(fixRun.out), '❌ 需要交互式终端来审批修复…');
    check(7, 'review --fix 一个字节都没改（文件哈希不变）', beforeHash === afterHash, `${beforeHash} → ${afterHash}`);
    // 诚实记录（已知问题 K8）：非 TTY 下 `--fix` 是「先跑完 5 个子代理的审查，再拒绝修复」，
    // 也就是说这一轮的模型费用白花。判据 = 带 --fix 的那次也产出了完整报告与新的统计数字。
    const fixRanReview = /9 维分级/.test(fixRun.out);
    note(`review --fix 在非 TTY 下是否先跑完审查再拒：${fixRanReview ? '是（K8：白花一轮审查费用）' : '否（开跑前就拒）'}`);
    check(7, 'review 的自动测试段如实体现在无测试脚本项目上的结果', /自动测试/.test(review.out), (review.out.match(/自动测试\*\*：[^\n]*/)?.[0] ?? '').replace(/\*\*/g, ''));
    // K15：两段都要量得到（`--fix` 那段的钱也不能白花得没数）
    check(
      7,
      '成本可度量：`review` 与 `review --fix` 都打出「本次消耗」行（K15 修法生效）',
      readings7.every((r) => r.measured),
      readings7.map((r) => `${r.label}=${r.measured ? money(r.cost) : `读不到（${r.reason}）`}`).join('；'),
    );
    note(
      `场景 7 实际消耗：本地累加 ${money(gate7.total)} ｜ 余额差 ¥${delta ?? '未能读出'}（余额只作量级对账）`,
    );
    if (gate7.stop) {
      say(`⛔ ${gate7.reason} → 停手`);
      check(7, '预算闸门生效（读数超阈值或读不到 → 停手）', true, gate7.reason);
    }
  }

  finish(estimate, spent, false);
};

function finish(estimate, spent, aborted) {
  const balFinal = readBalance(path.join(ROOT, 'probe', 'proj'), path.join(ROOT, 'probe', 'home'));
  say('\n── 实际消耗（按场景；K15：**本地累加为准**，余额差只作量级对账）──');
  for (const e of estimate) {
    const actual = spent.get(e.scenario);
    const local = actual?.local;
    say(
      `场景${e.scenario}：预估 ≈¥${e.cny} ｜ 本地累加 ${money(local)} ｜ 余额差 ¥${actual?.balanceDelta ?? '未能读出'}`,
    );
  }
  say(`余额（跑后）：${balFinal.value ?? '读取失败'} ｜ ${balFinal.raw}`);
  if (aborted) say('（本轮因超预算提前停手，后续场景未执行）');

  cleanup();
  const failed = results.filter((r) => !r.pass);
  say(`\n合计 ${results.length} 条断言；PASS ${results.length - failed.length}；FAIL ${failed.length}`);
  say(`清理自证：临时目录存在 ${fs.existsSync(ROOT)} / 清理失败 ${leftovers.length}`);
  if (leftovers.length) say(`残留：${leftovers.join(', ')}`);
  fs.writeFileSync(
    path.join(REPO, '.git', 't233real-transcript.json'),
    JSON.stringify({ results, transcript, estimate, spent: [...spent], root: ROOT, cleaned: !fs.existsSync(ROOT) }, null, 2),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await run();
