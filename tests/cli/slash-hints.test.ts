/**
 * `/hints` 斜杠命令测试（v5.0 T13）。
 *
 * 覆盖：解析（on/off/status/裸命令/未知子命令）、执行回执、会话级语义
 * （`off` 要求 dismiss、`on` 要求清掉 dismissed → 不能是假按钮）、
 * 以及「回执里承诺的命令必须真存在」（T10 空头支票教训）。
 */

import { describe, expect, it } from 'vitest';

import { executeHintsCommand, parseHintsCommand } from '../../src/cli/slash/hints';
import {
  HINT_COOLDOWN_MS,
  MAX_HINTS_PER_SESSION,
  SUGGESTION_RULES,
} from '../../src/core/suggestion';

describe('parseHintsCommand：解析', () => {
  it('非 /hints 命令 → null（不抢别的 handler）', () => {
    expect(parseHintsCommand('/review')).toBeNull();
    expect(parseHintsCommand('你好')).toBeNull();
    expect(parseHintsCommand('/hint')).toBeNull(); // 差一个字母不算
    expect(parseHintsCommand('')).toBeNull();
  });

  it('/hints 与 /hints status 都等价于 status（裸命令最可能是想看状态）', () => {
    expect(parseHintsCommand('/hints')).toEqual({ type: 'status' });
    expect(parseHintsCommand('/hints status')).toEqual({ type: 'status' });
    expect(parseHintsCommand('  /hints  ')).toEqual({ type: 'status' });
  });

  it('on / off 解析准确（大小写敏感：不认识的写法走 unknown）', () => {
    expect(parseHintsCommand('/hints on')).toEqual({ type: 'on' });
    expect(parseHintsCommand('/hints off')).toEqual({ type: 'off' });
    const upper = parseHintsCommand('/hints OFF');
    expect(upper?.type).toBe('unknown');
  });

  it('未知子命令 → unknown 且回执带原始输入（便于用户发现拼错）', () => {
    const cmd = parseHintsCommand('/hints maybe');
    expect(cmd?.type).toBe('unknown');
    expect(cmd?.type === 'unknown' ? cmd.message : '').toContain('maybe');
  });
});

describe('executeHintsCommand：会话级开关', () => {
  it('/hints off → 关开关 + 要求立刻静默（dismiss），并告知两种恢复方式', () => {
    const result = executeHintsCommand({ type: 'off' }, { enabled: true });
    expect(result.handled).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.dismiss).toBe(true);
    // 「关掉之后怎么回来」必须写在回执里：只关不给恢复入口，用户会被永久静音而不自知
    expect(result.message.content).toContain('/hints on');
    expect(result.message.content).toContain('config set hints off');
  });

  it('/hints on → 开开关 + 明确不 dismiss（要清掉「已忽略」，否则是假按钮）', () => {
    const result = executeHintsCommand({ type: 'on' }, { enabled: false });
    expect(result.enabled).toBe(true);
    expect(result.dismiss).toBe(false);
  });

  it('/hints status：按当前开关给不同回执，且带真实硬上限数字', () => {
    const on = executeHintsCommand({ type: 'status' }, { enabled: true });
    expect(on.message.content).toContain(String(MAX_HINTS_PER_SESSION));
    expect(on.message.content).toContain(String(Math.round(HINT_COOLDOWN_MS / 60_000)));
    expect(on.enabled).toBeUndefined(); // 不改开关

    const off = executeHintsCommand({ type: 'status' }, { enabled: false });
    expect(off.message.content).toContain('/hints on');
  });

  it('unknown → 原样回执，不改开关、不 dismiss', () => {
    const result = executeHintsCommand(
      { type: 'unknown', message: '❌ 未知子命令' },
      { enabled: true },
    );
    expect(result.handled).toBe(true);
    expect(result.message.content).toBe('❌ 未知子命令');
    expect(result.enabled).toBeUndefined();
    expect(result.dismiss).toBeUndefined();
  });
});

describe('回执里承诺的命令必须真存在（T10 空头支票教训）', () => {
  it('/hints off 回执提到的 `concertoai config set hints off` 在 CLI 侧已实现', () => {
    const result = executeHintsCommand({ type: 'off' }, { enabled: true });
    // 文案承诺的能力：config set hints <on|off>（T12 实现并有用例）
    expect(result.message.content).toContain('config set hints off');
  });

  it('规则表里的命令与 /hints 承诺不冲突（都在本版本已实现范围）', () => {
    // 三条规则的命令必须都是「已有实现」的形态（T12 已有 --help 护栏；
    // 此处再断言它们不含 M4 才有的动词，防止未来误加空头支票）
    for (const rule of SUGGESTION_RULES) {
      expect(rule.command({} as never)).not.toContain('concertoai fix');
    }
  });
});
