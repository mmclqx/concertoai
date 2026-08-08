import { describe, expect, it } from 'vitest';

import { fmt, zh } from '../../src/i18n/zh';

describe('fmt 占位符替换', () => {
  it('替换字符串占位符', () => {
    expect(fmt('模型调用失败：{message}', { message: 'timeout' })).toBe('模型调用失败：timeout');
  });

  it('替换数字占位符', () => {
    expect(fmt('已恢复会话 {id}（{count} 条消息）', { id: 'a-1', count: 3 })).toBe(
      '已恢复会话 a-1（3 条消息）',
    );
  });

  it('缺失参数保留原占位符', () => {
    expect(fmt('会话不存在: {id}', {})).toBe('会话不存在: {id}');
  });

  it('多处同名占位符全部替换', () => {
    expect(fmt('{name} 与 {name}', { name: 'x' })).toBe('x 与 x');
  });
});

describe('zh 文案表', () => {
  it('关键错误文案存在且含指引', () => {
    expect(zh.errors.noApiKey).toContain('DEEPSEEK_API_KEY');
    expect(zh.errors.loopMaxTurns).toContain('轮上限');
  });

  it('审批框文案齐全', () => {
    expect(zh.approval.editTitle).toBe('编辑文件');
    expect(zh.approval.shellTitle).toBe('执行命令');
    expect(zh.approval.confirm).toContain('y');
    expect(zh.approval.reject).toContain('n');
  });

  it('输入框与状态条文案存在', () => {
    expect(zh.prompt.placeholder).toContain('Enter');
    expect(zh.status.cost).toBe('成本');
    expect(zh.status.yuan).toBe('元');
  });
});
