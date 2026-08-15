/**
 * 工作流运行前环境预检测试（v4.1 T1.4，客户评价问题 1）。
 *
 * 覆盖：extractNpmScripts 提取 / checkPrerequisites（脚本缺失、依赖未装、
 * 配置缺失、正常就绪）/ summarizeAutoInit 去重 / applyAutoInitWrites 写
 * package.json + 配置文件 / binExists Windows 兼容。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAutoInitWrites,
  autoInitForScript,
  binExists,
  checkPrerequisites,
  extractNpmScripts,
  summarizeAutoInit,
} from '../../src/workflow/preflight';
import type { Workflow } from '../../src/workflow/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-preflight-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePkg(pkg: Record<string, unknown>): void {
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
}

const precommit: Workflow = {
  name: 'precommit',
  steps: [
    { name: 'lint', run: 'npm run lint' },
    { name: 'typecheck', run: 'npm run typecheck' },
    { name: 'test', run: 'npm run test -- --silent', depends: ['lint', 'typecheck'] },
  ],
};

describe('extractNpmScripts', () => {
  it('提取 npm run 引用的脚本（去重保序）', () => {
    const steps = [
      { name: 'a', run: 'npm run lint' },
      { name: 'b', run: 'npm run lint && npm run typecheck' },
      { name: 'c', run: 'echo no script' },
    ];
    expect(extractNpmScripts(steps)).toEqual(['lint', 'typecheck']);
  });
});

describe('checkPrerequisites', () => {
  it('裸项目（无 package.json）→ 报告所有 npm 脚本缺失 + 依赖/配置缺失', () => {
    const result = checkPrerequisites(precommit, tmp);
    expect(result.ok).toBe(false);
    // lint / typecheck / test 三个脚本缺失
    const scripts = result.missing.filter((m) => m.kind === 'script').map((m) => m.name);
    expect(scripts).toEqual(['lint', 'typecheck', 'test']);
    // lint 可自动、typecheck 可自动、test 不可自动
    const lint = result.missing.find((m) => m.name === 'lint');
    expect(lint?.fix?.install).toBe('@biomejs/biome');
    const test = result.missing.find((m) => m.name === 'test');
    expect(test?.fix).toBeUndefined();
    // 依赖缺失（biome / tsc 均未装）
    expect(result.missing.some((m) => m.kind === 'dep' && m.name === 'biome')).toBe(true);
    expect(result.missing.some((m) => m.kind === 'dep' && m.name === 'typescript')).toBe(true);
    // 配置缺失（biome.json + tsconfig.json）
    expect(result.missing.some((m) => m.kind === 'config' && m.name === 'biome.json')).toBe(true);
    expect(result.missing.some((m) => m.kind === 'config' && m.name === 'tsconfig.json')).toBe(
      true,
    );
    // tsconfig.json 缺失项可自动修复（写入默认 tsconfig）
    const tsconfig = result.missing.find((m) => m.name === 'tsconfig.json');
    expect(tsconfig?.fix?.writeFile?.file).toBe('tsconfig.json');
  });

  it('脚本已配置但依赖未装 → 只报依赖缺失（可自动安装）', () => {
    writePkg({
      scripts: { lint: 'biome check .', typecheck: 'tsc --noEmit', test: 'vitest run' },
    });
    const result = checkPrerequisites(precommit, tmp);
    expect(result.missing.some((m) => m.kind === 'script')).toBe(false);
    expect(result.missing.some((m) => m.kind === 'dep' && m.name === 'biome')).toBe(true);
    expect(result.missing.some((m) => m.kind === 'dep' && m.name === 'typescript')).toBe(true);
  });

  it('半完成状态（依赖已装但脚本缺失）→ lint fix 不含 install（只补 scripts+配置）', () => {
    // 模拟「npm install 成功但写 JSON 失败」后的状态：biome 已装但 scripts 缺 lint
    mkdirSync(path.join(tmp, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(tmp, 'node_modules', '.bin', 'biome.cmd'), '@echo off', 'utf8');
    writePkg({ name: 'demo' }); // 无 scripts.lint
    const result = checkPrerequisites(precommit, tmp);
    const lint = result.missing.find((m) => m.name === 'lint');
    expect(lint).toBeDefined();
    // 依赖已装 → fix 不再含 install（避免重复安装）
    expect(lint?.fix?.install).toBeUndefined();
    // 仍需补 scripts + biome.json（biome.json 也缺）
    expect(lint?.fix?.addScript?.name).toBe('lint');
    expect(lint?.fix?.writeFile?.file).toBe('biome.json');
  });

  it('半完成状态（脚本缺失但 biome.json 已存在）→ lint fix 不含 writeFile', () => {
    writeFileSync(path.join(tmp, 'biome.json'), '{}', 'utf8');
    writePkg({ name: 'demo' });
    const result = checkPrerequisites(precommit, tmp);
    const lint = result.missing.find((m) => m.name === 'lint');
    expect(lint?.fix?.writeFile).toBeUndefined();
    expect(lint?.fix?.install).toBe('@biomejs/biome'); // 依赖仍缺 → 保留 install
  });

  it('脚本 + 依赖 + 配置齐全 → ok（环境就绪）', () => {
    writePkg({
      scripts: { lint: 'biome check .', typecheck: 'tsc --noEmit', test: 'vitest run' },
    });
    mkdirSync(path.join(tmp, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(tmp, 'node_modules', '.bin', 'biome.cmd'), '@echo off', 'utf8');
    writeFileSync(path.join(tmp, 'node_modules', '.bin', 'tsc.cmd'), '@echo off', 'utf8');
    writeFileSync(path.join(tmp, 'biome.json'), '{}', 'utf8');
    writeFileSync(path.join(tmp, 'tsconfig.json'), '{}', 'utf8');
    const result = checkPrerequisites(precommit, tmp);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('binExists Windows 兼容（.cmd 后缀命中）', () => {
    mkdirSync(path.join(tmp, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(tmp, 'node_modules', '.bin', 'biome.cmd'), '@echo off', 'utf8');
    expect(binExists(tmp, 'biome')).toBe(true);
  });
});

describe('autoInitForScript', () => {
  it('lint → biome 安装 + biome.json + scripts.lint', () => {
    const fix = autoInitForScript('lint');
    expect(fix?.install).toBe('@biomejs/biome');
    expect(fix?.writeFile?.file).toBe('biome.json');
    expect(fix?.addScript).toEqual({ name: 'lint', command: 'biome check .' });
  });

  it('默认 biome.json 使用 biome 2.x schema + preset（v4.1.1 P0，不再 deprecated recommended）', () => {
    const fix = autoInitForScript('lint');
    const biomeJson = JSON.parse(fix?.writeFile?.content ?? '{}') as {
      $schema?: string;
      linter?: { rules?: Record<string, unknown> };
    };
    // 2.x schema URL（1.9.4 在 biome 2.5.8 下报 schema 不匹配）
    expect(biomeJson.$schema).toMatch(
      /^https:\/\/biomejs\.dev\/schemas\/2\.\d+\.\d+\/schema\.json$/,
    );
    expect(biomeJson.$schema).not.toContain('1.9.4');
    // preset 替代 deprecated 的 recommended: true
    expect(biomeJson.linter?.rules?.preset).toBe('recommended');
    expect(biomeJson.linter?.rules?.recommended).toBeUndefined();
  });

  it('typecheck → typescript 安装 + scripts.typecheck + tsconfig.json 生成（v4.1.1 P0）', () => {
    const fix = autoInitForScript('typecheck');
    expect(fix?.install).toBe('typescript');
    expect(fix?.addScript?.command).toBe('tsc --noEmit');
    // v4.1.1 P0：裸项目无 tsconfig.json 时 tsc 打印 help → 自动初始化必须生成
    expect(fix?.writeFile?.file).toBe('tsconfig.json');
    const tsconfig = JSON.parse(fix?.writeFile?.content ?? '{}') as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
    };
    expect(tsconfig.compilerOptions?.noEmit).toBe(true);
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(tsconfig.include).toContain('**/*.ts');
  });

  it('test → 不可自动（无法猜框架）', () => {
    expect(autoInitForScript('test')).toBeUndefined();
  });
});

