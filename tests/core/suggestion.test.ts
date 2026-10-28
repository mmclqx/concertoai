/**
 * 场景提示引擎测试（v5.0 T12）。
 *
 * 覆盖七条硬约束 + 三条规则阈值 + 边缘路径：
 * - 约束① 同时最多 1 条（构造 3 条全命中 → 只出最高优先级）
 * - 约束② 同一 id 每会话 1 次
 * - 约束③ 全局 10 分钟冷却（9min 不出 / 11min 可再出 / 时钟回拨按冷却处理）
 * - 约束④ 每会话总计 ≤3 条
 * - 约束⑤ Esc / 忽略 → 本会话全静默
 * - 约束⑥ hints off → 恒 null
 * - 约束⑦ 纯函数（源码护栏：判定层不碰 fs、不调 Date.now）
 * 边缘：首次运行（状态文件不存在）/ 损坏 JSON / 写盘失败不抛错 / 超长冷却记录淘汰 /
 *       路径含空格降级 / 占位符不漏到用户眼前 / 命令护栏（真跑 --help）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseReviewCommand } from '../../src/cli/slash/review';
import {
  DEFAULT_SUGGESTION_MESSAGES,
  defaultHintStatePath,
  dismissHints,
  EMPTY_HINT_HISTORY,
  evaluateSuggestion,
  HINT_COOLDOWN_MS,
  HINT_STATE_VERSION,
  type HintHistory,
  isCoolingDown,
  isHintsEnabled,
  MAX_COOLDOWN_ENTRIES,
  MAX_HINTS_PER_SESSION,
  pruneCooldowns,
  readHintCooldowns,
  recordSuggestionShown,
  SUGGESTION_RULES,
  type SuggestionState,
  writeHintCooldowns,
} from '../../src/core/suggestion';
import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';

/** 当前时间基准（固定值：测试里所有 now 都相对它，绝不读真实时钟）。 */
const NOW = 1_700_000_000_000;

/** 构造 state（默认「什么都不命中」，各用例按需覆盖）。 */
function stateOf(overrides: Partial<SuggestionState> = {}): SuggestionState {
  return {
    userTurns: 1,
    hasProjectRules: true,
    consecutiveFailures: 0,
    fileRejectStreak: 0,
    hintsEnabled: true,
    ...overrides,
  };
}

/** 构造 history。 */
function historyOf(overrides: Partial<HintHistory> = {}): HintHistory {
  return { ...EMPTY_HINT_HISTORY, ...overrides };
}

/** 一条命中的便捷求值。 */
function evaluate(state: Partial<SuggestionState>, history: Partial<HintHistory> = {}) {
  return evaluateSuggestion({ state: stateOf(state), history: historyOf(history), now: NOW });
}

describe('规则表结构（三条确定性规则）', () => {
  it('恰好三条规则，id 唯一，priority 可排序且 i18nKey 在 zh/en 字典中都存在', () => {
    expect(SUGGESTION_RULES).toHaveLength(3);
    const ids = SUGGESTION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      'repeated-edit-rejection',
      'repeated-verify-failure',
      'missing-project-rules',
    ]);
    for (const rule of SUGGESTION_RULES) {
      expect(Number.isFinite(rule.priority)).toBe(true);
      // i18nKey 必须有对应文案（T13 直接接英文的前提：zh/en 键结构一致）
      expect(typeof zh.hints[rule.i18nKey]).toBe('string');
      expect(typeof en.hints[rule.i18nKey]).toBe('string');
      if (rule.i18nKeyNoFile !== undefined) {
        expect(typeof zh.hints[rule.i18nKeyNoFile]).toBe('string');
        expect(typeof en.hints[rule.i18nKeyNoFile]).toBe('string');
      }
    }
  });

  it('priority 严格递减：文件级问题 > 构建失败 > 入场引导', () => {
    const byId = new Map(SUGGESTION_RULES.map((r) => [r.id, r.priority]));
    expect(byId.get('repeated-edit-rejection')).toBeGreaterThan(
      byId.get('repeated-verify-failure') as number,
    );
    expect(byId.get('repeated-verify-failure')).toBeGreaterThan(
      byId.get('missing-project-rules') as number,
    );
  });
});

