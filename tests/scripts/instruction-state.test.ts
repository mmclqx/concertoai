/**
 * `scripts/instruction-state.mjs` 的验收测试（ADR-051 / docs/12）。
 *
 * ## 这组用例存在的唯一理由
 *
 * 该脚本是「我自证」的升级版：**如果它自己没牙，我只是把「我说通过」换成了「我写的脚本说通过」**。
 * 所以每条断言都对着一个**可能悄悄为真**的废实现来写：
 *
 * | 废实现 | 会被哪条用例抓住 |
 * |---|---|
 * | `check` 恒返 0（恒绿） | 「有 fail 必须 exit 20」「超时必须 exit 20」 |
 * | `check` 恒返 20（恒空） | 「全 pass 必须 exit 0」 |
 * | 只看 `exitCode === 0`、不看 `expectContains` | 「exit 0 但输出缺标记必须 exit 20」 |
 * | `--step done` 无 evidence 也放行 | 「判据 fail 时必须拒绝」 |
 * | 复用不看新鲜度/HEAD | 「TTL 过期必须重跑」「head 变了必须重跑」 |
 * | `--approved-by self` 也认 | 「self 必须 exit 22 且原文件未改」 |
 * | 终态复用历史 evidence | 「`--set-status done` 必须全部 `reused: false`」 |
 * | 覆盖别人的进度 | 「运行中文件被外部改动 ⇒ exit 23」 |
 *
 * 所有用例都用 `CONCERTOAI_INSTRUCTION_DIR` 指向临时目录：**绝不许碰开发者真实的 `.git/` 状态**
 * （与 `tests/setup.ts` 关掉复盘/提示同一个理由）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(process.cwd(), 'scripts/instruction-state.mjs');
const REPO_ROOT = process.cwd();

let stateDir = '';
let counter = '';

type RunResult = { code: number | null; out: string };

function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): RunResult {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, CONCERTOAI_INSTRUCTION_DIR: stateDir, ...(opts.env ?? {}) },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const statePath = () => path.join(stateDir, 'concertoai-current-instruction.json');
const historyPath = () => path.join(stateDir, 'concertoai-instruction-history.jsonl');
const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const readHistory = () =>
  fs.existsSync(historyPath())
    ? fs
        .readFileSync(historyPath(), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

/** 计数型判据：每跑一次往计数器追一个 x —— 用来区分「重跑」与「复用」。 */
function countingCriterion(id: string, exitCode = 0) {
  const target = counter.split(path.sep).join('/');
  return {
    id,
    desc: `计数判据 ${id}`,
    check: `node -e "require('fs').appendFileSync('${target}','x');process.exit(${exitCode})"`,
    expectContains: [],
    covers: [],
  };
}

function countRuns() {
  return fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0;
}

function writePayload(payload: Record<string, unknown>, name = 'payload.json') {
  const file = path.join(stateDir, name);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    instruction: '六件裁决 + 脚本现在写',
    doneCriteria: [countingCriterion('C1')],
    steps: [{ id: 1, goal: '第一步', targets: ['docs/12'], criteria: ['C1'], status: 'pending' }],
    ...overrides,
  };
}

