/**
 * `doctor` 诊断永不写盘（v5.3 N1，任务书 T1.3）。
 *
 * ## 为什么必须起真进程
 *
 * 「跑一次 doctor 会不会改我的配置」是一条**端到端**承诺，它同时经过：
 * `commander action` → `resolveApiKeyWithConfigFallback` → `readConfigDeepseekKey`
 * → `loadConfig` → `readConfigFile` → `migrateV3ToV4`（写盘点）。任何一环漏传 `readOnly`
 * 都只表现成「文件还是被改了」，进程内测某一环看不出断在哪。
 *
 * ## 探针纪律（任务书 §0.2，本轮实测踩过）
 *
 * 1. **探针必须通电**：`DEFAULT_CONFIG_PATH` 是**模块加载期**求值的常量
 *    （`config.ts` 的 `export const DEFAULT_CONFIG_PATH = configPath()`）⇒ 在进程内改
 *    `process.env.USERPROFILE` **无效**，读的还是真实 home。所以：
 *    ① 配置一律写到临时 home；② 起子进程时把 `HOME` / `USERPROFILE` 指过去；
 *    ③ 再加一条用例**断言子进程自己打印的 `configPath()` 落在临时 home 内**——
 *    否则「没写盘」可能只是「压根没读临时 home」，那是假绿。
 * 2. **判据只看磁盘**：`config.json` 的 sha256 + 有没有 `config.v3.bak`。
 *    **不看退出码**（无 Key 时 doctor 本来就 exit 1，与迁移无关）、不看屏幕文案。
 *
 * ## 变异探针（证明每条用例有牙，改坏了会红）
 *
 * | 探针 | 改法 | 必须红在 |
 * |---|---|---|
 * | M1 | `src/cli/index.ts` 去掉 `{ readOnly: true }` | 用例 1（无 Key）、用例 3（--vscode）、用例 4 |
 * | M2 | `src/cli/doctor.ts` 的 `diagnoseMetrics` 去掉 `readOnly: true` | **只有用例 2**（--metrics） |
 * | M3 | `readConfigFile` 里 `opts.migrate === false` 改成 `false`（只读分支永不生效） | 用例 1、2、3 |
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const TSX = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CONFIG_SRC = path.join(REPO_ROOT, 'src', 'store', 'config.ts');
const PATHS_SRC = path.join(REPO_ROOT, 'src', 'store', 'paths.ts');

let home: string;

/** v3 形态配置：`schemaVersion: 1` + 无 `defaultProvider` ⇒ `isV3Config` 判真（会触发迁移）。 */
const V3 = {
  schemaVersion: 1,
  defaultModel: 'deepseek-chat',
  locale: 'zh',
  pricingHolidays: { holidays: ['2026-01-01'] },
};

const configFile = (): string => path.join(home, '.concertoai', 'config.json');
const backupFile = (): string => `${configFile()}.v3.bak`;

/**
 * 起真 CLI（`doctor` 或自定义脚本）。
 *
 * env 逐项写清（不 `...process.env` 抄父进程）：
 * - `PATH`：**必须给**——子进程要找到 git / node（缺了会 `command not found`，且 Windows 上
 *   因 libuv 会补一组变量而**看不出来**，只在 POSIX CI 上炸，见 AGENTS 第 34 条同族教训）；
 * - `HOME` + `USERPROFILE`：把「家」指到临时目录（Windows 用后者，POSIX 用前者）；
 * - `LUMEN_LOCALE: ''`：钉死中文（不依赖开发机 shell）；
 * - **不传** `DEEPSEEK_API_KEY`：用例 1 的前提是「无 Key」。
 */
function spawnCli(args: string[]): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    // Windows 上部分库会读这两个，一并指到临时目录
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    LUMEN_LOCALE: '',
    LANG: '',
  };
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env,
  });
}

