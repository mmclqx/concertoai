/**
 * `scripts/instruction-state.mjs show` 的验收测试（ADR-051 / docs/12 §9.1）。
 *
 * ## 为什么单独一个文件（不是塞进 instruction-state.test.ts）
 *
 * 因为**判据**要用它：`doneCriteria` 里写的是
 * `npx vitest run tests/scripts/instruction-state-show.test.ts`。
 * 2026-11-10 实测了一条坑：`npx vitest run <文件> -t <过滤词>` 在**零匹配**时
 * 退出码是 0（`Test Files 1 skipped / Tests N skipped`），拿它当判据等于**恒绿**。
 * 而「文件不存在」时 vitest 是 exit 1（有牙）。所以判据必须落在**文件粒度**上。
 * 见 `docs/09-踩坑记录/2026-11-10-vitest过滤词零匹配也返回成功.md`。
 *
 * ## 这组用例守的是什么
 *
 * `show` 只回显记录、**不跑判据**，所以它最大的风险不是「显示错」，而是**被读成证据**：
 * 看到 `status=done` 就以为做完了。所以每条用例都在两侧各钉一下：
 *
 * | 废实现 | 会被哪条用例抓住 |
 * |---|---|
 * | 不打印「本命令没跑判据」尾行 | 「固定尾行必须出现」 |
 * | 顺手把判据跑一遍（把 show 变成 check） | 「不产生副作用：计数器不变」 |
 * | 无记录也说「一切正常」 | 「无记录 ⇒ exit 3 且明说无记录」 |
 * | 记录损坏就重建一份 | 「损坏 ⇒ 备份 + 原文件一字未改」 |
 * | 全部 evidence 一次刷屏 | 「默认只显示最近 1 条 + 另有 N 条」 |
 * | `--json` 输出摘要而不是原记录 | 「--json 可 JSON.parse 且 instruction 逐字相同」 |
 *
 * 所有用例都用 `CONCERTOAI_INSTRUCTION_DIR` 指向临时目录，**绝不碰开发者真实 `.git/`**。
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

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, CONCERTOAI_INSTRUCTION_DIR: stateDir, ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const statePath = () => path.join(stateDir, 'concertoai-current-instruction.json');
const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const writeStateFile = (data: unknown) =>
  fs.writeFileSync(statePath(), `${JSON.stringify(data, null, 2)}\n`, 'utf8');

/** 计数型判据：每跑一次追一个 x —— 用来证明 `show` **没有**偷偷跑判据。 */
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

const countRuns = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);

function writePayload(payload: Record<string, unknown>) {
  const file = path.join(stateDir, 'payload.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    instruction: '用户原话：把 show 做出来',
    doneCriteria: [countingCriterion('C1')],
    steps: [
      { id: 1, goal: '第一步（已做）', targets: ['docs/12'], criteria: ['C1'], status: 'done' },
      {
        id: 2,
        goal: '第二步（待做）',
        targets: ['AGENTS.md'],
        criteria: ['C1'],
        status: 'pending',
      },
    ],
    ...overrides,
  };
}

