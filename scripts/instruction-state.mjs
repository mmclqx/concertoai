#!/usr/bin/env node
// ConcertoAI —— 指令进度记录（instruction state）：让「上次做到哪」与「到底做完没有」落盘
//
// 【它解决的两次事故，都是一个形状】
//   ① 会话重启后没有「上次做到哪」的记录 ⇒ 我从看板重挑了一个**已被别的提交做完**的任务，
//      又做了一遍（`git diff f11c583 d2d8f15 -- CHANGELOG.md` 为空），还宣布完成。
//   ② 同一份「继续」被两个实例各执行了一遍（本轮实测：`6864772` 不是我这条命令链提交的）。
//   两次都**不报错**，只在事后对照时暴露 ⇒ 判据不能是「我读一遍觉得对了」，
//   必须是「现跑一条能证伪的命令」（`check` 子命令起子进程，只认 `exitCode === 0`）。
//
// 【它是什么 / 不是什么】
//   是：**意图与进度**的记录（`.git/concertoai-current-instruction.json`）+ 判据执行器（`check`）。
//   不是：完成证据。`status = done` 只是索引，真正的证据是 `doneCriteria` 逐条 `exit 0` 的落盘日志。
//   仍然靠自律：另一个会话可以完全不读不写这个文件（ADR-051「已知局限 ①」）。
//
// 【用法】
//   node scripts/instruction-state.mjs write --file <payload.json> [--on-conflict abandon|keep] [--skip-baseline] [--allow-untracked-targets]
//   node scripts/instruction-state.mjs check [--step <id>]
//   node scripts/instruction-state.mjs dedup [--step <id>] [--targets a,b] [--baseline <ref>] [--force] [--ttl <分钟>] [--no-save]
//   node scripts/instruction-state.mjs update --step <id> --status <pending|in_progress|done|skipped|superseded> [--reuse-evidence]
//   node scripts/instruction-state.mjs update --followup "<原话>" --kind criteria --check "<命令>" [--id C9] [--step <id>]
//   node scripts/instruction-state.mjs update --followup "<原话>" --kind step [--targets a,b] [--goal "<目标>"]
//   node scripts/instruction-state.mjs update --followup "<原话>" --kind note --why "<为何无需验证>"
//   node scripts/instruction-state.mjs update --adjust-steps <steps.json> --approved-by user
//   node scripts/instruction-state.mjs update --set-status done|blocked|abandoned [--reason "<原因>"]
//
// 【退出码】
//   0 成功 / 1 旧 in_progress 冲突未解决 / 2 用法或校验错（含状态文件被 git 跟踪）/ 3 无记录（或记录损坏）
//   4 写盘失败 / 20 判据有 fail / 21 门槛不满足 / 22 未获用户批准 / 23 并发冲突（lastUpdated 被外部改动）
//   10 dedup 结论「已完成」（**不要重做**；刻意与 0 分开：0 = 可以接着做）
//   11 dedup 结论「记录与实际不符」（产物没变但判据不满足 ⇒ 报用户，不擅自做）
//
// 【写死在代码里的五条安全约束（docs/12 §9.2）】
//   1. 终态 `--set-status done` **重跑全部**判据，一律不复用历史 evidence；单步 `--step … --status done`
//      按 §4.5 复用「exitCode === 0 + 新鲜（≤10 分钟）+ head 一致」的 evidence，任一不成立就重跑。
//   2. 任何写操作**原子 rename**；写前比对磁盘内容是否被外部改过（改过 → exit 23，不覆盖）。
//   3. `instruction` **只允许 `write` 写入**，其它子命令/形态改它一律拒绝。
//   4. `steps` 重排/删除必须 `--approved-by user`（写 `self` 一律 exit 22）。
//   5. 状态文件**不得**被 git 跟踪：命中 `git ls-files --error-unmatch` 就拒绝写入（exit 2）。
//
// 【判据怎么表达「已入库」（2026-11-08 事故的直接对策）】
//   判据可声明 `mustBeTracked: ["scripts/x.mjs"]`；执行器除了跑 `check`，还会对每个路径
//   跑 `git ls-files --error-unmatch`，任一未命中即该判据 fail（digest 明说「未入库」）。
//   另：`write` 时若某 step 的 target 还不在版本库里、而该步判据没有任何一条声明
//   mustBeTracked 覆盖它 ⇒ **拒绝写入**（提示怎么改）。真不需要入库的，显式
//   `--allow-untracked-targets` 或在载荷里写 `allowUntrackedTargets: true`，并留痕。
//   为什么：判据只看工作区时，`status=done` 而文件是 `??` —— 换台机器 clone 下来
//   「完成」就蒸发了（`docs/09-踩坑记录/2026-11-08-done不等于入库判据漏了缴库这一步.md`）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── 常量 ──────────────────────────────────────────────────────

const EXIT = Object.freeze({
  OK: 0,
  CONFLICT: 1,
  USAGE: 2,
  NO_RECORD: 3,
  WRITE_FAIL: 4,
  CRITERIA_FAIL: 20,
  THRESHOLD: 21,
  NOT_APPROVED: 22,
  CONCURRENT: 23,
  // 查重专用：10 = 已完成（不是 0）。同码会让「已完成」被当成「待开工」再干一遍。
  DEDUP_DONE: 10,
  DEDUP_MISMATCH: 11,
});

const SCHEMA_VERSION = 1;
const REUSE_TTL_MS = 10 * 60 * 1000; // docs/12 §4.5：单步复用的 TTL
const DEDUP_TTL_MS = 10 * 60 * 1000; // docs/12 §5.2：轻量查重的「多久必须重查」阈值（裁决 5）
const DIGEST_MAX = 300; // 落 JSON 的摘要上限，全文进 evidence/*.log
const DEFAULT_TIMEOUT_MS = 300_000;
const TIMEOUT_EXIT_CODE = 124; // 与 coreutils timeout 同口径：超时不是 0，也不是「没跑」
const MAX_BUFFER = 10 * 1024 * 1024;

const INSTRUCTION_STATUSES = ['in_progress', 'done', 'blocked', 'abandoned'];
const STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped', 'superseded'];

/**
 * 「完成」的三档口径（2026-11-08 用户裁决，见 `docs/12` §一）。
 *
 * 事故的形状是**两头都歪**：我把「未提交」说成「已完成」（偏乐观）；用户读到
 * 一堆英文告警，以为是「写入失败」（偏悲观）。两者同一个真空——**没有档位**。
 *
 *   ① 已写入（磁盘上有）     ← `check` 命令本身在测这个
 *   ② 已提交（进版本库）     ← 只有判据声明了 `mustBeTracked` 才算测过
 *   ③ 已推送（远端有）       ← **本命令不判**：本地 `origin/main` 可能过时，
 *                              拿它当证据就是「安静地给出有利结论」
 *
 * 所以每次 `check` / `--set-status done` 都**固定打印**这行，逼读的人知道边界在哪。
 */
