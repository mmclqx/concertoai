/**
 * bin 双入口测试（v5.0 T3）。
 *
 * 目标：`ccai` 与 `concertoai` 完全等价（同一入口文件），且不占用系统命令 `cc` / `c`。
 * 只做静态断言（读 package.json）——真实符号链接行为由 npm 安装时保证；
 * 版本一致性的端到端验证在 T23.1 手工测试中做。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** 项目根 package.json。 */
const PKG_PATH = path.join(process.cwd(), 'package.json');

interface PkgJson {
  bin?: Record<string, string>;
  files?: string[];
}

function readPkg(): PkgJson {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8')) as PkgJson;
}

describe('bin 双入口（v5.0 T3）', () => {
  it('concertoai 与 ccai 指向同一入口文件', () => {
    const pkg = readPkg();
    expect(pkg.bin?.concertoai).toBe('./dist/cli/index.js');
    expect(pkg.bin?.ccai).toBe('./dist/cli/index.js');
    expect(pkg.bin?.concertoai).toBe(pkg.bin?.ccai);
  });

  it('不注册 cc / c 短命令（避免与 C 编译器 cc 冲突）', () => {
    const pkg = readPkg();
    const names = Object.keys(pkg.bin ?? {});
    expect(names).not.toContain('cc');
    expect(names).not.toContain('c');
    // 只应有两个入口
    expect(names.sort()).toEqual(['ccai', 'concertoai']);
  });

  it('入口文件存在于 dist（构建产物已就绪时）', () => {
    const pkg = readPkg();
    const entry = pkg.bin?.concertoai;
    expect(entry).toBeDefined();
    // 构建产物存在性（不强制 —— 单测可能在未 build 时跑，用条件断言）
    const full = path.join(process.cwd(), entry as string);
    if (existsSync(full)) {
      expect(statSync(full).size).toBeGreaterThan(0);
    }
  });
});