describe('约束①：同时最多 1 条（priority 最高者）', () => {
  it('三条规则全命中 → 只返回 repeated-edit-rejection', () => {
    const result = evaluate({
      hasProjectRules: false,
      consecutiveFailures: 2,
      fileRejectStreak: 2,
      fileRejectFile: 'src/a.ts',
    });
    expect(result?.id).toBe('repeated-edit-rejection');
    expect(result?.command).toBe('/review src/a.ts');
  });

  it('去掉文件级命中后轮转到构建失败（优先级次高）', () => {
    const result = evaluate({ hasProjectRules: false, consecutiveFailures: 2 });
    expect(result?.id).toBe('repeated-verify-failure');
    expect(result?.command).toBe('concertoai self-heal');
  });

  it('只有入场引导命中时返回它', () => {
    const result = evaluate({ hasProjectRules: false });
    expect(result?.id).toBe('missing-project-rules');
    expect(result?.command).toBe('concertoai init');
  });

  it('什么都不命中 → null（不会硬造一条提示）', () => {
    expect(evaluate({})).toBeNull();
  });
});

describe('约束②：同一 id 每会话 1 次', () => {
  it('已展示过的 id 不再返回，轮转到下一个仍命中的规则', () => {
    const state = { hasProjectRules: false, consecutiveFailures: 2 };
    const first = evaluate(state);
    expect(first?.id).toBe('repeated-verify-failure');
    const history = recordSuggestionShown(historyOf(), 'repeated-verify-failure', NOW);
    const second = evaluate(state, history);
    expect(second?.id).toBe('missing-project-rules');
  });

  it('唯一命中的规则已展示过 → null（宁可不出，也不重复同一句）', () => {
    const history = recordSuggestionShown(historyOf(), 'missing-project-rules', NOW);
    expect(evaluate({ hasProjectRules: false }, history)).toBeNull();
  });

  it('recordSuggestionShown 幂等：同 id 记两次不会虚耗会话配额', () => {
    const once = recordSuggestionShown(historyOf(), 'repeated-verify-failure', NOW);
    const twice = recordSuggestionShown(once, 'repeated-verify-failure', NOW + 1000);
    expect(twice).toBe(once); // 返回原对象（纯函数 + 幂等）
    expect(twice.shownCount).toBe(1);
    expect(twice.cooldowns['repeated-verify-failure']).toBe(NOW); // 不覆盖首次时间
  });
});

describe('约束③：全局 10 分钟冷却', () => {
  it('9 分钟 → 仍在冷却（null）；11 分钟 → 可再触发', () => {
    const cooldowns = { 'repeated-verify-failure': NOW };
    const state = { consecutiveFailures: 2 };
    // 会话历史已清空（模拟重启进程后新会话），只剩全局冷却
    expect(
      evaluateSuggestion({
        state: stateOf(state),
        history: historyOf({ cooldowns }),
        now: NOW + 9 * 60 * 1000,
      }),
    ).toBeNull();
    const later = evaluateSuggestion({
      state: stateOf(state),
      history: historyOf({ cooldowns }),
      now: NOW + HINT_COOLDOWN_MS + 60 * 1000,
    });
    expect(later?.id).toBe('repeated-verify-failure');
  });

  it('isCoolingDown 边界：无记录 / 非法不冷却；恰 10 分钟整即可再触发；时钟回拨按冷却处理', () => {
    expect(isCoolingDown(undefined, NOW)).toBe(false);
    expect(isCoolingDown(Number.NaN, NOW)).toBe(false);
    expect(isCoolingDown(NOW, NOW + HINT_COOLDOWN_MS - 1)).toBe(true);
    expect(isCoolingDown(NOW, NOW + HINT_COOLDOWN_MS)).toBe(false);
    // 系统时间被改早（last 在未来）→ 宁少勿多：视为仍在冷却
    expect(isCoolingDown(NOW + 60_000, NOW)).toBe(true);
  });

  it('冷却按 id 独立：一条在冷却不影响另一条', () => {
    const result = evaluate(
      { hasProjectRules: false, consecutiveFailures: 2 },
      { cooldowns: { 'repeated-verify-failure': NOW } },
    );
    expect(result?.id).toBe('missing-project-rules');
  });
});

describe('约束④：每会话总计最多 3 条', () => {
  it('shownCount 达上限 → 恒 null（即使规则仍命中且未展示过）', () => {
    expect(evaluate({ hasProjectRules: false }, { shownCount: MAX_HINTS_PER_SESSION })).toBeNull();
  });

  it('MAX_HINTS_PER_SESSION 为 3（用户拍板的硬上限）', () => {
    expect(MAX_HINTS_PER_SESSION).toBe(3);
    expect(evaluate({ hasProjectRules: false }, { shownCount: 2 })?.id).toBe(
      'missing-project-rules',
    );
  });
});

