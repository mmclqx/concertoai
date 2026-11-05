/**
 * 第三方许可声明测试（v5.0 T4）。
 *
 * 目的：防止「许可证声明与实际依赖漂移」——脚本化生成的价值就在于可断言。
 * 覆盖：
 * - 7 个直接依赖全部出现在声明表；
 * - **许可证类型与 node_modules 实测一致**（本次发现计划书把 cli-highlight 误写 MIT，实际 ISC）；
 * - BSD-3-Clause 传递依赖（highlight.js）被显式声明（二进制分发须复现版权声明）；
 * - tiktoken 无 LICENSE 文件的事实被如实记录（不伪造原文）；
 * - LICENSES/ 中每个文件真实存在且非空；
 * - package.json files 包含声明文件（随包发布）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const NOTICES = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
const LICENSES_DIR = path.join(ROOT, 'LICENSES');

/** 直接运行时依赖（与 package.json dependencies 对应）。 */
const DIRECT_DEPS = ['chalk', 'cli-highlight', 'commander', 'ink', 'react', 'tiktoken', 'zod'];

function readNotices(): string {
  return readFileSync(NOTICES, 'utf8');
}

/** 递归收集 dist 下的 .js 产物（构建产物不参与类型检查，只读文本）。 */
function collectJs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectJs(full));
    } else if (entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

describe('THIRD_PARTY_NOTICES（v5.0 T4）', () => {
  it('声明文件存在', () => {
    expect(existsSync(NOTICES)).toBe(true);
    expect(readNotices().length).toBeGreaterThan(300);
  });

  it('7 个直接依赖全部列出', () => {
    const text = readNotices();
    for (const dep of DIRECT_DEPS) {
      expect(text).toContain(`\`${dep}\``);
    }
  });

  it('声明的许可证类型与 node_modules 实测一致（防漂移）', () => {
    const text = readNotices();
    for (const dep of DIRECT_DEPS) {
      const pkgPath = path.join(ROOT, 'node_modules', dep, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { license?: string };
      // 该依赖行必须同时包含包名与其真实许可证类型
      const line = text.split('\n').find((l) => l.includes(`\`${dep}\``));
      expect(line, `${dep} 未在声明表中`).toBeDefined();
      expect(line).toContain(String(pkg.license));
    }
  });

  it('cli-highlight 明确标为 ISC（不是 MIT——计划书曾写错）', () => {
    const line = readNotices()
      .split('\n')
      .find((l) => l.includes('`cli-highlight`'));
    expect(line).toContain('ISC');
  });

  it('highlight.js（BSD-3-Clause 传递依赖）被显式声明并复现版权', () => {
    const text = readNotices();
    expect(text).toContain('highlight.js');
    expect(text).toContain('BSD-3-Clause');
    // BSD-3 要求复现版权声明
    expect(text).toMatch(/highlight\.js@[\d.]+\*\* — BSD-3-Clause — Copyright/);
  });

  it('tiktoken 缺 LICENSE 文件的事实被如实记录（不伪造原文）', () => {
    const text = readNotices();
    expect(text).toContain('已知的许可证文件缺失');
    const tiktokenSection = text.slice(text.indexOf('已知的许可证文件缺失'));
    expect(tiktokenSection).toContain('tiktoken');
    // 不得伪造一份"看起来像 MIT 原文"的内容
    expect(tiktokenSection).toContain('package.json 声明');
  });

  it('LICENSES/ 下每个声明文件真实存在且非空', () => {
    const text = readNotices();
    const matches = [...text.matchAll(/\.\/LICENSES\/([^\s)]+)/g)].map((m) => m[1]);
    expect(matches.length).toBeGreaterThanOrEqual(DIRECT_DEPS.length);
    for (const file of new Set(matches)) {
      const full = path.join(LICENSES_DIR, file as string);
      expect(existsSync(full), `${file} 不存在`).toBe(true);
      expect(statSync(full).size, `${file} 为空`).toBeGreaterThan(0);
    }
  });

  it('package.json files 含声明文件（随包发布）', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
    expect(pkg.files).toContain('LICENSES');
  });

  it('声明文件由脚本生成（含自动生成标注）', () => {
    expect(readNotices()).toContain('gen-third-party-notices.mjs');
    expect(readNotices()).toContain('自动生成');
  });

  it('声明不再声称「依赖会被打包进产物」，与 dist 实测一致（C6，2026-11-05）', () => {
    const text = readNotices();

    // 否定面：旧版两句假话必须消失（它们曾让「漏洞随包到达用户」这个错误结论看起来很合理）
    expect(text).not.toContain('会被打包进产物');
    expect(text).not.toContain('运行时依赖会被打包进');

    // 正例：新声明明确写了「不打包」
    expect(text).toContain('不打包任何第三方依赖');

    // 真机校验 dist（`npm run verify` 先 build，故正常链路下 dist 一定在；
    // 单独 `npm test` 且从未 build 时跳过这一段，上面的文案断言仍在守）
    const distDir = path.join(ROOT, 'dist');
    if (!existsSync(distDir)) {
      return;
    }
    const js = collectJs(distDir).map((f) => readFileSync(f, 'utf8'));
    const all = js.join('\n');

    // 探针通电：先证明「搜索是有效的」——cli-highlight 的外链必须找得到，
    // 否则下面的 0 命中只说明我把 token 拼错了（AGENTS「检索类必须先自证探针」）
    expect(all, '探针失效：dist 里连 cli-highlight 的外链都搜不到').toContain(
      'import("cli-highlight")',
    );
    // 目标：highlight.js 没有被打进产物（否则「不打包」这句话又是假的）
    expect(all).not.toMatch(/\bhljs\b/);
    expect(all).not.toContain('registerLanguage');
  });
});