/** 起一个「只打印 `configPath()`」的探针脚本（**探针通电**自证用）。 */
function spawnConfigPathProbe(): ReturnType<typeof spawnSync> {
  const probe = path.join(home, 'probe-config-path.mts');
  writeFileSync(
    probe,
    [
      `import { configPath } from ${JSON.stringify(pathToFileURL(PATHS_SRC).href)};`,
      'console.log(configPath());',
      '',
    ].join('\n'),
    'utf8',
  );
  return spawnSync(process.execPath, [TSX, probe], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LUMEN_LOCALE: '' },
  });
}

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/** 写一份 v3 配置到临时 home，返回初始 `sha` 供前后对比。 */
function seedV3(): { sha: string } {
  const file = configFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(V3, null, 2)}\n`, 'utf8');
  return { sha: sha256(file) };
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-doctor-ro-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 每个用例共用的断言：文件字节不变 + 没有备份。 */
function expectUntouched(before: string, label: string): void {
  expect(sha256(configFile()), `${label}：config.json 必须一字不改`).toBe(before);
  expect(existsSync(backupFile()), `${label}：不得生成 config.v3.bak`).toBe(false);
}

describe('doctor 诊断永不写盘（N1 主判据：只看磁盘）', () => {
  it('v3 配置 + **无 Key** ⇒ 不迁移、不备份（配置保持 v3）', () => {
    const { sha } = seedV3();

    const r = spawnCli(['doctor']);
    const combined = `${r.stdout}${r.stderr}`;

    expectUntouched(sha, 'doctor（无 Key）');
    // 输出自洽：如实说「配置仍为 v3 格式」+「启动时会备份到哪」
    expect(combined).toContain('配置仍为 v3 格式');
    expect(combined).toContain('会自动把原配置备份到'); // 「启动时会备份到哪」而不是「不需要备份」
    // 否定面：绝不能出现「迁移完成」这种自相矛盾的结论
    expect(combined).not.toContain('v4 迁移完成');
  });

  it('v3 配置 + `--metrics` ⇒ 不写盘（M2 探针专抓这一条）', () => {
    /**
     * 这一条守的是**最容易被漏的那处**：Metrics 的配置读取不在 `doctor` 的 action 里，
     * 而在诊断项内部（`diagnoseMetrics` → `resolveMetricsEnabled` → `loadConfig`）。
     * 只修 Key 那条链时，用例 1/3 会绿、本用例必须红。
     */
    const { sha } = seedV3();

    const r = spawnCli(['doctor', '--metrics']);

    // 确认真的走到了指标诊断项（否则「没写盘」可能只是「--metrics 没生效」，本条空转）
    expect(r.stdout).toContain('本地体验指标');
    expectUntouched(sha, 'doctor --metrics');
  });

  it('v3 配置 + `--vscode` ⇒ 不写盘', () => {
    const { sha } = seedV3();

    const r = spawnCli(['doctor', '--vscode']);

    expect(`${r.stdout}${r.stderr}`).toContain('VS Code');
    expectUntouched(sha, 'doctor --vscode');
  });

  it('有 Key / 无 Key 两次跑出的磁盘状态**一致**（都不改文件）', () => {
    /**
     * 需求原文的判据：**「配不配 Key」不该改变命令的副作用**。
     * 修复前的形态正是：无 Key 走 `loadConfig` 迁移（写盘）、有 Key 停在只读检查（不写盘）
     * ——同一个命令、同一台机器，配置变不变取决于有没有配 Key，用户无法预期。
     */
    const { sha } = seedV3();

    const noKey = spawnCli(['doctor']);
    expectUntouched(sha, '第一次（无 Key）');

    // 第二次：带 Key（余额查询会失败，但**磁盘判据与它无关**）
    const withKeyEnv = { DEEPSEEK_API_KEY: 'sk-test-not-a-real-key' } as const;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      LUMEN_LOCALE: '',
      LANG: '',
      ...withKeyEnv,
    };
    const withKey = spawnSync(process.execPath, [TSX, CLI, 'doctor'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    });

    expect(`${withKey.stdout}${withKey.stderr}`).toContain('API Key: 已设置'); // 探针通电：确认 Key 真被读到
    expectUntouched(sha, '第二次（有 Key）');
    // 两次的磁盘状态必须一致（sha 相同 + 都没有备份）
    expect(sha256(configFile())).toBe(sha);
    expect(existsSync(backupFile())).toBe(false);
    // 无 Key 那次也不该因为「没配 Key」就产生不同副作用
    expect(noKey.status).toBeDefined();
  });
});

describe('探针通电自证（防「压根没读临时 home」的假绿）', () => {
  it('子进程打印的 `configPath()` 落在临时 home 内', () => {
    /**
     * 若这条红，说明上面所有「没写盘」都可能是**空转**：
     * 子进程读的是真实 `~/.concertoai/`，而我一直盯着临时目录。
     * 这也是任务书 §0.2 第 1 条的来历（第一版探针在进程内改 env，得到假绿）。
     */
    const r = spawnConfigPathProbe();
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    const printed = String(r.stdout).trim();
    expect(printed, `configPath() 应落在 ${home} 内`).toContain(home);
    expect(printed.endsWith(path.join('.concertoai', 'config.json'))).toBe(true);
    // 与用例里的路径**同源**：本文件断言的文件就是子进程会读的那个
    expect(printed).toBe(configFile());
  });
});

describe('源码护栏：只读分支里不许出现写盘动作', () => {
  it('`readConfigFile` 的 `migrate === false` 分支内无 migrateV3ToV4 / writeConfig / copyFile（配正例自证）', () => {
    /**
     * 这是「把纪律变成可执行断言」：只靠代码评审记不住「别在只读分支里顺手写盘」。
     * 正例自证（本用例前半段）：文件读到了、分支标记在、三个函数名在文件里**确实存在**
     * ——否则「找不到」既可能是「干净的」，也可能是「正则/变量名写错了」。
     */
    const src = readFileSync(CONFIG_SRC, 'utf8');

    // ① 正例自证：源码真的读到了，且分支标记与三个写盘函数名都在（尺子有读数）
    expect(src, '源码读取失败或路径写错').toContain('export async function loadConfigReadOnly');
    for (const name of ['migrateV3ToV4', 'writeConfig', 'copyFile']) {
      expect(src.includes(name), `正例自证：\`${name}\` 应在 config.ts 里存在`).toBe(true);
    }

    // ② 取出只读分支体（从标记到 return 行），断言其中没有写盘动作
    const marker = 'if (opts.migrate === false) {';
    const start = src.indexOf(marker);
    expect(start, '找不到只读分支标记（改结构必须同步改用例）').toBeGreaterThan(-1);
    const end = src.indexOf(
      '}',
      src.indexOf('return { schemaVersion: CONFIG_SCHEMA_VERSION, ...parsed };', start),
    );
    const branch = src.slice(start, end);
    expect(branch.length, '分支体取空了 ⇒ 护栏会恒绿').toBeGreaterThan(20);
    for (const forbidden of ['migrateV3ToV4(', 'writeConfig(', 'copyFile(']) {
      expect(branch.includes(forbidden), `只读分支内不得调用 \`${forbidden}\``).toBe(false);
    }
  });
});