describe('约束⑤：Esc / 忽略 → 本会话立刻静默', () => {
  it('dismissed 后连最高优先级的规则也不出', () => {
    expect(
      evaluate(
        { hasProjectRules: false, consecutiveFailures: 2, fileRejectStreak: 2 },
        { dismissed: true },
      ),
    ).toBeNull();
  });

  it('dismissHints 幂等，且**不清空**全局冷却（关的是这次会话，不是以后都别提醒）', () => {
    const base = historyOf({ cooldowns: { 'missing-project-rules': NOW } });
    const dismissed = dismissHints(base);
    expect(dismissed.dismissed).toBe(true);
    expect(dismissed.cooldowns).toEqual({ 'missing-project-rules': NOW });
    expect(dismissHints(dismissed)).toBe(dismissed); // 幂等
  });
});

describe('约束⑥：hints off → 恒 null', () => {
  it('hintsEnabled: false 时所有规则都不出', () => {
    const result = evaluate({
      hintsEnabled: false,
      hasProjectRules: false,
      consecutiveFailures: 5,
      fileRejectStreak: 5,
      fileRejectFile: 'src/a.ts',
    });
    expect(result).toBeNull();
  });

  it('isHintsEnabled 双轨：默认 on；env 优先；写错值回落 config（不静默推翻用户配置）', () => {
    expect(isHintsEnabled()).toBe(true);
    expect(isHintsEnabled(undefined, undefined)).toBe(true);
    expect(isHintsEnabled('off')).toBe(false);
    expect(isHintsEnabled('on', 'off')).toBe(false);
    expect(isHintsEnabled('off', 'on')).toBe(true);
    expect(isHintsEnabled('off', '')).toBe(false); // 空环境变量 = 未设置
    // 手滑 `ofl` → 回落配置文件里的 on（而不是把 on 静默改成 off）
    expect(isHintsEnabled('on', 'ofl')).toBe(true);
    expect(isHintsEnabled('off', 'ofl')).toBe(false);
  });
});

describe('三条规则的触发阈值（苛刻：一眼能确认的确定性事实）', () => {
  it('missing-project-rules：userTurns=0 不提示（不抢开场白），≥1 才提示', () => {
    expect(evaluate({ hasProjectRules: false, userTurns: 0 })).toBeNull();
    expect(evaluate({ hasProjectRules: false, userTurns: 1 })?.id).toBe('missing-project-rules');
  });

  it('repeated-verify-failure：连续 1 轮失败不提示，2 轮才提示', () => {
    expect(evaluate({ consecutiveFailures: 1 })).toBeNull();
    expect(evaluate({ consecutiveFailures: 2 })?.id).toBe('repeated-verify-failure');
  });

  it('repeated-edit-rejection：同一文件 1 次拒绝不提示，2 次才提示', () => {
    expect(evaluate({ fileRejectStreak: 1, fileRejectFile: 'src/a.ts' })).toBeNull();
    expect(evaluate({ fileRejectStreak: 2, fileRejectFile: 'src/a.ts' })?.id).toBe(
      'repeated-edit-rejection',
    );
  });

  it('有规则文件时不提示 init（hasProjectRules 为真的唯一判据）', () => {
    expect(evaluate({ hasProjectRules: true, userTurns: 5 })).toBeNull();
  });
});

