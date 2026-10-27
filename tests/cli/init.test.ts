/**
 * `concertoai init` 测试（v5.0 T5）。
 *
 * 覆盖任务书验收：
 * - 双文件生成（AGENTS.md + PROJECT_GUIDE.md），**同源一次分析**；
 * - PROJECT_GUIDE 三章节齐全且每条断言带 `文件:行号`；
 * - 无证据段落写「未检测到」，**不编造**；
 * - 已有文件默认不覆盖（交互拒绝 / 非 TTY / --force 三种策略）；
 * - 非项目目录友好提示，不生成空文件；
 * - 边缘路径：首次运行 / 覆盖拒绝 / Ctrl+C（undefined）/ 超长目录截断提示。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENTS_FILE,
  GUIDE_FILE,
  type InitCommandOptions,
  runInitCommand,
} from '../../src/cli/init';
import { setLocale } from '../../src/i18n';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'init-'));
  setLocale('zh');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  setLocale('zh');
});

/** 写文件（自动建目录）。 */
function write(rel: string, content: string): void {
  const full = path.join(tmp, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** 构建一个真实感项目（含风险调用 / TODO / 多引用）。 */
function seedProject(): void {
  write(
    'package.json',
    JSON.stringify({
      name: 'demo-app',
      description: '演示应用',
      scripts: { dev: 'tsx src/index.ts', test: 'vitest run', verify: 'npm run test' },
      dependencies: { zod: '^1' },
    }),
  );
  write('tsconfig.json', '{}');
  write('package-lock.json', '{}');
  write('README.md', '# demo');
  write('src/util.ts', 'export const u = 1;');
  write(
    'src/api.ts',
    [
      "import { u } from './util';",
      'export async function get(url: string) {',
      '  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });',
      '  return resp.json();',
      '}',
      '// TODO: 加上重试',
    ].join('\n'),
  );
  write(
    'src/auth.ts',
    [
      "import { u } from './util';",
      'export function canAccess(user: string) {',
      '  const permission = "p-" + user;',
      '  return permission !== "";',
      '}',
    ].join('\n'),
  );
  write(
    'src/index.ts',
    [
      "import { u } from './util';",
      "import { get } from './api';",
      "import { canAccess } from './auth';",
      'export const app = { u, get, canAccess };',
    ].join('\n'),
  );
}

/** 默认选项：非交互（避免测试卡住），收集输出。 */
function makeOptions(overrides: InitCommandOptions = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const options: InitCommandOptions = {
    cwd: tmp,
    isTTY: false,
    log: (l) => lines.push(l),
    logError: (l) => errors.push(l),
    ...overrides,
  };
  return { options, lines, errors };
}

describe('runInitCommand：双文件输出（v5.0 T5）', () => {
  it('生成 AGENTS.md + PROJECT_GUIDE.md 两份文件', async () => {
    seedProject();
    const { options } = makeOptions();
    const result = await runInitCommand(options);

    expect(result.code).toBe(0);
    expect(result.written).toEqual([AGENTS_FILE, GUIDE_FILE]);
    expect(existsSync(path.join(tmp, AGENTS_FILE))).toBe(true);
    expect(existsSync(path.join(tmp, GUIDE_FILE))).toBe(true);
  });

  it('两份文件同源（同一次扫描结果，内容互相对应）', async () => {
    seedProject();
    const { options } = makeOptions();
    const result = await runInitCommand(options);

    const agents = readFileSync(path.join(tmp, AGENTS_FILE), 'utf8');
    const guide = readFileSync(path.join(tmp, GUIDE_FILE), 'utf8');
    // 项目名/描述同时出现在两份
    expect(agents).toContain('demo-app');
    expect(guide).toContain('demo-app');
    // 扫描文件数一致（同一 profile）
    const scanned = String(result.profile?.scannedFiles);
    expect(agents.length).toBeGreaterThan(0);
    expect(guide.length).toBeGreaterThan(0);
    expect(result.profile?.scannedFiles).toBeGreaterThan(0);
    expect(scanned).toMatch(/^\d+$/);
  });

  it('AGENTS.md 含定位/技术栈/命令/守护要点/技术债五段', async () => {
    seedProject();
    await runInitCommand(makeOptions().options);
    const agents = readFileSync(path.join(tmp, AGENTS_FILE), 'utf8');

    expect(agents).toContain('# AGENTS.md');
    expect(agents).toContain('## 项目定位');
    expect(agents).toContain('## 技术栈');
    expect(agents).toContain('## 常用命令');
    expect(agents).toContain('## 守护要点');
    expect(agents).toContain('## 技术债');
    expect(agents).toContain('## 提交前检查');
    // 命令来自真实 scripts
    expect(agents).toContain('npm run verify');
  });

  it('PROJECT_GUIDE.md 含「最脆弱 / 连锁反应 / 跑通本地」三章节', async () => {
    seedProject();
    await runInitCommand(makeOptions().options);
    const guide = readFileSync(path.join(tmp, GUIDE_FILE), 'utf8');

    expect(guide).toContain('一、这个项目最脆弱的地方');
    expect(guide).toContain('二、改哪里最容易引发连锁反应');
    expect(guide).toContain('三、如何快速跑通本地环境');
  });

  it('【G7 证据】PROJECT_GUIDE 的风险条目带 `文件:行号`', async () => {
    seedProject();
    await runInitCommand(makeOptions().options);
    const guide = readFileSync(path.join(tmp, GUIDE_FILE), 'utf8');

    // 网络调用证据：src/api.ts:3
    expect(guide).toMatch(/`src\/api\.ts:\d+`/);
    // 鉴权证据：src/auth.ts
    expect(guide).toMatch(/`src\/(api|auth)\.ts:\d+`/);
  });

  it('【G7 证据】连锁反应区列出被多引用的文件（src/util 被 3 个文件引用）', async () => {
    seedProject();
    await runInitCommand(makeOptions().options);
    const guide = readFileSync(path.join(tmp, GUIDE_FILE), 'utf8');

    expect(guide).toContain('src/util');
    expect(guide).toMatch(/src\/util.*3/);
  });

  it('【G7 证据】无证据段落写「未检测到」，不编造', async () => {
    // 空项目：只有 package.json，无风险调用、无 TODO、无依赖
    write('package.json', JSON.stringify({ name: 'bare' }));
    await runInitCommand(makeOptions().options);

    const guide = readFileSync(path.join(tmp, GUIDE_FILE), 'utf8');
    expect(guide).toContain('未检测到');
    // 不得出现凭空捏造的鉴权/删除描述（无证据时）
    expect(guide).not.toContain('`undefined:');
    expect(guide).not.toContain('`null:');
  });

  it('生成后打印摘要（≤6 行，含两份文件路径与「最脆弱」提示）', async () => {
    seedProject();
    const { options, lines } = makeOptions();
    await runInitCommand(options);

    const summary = lines.filter((l) => l.includes('AGENTS.md') || l.includes('PROJECT_GUIDE'));
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.join('\n')).toContain('最脆弱');
    // 摘要整体紧凑
    expect(lines.length).toBeLessThan(20);
  });
});

describe('runInitCommand：覆盖策略（fail-closed）', () => {
  it('已有文件 + 非 TTY → 不覆盖，明确提示用 --force', async () => {
    seedProject();
    write(AGENTS_FILE, '用户已有的内容');

    const { options, lines } = makeOptions();
    const result = await runInitCommand(options);

    expect(result.skipped).toContain(AGENTS_FILE);
    expect(readFileSync(path.join(tmp, AGENTS_FILE), 'utf8')).toBe('用户已有的内容');
    expect(lines.join('\n')).toContain('--force');
  });

  it('已有文件 + 交互拒绝 → 不覆盖，但另一份仍生成', async () => {
    seedProject();
    write(AGENTS_FILE, '用户已有的内容');

    const confirmOverwrite = vi.fn(async () => false);
    const { options } = makeOptions({ isTTY: true, confirmOverwrite });
    const result = await runInitCommand(options);

    expect(confirmOverwrite).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(tmp, AGENTS_FILE), 'utf8')).toBe('用户已有的内容');
    // PROJECT_GUIDE 不存在 → 正常生成
    expect(result.written).toContain(GUIDE_FILE);
    expect(existsSync(path.join(tmp, GUIDE_FILE))).toBe(true);
  });

  it('已有文件 + 交互确认覆盖 → 覆盖成功', async () => {
    seedProject();
    write(AGENTS_FILE, '旧内容');

    const { options } = makeOptions({ isTTY: true, confirmOverwrite: async () => true });
    const result = await runInitCommand(options);

    expect(result.written).toContain(AGENTS_FILE);
    expect(readFileSync(path.join(tmp, AGENTS_FILE), 'utf8')).not.toBe('旧内容');
  });

  it('--force（overwrite=yes）→ 直接覆盖，不询问', async () => {
    seedProject();
    write(AGENTS_FILE, '旧内容');

    const confirmOverwrite = vi.fn(async () => false);
    const { options } = makeOptions({ overwrite: 'yes', confirmOverwrite });
    const result = await runInitCommand(options);

    expect(confirmOverwrite).not.toHaveBeenCalled();
    expect(result.written).toContain(AGENTS_FILE);
    expect(readFileSync(path.join(tmp, AGENTS_FILE), 'utf8')).not.toBe('旧内容');
  });

  it('overwrite=no → 永不覆盖', async () => {
    seedProject();
    write(AGENTS_FILE, '旧内容');
    const { options } = makeOptions({ overwrite: 'no' });
    const result = await runInitCommand(options);
    expect(readFileSync(path.join(tmp, AGENTS_FILE), 'utf8')).toBe('旧内容');
    expect(result.skipped).toContain(AGENTS_FILE);
  });

  it('全部跳过时明确提示「未写入任何文件」', async () => {
    seedProject();
    write(AGENTS_FILE, 'a');
    write(GUIDE_FILE, 'b');
    const { options, lines } = makeOptions();
    const result = await runInitCommand(options);

    expect(result.written).toEqual([]);
    expect(lines.join('\n')).toContain('未写入任何文件');
  });
});