/** 写一条基准记录（`--skip-baseline`：本文件不验 baseline 语义，那是另一个文件的用例）。 */
function writeBase(overrides: Record<string, unknown> = {}) {
  return runCli(['write', '--file', writePayload(basePayload(overrides)), '--skip-baseline']);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-show-'));
  counter = path.join(stateDir, 'counter.txt');
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('show：人读摘要（只读，且必须明说自己不是证据）', () => {
  it('正常记录 ⇒ exit 0，显示指令/状态/进度/步骤标记/判据状态', () => {
    expect(writeBase().code).toBe(0);
    const r = runCli(['show']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('用户原话：把 show 做出来');
    expect(r.out).toContain('状态：in_progress');
    expect(r.out).toContain('1/2 步完成'); // 一条 done、一条 pending
    expect(r.out).toContain('#1 第一步（已做）');
    expect(r.out).toContain('C1 未验证'); // 还没跑过判据
  });

  it('**固定尾行必须出现**：明说「没有跑任何判据」（防止把 status=done 读成已完成）', () => {
    /**
     * 这是「护栏的护栏」：与 check 的 TIER_LINE 同一用意。
     * 探针实证：删掉 `o.push(SHOW_NOT_PROOF)` ⇒ 本用例红。
     */
    expect(writeBase().code).toBe(0);
    const r = runCli(['show']);
    expect(r.out).toContain('只回显记录');
    expect(r.out).toContain('没有跑任何判据');
    expect(r.out).toContain('status/verdict 是索引，不是证据');
  });

  it('**不产生副作用**：show 一次都不跑判据（计数判据的计数器必须不变）', () => {
    /**
     * 废实现：把 show 写成「顺便跑一遍判据好显示结果」——那就等于把只读命令变成有成本、
     * 有证据落盘的动作，还会让「看一眼状态」变成十几秒的全量 verify。
     * 探针实证：在 show 里加一次 `runCriterion(...)` ⇒ 本用例红（计数器 +1）。
     */
    expect(writeBase().code).toBe(0);
    expect(countRuns()).toBe(0);
    const r = runCli(['show']);
    expect(r.code).toBe(0);
    expect(countRuns()).toBe(0);
    // 记录本身也不许被改写（只读命令不该刷新 lastUpdated）
    const before = fs.statSync(statePath()).mtimeMs;
    runCli(['show']);
    expect(fs.statSync(statePath()).mtimeMs).toBe(before);
  });

  it('判据有 evidence 时显示 PASS/FAIL 与时间（照抄 exitCode，不自己下结论）', () => {
    expect(writeBase({ doneCriteria: [countingCriterion('C1', 1)] }).code).toBe(0);
    expect(runCli(['update', '--set-status', 'done']).code).toBe(21); // 有 fail，拒绝
    const r = runCli(['show']);
    expect(r.out).toContain('FAIL(exit=1)');
    // 正例对照：判据转绿后必须显示 PASS（否则上面的 FAIL 可能是恒 FAIL）
    expect(
      runCli([
        'write',
        '--file',
        writePayload(basePayload()),
        '--on-conflict',
        'abandon',
        '--skip-baseline',
      ]).code,
    ).toBe(0);
    expect(runCli(['check']).code).toBe(0);
    expect(runCli(['show']).out).toContain('C1 PASS');
  });

  it('默认只显示每条步最近 1 条 evidence + 「另有 N 条」；--full 展开全部', () => {
    expect(writeBase().code).toBe(0);
    for (let i = 0; i < 3; i += 1) expect(runCli(['check', '--step', '1']).code).toBe(0);
    const brief = runCli(['show']);
    expect(brief.out).toContain('另有 2 条证据');
    const full = runCli(['show', '--full']);
    expect(full.out).not.toContain('另有 2 条证据');
    expect(full.out).toContain('exit=0');
  });

  it('--json ⇒ 原记录（可 JSON.parse，instruction 逐字不改，含全部字段）', () => {
    const original = '原话里有「限定词」和 123 数字，不许被摘要化';
    expect(writeBase({ instruction: original }).code).toBe(0);
    const r = runCli(['show', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.instruction).toBe(original);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.doneCriteria[0].check).toContain('appendFileSync');
    expect(Array.isArray(parsed.steps)).toBe(true);
    // --json 也不许跑判据
    expect(countRuns()).toBe(0);
  });

  it('**无记录 ⇒ exit 3 且明说「无记录」**（不许把「没记录」说成「一切正常」）', () => {
    const r = runCli(['show']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('无记录');
  });

  it('**记录损坏 ⇒ exit 3 + 生成 .corrupt 备份 + 原文件一字未改**（不猜不重建）', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath(), '{ 这不是 JSON', 'utf8');
    const r = runCli(['show']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('记录损坏');
    expect(fs.readFileSync(statePath(), 'utf8')).toBe('{ 这不是 JSON');
    const backups = fs.readdirSync(stateDir).filter((f) => f.includes('.corrupt-'));
    expect(backups.length).toBe(1);
  });

  it('超长内容截断并明示「原文见 --json」（不静默砍掉，也不刷屏）', () => {
    const longInstruction = '很长的指令'.repeat(100); // 600 字
    expect(writeBase({ instruction: longInstruction }).code).toBe(0);
    const r = runCli(['show']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('…（原文见 --json）');
    // 否定面（必须有）：不截断的实现会把整串打出来 —— 上面两条断言它也能满足
    //（`…（原文见 --json）` 那句靠的是 length>200 的判断，与切不切无关）。
    // 探针实证：把 `slice(0, 200)` 去掉 ⇒ 只有这一条会红。
    expect(r.out).not.toContain(longInstruction);
    expect(r.out.length).toBeLessThan(longInstruction.length * 3);
    // 截断不等于丢：--json 里必须是全文
    expect(JSON.parse(runCli(['show', '--json']).out).instruction).toBe(longInstruction);
  });

  it('done 记录：显示 doneProof 三档（pushed 必须是 unjudged，不许显示成已推送）', () => {
    expect(writeBase().code).toBe(0);
    expect(runCli(['update', '--set-status', 'done']).code).toBe(0);
    const r = runCli(['show']);
    expect(r.out).toContain('doneProof');
    expect(r.out).toContain('③unjudged');
    expect(r.out).toContain('状态：done');
  });

  it('blocked 记录：显示 blockedReason（「继续」时先看它，不用猜）', () => {
    expect(writeBase().code).toBe(0);
    expect(
      runCli(['update', '--set-status', 'blocked', '--reason', '缺 API Key，等用户给']).code,
    ).toBe(0);
    const r = runCli(['show']);
    expect(r.out).toContain('状态：blocked');
    expect(r.out).toContain('缺 API Key，等用户给');
  });

  it('followUps 与 pendingDecisions 都显示（补丁①②不能被摘要吞掉）', () => {
    // 注意：`write` 不收载荷里的 followUps（它是「中途补充」，只能由 update 追加），
    // 所以这里直接改记录文件造数据 —— 顺带证明 show 对「手写/旧版本记录」也能读。
    const data = readStateAfterWrite();
    data.followUps = [
      {
        id: 'F1',
        text: '别忘了先跑 verify',
        at: '2026-11-10T00:00:00+08:00',
        kind: 'criteria',
        status: 'applied',
        turnedInto: { kind: 'criteria', id: 'C1' },
      },
    ];
    data.pendingDecisions = [{ id: 'D1', text: 'hook 要不要做', mySuggestion: '先报方案' }];
    writeStateFile(data);
    const r = runCli(['show']);
    expect(r.out).toContain('别忘了先跑 verify');
    expect(r.out).toContain('[criteria/applied]');
    expect(r.out).toContain('hook 要不要做');
    expect(r.out).toContain('先报方案');
  });

  it('步骤的查重结论与整条指令的查重结论都会显示（含 reused 标注）', () => {
    const data = readStateAfterWrite();
    data.dedup = {
      checkedAt: '2026-11-10T00:10:00+08:00',
      logHead: 'abc1234',
      baseline: 'abc1234',
      baselineSource: 'record.baselineHead',
      scope: 'repo',
      targets: ['docs/12'],
      changedFiles: ['a.md'],
      newCommits: [],
      worktreeChanges: [],
      criteria: [],
      verdict: 'not-done',
      verdictSource: 'reused',
    };
    data.steps[0].dedup = { checkedAt: '2026-11-10T00:11:00+08:00', verdict: 'done' };
    writeStateFile(data);
    const r = runCli(['show']);
    expect(r.out).toContain('最近查重（整条指令）：not-done');
    expect(r.out).toContain('（结论沿用上次）');
    expect(r.out).toContain('查重=done@');
  });
});

function readStateAfterWrite() {
  expect(writeBase().code).toBe(0);
  return readState();
}
