import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index';

/**
 * `package.json` 里的版本号（发布真正听从的那一个）。
 *
 * ⚠️ 这里**不许**再写成字面量 `'5.0.0'`（v5.1.0 发版时踩到）：版本号每次发布都要变，
 * 字面量断言就变成「每次发版必须记得手改测试」——忘了改就是一条假红，而假红会被
 * 训练成「这条红了不用管」，护栏等于不存在。更糟的是有人会「反正它红了，把字面量
 * 改成新版本号」了事，那条断言从此只剩「测试跑得起来」。
 *
 * 改为对照 `package.json` 后，它守的是一条**真正的不变量**：`src/version.ts` 与
 * `package.json` 必须同版本（否则 `concertoai --version` 与实际发布的包版本会不一致，
 * 用户报 bug 时对不上号）。
 */
const PKG_VERSION = (
  JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('smoke', () => {
  it('库入口可加载且版本正确', () => {
    // 正例自证：先确认 `package.json` 真被读到（否则下面等同于拿 '' 去比）
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VERSION).toBe(PKG_VERSION);
  });

  it('vitest 运行正常', () => {
    expect(1 + 1).toBe(2);
  });
});