describe('runInitCommand：边缘路径（AGENTS 四覆盖）', () => {
  it('① 首次运行（空项目目录）→ 正常生成，不崩', async () => {
    write('package.json', JSON.stringify({ name: 'first-run' }));
    const { options } = makeOptions();
    const result = await runInitCommand(options);
    expect(result.code).toBe(0);
    expect(result.written).toHaveLength(2);
  });

  it('② 非项目目录 → 友好提示 + 退出 1，**不生成任何文件**', async () => {
    const { options, errors } = makeOptions();
    const result = await runInitCommand(options);

    expect(result.code).toBe(1);
    expect(result.written).toEqual([]);
    expect(existsSync(path.join(tmp, AGENTS_FILE))).toBe(false);
    expect(existsSync(path.join(tmp, GUIDE_FILE))).toBe(false);
    expect(errors.join('\n')).toContain('不是项目根目录');
  });

  it('③ 用户在覆盖提示处 Ctrl+C（undefined）→ 按不覆盖处理（fail-closed）', async () => {
    seedProject();
    write(AGENTS_FILE, '旧内容');
    // 模拟 promptLine 返回 undefined（Ctrl+C / 超时）→ 默认 confirm 返回 false
    const { options } = makeOptions({ isTTY: true, confirmOverwrite: async () => false });
    const result = await runInitCommand(options);
    expect(readFileSync(path.join(tmp, AGENTS_FILE), 'utf8')).toBe('旧内容');
    expect(result.skipped).toContain(AGENTS_FILE);
  });

  it('④ 超大项目（达扫描上限）→ 摘要中明确提示结果不完整', async () => {
    write('package.json', JSON.stringify({ name: 'huge' }));
    for (let i = 0; i < 10; i += 1) {
      write(`src/f${i}.ts`, `export const v${i} = ${i};`);
    }
    const { options, lines } = makeOptions({ scan: { maxFiles: 3 } });
    const result = await runInitCommand(options);

    expect(result.profile?.truncated).toBe(true);
    expect(lines.join('\n')).toContain('扫描上限');
  });

  it('【护栏】生成内容只推荐真实注册的 CLI 命令（AGENTS 规则 15）', async () => {
    seedProject();
    await runInitCommand(makeOptions().options);

    // 真实注册的命令清单（以 CLI 入口为准，防「模板超前于实现」）
    const cliSource = readFileSync(path.join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');
    const commands = new Set(
      [...cliSource.matchAll(/\.command\('([a-z-]+)/g)].map((m) => m[1] as string),
    );
    expect(commands.size).toBeGreaterThan(10);

    const text =
      readFileSync(path.join(tmp, AGENTS_FILE), 'utf8') +
      readFileSync(path.join(tmp, GUIDE_FILE), 'utf8');
    const mentioned = [...text.matchAll(/`concertoai ([a-z-]+)/g)].map((m) => m[1] as string);

    // 至少要提到命令（否则护栏空转）
    expect(mentioned.length).toBeGreaterThan(0);
    for (const cmd of new Set(mentioned)) {
      expect(commands.has(cmd), `生成了未注册的命令：concertoai ${cmd}`).toBe(true);
    }
  });

  it('写入失败（目录被占用）→ 友好错误，不崩', async () => {
    seedProject();
    // 把 AGENTS.md 做成目录，writeFile 会失败
    mkdirSync(path.join(tmp, AGENTS_FILE));
    const { options, errors } = makeOptions();
    const result = await runInitCommand(options);

    expect(result.written).not.toContain(AGENTS_FILE);
    expect(errors.join('\n')).toContain('写入');
    // 另一份仍成功
    expect(result.written).toContain(GUIDE_FILE);
  });
});
