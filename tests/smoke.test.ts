import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index';

describe('smoke', () => {
  it('库入口可加载且版本正确', () => {
    expect(VERSION).toBe('5.0.0');
  });

  it('vitest 运行正常', () => {
    expect(1 + 1).toBe(2);
  });
});
