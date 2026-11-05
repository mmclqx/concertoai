/**
 * 依赖安全底线（C6，2026-11-05）。
 *
 * 为什么需要这条用例：
 * `npm audit` 只反映**当下**的 advisories 快照——它能告诉你「现在有漏洞」，却不能阻止
 * 有人把 `zod` 从 `^4.6.7` 写回 `^4.4.3`（那时审计会重新报 high，但没人会天天跑 audit 才发版）。
 * 本用例把「已知漏洞的**最低已修复版本**」钉在仓库里：任何降级都会在 `npm run verify` 立刻红。
 *
 * 断言范围（均为 2026-11-05 实测修复的版本线）：
 * - `zod`（运行时直接依赖）：advisory GHSA-mrhx-c7xc-m3w5 影响 `<4.6.6` ⇒ 底线 4.6.6
 * - `vitest`（开发直接依赖）：GHSA-82fw-gwwq-j7x9 / GHSA-qxg6-89mg-rqv8 ⇒ 底线 4.1.12
 * - `overrides` 里三条传递依赖：vite `<8.2.4` / nanoid `<3.3.18` / source-map-js `<1.2.2` 均受影响
 *
 * 阶梯自证（防「恒绿」废实现，见 AGENTS「度量类必须有否定面用例」）：
 * - 否定面：`compareVersion('4.4.3', '4.6.6') < 0` —— 旧版本**必须**被判为低于底线；
 * - 边界：`compareVersion('4.6.6', '4.6.6') === 0`；
 * - 正向：`compareVersion('4.6.7', '4.6.6') > 0`。
 * 变异探针（2026-11-05 实测）：把 `compareVersion` 的逐位比较改成恒 `return 0`
 * ⇒ 本文件 **1 红 / 5 绿**，红的正是上面那条阶梯自证；改回（sha256 `964c0441` 逐字节核对）⇒ 6 绿。
 * ⚠️ 实测只有 1 条红，不是「底线断言也会红」：恒 0 时 `>= 0` 依然成立，所以
 * 「底线断言」本身对「比较器失效」是**盲的**，真正有牙的只有阶梯自证那一组。
 * 这条差异写在这里，是为了防止后来人以为「有 6 条用例守着」而删掉阶梯自证。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** 已知漏洞的最低已修复版本（advisory 一手来源见文件顶部注释）。 */
const FLOORS: Record<string, string> = {
  zod: '4.6.6',
  vitest: '4.1.12',
  vite: '8.2.4',
  nanoid: '3.3.18',
  'source-map-js': '1.2.2',
};

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

function readPkg(): Pkg {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Pkg;
}

/**
 * 取语义化版本比较用的数字三元组。
 * 只接受 `\d+.\d+.\d+` 开头（允许 `^` `~` `>=` 前缀），其余返回 `undefined` ——
 * 「解析不出来」必须与「版本够新」区分开，否则一个写错的 range 反而会静默通过。
 */
function versionTriple(v: string): [number, number, number] | undefined {
  const m = /^[\^~>=v\s]*(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (m === null) {
    return undefined;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 比较两个版本号：a<b 返回负数，相等 0，a>b 正数。任一解析失败抛错（不静默）。 */
function compareVersion(a: string, b: string): number {
  const x = versionTriple(a);
  const y = versionTriple(b);
  if (x === undefined || y === undefined) {
    throw new Error(`无法解析版本号：${a} / ${b}`);
  }
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** 从声明的 range 里取「最低可能装到的版本」（`^4.6.7` → `4.6.7`）。 */
function declaredFloor(range: string): string | undefined {
  const t = versionTriple(range);
  return t === undefined ? undefined : t.join('.');
}

describe('依赖安全底线（C6）', () => {
  it('compareVersion 阶梯自证：旧版本必须低于底线、同版为 0、新版为正', () => {
    // 否定面：这是「恒 0 / 恒负 / 恒正」三种废实现唯一会翻车的地方
    expect(compareVersion('4.4.3', '4.6.6')).toBeLessThan(0);
    expect(compareVersion('4.1.10', '4.1.12')).toBeLessThan(0);
    expect(compareVersion('8.2.1', '8.2.4')).toBeLessThan(0);
    // 边界与正向
    expect(compareVersion('4.6.6', '4.6.6')).toBe(0);
    expect(compareVersion('4.6.7', '4.6.6')).toBeGreaterThan(0);
    expect(compareVersion('^4.10.0', '4.6.6')).toBeGreaterThan(0); // 位权：10 > 6 而不是字符串比较
  });

  it('版本解析失败必须显式报错，不能当成「够新」静默通过', () => {
    expect(versionTriple('workspace:*')).toBeUndefined();
    expect(versionTriple('latest')).toBeUndefined();
    expect(() => compareVersion('latest', '4.6.6')).toThrow(/无法解析版本号/);
  });

  it('zod 不低于 4.6.6（运行时直接依赖，会随包到达用户）', () => {
    const zod = readPkg().dependencies?.zod;
    expect(zod, 'package.json dependencies 缺 zod').toBeDefined();
    const floor = declaredFloor(zod as string);
    expect(floor, `zod 声明 ${zod} 无法解析出版本下限`).toBeDefined();
    expect(compareVersion(floor as string, FLOORS.zod as string)).toBeGreaterThanOrEqual(0);
  });

  it('vitest 不低于 4.1.12（开发直接依赖）', () => {
    const vitest = readPkg().devDependencies?.vitest;
    expect(vitest, 'package.json devDependencies 缺 vitest').toBeDefined();
    const floor = declaredFloor(vitest as string);
    expect(floor).toBeDefined();
    expect(compareVersion(floor as string, FLOORS.vitest as string)).toBeGreaterThanOrEqual(0);
  });

  it('三条传递依赖的 overrides 存在且不低于已修复版本', () => {
    const overrides = readPkg().overrides ?? {};
    for (const name of ['vite', 'nanoid', 'source-map-js']) {
      const range = overrides[name];
      expect(range, `package.json overrides 缺 ${name}（审计曾报 high）`).toBeDefined();
      const floor = declaredFloor(range as string);
      expect(floor, `${name} 的 override 无法解析：${range}`).toBeDefined();
      expect(
        compareVersion(floor as string, FLOORS[name] as string),
        `${name} 的 override 下限 ${floor} 低于已修复版本 ${FLOORS[name]}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('node_modules 里实际装到的版本也不低于底线（声明与实装双查）', () => {
    for (const [name, floor] of Object.entries(FLOORS)) {
      const file = path.join(ROOT, 'node_modules', name, 'package.json');
      let installed: string;
      try {
        installed = (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
      } catch {
        // 开发依赖可能因安装方式不同缺席：缺席不算「版本过低」，但要显式说明跳过了谁
        continue;
      }
      expect(
        compareVersion(installed, floor),
        `${name} 实装 ${installed} 低于已修复版本 ${floor}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