describe('文案与命令：不打空头支票、不漏占位符', () => {
  it('文件级提示填充 {file}，且终态文案里不留任何占位符', () => {
    const result = evaluate({ fileRejectStreak: 2, fileRejectFile: 'src/core/a.ts' });
    expect(result?.message).toContain('src/core/a.ts');
    expect(result?.message).not.toMatch(/\{file\}/);
    expect(result?.command).toBe('/review src/core/a.ts');
  });

  it('路径含空格 → 降级文案 + `/review`（不给一条会被拆坏的命令）', () => {
    const result = evaluate({ fileRejectStreak: 2, fileRejectFile: 'src/my file.ts' });
    expect(result?.i18nKey).toBe('repeatedEditRejectionNoFile');
    expect(result?.command).toBe('/review');
    expect(result?.message).not.toMatch(/[{}<]/);
    // 降级文案与带文件文案必须是两条不同的话（不是同一句漏了替换）
    expect(result?.message).not.toBe(DEFAULT_SUGGESTION_MESSAGES.repeatedEditRejection);
  });

  it('无文件上下文 → 同样降级为 `/review`', () => {
    const result = evaluate({ fileRejectStreak: 2 });
    expect(result?.command).toBe('/review');
    expect(result?.i18nKey).toBe('repeatedEditRejectionNoFile');
  });

  it('所有规则产出的命令都是完整可执行串（无占位符、无中文、有可识别前缀）', () => {
    for (const rule of SUGGESTION_RULES) {
      const state = stateOf({
        hasProjectRules: false,
        consecutiveFailures: 9,
        fileRejectStreak: 9,
        fileRejectFile: 'src/a.ts',
      });
      const command = rule.command(state);
      expect(command).not.toMatch(/[<>{}]/); // 无未替换占位符
      expect(command).not.toMatch(/[\u4e00-\u9fff]/); // 命令里不该出现中文释义
      expect(/^(concertoai |\/)/.test(command)).toBe(true); // CLI 命令或斜杠命令
    }
  });

  it('可注入英文文案（T13 直接接 `t().hints`，引擎结构不变）', () => {
    const result = evaluateSuggestion({
      state: stateOf({ hasProjectRules: false }),
      history: historyOf(),
      now: NOW,
      messages: en.hints,
    });
    expect(result?.message).toBe(en.hints.missingProjectRules);
    expect(result?.message).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('命令可用性护栏（T10 教训：提示里的话是承诺）', () => {
  it('CLI 规则命令真的注册过——实跑 `--help` 断言，不是断言字符串', { timeout: 200_000 }, () => {
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    // 隔离 HOME：真实 CLI 入口会碰 ~/.concertoai（迁移 / 建目录 / 读技能与规则）。
    // 不隔离时它会写开发者真实 home，并与同批次的其它用例互相干扰
    // （如 tests/skill/loader.test.ts 会扫 ~/.concertoai/skills，见 AGENTS 第 16 条「隔离目录」）。
    const home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-hint-help-'));
    let help: string;
    try {
      help = execFileSync(process.execPath, [tsxCli, 'src/cli/index.ts', '--help'], {
        encoding: 'utf8',
        timeout: 180_000,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CONCERTOAI_HINTS: 'off',
          // v5.0 T22：入口按 LUMEN_LOCALE > LANG 定语言，不钉死会随开发机 shell 漂移
          // （下面的断言拿 zh 字典比对；同 v3.3 漏隔离 LUMEN_LOCALE 的教训）。
          LUMEN_LOCALE: 'zh',
          HOME: home,
          USERPROFILE: home,
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    // 只校验 CLI 形态的命令；斜杠命令另有校验（见下一条用例）
    for (const rule of SUGGESTION_RULES) {
      const command = rule.command(stateOf({ fileRejectFile: 'src/a.ts' }));
      if (!command.startsWith('concertoai ')) {
        continue;
      }
      const verb = command.slice('concertoai '.length).split(' ')[0] as string;
      // --help 的命令列表里必须有这个动词（如 `init` / `self-heal`）
      expect(help).toMatch(new RegExp(`^\\s+${verb}\\b`, 'm'));
    }
  });
  it('斜杠命令 `/review <file>` 能被真实解析器接受（不是幻想命令）', () => {
    const result = evaluate({ fileRejectStreak: 2, fileRejectFile: 'src/a.ts' });
    const parsed = parseReviewCommand(result?.command ?? '');
    expect(parsed?.type).toBe('files');
    expect(parsed).toMatchObject({ paths: ['src/a.ts'] });
    // 降级形态 `/review`（auto 模式）同样合法
    expect(parseReviewCommand('/review')?.type).toBe('auto');
  });
});

describe('约束⑦：纯函数（源码护栏）', () => {
  it('判定层不碰文件系统、不读真实时钟（时间必须注入）', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/core/suggestion.ts'), 'utf8');
    const pureStart = source.indexOf('── 纯判定层');
    const ioStart = source.indexOf('── IO 层');
    // 分层标记必须存在，否则本护栏会「静默失效」（切片取空 → 永远通过）
    expect(pureStart).toBeGreaterThan(0);
    expect(ioStart).toBeGreaterThan(pureStart);
    const pureLayer = source
      .slice(pureStart, ioStart)
      // 去掉注释：护栏校验的是**代码**，而注释里正常会写「不读 Date.now()」这类说明
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(pureLayer).not.toMatch(/Date\.now\s*\(/);
    expect(pureLayer).not.toMatch(/readFile|writeFile|mkdir|appendFile/);
    expect(pureLayer).not.toMatch(/\brename\s*\(|\brm\s*\(/);
    // 判定层确实有内容（防止切片写错导致误绿）
    expect(pureLayer).toContain('evaluateSuggestion');
  });

  it('相同入参 → 相同结果（无隐藏状态、无时间副作用）', () => {
    const args = { state: stateOf({ hasProjectRules: false }), history: historyOf(), now: NOW };
    expect(evaluateSuggestion(args)).toEqual(evaluateSuggestion(args));
    // 传入的 state / history 未被修改（纯函数不产生副作用）
    expect(args.state.userTurns).toBe(1);
    expect(args.history.shownIds).toEqual([]);
  });
});

describe('IO 层：hint-state.json（永不抛错）', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-hint-'));
    file = path.join(tmp, 'hint-state.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('首次运行：文件不存在 → 空记录 + reset:false（不报错）', async () => {
    const read = await readHintCooldowns({ file });
    expect(read.cooldowns).toEqual({});
    expect(read.reset).toBe(false);
  });

  it('写入后读回一致，且落盘含 schema 版本（未来改格式可识别旧文件）', async () => {
    const write = await writeHintCooldowns({ 'missing-project-rules': NOW }, { file, now: NOW });
    expect(write.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number };
    expect(raw.version).toBe(HINT_STATE_VERSION);
    const read = await readHintCooldowns({ file });
    expect(read.cooldowns).toEqual({ 'missing-project-rules': NOW });
  });

  it('自动建目录（嵌套路径）+ 原子写不留 .tmp 残骸', async () => {
    const nested = path.join(tmp, 'a', 'b', 'hint-state.json');
    expect(
      (await writeHintCooldowns({ 'repeated-verify-failure': NOW }, { file: nested, now: NOW })).ok,
    ).toBe(true);
    expect(existsSync(nested)).toBe(true);
    // 原子写：目录里只应留下目标文件，不应留下 `<file>.<pid>.tmp`
    const leftovers = readdirSync(path.dirname(nested));
    expect(leftovers).toEqual(['hint-state.json']);
  });

  it('损坏 JSON / 结构非法 → 空记录 + reset:true（坏状态只意味着可能多提示一次）', async () => {
    writeFileSync(file, '{"version":1,"cooldowns":', 'utf8');
    expect(await readHintCooldowns({ file })).toEqual({ cooldowns: {}, reset: true });
    writeFileSync(file, '"not an object"', 'utf8');
    expect(await readHintCooldowns({ file })).toEqual({ cooldowns: {}, reset: true });
    writeFileSync(file, JSON.stringify({ version: 1, cooldowns: null }), 'utf8');
    expect((await readHintCooldowns({ file })).reset).toBe(true);
  });

  it('单条非法 → 只剔除该条，其余照用（不因一条脏数据丢掉全部冷却）', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        cooldowns: { good: NOW, bad: 'yesterday', worse: Number.NaN, '': NOW },
      }),
      'utf8',
    );
    const read = await readHintCooldowns({ file });
    expect(read.cooldowns).toEqual({ good: NOW });
    expect(read.reset).toBe(false);
  });

  it('写盘失败 → { ok:false } 而不抛错（提示功能不该让对话崩掉）', async () => {
    const blocker = path.join(tmp, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const result = await writeHintCooldowns(
      { x: NOW },
      { file: path.join(blocker, 'h.json'), now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('默认路径指向 ~/.concertoai/hint-state.json（单一来源 store/paths.ts）', () => {
    expect(defaultHintStatePath()).toBe(path.join(os.homedir(), '.concertoai', 'hint-state.json'));
  });
});

describe('pruneCooldowns：控量与过期淘汰', () => {
  it('过期（>10min）与未来时间戳（时钟回拨）都被剔除，仅留窗口内记录', () => {
    const pruned = pruneCooldowns(
      {
        fresh: NOW - 1000,
        stale: NOW - HINT_COOLDOWN_MS - 1,
        future: NOW + 60_000,
        exact: NOW - HINT_COOLDOWN_MS,
      },
      NOW,
    );
    expect(Object.keys(pruned)).toEqual(['fresh']);
  });

  it(`最多保留 ${MAX_COOLDOWN_ENTRIES} 条（按时间新的优先），文件不会无限增长`, () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_COOLDOWN_ENTRIES + 20; i += 1) {
      many[`id-${i}`] = NOW - i;
    }
    const pruned = pruneCooldowns(many, NOW);
    expect(Object.keys(pruned)).toHaveLength(MAX_COOLDOWN_ENTRIES);
    expect(pruned['id-0']).toBe(NOW); // 最新的留下
    expect(pruned[`id-${MAX_COOLDOWN_ENTRIES - 1}`]).toBe(NOW - (MAX_COOLDOWN_ENTRIES - 1)); // 窗口内最后一条留下
    expect(pruned[`id-${MAX_COOLDOWN_ENTRIES}`]).toBeUndefined(); // 超出上限的更旧记录被淘汰
  });
});