const TIER_LINE =
  'instruction-state: 档位 —— ①已写入 + ②已提交（判据声明 mustBeTracked 时才算）已判；③已推送 **未判**（本地 origin/main 可能过时，要自己跑 git log origin/main..HEAD 复核）';

// ── 时间与路径 ────────────────────────────────────────────────

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** 本地时区 ISO（`2026-11-08T09:46:34+08:00`）。不用 `toISOString()`：UTC 时间戳读起来要心算。 */
function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** 文件名用紧凑时间戳（冒号在 Windows 文件名里非法）。 */
function tsToken(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd: opts.cwd, maxBuffer: MAX_BUFFER });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function repoRoot() {
  const r = git(['rev-parse', '--show-toplevel']);
  return r.ok && r.out ? r.out : process.cwd();
}

function currentHead() {
  const r = git(['rev-parse', '--short', 'HEAD']);
  return r.ok ? r.out : null;
}

/**
 * 状态目录：
 *   · 默认 `.git/`（会话级、不进版本库、不跨机器 —— ADR-051 红线①）
 *   · `CONCERTOAI_INSTRUCTION_DIR` 可改写（测试隔离用：绝不许测试碰开发者真实状态）
 */
function stateDir() {
  const override = (process.env.CONCERTOAI_INSTRUCTION_DIR ?? '').trim();
  if (override) return path.resolve(override);
  const r = git(['rev-parse', '--git-dir']);
  return path.resolve(r.ok && r.out ? r.out : '.git');
}

const statePath = () => path.join(stateDir(), 'concertoai-current-instruction.json');
const historyPath = () => path.join(stateDir(), 'concertoai-instruction-history.jsonl');
const evidenceDir = () => path.join(stateDir(), 'concertoai-instruction-evidence');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── 读写（原子 + 并发检测 + 不得被 git 跟踪） ──────────────────

