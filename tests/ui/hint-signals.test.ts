/**
 * 场景提示信号采集测试（v5.0 T13）。
 *
 * 这些函数决定了 T12 规则表拿到的数字对不对——**错了就是狼来了**：
 * 连续失败没归零 → 用户修好了还被告知「构建没通过」；拒改跨文件累计 →
 * 用户在正常推进时被提示「你在死磕同一个文件」。故每条口径都有独立用例。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countUserTurns,
  EMPTY_REJECT_STREAK,
  hasProjectRulesFile,
  isVerifyClassCommand,
  nextFailureStreak,
  nextRejectStreak,
} from '../../src/ui/hint-signals';

describe('isVerifyClassCommand：只认「质量关卡」命令', () => {
  it('verify 类命令全部识别（含 npm test / lint / typecheck / build / self-heal）', () => {
    for (const command of [
      'npm run verify',
      'npm test',
      'npm run test -- --silent',
      'npm run lint',
      'npm run typecheck',
      'npm run build',
      'concertoai self-heal',
      'npx biome check src',
      'npx tsc --noEmit',
    ]) {
      expect(isVerifyClassCommand(command)).toBe(true);
    }
  });

  it('普通工具命令不算（否则正常干活时会被反复提示去 self-heal）', () => {
    for (const command of [
      'git status',
      'ls -la',
      'cat package.json',
      'npm install',
      'node scripts/build.js',
      '',
      '   ',
    ]) {
      expect(isVerifyClassCommand(command)).toBe(false);
    }
  });

  it('多余空白也能识别（LLM 生成的命令常带连续空格）', () => {
    expect(isVerifyClassCommand('npm   run   verify')).toBe(true);
    expect(isVerifyClassCommand('  npm test  ')).toBe(true);
  });
});

describe('nextFailureStreak：连续失败计数', () => {
  it('失败累加、通过归零（归零是「连续」二字的前提）', () => {
    let streak = 0;
    streak = nextFailureStreak(streak, 'failed');
    expect(streak).toBe(1);
    streak = nextFailureStreak(streak, 'failed');
    expect(streak).toBe(2); // 达到 T12 阈值
    streak = nextFailureStreak(streak, 'passed');
    expect(streak).toBe(0); // 修好了就必须归零
  });

  it('非法历史值（负数 / NaN）按 0 处理，不会算出奇怪的阈值', () => {
    expect(nextFailureStreak(Number.NaN, 'failed')).toBe(1);
    expect(nextFailureStreak(-5, 'failed')).toBe(1);
    expect(nextFailureStreak(1.7, 'failed')).toBe(2);
  });
});

describe('nextRejectStreak：同一文件连续被拒', () => {
  it('同一文件被拒 2 次 → count=2（达到 T12 阈值）', () => {
    let state = nextRejectStreak(EMPTY_REJECT_STREAK, { file: 'src/a.ts', approved: false });
    expect(state).toEqual({ file: 'src/a.ts', count: 1 });
    state = nextRejectStreak(state, { file: 'src/a.ts', approved: false });
    expect(state).toEqual({ file: 'src/a.ts', count: 2 });
  });

  it('换文件 → 从 1 重新开始（用户在推进，不是死磕一处）', () => {
    let state = nextRejectStreak(EMPTY_REJECT_STREAK, { file: 'src/a.ts', approved: false });
    state = nextRejectStreak(state, { file: 'src/a.ts', approved: false });
    state = nextRejectStreak(state, { file: 'src/b.ts', approved: false });
    expect(state).toEqual({ file: 'src/b.ts', count: 1 });
  });

  it('批准一次 → 归零（用户认可了 AI 改动，不再是「卡住」）', () => {
    let state = nextRejectStreak(EMPTY_REJECT_STREAK, { file: 'src/a.ts', approved: false });
    state = nextRejectStreak(state, { file: 'src/a.ts', approved: false });
    state = nextRejectStreak(state, { file: 'src/a.ts', approved: true });
    expect(state).toEqual(EMPTY_REJECT_STREAK);
  });

  it('无文件上下文 → 不计数（数不出「同一文件」就不硬数，否则是噪音）', () => {
    const state = nextRejectStreak(EMPTY_REJECT_STREAK, { file: undefined, approved: false });
    expect(state).toEqual(EMPTY_REJECT_STREAK);
    const blank = nextRejectStreak(EMPTY_REJECT_STREAK, { file: '   ', approved: false });
    expect(blank).toEqual(EMPTY_REJECT_STREAK);
  });
});

describe('hasProjectRulesFile：只看存在性', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-hint-signals-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('空目录 → false（会触发 missing-project-rules）', () => {
    expect(hasProjectRulesFile(tmp)).toBe(false);
  });

  it('有 AGENTS.md 或 CARBON.md 任一 → true', () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), '# rules', 'utf8');
    expect(hasProjectRulesFile(tmp)).toBe(true);

    const other = path.join(tmp, 'other');
    rmSync(path.join(tmp, 'AGENTS.md'));
    writeFileSync(path.join(tmp, 'CARBON.md'), '# rules', 'utf8');
    expect(hasProjectRulesFile(tmp)).toBe(true);
    expect(hasProjectRulesFile(other)).toBe(false); // 嵌套目录无关
  });

  it('内容为空也算「有」（只看存在性，内容质量归 init/T5 管）', () => {
    writeFileSync(path.join(tmp, 'AGENTS.md'), '', 'utf8');
    expect(hasProjectRulesFile(tmp)).toBe(true);
  });
});

describe('countUserTurns：输入轮数', () => {
  it('只数 user 角色（assistant / system 不算）', () => {
    expect(countUserTurns([])).toBe(0);
    expect(
      countUserTurns([
        { role: 'system' },
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' },
        { role: 'tool' },
      ]),
    ).toBe(2);
  });
});