describe('summarizeAutoInit + applyAutoInitWrites', () => {
  it('去重并汇总动作（install/write/script 各一份）', () => {
    const actions = [
      {
        install: '@biomejs/biome',
        writeFile: { file: 'biome.json', content: '{}' },
        addScript: { name: 'lint', command: 'biome check .' },
      },
      { install: '@biomejs/biome' }, // 重复 install 去重
      { addScript: { name: 'lint', command: 'biome check .' } }, // 重复 script 去重
    ];
    const plan = summarizeAutoInit(actions);
    expect(plan.commands).toEqual(['npm install -D @biomejs/biome --no-audit --no-fund']);
    expect(plan.writes).toEqual(['biome.json']);
    expect(plan.unique.filter((a) => a.addScript !== undefined)).toHaveLength(1);
  });

  it('applyAutoInitWrites 写入 package.json scripts + 配置文件', () => {
    writePkg({ name: 'demo', scripts: { test: 'vitest run' } });
    const err = applyAutoInitWrites(
      [
        { addScript: { name: 'lint', command: 'biome check .' } },
        { writeFile: { file: 'biome.json', content: '{}' } },
      ],
      tmp,
    );
    expect(err).toBeUndefined();
    const pkg = JSON.parse(readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint).toBe('biome check .');
    expect(pkg.scripts.test).toBe('vitest run'); // 保留原有脚本
    expect(readFileSync(path.join(tmp, 'biome.json'), 'utf8')).toBe('{}');
  });

  it('package.json 不存在 → 返回错误（不抛异常）', () => {
    const err = applyAutoInitWrites(
      [{ addScript: { name: 'lint', command: 'biome check .' } }],
      tmp,
    );
    expect(err).toContain('package.json');
  });
});