function readRaw() {
  try {
    return fs.readFileSync(statePath(), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 读状态。三态：missing（首次运行）/ corrupt（备份后不猜）/ ok。
 * corrupt 时**不改动原文件**（只 copy 一份备份）——「损坏」不代表可以替我重写。
 */
function readState() {
  const raw = readRaw();
  if (raw === null) return { kind: 'missing' };
  try {
    return { kind: 'ok', data: JSON.parse(raw), raw };
  } catch (error) {
    let backup = null;
    try {
      backup = `${statePath()}.corrupt-${tsToken()}`;
      fs.copyFileSync(statePath(), backup);
    } catch {
      backup = null;
    }
    return { kind: 'corrupt', backup, error: error.message, raw };
  }
}

function isGitTracked(absPath) {
  const root = repoRoot();
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const posix = rel.split(path.sep).join('/');
  return git(['ls-files', '--error-unmatch', '--', posix], { cwd: root }).ok;
}

/**
 * 按**仓库相对路径**判定「是否已进版本库」。
 *
 * 为什么需要这一条：`2026-11-08` 的事故里，判据只断言了「文件存在 + 测试绿」，
 * 于是 `status=done` 而 `scripts/` `tests/` 一直 `??` 未跟踪——**换台机器 clone 下来
 * 「完成」就蒸发了**。工作区绿 ≠ 交付可用，判据必须自己覆盖这一步。
 */
function isTrackedRel(relPath) {
  const root = repoRoot();
  const posix = String(relPath).split(path.sep).join('/');
  return git(['ls-files', '--error-unmatch', '--', posix], { cwd: root }).ok;
}

function fail(message, code = EXIT.USAGE) {
  console.error(`instruction-state: ${message}`);
  process.exit(code);
}

/** 原子写（tmp + rename），写前做两件事：git 跟踪检查、外部改动检查。 */
function writeState(data, loaded) {
  const target = statePath();
  if (isGitTracked(target)) {
    fail(`状态文件不得被 git 跟踪（ADR-051 红线①）：${target}`, EXIT.USAGE);
  }
  const rawNow = readRaw();
  const rawBefore = loaded && loaded.kind === 'ok' ? loaded.raw : rawNow;
  if (rawBefore !== rawNow) {
    fail('并发冲突：状态文件在本次操作期间被外部改动，已中止且未写入（重读后再决定，别覆盖别人的进度）', EXIT.CONCURRENT);
  }
  data.lastUpdated = nowIso();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    ensureDir(path.dirname(target));
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主结论 */
    }
    fail(`写盘失败：${error.message}`, EXIT.WRITE_FAIL);
  }
  return data;
}

/** 历史归档（O_APPEND，追加不改写）。 */
function appendHistory(entry) {
  try {
    ensureDir(stateDir());
    fs.appendFileSync(historyPath(), `${JSON.stringify({ at: nowIso(), ...entry })}\n`, 'utf8');
  } catch (error) {
    // 进度记录写盘失败不得阻断主任务（ADR-051 红线⑦）
    console.error(`instruction-state: 警告：历史归档写盘失败（${error.message}），本次结论不受影响`);
  }
}

// ── 判据执行 ──────────────────────────────────────────────────

/**
 * 跑一条判据。**只认 `exitCode === 0` + `expectContains` 逐条命中**。
 * 超时/被杀 → `TIMEOUT_EXIT_CODE`（124），记 fail，绝不记 pass。
 */
function runCriterion(criterion, opts = {}) {
  const timeoutMs = Number(criterion.timeoutMs) > 0 ? Number(criterion.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const r = spawnSync(criterion.check, {
    shell: true,
    cwd: opts.cwd ?? repoRoot(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const timedOut = r.status === null;
  const exitCode = timedOut ? TIMEOUT_EXIT_CODE : r.status;
  const expect = Array.isArray(criterion.expectContains) ? criterion.expectContains : [];
  const missing = expect.filter((s) => typeof s === 'string' && s.length > 0 && !output.includes(s));
  // 「已入库」断言：判据自己声明 mustBeTracked，执行器逐个跑 `git ls-files --error-unmatch`。
  // 执行器仍然只做一件事（起子进程、看退出码），**要不要入库由判据自己声明**——
  // 把口径硬编码进执行器，不同判据的不同要求（有的要入库、有的只要本地产物）就表达不出来了。
  const tracked = Array.isArray(criterion.mustBeTracked) ? criterion.mustBeTracked : [];
  const untracked = tracked.filter((p) => typeof p === 'string' && p.length > 0 && !isTrackedRel(p));
  const pass = !timedOut && exitCode === 0 && missing.length === 0 && untracked.length === 0;
  return { checkId: criterion.id, cmd: criterion.check, exitCode, pass, missing, untracked, timedOut, output };
}

/** 去掉 ANSI 颜色转义：摘要给人读，`\u001b[36m` 这类字节只会让日志变成乱码。 */
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

function digestOf(run) {
  const firstLine = stripAnsi(run.output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  let digest = firstLine ?? '(无输出)';
  if (run.untracked.length > 0) {
    digest = `未入库：${run.untracked.join(', ')}（工作区有，但 git 里没有 ⇒ 换台机器就没了） ｜ ${digest}`;
  }
  if (run.missing.length > 0) {
    digest = `expectContains 缺 ${run.missing.map((s) => JSON.stringify(s)).join(', ')} ｜ ${digest}`;
  }
  if (run.timedOut) digest = `超时/被杀 ｜ ${digest}`;
  return digest.slice(0, DIGEST_MAX);
}

/** 全文落 evidence 日志，JSON 只留路径 + 摘要（文档 §4.2 落盘口径）。 */
function writeEvidenceLog(run, stepId) {
  const dir = evidenceDir();
  ensureDir(dir);
  const file = path.join(dir, `${stepId ?? 'instruction'}-${run.checkId}-${tsToken()}-${process.pid}.log`);
  const header = [
    `# checkId: ${run.checkId}`,
    `# stepId: ${stepId ?? '(none)'}`,
    `# cmd: ${run.cmd}`,
    `# exitCode: ${run.exitCode}`,
    `# pass: ${run.pass}`,
    `# at: ${nowIso()}`,
    '# --- 以下为 stdout+stderr 全文 ---',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(file, `${header}${run.output}`, 'utf8');
  } catch (error) {
    console.error(`instruction-state: 警告：证据日志写盘失败（${error.message}），JSON 仍会记录摘要`);
    return null;
  }
  const root = repoRoot();
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}

function evidenceEntry(run, stepId, extra = {}) {
  return {
    checkId: run.checkId,
    stepId: stepId ?? null,
    cmd: run.cmd,
    exitCode: run.exitCode,
    digest: digestOf(run),
    logPath: writeEvidenceLog(run, stepId),
    at: nowIso(),
    by: 'self',
    head: currentHead(),
    reused: false,
    ...extra,
  };
}

// ── 记录操作小工具 ────────────────────────────────────────────

function requireRecord() {
  const loaded = readState();
  if (loaded.kind === 'missing') {
    fail('无记录：没有找到指令状态（首次运行属正常；先 write 一条，或按 docs/12 §5.1 手工查重后问我做到哪）', EXIT.NO_RECORD);
  }
  if (loaded.kind === 'corrupt') {
    fail(
      `记录损坏（JSON 解析失败：${loaded.error}）；已备份到 ${loaded.backup ?? '(备份失败)'}，原文件未改动。不猜、不覆盖。`,
      EXIT.NO_RECORD,
    );
  }
  return loaded;
}

const criteriaById = (data) => new Map((data.doneCriteria ?? []).map((c) => [c.id, c]));

function latestEvidence(data, checkId) {
  const pool = [
    ...(data.evidence ?? []),
    ...(data.steps ?? []).flatMap((s) => (s.evidence ?? []).map((e) => ({ ...e, stepId: e.stepId ?? s.id }))),
  ].filter((e) => e && e.checkId === checkId);
  if (pool.length === 0) return null;
  return pool.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())[0];
}

const ageMs = (at) => Date.now() - new Date(at ?? 0).getTime();

function nextPendingStepId(steps) {
  const next = (steps ?? []).find((s) => s.status === 'pending' || s.status === 'in_progress');
  return next ? next.id : null;
}

// ── 参数解析 ──────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      opts._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
}

function readJsonFile(file, what) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`读不到${what}：${file}（${error.message}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${what}不是合法 JSON：${file}（${error.message}）`);
  }
}

// ── 校验 ──────────────────────────────────────────────────────

function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    fail('doneCriteria 必须是非空数组（没有判据就无法机械判定 done —— 拒绝恒绿空转）');
  }
  const seen = new Set();
  for (const c of criteria) {
    if (!c || typeof c.id !== 'string' || !c.id) fail('doneCriteria 每条必须有字符串 id');
    if (seen.has(c.id)) fail(`doneCriteria 判据 id 重复：${c.id}`);
    seen.add(c.id);
    if (typeof c.check !== 'string' || !c.check.trim()) fail(`判据 ${c.id} 缺少 check 命令`);
    if (c.expectContains !== undefined && !Array.isArray(c.expectContains)) {
      fail(`判据 ${c.id} 的 expectContains 必须是字符串数组（desc 里的自然语言不算判据）`);
    }
    if (c.desc !== undefined && typeof c.desc !== 'string') fail(`判据 ${c.id} 的 desc 必须是字符串`);
    if (c.mustBeTracked !== undefined) {
      if (!Array.isArray(c.mustBeTracked) || c.mustBeTracked.some((p) => typeof p !== 'string' || !p.trim())) {
        fail(`判据 ${c.id} 的 mustBeTracked 必须是非空字符串数组（仓库相对路径）`);
      }
    }
  }
  return criteria;
}

function validateSteps(steps, criteria) {
  if (!Array.isArray(steps) || steps.length === 0) fail('steps 必须是非空数组');
  const ids = new Set();
  for (const s of steps) {
    if (!s || !Number.isInteger(s.id)) fail('steps 每步必须有整数 id');
    if (ids.has(s.id)) fail(`steps 步骤 id 重复：${s.id}`);
    ids.add(s.id);
    if (typeof s.goal !== 'string' || !s.goal.trim()) fail(`步骤 ${s.id} 缺少 goal`);
    if (s.targets !== undefined && !Array.isArray(s.targets)) fail(`步骤 ${s.id} 的 targets 必须是数组`);
    for (const cid of s.criteria ?? []) {
      if (!criteria.has(cid)) fail(`步骤 ${s.id} 引用了不存在的判据：${cid}`);
    }
    if (s.status !== undefined && !STEP_STATUSES.includes(s.status)) {
      fail(`步骤 ${s.id} 的 status 非法：${s.status}（允许 ${STEP_STATUSES.join(' / ')}）`);
    }
  }
  return steps;
}