function writeBase(overrides: Record<string, unknown> = {}) {
  const file = writePayload(basePayload(overrides));
  return runCli(['write', '--file', file]);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-state-'));
  counter = path.join(stateDir, 'counter.txt');
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ── write ─────────────────────────────────────────────────────

describe('write：写入新指令', () => {
  it('首次运行（目录/文件都不存在）⇒ 自动建目录、写入成功、currentStep 指向首个 pending 步', () => {
    const r = writeBase();
    expect(r.code).toBe(0);
    const state = readState();
    expect(state.status).toBe('in_progress');
    expect(state.currentStep).toBe(1);
    expect(state.instruction).toBe('六件裁决 + 脚本现在写');
    expect(state.steps[0].status).toBe('pending');
    expect(state.schemaVersion).toBe(1);
  });

  it('写盘时实测基线：判据真的 pass 记 GREEN、真的 fail 记 RED（证明 baseline 不是恒绿空转）', () => {
    // 一条必过、一条必失败 —— 若实现把 baseline 写死成 GREEN，第二条会红
    const failing = countingCriterion('C2', 1);
    const r = writeBase({ doneCriteria: [countingCriterion('C1'), failing] });
    expect(r.code).toBe(0);
    const baseline = readState().baselineCriteriaState;
    expect(baseline.C1).toBe('GREEN');
    expect(baseline.C2).toBe('RED');
  });

  it('--skip-baseline ⇒ 如实记 skipped（不假装测过）', () => {
    const file = writePayload(basePayload());
    const r = runCli(['write', '--file', file, '--skip-baseline']);
    expect(r.code).toBe(0);
    expect(readState().baselineCriteriaState.skipped).toBe(true);
  });

  it('缺 instruction ⇒ exit 2（原话是唯一锚点，不能有默认值）', () => {
    const file = writePayload({
      doneCriteria: [countingCriterion('C1')],
      steps: [{ id: 1, goal: 'g', criteria: ['C1'] }],
    });
    expect(runCli(['write', '--file', file]).code).toBe(2);
  });

  it('doneCriteria 为空 ⇒ exit 2（没有判据就无法机械判定 done，拒绝恒绿空转）', () => {
    const file = writePayload(basePayload({ doneCriteria: [] }));
    const r = runCli(['write', '--file', file]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('非空数组');
  });

  it('steps 引用不存在的判据 ⇒ exit 2（拼错判据 id 不许静默当成「无判据」）', () => {
    const file = writePayload(basePayload({ steps: [{ id: 1, goal: 'g', criteria: ['C404'] }] }));
    expect(runCli(['write', '--file', file]).code).toBe(2);
  });

  it('旧 in_progress 未结 ⇒ exit 1，打印三选一，且**文件一字未改**', () => {
    expect(writeBase().code).toBe(0);
    const before = fs.readFileSync(statePath(), 'utf8');
    const file = writePayload({ ...basePayload(), instruction: '另一件事' }, 'payload2.json');
    const r = runCli(['write', '--file', file]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('上一条指令还没到 done');
    expect(r.out).toContain('① 继续它');
    expect(fs.readFileSync(statePath(), 'utf8')).toBe(before);
  });

  it('--on-conflict abandon ⇒ 旧记录归档进 history.jsonl 后才覆盖（不静默丢弃）', () => {
    expect(writeBase().code).toBe(0);
    const file = writePayload({ ...basePayload(), instruction: '另一件事' }, 'payload2.json');
    const r = runCli(['write', '--file', file, '--on-conflict', 'abandon']);
    expect(r.code).toBe(0);
    expect(readState().instruction).toBe('另一件事');
    const archived = readHistory().filter((h) => h.kind === 'instruction-archived');
    expect(archived).toHaveLength(1);
    expect(archived[0].instruction).toBe('六件裁决 + 脚本现在写');
  });

  it('状态文件被 git 跟踪 ⇒ 拒绝写入 exit 2（ADR-051 红线①代码化）', () => {
    // 真造一个 git 仓库并把状态文件 add 进去，再让脚本往里写
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-state-tracked-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      fs.writeFileSync(
        path.join(repo, 'concertoai-current-instruction.json'),
        '{"old":true}\n',
        'utf8',
      );
      spawnSync('git', ['add', 'concertoai-current-instruction.json'], { cwd: repo });
      const payloadFile = path.join(repo, 'payload.json');
      fs.writeFileSync(payloadFile, JSON.stringify(basePayload()), 'utf8');

      const r = spawnSync(process.execPath, [SCRIPT, 'write', '--file', payloadFile], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, CONCERTOAI_INSTRUCTION_DIR: repo },
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status).toBe(2);
      expect(out).toContain('不得被 git 跟踪');
      // 原文件必须没被改写
      expect(fs.readFileSync(path.join(repo, 'concertoai-current-instruction.json'), 'utf8')).toBe(
        '{"old":true}\n',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── write：判据须覆盖「已入库」（2026-11-08 事故对策） ─────────

describe('write：未入库的 target 必须有 mustBeTracked 覆盖（否则拒绝写入）', () => {
  /**
   * 这组用例只做一件事：把「判据说 done、产物没入库」这条坑**堵在写入入口**。
   * 事故原文：`status=done` + `C1/C2/C3 全绿`，而 `scripts/` `tests/` 一直是 `??`。
   *
   * 配变异探针验证有牙：把 `findUntrackedTargetsWithoutGuard` 改成 `return []`
   * ⇒ 「必须拒绝」两条红；把 `looksLikeFile` 改成 `return false`（过滤放宽到失明）
   * ⇒ 「违规仍必须红」那条红（正例 fixture 绿不能证明它有牙）。
   */
  const UNTRACKED = 'scripts/.never-committed-probe.mjs';
  const TRACKED = 'package.json';

  function payloadWithTarget(target: string, criterionOverrides: Record<string, unknown> = {}) {
    return {
      instruction: '测试：判据是否覆盖已入库',
      doneCriteria: [{ ...countingCriterion('C1'), ...criterionOverrides }],
      steps: [{ id: 1, goal: '改一个还没入库的文件', targets: [target], criteria: ['C1'] }],
    };
  }

  it('target 未入库且判据没声明 mustBeTracked ⇒ **拒绝写入 exit 2**，并给出改法', () => {
    const r = runCli(['write', '--file', writePayload(payloadWithTarget(UNTRACKED))]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('判据漏了「已入库」这一步');
    expect(r.out).toContain('mustBeTracked');
    expect(r.out).toContain(UNTRACKED);
    // 拒绝时必须一点都没写
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('判据声明 mustBeTracked 覆盖该 target ⇒ 放行（正例：护栏没有把合法载荷也拦下）', () => {
    const payload = payloadWithTarget(UNTRACKED, { mustBeTracked: [UNTRACKED] });
    const r = runCli(['write', '--file', writePayload(payload), '--skip-baseline']);
    expect(r.code).toBe(0);
    expect(readState().doneCriteria[0].mustBeTracked).toEqual([UNTRACKED]);
  });

  it('target **已入库**（无需 mustBeTracked）⇒ 放行（不该红必不红）', () => {
    const r = runCli([
      'write',
      '--file',
      writePayload(payloadWithTarget(TRACKED)),
      '--skip-baseline',
    ]);
    expect(r.code).toBe(0);
  });

  it('目录类 target（`docs/`）不触发该检查（边界写清：目录是否入库由其中文件决定）', () => {
    const r = runCli([
      'write',
      '--file',
      writePayload(payloadWithTarget('docs/')),
      '--skip-baseline',
    ]);
    expect(r.code).toBe(0);
  });

  it('确不需要入库时显式放行 ⇒ exit 0 且**留痕**（放行本身也要能事后查出来）', () => {
    const file = writePayload(payloadWithTarget(UNTRACKED));
    const r = runCli(['write', '--file', file, '--skip-baseline', '--allow-untracked-targets']);
    expect(r.code).toBe(0);
    expect(readState().untrackedTargetsAck).toBe(true);
  });

  it('载荷里写 allowUntrackedTargets:true 与命令行等价（两条入口都留痕）', () => {
    const payload = { ...payloadWithTarget(UNTRACKED), allowUntrackedTargets: true };
    const r = runCli(['write', '--file', writePayload(payload), '--skip-baseline']);
    expect(r.code).toBe(0);
    expect(readState().untrackedTargetsAck).toBe(true);
  });

  it('mustBeTracked 类型非法（不是字符串数组）⇒ exit 2', () => {
    const payload = payloadWithTarget(UNTRACKED, { mustBeTracked: 'scripts/x.mjs' });
    const r = runCli(['write', '--file', writePayload(payload)]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('mustBeTracked 必须是非空字符串数组');
  });
});

// ── check ─────────────────────────────────────────────────────

describe('check：判据执行（只认 exitCode === 0 + expectContains 命中）', () => {
  it('全部通过 ⇒ exit 0，且末尾固定打印「不等于查重」（防止把判据全绿误读成已查重）', () => {
    expect(writeBase().code).toBe(0);
    const r = runCli(['check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS C1');
    expect(r.out).toContain('不等于查重');
    // 「check 全绿」同样必须带档位说明（与终态同一口径，防止只在收尾时提醒）
    expect(r.out).toContain('①已写入');
    expect(r.out).toContain('③已推送');
    expect(r.out).toContain('未判');
  });

  it('判据 exit 1 ⇒ exit 20（恒绿废实现会红在这条）', () => {
    expect(writeBase({ doneCriteria: [countingCriterion('C1', 1)] }).code).toBe(0);
    const r = runCli(['check']);
    expect(r.code).toBe(20);
    expect(r.out).toContain('FAIL C1');
  });

  it('**exit 0 但输出缺 expectContains 标记 ⇒ exit 20**（只看退出码的实现会红在这条）', () => {
    const noMarker = {
      id: 'C1',
      desc: '必须打印 MARKER-OK',
      check: `node -e "process.exit(0)"`,
      expectContains: ['MARKER-OK'],
      covers: [],
    };
    expect(writeBase({ doneCriteria: [noMarker] }).code).toBe(0);
    const r = runCli(['check']);
    expect(r.code).toBe(20);
    expect(r.out).toContain('FAIL C1');

    // 正例对照：同一个判据，只要真打印标记就必须变成 PASS（否则上面的 FAIL 可能是别的原因）
    const withMarker = { ...noMarker, check: `node -e "console.log('MARKER-OK')"` };
    const file = writePayload(
      { ...basePayload(), doneCriteria: [withMarker] },
      'payload-marker.json',
    );
    expect(runCli(['write', '--file', file, '--on-conflict', 'abandon']).code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
  });

  it('超时 ⇒ 记 fail（exit 20），digest 明说「超时」，exitCode 记 124（恒绿废实现会红在这条）', () => {
    const slow = {
      id: 'C1',
      desc: '故意睡 4 秒，超时设 300ms',
      check: `node -e "setTimeout(()=>{},4000)"`,
      expectContains: [],
      timeoutMs: 300,
      covers: [],
    };
    expect(writeBase({ doneCriteria: [slow] }).code).toBe(0);
    const r = runCli(['check']);
    expect(r.code).toBe(20);
    const evidence = readState().evidence.at(-1);
    expect(evidence.exitCode).toBe(124);
    expect(evidence.digest).toContain('超时');
  });

  it('阶梯自证：exit 0 / exit 1 / 超时 三种判据分别得 0 / 20 / 20（「恒绿」与「恒空」两种废实现都过不去）', () => {
    /**
     * 配变异探针验证有牙：把 `pass = !timedOut && exitCode === 0 && missing.length === 0`
     * 改成 `pass = true` ⇒ 本用例红；改成 `pass = false` ⇒ 第一条断言红。
     * 单测若只断言「有 fail 时 exit 20」，一个「恒 20」的实现照样能骗过。
     */
    const cases = [
      [`node -e "process.exit(0)"`, 0],
      [`node -e "process.exit(1)"`, 20],
      [`node -e "setTimeout(()=>{},4000)"`, 20],
    ] as const;
    for (const [check, expected] of cases) {
      fs.rmSync(statePath(), { force: true });
      const criterion = {
        id: 'C1',
        desc: check,
        check,
        expectContains: [],
        timeoutMs: 300,
        covers: [],
      };
      const file = writePayload(
        { ...basePayload(), doneCriteria: [criterion] },
        `p-${expected}-${Math.random()}.json`,
      );
      expect(runCli(['write', '--file', file, '--skip-baseline']).code).toBe(0);
      expect(runCli(['check']).code).toBe(expected);
    }
  });

  it('无记录 ⇒ exit 3 且明说「无记录」（不许把「没判据」当成「全部通过」）', () => {
    const r = runCli(['check']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('无记录');
  });

  it('JSON 损坏 ⇒ exit 3 + 生成 .corrupt-* 备份 + 原文件一字未改', () => {
    fs.writeFileSync(statePath(), '{ this is not json', 'utf8');
    const r = runCli(['check']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('记录损坏');
    const backups = fs.readdirSync(stateDir).filter((f) => f.includes('.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(statePath(), 'utf8')).toBe('{ this is not json');
  });

  it('证据落盘：JSON 只存 ≤300 字摘要 + logPath，全文进日志文件（超长输出不胀大 JSON）', () => {
    const noisy = {
      id: 'C1',
      desc: '输出 5000 字符',
      check: `node -e "console.log('y'.repeat(5000))"`,
      expectContains: [],
      covers: [],
    };
    expect(writeBase({ doneCriteria: [noisy] }).code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    const evidence = readState().evidence.at(-1);
    expect(evidence.digest.length).toBeLessThanOrEqual(300);
    expect(evidence.logPath).toBeTruthy();
    const logAbs = path.isAbsolute(evidence.logPath)
      ? evidence.logPath
      : path.join(REPO_ROOT, evidence.logPath);
    expect(fs.existsSync(logAbs)).toBe(true);
    expect(fs.readFileSync(logAbs, 'utf8').length).toBeGreaterThan(5000);
  });

  it('mustBeTracked 未入库 ⇒ 即使 check 命令 exit 0 也判 **FAIL（exit 20）**，digest 明说「未入库」', () => {
    const criterion = {
      ...countingCriterion('C1'), // exit 0
      mustBeTracked: ['scripts/.never-committed-probe.mjs'],
    };
    const payload = {
      instruction: '测试：已入库断言',
      doneCriteria: [criterion],
      steps: [{ id: 1, goal: 'g', targets: [], criteria: ['C1'] }],
    };
    expect(runCli(['write', '--file', writePayload(payload), '--skip-baseline']).code).toBe(0);
    const r = runCli(['check']);
    expect(r.code).toBe(20);
    expect(r.out).toContain('FAIL C1');
    const evidence = readState().evidence.at(-1);
    expect(evidence.exitCode).toBe(0); // 命令本身是 0 —— 失败只能来自入库断言
    expect(evidence.digest).toContain('未入库');
  });

  it('mustBeTracked 已入库 ⇒ PASS（正例：证明上一条的 FAIL 只因为「未入库」）', () => {
    const criterion = { ...countingCriterion('C1'), mustBeTracked: ['package.json'] };
    const payload = {
      instruction: '测试：已入库断言正例',
      doneCriteria: [criterion],
      steps: [{ id: 1, goal: 'g', targets: [], criteria: ['C1'] }],
    };
    expect(runCli(['write', '--file', writePayload(payload), '--skip-baseline']).code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
  });

  it('digest 去掉 ANSI 颜色码（真机上 C3 的摘要曾是一条 `\u001b[36m RUN`，人读不了）', () => {
    const colored = {
      id: 'C1',
      desc: '带颜色的输出',
      // 真跑 vitest 时输出就是这样：摘要若不剥色，JSON 里存的是转义字节而不是人话
      check: `node -e "console.log('\\u001b[36mMARKER\\u001b[39m')"`,
      expectContains: [],
      covers: [],
    };
    expect(writeBase({ doneCriteria: [colored] }).code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    const evidence = readState().evidence.at(-1);
    expect(evidence.digest).toContain('MARKER');
    expect(evidence.digest).not.toContain('\u001b[');
  });

  it('check --step：只跑该步关联的判据（别的步的判据不进本次证据）', () => {
    const c1 = countingCriterion('C1');
    const c2 = countingCriterion('C2', 1);
    const file = writePayload({
      ...basePayload(),
      doneCriteria: [c1, c2],
      steps: [
        { id: 1, goal: '第一步', criteria: ['C1'] },
        { id: 2, goal: '第二步', criteria: ['C2'] },
      ],
    });
    expect(runCli(['write', '--file', file]).code).toBe(0);
    const r = runCli(['check', '--step', '1']);
    expect(r.code).toBe(0);
    const evidence = readState().evidence;
    expect(evidence.map((e: { checkId: string }) => e.checkId)).toEqual(['C1']);
  });

  it('check --step 到没有判据的步 ⇒ exit 2（「无事可做」不等于「通过」）', () => {
    const file = writePayload({
      ...basePayload(),
      steps: [
        { id: 1, goal: '第一步', criteria: ['C1'] },
        { id: 2, goal: '没有判据的步', criteria: [] },
      ],
    });
    expect(runCli(['write', '--file', file]).code).toBe(0);
    expect(runCli(['check', '--step', '2']).code).toBe(2);
  });
});

// ── update：推进步骤 ──────────────────────────────────────────

describe('update --step：推进与「单步 done」的复用语义（docs/12 §4.5）', () => {
  it('--status in_progress ⇒ currentStep 指向该步', () => {
    const file = writePayload({
      ...basePayload(),
      steps: [
        { id: 1, goal: '一', criteria: ['C1'] },
        { id: 2, goal: '二', criteria: ['C1'] },
      ],
    });
    expect(runCli(['write', '--file', file]).code).toBe(0);
    expect(runCli(['update', '--step', '2', '--status', 'in_progress']).code).toBe(0);
    expect(readState().currentStep).toBe(2);
  });

  it('--status done 且无 evidence ⇒ 现跑判据，通过则 done + evidence 记 reused:false', () => {
    expect(writeBase().code).toBe(0);
    const r = runCli(['update', '--step', '1', '--status', 'done']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('复用 0 条');
    const step = readState().steps[0];
    expect(step.status).toBe('done');
    expect(step.evidence.length).toBe(1);
    expect(step.evidence[0].reused).toBe(false);
    expect(readState().currentStep).toBeNull();
  });

  it('**判据 fail ⇒ 拒绝标记 done（exit 21），步骤状态不变**（无 evidence 也不能想当然放行）', () => {
    expect(writeBase({ doneCriteria: [countingCriterion('C1', 1)] }).code).toBe(0);
    const r = runCli(['update', '--step', '1', '--status', 'done']);
    expect(r.code).toBe(21);
    expect(readState().steps[0].status).toBe('pending');
  });

  it('没有关联判据的步骤不许标 done（exit 21：无法证明 ≠ 已证明）', () => {
    const file = writePayload({
      ...basePayload(),
      steps: [{ id: 1, goal: '无边界的步', criteria: [] }],
    });
    expect(runCli(['write', '--file', file]).code).toBe(0);
    expect(runCli(['update', '--step', '1', '--status', 'done']).code).toBe(21);
  });

  it('复用：刚 check 过的 evidence（≤10 分钟）⇒ 不重跑（计数器不变），记 reused:true + reusedFrom', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    const afterCheck = countRuns();
    // 1 次来自 write 的基线实测（没给 --skip-baseline），1 次来自 check —— 数清是为了让下一条断言有牙
    expect(afterCheck).toBe(2);
    const r = runCli(['update', '--step', '1', '--status', 'done']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('复用 1 条');
    expect(countRuns()).toBe(afterCheck); // 没有重跑
    const entry = readState().steps[0].evidence.at(-1);
    expect(entry.reused).toBe(true);
    expect(typeof entry.reusedFrom).toBe('string');
  });

  it('TTL 过期（evidence 是 30 分钟前）⇒ 强制重跑（计数器 +1）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    const before = countRuns();
    const state = readState();
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    for (const e of state.evidence) e.at = old;
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');

    expect(runCli(['update', '--step', '1', '--status', 'done']).code).toBe(0);
    expect(countRuns()).toBe(before + 1);
  });

  it('HEAD 变了（evidence.head 与当前不一致）⇒ 强制重跑（10 分钟只防旧，防不了「刚改完又复用」）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    const before = countRuns();
    const state = readState();
    for (const e of [...state.evidence, ...state.steps[0].evidence]) e.head = 'deadbee';
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');

    expect(runCli(['update', '--step', '1', '--status', 'done']).code).toBe(0);
    expect(countRuns()).toBe(before + 1);
  });

  it('--reuse-evidence ⇒ 允许跨 HEAD 复用，并留痕 reusedAcrossHead:true（不静默放宽）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    const before = countRuns();
    const state = readState();
    for (const e of state.evidence) e.head = 'deadbee';
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');

    expect(runCli(['update', '--step', '1', '--status', 'done', '--reuse-evidence']).code).toBe(0);
    expect(countRuns()).toBe(before);
    const entry = readState().steps[0].evidence.at(-1);
    expect(entry.reused).toBe(true);
    expect(entry.reusedAcrossHead).toBe(true);
  });

  it('--status 非法 ⇒ exit 2；步骤不存在 ⇒ exit 2', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['update', '--step', '1', '--status', 'finished']).code).toBe(2);
    expect(runCli(['update', '--step', '99', '--status', 'done']).code).toBe(2);
  });
});

// ── update：终态 ──────────────────────────────────────────────

describe('update --set-status：终态门槛', () => {
  it('**有判据 fail ⇒ 拒绝 done（exit 21），status 仍 in_progress、doneProof 仍 null**', () => {
    expect(writeBase({ doneCriteria: [countingCriterion('C1', 1)] }).code).toBe(0);
    const r = runCli(['update', '--set-status', 'done']);
    expect(r.code).toBe(21);
    const state = readState();
    expect(state.status).toBe('in_progress');
    expect(state.doneProof).toBeNull();
  });

  it('全部通过 ⇒ done，且**全部 reused:false**（终态不豁免：宁可多跑一次）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['check']).code).toBe(0); // 先制造「新鲜且通过」的历史证据
    const r = runCli(['update', '--set-status', 'done']);
    expect(r.code).toBe(0);
    const state = readState();
    expect(state.status).toBe('done');
    expect(state.doneProof.criteria.length).toBe(1);
    expect(state.doneProof.head).toBeTruthy();
    const lastEvidence = state.evidence.at(-1);
    expect(lastEvidence.reused).toBe(false);
  });

  it('**档位说明必须打印**（护栏的护栏）：done 只覆盖 ①②，③已推送 明说「未判」', () => {
    /**
     * 这行是防止「判据全绿 = 已推送」误读的唯一机制（2026-11-08 用户裁决的三档口径）。
     * 没有它，看的人只会看到一堆 PASS，然后以为远端也有了。
     * 本地 `origin/main` 是缓存引用，可能过时——所以本机制**刻意不判** ③，只明示边界。
     */
    expect(writeBase().code).toBe(0);
    const r = runCli(['update', '--set-status', 'done']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('①已写入');
    expect(r.out).toContain('③已推送');
    expect(r.out).toContain('未判');
    expect(r.out).toContain('git log origin/main..HEAD'); // 要判就自己跑的那条命令
  });

  it('doneProof.tiers 留痕：committed 由 mustBeTracked 决定，pushed 恒为 unjudged', () => {
    const withTrack = { ...countingCriterion('C1'), mustBeTracked: ['package.json'] };
    const payload = {
      instruction: '测试：tiers 留痕',
      doneCriteria: [withTrack],
      steps: [{ id: 1, goal: 'g', targets: [], criteria: ['C1'] }],
    };
    expect(runCli(['write', '--file', writePayload(payload), '--skip-baseline']).code).toBe(0);
    expect(runCli(['update', '--set-status', 'done']).code).toBe(0);
    const tiers = readState().doneProof.tiers;
    expect(tiers.written).toBe('covered');
    expect(tiers.committed).toBe('covered-by:C1');
    expect(tiers.pushed).toBe('unjudged'); // 刻意不判，不是「已推送」
  });

  it('没有 mustBeTracked 的判据 ⇒ committed 记 not-covered（不许默认当已提交）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['update', '--set-status', 'done']).code).toBe(0);
    const tiers = readState().doneProof.tiers;
    expect(tiers.committed).toBe('not-covered');
    expect(tiers.pushed).toBe('unjudged');
  });

  it('blocked 缺 --reason ⇒ exit 2（否则下次「继续」只能猜）；给了 reason ⇒ 记 blockedReason', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['update', '--set-status', 'blocked']).code).toBe(2);
    expect(runCli(['update', '--set-status', 'blocked', '--reason', '等你裁决口径']).code).toBe(0);
    expect(readState().blockedReason).toBe('等你裁决口径');
  });

  it('**终态也因此堵死「done 但没入库」**：mustBeTracked 未入库 ⇒ 拒绝 done（exit 21）', () => {
    /**
     * 这条是 2026-11-08 事故的正面收口：当时 `--set-status done` 只重跑 `check` 命令，
     * 而判据没断言入库，于是 done 与 `??` 同时成立。现在终态会连 mustBeTracked 一起重跑。
     */
    const criterion = {
      ...countingCriterion('C1'),
      mustBeTracked: ['scripts/.never-committed-probe.mjs'],
    };
    const payload = {
      instruction: '测试：终态也要求已入库',
      doneCriteria: [criterion],
      steps: [{ id: 1, goal: 'g', targets: [], criteria: ['C1'] }],
    };
    expect(runCli(['write', '--file', writePayload(payload), '--skip-baseline']).code).toBe(0);
    const r = runCli(['update', '--set-status', 'done']);
    expect(r.code).toBe(21);
    const state = readState();
    expect(state.status).toBe('in_progress');
    expect(state.doneProof).toBeNull();
  });

  it('--set-status in_progress ⇒ exit 2（推进由 --step 隐含，不提供两个入口）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['update', '--set-status', 'in_progress']).code).toBe(2);
  });
});

// ── update：followUp 转化 ────────────────────────────────────

describe('update --followup：记录不是目的，当场转化才是（docs/12 §3.2）', () => {
  it('--kind criteria 缺 --check ⇒ exit 2（否则只是一句备注，不是判据）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['update', '--followup', '别忘了先跑 verify', '--kind', 'criteria']).code).toBe(
      2,
    );
  });

  it('--kind criteria ⇒ doneCriteria 新增 + 挂到 currentStep 的步 + followUps 记 turnedInto', () => {
    expect(writeBase().code).toBe(0);
    const r = runCli([
      'update',
      '--followup',
      '别忘了先跑 verify',
      '--kind',
      'criteria',
      '--check',
      `node -e "process.exit(0)"`,
      '--id',
      'C2',
    ]);
    expect(r.code).toBe(0);
    const state = readState();
    expect(state.doneCriteria.map((c: { id: string }) => c.id)).toContain('C2');
    expect(state.steps[0].criteria).toContain('C2');
    expect(state.followUps[0].turnedInto).toEqual({ kind: 'criteria', id: 'C2', stepId: 1 });
  });

  it('--kind step ⇒ 只追加到末尾（不插队，插队属须报批的 --adjust-steps）', () => {
    const file = writePayload({
      ...basePayload(),
      steps: [
        { id: 1, goal: '一', criteria: ['C1'] },
        { id: 2, goal: '二', criteria: ['C1'] },
      ],
    });
    expect(runCli(['write', '--file', file]).code).toBe(0);
    expect(
      runCli([
        'update',
        '--followup',
        '顺便把 X 也改了',
        '--kind',
        'step',
        '--targets',
        'src/a.ts,src/b.ts',
      ]).code,
    ).toBe(0);
    const steps = readState().steps;
    expect(steps).toHaveLength(3);
    expect(steps[2].id).toBe(3);
    expect(steps[2].targets).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('--kind note 缺 --why ⇒ exit 2；给了 why ⇒ 只记录不改造判据，且 instruction 一字未改', () => {
    expect(writeBase().code).toBe(0);
    const before = readState().instruction;
    expect(runCli(['update', '--followup', '这个不急', '--kind', 'note']).code).toBe(2);
    expect(
      runCli([
        'update',
        '--followup',
        '这个不急',
        '--kind',
        'note',
        '--why',
        '纯说明，无可验证内容',
      ]).code,
    ).toBe(0);
    const state = readState();
    expect(state.followUps[0].turnedInto).toEqual({ kind: 'note', why: '纯说明，无可验证内容' });
    expect(state.doneCriteria).toHaveLength(1);
    expect(state.instruction).toBe(before);
  });
});

// ── update：调整 steps ───────────────────────────────────────

describe('update --adjust-steps：自己不许改顺序（docs/12 §4.4）', () => {
  function twoStepPayload() {
    return writePayload({
      ...basePayload(),
      steps: [
        { id: 1, goal: '一', criteria: ['C1'] },
        { id: 2, goal: '二', criteria: ['C1'] },
        { id: 3, goal: '三', criteria: ['C1'] },
      ],
    });
  }

  it('**--approved-by self ⇒ exit 22，且 steps 与文件都一字未改**', () => {
    expect(runCli(['write', '--file', twoStepPayload()]).code).toBe(0);
    const before = fs.readFileSync(statePath(), 'utf8');
    const stepsFile = writePayload(
      {
        reason: '想插队',
        steps: [
          { id: 3, goal: '三', criteria: ['C1'] },
          { id: 1, goal: '一', criteria: ['C1'] },
          { id: 2, goal: '二', criteria: ['C1'] },
        ],
      },
      'steps.json',
    );
    const r = runCli(['update', '--adjust-steps', stepsFile, '--approved-by', 'self']);
    expect(r.code).toBe(22);
    expect(r.out).toContain('self 不算已批准');
    expect(fs.readFileSync(statePath(), 'utf8')).toBe(before);
  });

  it('不给 --approved-by ⇒ exit 22（缺省不是「默认批准」）', () => {
    expect(runCli(['write', '--file', twoStepPayload()]).code).toBe(0);
    const stepsFile = writePayload(
      { steps: [{ id: 1, goal: '一', criteria: ['C1'] }] },
      'steps.json',
    );
    expect(runCli(['update', '--adjust-steps', stepsFile]).code).toBe(22);
  });

  it('--approved-by user ⇒ 写入成功 + revisions 留痕 + 旧 steps 归档进 history', () => {
    expect(runCli(['write', '--file', twoStepPayload()]).code).toBe(0);
    const stepsFile = writePayload(
      {
        reason: '第 3 步的判据依赖第 2 步产物，原顺序会假红',
        steps: [
          { id: 3, goal: '三', criteria: ['C1'] },
          { id: 1, goal: '一', criteria: ['C1'] },
          { id: 2, goal: '二', criteria: ['C1'] },
        ],
      },
      'steps.json',
    );
    const r = runCli(['update', '--adjust-steps', stepsFile, '--approved-by', 'user']);
    expect(r.code).toBe(0);
    const state = readState();
    expect(state.steps.map((s: { id: number }) => s.id)).toEqual([3, 1, 2]);
    expect(state.revisions[0].approvedBy).toBe('user');
    expect(state.revisions[0].before.length).toBe(3);
    expect(readHistory().filter((h) => h.kind === 'steps-revision')).toHaveLength(1);
  });

  it('删除已 done 的步骤 ⇒ exit 2（它的 evidence 指向具体产物状态）', () => {
    expect(runCli(['write', '--file', twoStepPayload()]).code).toBe(0);
    expect(runCli(['update', '--step', '1', '--status', 'done']).code).toBe(0);
    const stepsFile = writePayload(
      { steps: [{ id: 2, goal: '二', criteria: ['C1'] }] },
      'steps.json',
    );
    const r = runCli(['update', '--adjust-steps', stepsFile, '--approved-by', 'user']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('不许删除');
  });

  it('重排已 done 的步骤 ⇒ exit 2（重排会让 currentStep 语义错乱）', () => {
    expect(runCli(['write', '--file', twoStepPayload()]).code).toBe(0);
    expect(runCli(['update', '--step', '1', '--status', 'done']).code).toBe(0);
    expect(runCli(['update', '--step', '2', '--status', 'done']).code).toBe(0);
    const stepsFile = writePayload(
      {
        steps: [
          { id: 2, goal: '二', criteria: ['C1'] },
          { id: 1, goal: '一', criteria: ['C1'] },
          { id: 3, goal: '三', criteria: ['C1'] },
        ],
      },
      'steps.json',
    );
    const r = runCli(['update', '--adjust-steps', stepsFile, '--approved-by', 'user']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('不许重排');
  });
});

// ── 并发与形态校验 ───────────────────────────────────────────

describe('并发与形态校验', () => {
  it('判据运行期间状态文件被外部改动 ⇒ exit 23，且**不覆盖别人的写入**', () => {
    // 判据自己就是那个「另一个写入者」：它往状态文件里加一个字段
    const writer = {
      id: 'C1',
      desc: '模拟另一实例同时写状态文件',
      check: `node -e "const fs=require('fs');const p=process.env.CONCERTOAI_INSTRUCTION_DIR+'/concertoai-current-instruction.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.touchedByOther=true;fs.writeFileSync(p,JSON.stringify(j,null,2))"`,
      expectContains: [],
      covers: [],
    };
    expect(writeBase({ doneCriteria: [writer] }).code).toBe(0);
    const r = runCli(['check']);
    expect(r.code).toBe(23);
    expect(r.out).toContain('并发冲突');
    // 别人的改动必须还在（没被我用旧内存版本盖掉）
    expect(readState().touchedByOther).toBe(true);
  });

  it('update 必须且只能用一种形态（同时给 --step 与 --set-status ⇒ exit 2）', () => {
    expect(writeBase().code).toBe(0);
    const r = runCli(['update', '--step', '1', '--status', 'done', '--set-status', 'done']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('只能用一种形态');
  });

  it('未知子命令 / 无参数 ⇒ exit 2 并打印用法', () => {
    const unknown = runCli(['nope']);
    expect(unknown.code).toBe(2);
    const none = runCli([]);
    expect(none.code).toBe(2);
    expect(none.out).toContain('用法');
  });

  it('任何形态都不许改 instruction（推进/追加 followUp 后仍与原文逐字相同）', () => {
    const original = '六件裁决 + 脚本现在写（原话，含限定词）';
    expect(writeBase({ instruction: original }).code).toBe(0);
    expect(runCli(['update', '--step', '1', '--status', 'in_progress']).code).toBe(0);
    expect(runCli(['update', '--followup', '顺便 X', '--kind', 'step']).code).toBe(0);
    expect(readState().instruction).toBe(original);
  });
});