const normRel = (p) => String(p).trim().split(path.sep).join('/').replace(/^\.\//, '');

/**
 * 只判「看起来是文件」的 target（有扩展名、不以 `/` 结尾）。
 * 目录类 target（`docs/`、`src/`）不在本检查范围：目录是否入库由其中文件决定，
 * 对目录做 `git ls-files --error-unmatch` 只会得到无意义的否定。这条边界要写清，
 * 否则「过滤掉一切」的实现也能让护栏看起来全绿。
 */
function looksLikeFile(relPath) {
  const p = normRel(relPath);
  if (!p || p.endsWith('/')) return false;
  return /\.[A-Za-z0-9]+$/.test(path.posix.basename(p));
}

/**
 * 找出「target 还没入库、而该步判据没有任何一条声明 mustBeTracked 覆盖它」的组合。
 *
 * 这是把 `2026-11-08` 那条踩坑（判据说 done、产物没入库）从文档条款变成**可执行断言**：
 * 光写「凡新增文件类判据必须断言已入库」只是纪律，纪律靠自觉；这条让它**写不出来**。
 */
function findUntrackedTargetsWithoutGuard(steps, criteria) {
  const map = new Map(criteria.map((c) => [c.id, c]));
  const out = [];
  for (const step of steps) {
    const guarded = new Set(
      (step.criteria ?? []).flatMap((cid) => map.get(cid)?.mustBeTracked ?? []).map((p) => normRel(p)),
    );
    for (const target of step.targets ?? []) {
      if (!looksLikeFile(target)) continue;
      if (guarded.has(normRel(target))) continue;
      if (isTrackedRel(target)) continue;
      out.push({ stepId: step.id, target, criteria: step.criteria ?? [] });
    }
  }
  return out;
}

// ── write ─────────────────────────────────────────────────────

function conflictPrompt(data) {
  const steps = data.steps ?? [];
  const doneSteps = steps.filter((s) => s.status === 'done');
  const lines = [
    '上一条指令还没到 done：',
    `  指令：${String(data.instruction ?? '').slice(0, 60)}`,
    `  进度：第 ${data.currentStep ?? '?'} / ${steps.length} 步（currentStep=${data.currentStep ?? 'null'}，已完成 ${doneSteps.length} 步）`,
    `  最后更新：${data.lastUpdated ?? '(未知)'}`,
    '',
    '选一个（脚本不会替你选）：',
    '  ① 继续它 —— 保持现状，新指令先别写（本命令不加 --on-conflict 即是这个行为，文件未改动）',
    '  ② 放弃它 —— 旧记录标 abandoned 归档后写新指令：加 --on-conflict abandon',
    '  ③ 先看它卡在哪 —— 读记录：node -e "console.log(require(\'fs\').readFileSync(\'.git/concertoai-current-instruction.json\',\'utf8\'))"',
  ];
  console.error(lines.join('\n'));
}

function measureBaseline(criteria) {
  const state = { measuredAt: nowIso(), note: '写入时实测一遍全部判据：非恒绿空转的自证（docs/12 §9.1）' };
  for (const c of criteria) {
    const run = runCriterion(c);
    state[c.id] = run.pass ? 'GREEN' : 'RED';
    console.error(`instruction-state: baseline ${c.id} = ${run.pass ? 'GREEN' : 'RED'} ｜ ${digestOf(run)}`);
  }
  return state;
}

function cmdWrite(opts) {
  if (!opts.file) fail('write 需要 --file <payload.json>');
  const payload = readJsonFile(opts.file, '指令载荷');
  if (typeof payload.instruction !== 'string' || !payload.instruction.trim()) {
    fail('载荷缺少 instruction（用户原话，唯一锚点，禁止摘要化）');
  }
  const criteria = validateCriteria(payload.doneCriteria);
  const criteriaMap = criteriaById({ doneCriteria: criteria });
  const steps = validateSteps(payload.steps, criteriaMap);
  const untrackedAck = Boolean(opts['allow-untracked-targets']) || payload.allowUntrackedTargets === true;
  const uncovered = findUntrackedTargetsWithoutGuard(steps, criteria);
  if (uncovered.length > 0 && !untrackedAck) {
    const detail = uncovered.map((u) => `  步骤 ${u.stepId} 的 target「${u.target}」尚未入库，而该步判据（${u.criteria.join(', ') || '无'}）没有声明 mustBeTracked 覆盖它`).join('\n');
    fail(
      [
        '判据漏了「已入库」这一步（2026-11-08 事故的直接对策）：',
        detail,
        '',
        '二选一：',
        '  ① 在相关判据里加 mustBeTracked（推荐）：{"id":"C2","check":"...","mustBeTracked":["scripts/x.mjs"]}',
        '  ② 确认这些文件本来就不该入库，显式声明：加 --allow-untracked-targets 或在载荷里写 allowUntrackedTargets:true',
        '',
        '为什么不能默认放行：判据只看工作区时，status=done 而文件是 ?? 未跟踪 —— 换台机器 clone 下来「完成」就蒸发了。',
      ].join('\n'),
    );
  }

  const loaded = readState();
  if (loaded.kind === 'corrupt') {
    fail(`记录损坏，先人工处理（已备份 ${loaded.backup ?? '(备份失败)'}），不覆盖`, EXIT.CONFLICT);
  }
  if (loaded.kind === 'ok' && loaded.data.status === 'in_progress') {
    if (opts['on-conflict'] !== 'abandon') {
      conflictPrompt(loaded.data);
      process.exit(EXIT.CONFLICT);
    }
    appendHistory({
      kind: 'instruction-archived',
      reason: 'write --on-conflict abandon：用户选择放弃旧 in_progress',
      instruction: loaded.data.instruction,
      status: 'abandoned',
      currentStep: loaded.data.currentStep ?? null,
      lastUpdated: loaded.data.lastUpdated ?? null,
    });
  }

  const data = {
    schemaVersion: SCHEMA_VERSION,
    writtenBy: opts.by ?? process.env.CONCERTOAI_AGENT ?? 'unmarked',
    instruction: payload.instruction,
    instructionRaw: payload.instructionRaw ?? payload.instruction,
    receivedAt: nowIso(),
    baselineHead: opts['baseline-head'] ?? currentHead(),
    status: 'in_progress',
    doneCriteria: criteria.map((c) => ({
      id: c.id,
      desc: c.desc ?? '',
      check: c.check,
      expectContains: c.expectContains ?? [],
      mustBeTracked: c.mustBeTracked ?? [],
      ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
      covers: c.covers ?? [],
    })),
    steps: steps.map((s) => ({
      id: s.id,
      goal: s.goal,
      targets: s.targets ?? [],
      criteria: s.criteria ?? [],
      status: s.status ?? 'pending',
      evidence: [],
      dedup: null,
    })),
    currentStep: null,
    followUps: [],
    evidence: [],
    revisions: [],
    doneProof: null,
    blockedReason: null,
    // 留痕：本轮是否显式放行了「未入库 target」（放行也必须能事后查出来）
    untrackedTargetsAck: untrackedAck,
    baselineCriteriaState: opts['skip-baseline']
      ? { skipped: true, reason: '--skip-baseline：本轮未实测基线（仅限脚本自举/测试用）' }
      : measureBaseline(criteria),
    notes: payload.notes ?? [],
  };
  data.currentStep = nextPendingStepId(data.steps);
  writeState(data, loaded);
  console.log(`instruction-state: 已写入 ${statePath()}（判据 ${criteria.length} 条 / 步骤 ${steps.length} 个 / currentStep=${data.currentStep}）`);
  process.exit(EXIT.OK);
}

// ── check ─────────────────────────────────────────────────────

function cmdCheck(opts) {
  const loaded = requireRecord();
  const data = loaded.data;
  const all = data.doneCriteria ?? [];
  let targets = all;
  let stepId = null;
  if (opts.step !== undefined) {
    const step = (data.steps ?? []).find((s) => String(s.id) === String(opts.step));
    if (!step) fail(`没有这个步骤：${opts.step}`);
    stepId = step.id;
    const map = criteriaById(data);
    targets = (step.criteria ?? []).map((cid) => map.get(cid)).filter(Boolean);
    if (targets.length === 0) fail(`步骤 ${step.id} 没有关联判据，check 无事可做（这不等于通过）`);
  }

  const runs = targets.map((c) => runCriterion(c));
  data.evidence = data.evidence ?? [];
  for (const run of runs) data.evidence.push(evidenceEntry(run, stepId));
  writeState(data, loaded);

  for (const run of runs) {
    console.log(`${run.pass ? 'PASS' : 'FAIL'} ${run.checkId} ｜ exit=${run.exitCode} ｜ ${digestOf(run)}`);
  }
  // 固定尾行：防止把「判据全绿」误读成「已查重」（查重是 dedup 子命令，它看 git 产物）
  console.log('instruction-state: 本命令只判定判据，不等于查重（查重请用 dedup 子命令）');
  console.log(TIER_LINE);
  process.exit(runs.every((r) => r.pass) ? EXIT.OK : EXIT.CRITERIA_FAIL);
}

// ── dedup：查重（docs/12 §5.1 开工第一道 / §5.2 每步第二道） ────
//
// 【为什么它比状态文件硬】
//   另一个会话可以完全不读不写这个 JSON（ADR-051 局限①），但它**没法不留下提交**。
//   所以「这件事到底有没有被做完」只认产物 + 判据，「产物变没变」只认 git。
//   JSON 只省掉「我自己」的重复劳动；dedup 才是那道硬防线。
//
// 【四格矩阵（docs/12 §5.1）——不只看 diff 空不空，还要逐条跑判据】
//   | 产物 diff | 判据 | verdict  | 怎么办 |
//   | 空        | 全绿 | done     | 不要重做（exit 10） |
//   | 空        | 有红 | mismatch | 记录与实际不符 ⇒ 报用户，别动手（exit 11） |
//   | 非空      | 全绿 | done     | 别人用别的实现做完了，不要重做（exit 10） |
//   | 非空      | 有红 | not-done | 部分完成，从红的那条接着做（exit 0） |
//
// 【为什么不只看 diff】`git diff` 非空 ≠ 没过关（别人可能用别的实现满足判据）；
//   `git diff` 空 ≠ 一定过（产物可能被回退）。**只有判据 exit 0 才是证据。**

const DEDUP_VERDICT_NOTE = Object.freeze({
  done: '已完成 —— 不要重做（矩阵：判据全绿）。收尾仍要走 update --set-status done（终态重跑全部判据，不复用）',
  'not-done': '未完成 —— 部分产物已在，从 FAIL 的那条判据接着做（不要从头再来）',
  mismatch: '记录与实际不符 —— 产物自基线以来没变化，判据却不满足；先别动手，把这条报给用户（docs/12 §5.1 第 2 格）',
  'changes-only': '只报了产物变更 —— 本次没有判据可跑（无记录 / 未指定范围）⇒ **这既不是完成，也不是未完成**',
});

function refExists(ref) {
  if (!ref) return false;
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok && Boolean(r.out);
}

/**
 * 基线：显式 `--baseline` → 记录里的 `baselineHead` → `HEAD~3` → （提交不足时）首个提交。
 * `--baseline` 给错**不静默换**：悄悄换一个更近的基线，diff 会更空 —— 那正是
 * 「安静地给出有利结论」的形态（docs/12 §一）。
 */
function pickBaseline(explicit, data) {
  if (typeof explicit === 'string' && explicit.trim()) {
    const ref = explicit.trim();
    if (!refExists(ref)) {
      fail(`--baseline 不是有效提交：${ref}（拒绝静默换基线：换近了 diff 会更空，等于安静地给出有利结论）`);
    }
    return { ref, source: '--baseline' };
  }
  const candidates = [
    data?.baselineHead ? { ref: data.baselineHead, source: 'record.baselineHead' } : null,
    { ref: 'HEAD~3', source: 'HEAD~3（无记录时的默认，docs/12 §5.1）' },
    { ref: 'HEAD', source: 'HEAD（提交数不足 4）' },
  ].filter(Boolean);
  for (const c of candidates) if (refExists(c.ref)) return c;
  const first = git(['rev-list', '--max-parents=0', 'HEAD']);
  if (first.ok && first.out) return { ref: first.out.split('\n').pop().trim(), source: '首个提交' };
  return null;
}

const dedupPathArgs = (targets) => {
  const list = (targets ?? []).filter((t) => typeof t === 'string' && t.trim());
  return list.length > 0 ? ['--', ...list] : [];
};

const splitLines = (s) =>
  String(s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** 三样都取：提交级 diff（矩阵用）、期间提交（人读）、工作区状态（未提交的产物也是产物）。 */
function dedupChangeSet(baselineRef, targets) {
  const range = `${baselineRef}..HEAD`;
  const args = dedupPathArgs(targets);
  const diff = git(['diff', '--name-only', range, ...args]);
  const log = git(['log', '--format=%h|%ad|%s', '--date=iso', range, ...args]);
  const status = git(['status', '--porcelain', ...args]);
  return {
    changedFiles: splitLines(diff.out),
    commits: splitLines(log.out),
    worktree: splitLines(status.out),
  };
}

function cmdDedup(opts) {
  if (!git(['rev-parse', '--show-toplevel']).ok) {
    fail('dedup 需要 git 仓库（查重的唯一依据是提交与 diff，没有 git 就只能靠猜）');
  }
  const loaded = readState();
  if (loaded.kind === 'corrupt') {
    fail(`记录损坏（${loaded.error}），已备份 ${loaded.backup ?? '(备份失败)'}；不猜、不覆盖`, EXIT.NO_RECORD);
  }
  const data = loaded.kind === 'ok' ? loaded.data : null;

  // ── 范围：--step 优先，其次 --targets，最后取整条指令的全部 targets ──
  let step = null;
  let targets = [];
  let criteriaIds = null;
  if (opts.step !== undefined) {
    if (!data) fail('无记录：--step 需要状态记录（只查某段路径请用 --targets a,b）', EXIT.NO_RECORD);
    step = (data.steps ?? []).find((s) => String(s.id) === String(opts.step));
    if (!step) fail(`没有这个步骤：${opts.step}`);
    targets = step.targets ?? [];
    criteriaIds = step.criteria ?? [];
    if (criteriaIds.length === 0) {
      fail(
        `步骤 ${step.id} 没有关联判据 ⇒ dedup 无法判定「是否已被做完」（「没判据」不等于「未完成」，先补判据）`,
        EXIT.THRESHOLD,
      );
    }
  } else if (typeof opts.targets === 'string') {
    targets = opts.targets
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  } else if (data) {
    targets = [...new Set((data.steps ?? []).flatMap((s) => s.targets ?? []))];
  }

  const baseline = pickBaseline(typeof opts.baseline === 'string' ? opts.baseline : null, data);
  if (!baseline) fail('找不到可用基线：这个仓库还没有任何提交', EXIT.USAGE);
  const { changedFiles, commits, worktree } = dedupChangeSet(baseline.ref, targets);
  const head = currentHead();

  const map = data ? criteriaById(data) : new Map();
  const spec =
    criteriaIds === null
      ? (data?.doneCriteria ?? [])
      : criteriaIds.map((cid) => map.get(cid)).filter(Boolean);

  // ── 轻量查重（§5.2）：HEAD 没变 + 无新增提交 + 距上次查重不超阈值 ⇒ 沿用上次结论，不跑判据 ──
  const prev = step ? (step.dedup ?? null) : (data?.dedup ?? null);
  const ttlMs = Number(opts.ttl) > 0 ? Number(opts.ttl) * 60_000 : DEDUP_TTL_MS;
  const canReuse = Boolean(
    prev?.verdict &&
      prev.logHead &&
      prev.logHead === head &&
      ageMs(prev.checkedAt) <= ttlMs &&
      commits.length === 0 &&
      changedFiles.length === 0 &&
      !opts.force,
  );

  let verdict;
  let verdictSource = 'measured';
  let runs = [];
  let criteriaRecord = [];
  if (canReuse) {
    verdict = prev.verdict;
    verdictSource = 'reused';
    criteriaRecord = prev.criteria ?? [];
  } else if (spec.length === 0) {
    verdict = 'changes-only';
    criteriaRecord = [];
  } else {
    runs = spec.map((c) => runCriterion(c));
    const allPass = runs.every((r) => r.pass);
    // 四格矩阵：diff 空 + 有红 = 记录与实际不符；diff 非空 + 有红 = 部分完成
    verdict = allPass ? 'done' : changedFiles.length > 0 ? 'not-done' : 'mismatch';
    criteriaRecord = runs.map((r) => ({
      id: r.checkId,
      exitCode: r.exitCode,
      pass: r.pass,
      digest: digestOf(r),
      logPath: writeEvidenceLog(r, step ? step.id : null),
    }));
  }

  const record = {
    checkedAt: nowIso(),
    logHead: head,
    baseline: baseline.ref,
    baselineSource: baseline.source,
    scope: step ? `step:${step.id}` : targets.length > 0 ? 'targets' : 'repo',
    targets,
    changedFiles: changedFiles.slice(0, 50),
    newCommits: commits.slice(0, 10),
    worktreeChanges: worktree.slice(0, 10),
    criteria: criteriaRecord,
    verdict,
    verdictSource,
    ...(canReuse ? { reusedFrom: prev.checkedAt } : {}),
  };

  if (data && !opts['no-save']) {
    if (step) step.dedup = record;
    else data.dedup = record; // 指令级（开工第一道）结论；字段说明见 docs/12 §2.3
    writeState(data, loaded);
  }

  // ── 输出：先事实，再结论，最后固定档位行（与 check / 终态同一口径） ──
  console.log(
    `instruction-state: dedup 范围=${record.scope} 基线=${baseline.ref}（${baseline.source}）HEAD=${head ?? '(未知)'}`,
  );
  console.log(
    `  产物变更：${changedFiles.length} 个文件${changedFiles.length > 0 ? `（${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? ' …' : ''}）` : ''}`,
  );
  console.log(
    `  期间提交：${commits.length} 个${commits.length > 0 ? `（最新 ${commits[0]}）` : ''}`,
  );
  console.log(
    `  工作区未提交：${worktree.length} 项${worktree.length > 0 ? `（${worktree.slice(0, 3).join(' / ')}${worktree.length > 3 ? ' …' : ''}）` : ''}`,
  );
  if (canReuse) {
    console.log(
      `  判据：沿用 ${prev.checkedAt} 的结论（HEAD 未变 + 无新增提交 + ${Math.round(ttlMs / 60_000)} 分钟内查过；判据这次没重跑）`,
    );
  } else {
    for (const r of runs) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.checkId} ｜ exit=${r.exitCode} ｜ ${digestOf(r)}`);
    }
    if (spec.length === 0) console.log('  判据：无可执行判据（本次只报变更）');
  }
  console.log(`instruction-state: verdict=${verdict}（${verdictSource}）—— ${DEDUP_VERDICT_NOTE[verdict]}`);
  if (data && !opts['no-save']) {
    console.log(`  结论已写回 ${step ? `steps[${step.id}].dedup` : 'data.dedup'}（${statePath()}）`);
  }
  console.log(TIER_LINE);
  process.exit(verdict === 'done' ? EXIT.DEDUP_DONE : verdict === 'mismatch' ? EXIT.DEDUP_MISMATCH : EXIT.OK);
}

// ── update：形态 1（推进步骤） ────────────────────────────────

function cmdUpdateStep(opts) {
  const loaded = requireRecord();
  const data = loaded.data;
  const status = String(opts.status);
  if (!STEP_STATUSES.includes(status)) fail(`--status 非法：${status}（允许 ${STEP_STATUSES.join(' / ')}）`);
  const step = (data.steps ?? []).find((s) => String(s.id) === String(opts.step));
  if (!step) fail(`没有这个步骤：${opts.step}`);

  if (status !== 'done') {
    step.status = status;
    if (status === 'in_progress') data.currentStep = step.id;
    if (status === 'superseded' || status === 'skipped') data.currentStep = nextPendingStepId(data.steps);
    writeState(data, loaded);
    console.log(`instruction-state: 步骤 ${step.id} → ${status}（currentStep=${data.currentStep ?? 'null'}）`);
    process.exit(EXIT.OK);
  }

  // ── status === done：按 §4.5「新鲜则复用，否则重跑」 ──
  const map = criteriaById(data);
  const specIds = step.criteria ?? [];
  if (specIds.length === 0) {
    fail(`步骤 ${step.id} 没有关联判据，不能标记 done（没有判据 = 无法证明，拒绝恒绿）`, EXIT.THRESHOLD);
  }
  const head = currentHead();
  const allowCrossHead = Boolean(opts['reuse-evidence']);
  const fresh = [];
  const rerun = [];
  for (const cid of specIds) {
    const prev = latestEvidence(data, cid);
    const reusable =
      prev &&
      prev.exitCode === 0 &&
      ageMs(prev.at) <= REUSE_TTL_MS &&
      (allowCrossHead || prev.head === head);
    if (reusable) fresh.push({ cid, prev });
    else rerun.push(cid);
  }

  const newEntries = [];
  for (const { cid, prev } of fresh) {
    newEntries.push({
      checkId: cid,
      stepId: step.id,
      cmd: prev.cmd,
      exitCode: prev.exitCode,
      digest: prev.digest,
      logPath: prev.logPath,
      at: prev.at, // 复用必须保留原 at，否则事后无法判断是否过期
      by: prev.by ?? 'self',
      head: prev.head ?? null,
      reused: true,
      reusedFrom: prev.at,
      ...(allowCrossHead && prev.head !== head ? { reusedAcrossHead: true } : {}),
    });
  }
  const rerunResults = [];
  for (const cid of rerun) {
    const run = runCriterion(map.get(cid));
    rerunResults.push(run);
    newEntries.push(evidenceEntry(run, step.id, { reused: false }));
  }

  const failed = rerunResults.filter((r) => !r.pass);
  step.evidence = [...(step.evidence ?? []), ...newEntries];
  if (failed.length > 0) {
    writeState(data, loaded);
    for (const run of failed) console.error(`instruction-state: FAIL ${run.checkId} ｜ exit=${run.exitCode} ｜ ${digestOf(run)}`);
    fail(`步骤 ${step.id} 的判据未通过，未标记 done（证据已落盘，供你查看）`, EXIT.THRESHOLD);
  }

  step.status = 'done';
  data.currentStep = nextPendingStepId(data.steps);
  writeState(data, loaded);
  const reusedCount = fresh.length;
  console.log(
    `instruction-state: 步骤 ${step.id} → done（复用 ${reusedCount} 条 / 实跑 ${rerunResults.length} 条；currentStep=${data.currentStep ?? 'null'}）`,
  );
  process.exit(EXIT.OK);
}

// ── update：形态 2（followUp 当场转化） ──────────────────────

function cmdUpdateFollowup(opts) {
  const loaded = requireRecord();
  const data = loaded.data;
  const text = typeof opts.followup === 'string' ? opts.followup.trim() : '';
  if (!text) fail('--followup 需要一句原话（禁止空备注）');
  const kind = String(opts.kind ?? '');
  if (!['criteria', 'step', 'note'].includes(kind)) {
    fail('--kind 必须是 criteria / step / note（docs/12 §3.2：记录不是目的，当场转化才是）');
  }

  data.followUps = data.followUps ?? [];
  const id = `F${data.followUps.length + 1}`;
  const record = { id, text, at: nowIso(), kind, status: 'applied', turnedInto: null };

  if (kind === 'criteria') {
    const check = typeof opts.check === 'string' ? opts.check.trim() : '';
    if (!check) fail('--kind criteria 必须给 --check "<可执行判据命令>"（否则只是一句备注，不是判据）');
    const cid = typeof opts.id === 'string' ? opts.id : `C${(data.doneCriteria ?? []).length + 1}`;
    if (criteriaById(data).has(cid)) fail(`判据 id 已存在：${cid}`);
    data.doneCriteria.push({ id: cid, desc: text, check, expectContains: [], covers: [] });
    const stepTarget =
      opts.step !== undefined
        ? (data.steps ?? []).find((s) => String(s.id) === String(opts.step))
        : (data.steps ?? []).find((s) => s.id === data.currentStep);
    if (!stepTarget) fail('找不到要挂判据的步骤（用 --step <id> 指定）');
    stepTarget.criteria = [...(stepTarget.criteria ?? []), cid];
    record.turnedInto = { kind: 'criteria', id: cid, stepId: stepTarget.id };
  } else if (kind === 'step') {
    const maxId = (data.steps ?? []).reduce((m, s) => Math.max(m, s.id), 0);
    const newStep = {
      id: maxId + 1,
      goal: typeof opts.goal === 'string' ? opts.goal : text,
      targets: typeof opts.targets === 'string' ? opts.targets.split(',').map((t) => t.trim()).filter(Boolean) : [],
      criteria: [],
      status: 'pending',
      evidence: [],
      dedup: null,
    };
    data.steps.push(newStep); // 只追加到末尾，不插队（插队属 --adjust-steps，须报批）
    data.currentStep = data.currentStep ?? newStep.id;
    record.turnedInto = { kind: 'step', id: newStep.id };
  } else {
    const why = typeof opts.why === 'string' ? opts.why.trim() : '';
    if (!why) fail('--kind note 必须给 --why "<为何不需要验证>"（只存备注不转化也必须说清理由）');
    record.turnedInto = { kind: 'note', why };
  }

  data.followUps.push(record);
  writeState(data, loaded);
  console.log(`instruction-state: followUp ${id} 已${kind === 'note' ? '记录（无需验证），理由：' + record.turnedInto.why : '转化'} → ${JSON.stringify(record.turnedInto)}`);
  process.exit(EXIT.OK);
}

// ── update：形态 3（调整 steps，须用户批准） ─────────────────

function cmdUpdateAdjustSteps(opts) {
  const approvedBy = String(opts['approved-by'] ?? '');
  if (approvedBy !== 'user') {
    fail(
      `steps 调整必须 --approved-by user（收到的是 ${approvedBy || '(空)'}）——self 不算已批准（docs/12 §4.4）`,
      EXIT.NOT_APPROVED,
    );
  }
  if (!opts['adjust-steps']) fail('需要 --adjust-steps <steps.json>');
  const loaded = requireRecord();
  const data = loaded.data;
  const payload = readJsonFile(opts['adjust-steps'], 'steps 载荷');
  const nextSteps = validateSteps(payload.steps ?? payload, criteriaById(data));

  // 已 done 的步骤不许重排/删除：既要在，也要保持相对顺序
  const doneBefore = (data.steps ?? []).filter((s) => s.status === 'done').map((s) => s.id);
  const doneAfter = nextSteps.filter((s) => doneBefore.includes(s.id)).map((s) => s.id);
  const missing = doneBefore.filter((id) => !doneAfter.includes(id));
  if (missing.length > 0) {
    fail(`已完成的步骤不许删除：${missing.join(', ')}（要撤销请重开一条指令或标 superseded）`, EXIT.USAGE);
  }
  if (doneAfter.join(',') !== doneBefore.join(',')) {
    fail(`已完成的步骤不许重排（原序 ${doneBefore.join(',')} → 新序 ${doneAfter.join(',')}）`, EXIT.USAGE);
  }

  const before = (data.steps ?? []).map((s) => ({ id: s.id, goal: s.goal, status: s.status }));
  appendHistory({ kind: 'steps-revision', reason: payload.reason ?? '(未说明)', before, approvedBy });

  data.steps = nextSteps.map((s) => {
    const old = (data.steps ?? []).find((o) => o.id === s.id);
    return {
      id: s.id,
      goal: s.goal,
      targets: s.targets ?? old?.targets ?? [],
      criteria: s.criteria ?? old?.criteria ?? [],
      status: old?.status ?? s.status ?? 'pending',
      evidence: old?.evidence ?? [],
      dedup: old?.dedup ?? null,
    };
  });
  data.revisions = data.revisions ?? [];
  data.revisions.push({
    at: nowIso(),
    reason: payload.reason ?? '(未说明)',
    before,
    after: data.steps.map((s) => ({ id: s.id, goal: s.goal })),
    approvedBy,
    approvedAt: nowIso(),
  });
  data.currentStep = nextPendingStepId(data.steps);
  writeState(data, loaded);
  console.log(`instruction-state: steps 已调整（${before.length} → ${data.steps.length} 步，approvedBy=${approvedBy}，currentStep=${data.currentStep ?? 'null'}）`);
  process.exit(EXIT.OK);
}

// ── update：形态 4（终态） ───────────────────────────────────

function cmdUpdateSetStatus(opts) {
  // 注意：终态的取值在 `--set-status <值>` 里，**不是** `--status`（那是单步推进形参）
  const status = String(opts['set-status'] ?? '');
  if (!INSTRUCTION_STATUSES.includes(status) || status === 'in_progress') {
    fail('--set-status 只接受 done / blocked / abandoned（in_progress 由推进步骤隐含）');
  }
  const loaded = requireRecord();
  const data = loaded.data;

  if (status === 'blocked' || status === 'abandoned') {
    const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
    if (!reason) fail(`--set-status ${status} 必须给 --reason（否则下次「继续」时我只能猜）`);
    data.status = status;
    data.blockedReason = status === 'blocked' ? reason : null;
    writeState(data, loaded);
    console.log(`instruction-state: 整条指令 → ${status}（原因：${reason}）`);
    process.exit(EXIT.OK);
  }

  // ── done：**重跑全部判据，不复用**（最后一道门，宁可多跑一次） ──
  const criteria = data.doneCriteria ?? [];
  if (criteria.length === 0) fail('没有 doneCriteria，不能标记 done（恒绿防护）', EXIT.THRESHOLD);
  const runs = criteria.map((c) => runCriterion(c));
  data.evidence = data.evidence ?? [];
  for (const run of runs) data.evidence.push(evidenceEntry(run, null));
  const failed = runs.filter((r) => !r.pass);
  if (failed.length > 0) {
    writeState(data, loaded);
    for (const run of failed) console.error(`instruction-state: FAIL ${run.checkId} ｜ exit=${run.exitCode} ｜ ${digestOf(run)}`);
    fail(`有 ${failed.length} 条判据未通过，拒绝标记 done（证据已落盘）`, EXIT.THRESHOLD);
  }
  data.status = 'done';
  // 档位留痕：事后翻 doneProof 就能看出这次 done 到底覆盖到哪一档（不用猜、不用重读判据）
  const committedIds = (data.doneCriteria ?? []).filter((c) => (c.mustBeTracked ?? []).length > 0).map((c) => c.id);
  data.doneProof = {
    at: nowIso(),
    head: currentHead(),
    tiers: {
      written: 'covered',
      committed: committedIds.length > 0 ? `covered-by:${committedIds.join(',')}` : 'not-covered',
      pushed: 'unjudged',
    },
    criteria: runs.map((r) => ({ checkId: r.checkId, exitCode: r.exitCode, digest: digestOf(r) })),
  };
  writeState(data, loaded);
  console.log(`instruction-state: 整条指令 → done（${runs.length} 条判据全部 exit 0，head=${data.doneProof.head ?? '(未知)'}）`);
  // 终态更要防误读：done 只覆盖到 ①②，**不等于已推送**
  console.log(TIER_LINE);
  process.exit(EXIT.OK);
}

// ── 入口 ──────────────────────────────────────────────────────

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (!sub || opts.help) {
    console.error(
      [
        '用法: node scripts/instruction-state.mjs <write|check|dedup|update> [...]',
        '',
        '  write  --file <payload.json> [--on-conflict abandon|keep] [--skip-baseline] [--by <id>] [--allow-untracked-targets]',
        '  check  [--step <id>]',
        '  dedup  [--step <id>] [--targets a,b] [--baseline <ref>] [--force] [--ttl <分钟>] [--no-save]   （exit 10=已完成 / 11=记录与实际不符）',
        '  update --step <id> --status <status> [--reuse-evidence]',
        '  update --followup "<原话>" --kind criteria --check "<命令>" [--id C9] [--step <id>]',
        '  update --followup "<原话>" --kind step [--targets a,b] [--goal "<目标>"]',
        '  update --followup "<原话>" --kind note --why "<为何无需验证>"',
        '  update --adjust-steps <steps.json> --approved-by user',
        '  update --set-status done|blocked|abandoned [--reason "<原因>"]',
      ].join('\n'),
    );
    process.exit(EXIT.USAGE);
  }

  if (sub === 'write') return cmdWrite(opts);
  if (sub === 'check') return cmdCheck(opts);
  if (sub === 'dedup') return cmdDedup(opts);
  if (sub !== 'update') fail(`未知子命令：${sub}`);

  const forms = [
    ['step', opts.step !== undefined && opts.status !== undefined],
    ['followup', opts.followup !== undefined],
    ['adjust-steps', opts['adjust-steps'] !== undefined],
    ['set-status', opts['set-status'] !== undefined],
  ].filter(([, on]) => on);
  if (forms.length !== 1) {
    fail(`update 必须且只能用一种形态（收到 ${forms.length} 个：${forms.map(([n]) => n).join(', ') || '无'}）`);
  }
  const which = forms[0][0];
  if (which === 'step') return cmdUpdateStep(opts);
  if (which === 'followup') return cmdUpdateFollowup(opts);
  if (which === 'adjust-steps') return cmdUpdateAdjustSteps(opts);
  return cmdUpdateSetStatus(opts);
}

main();
