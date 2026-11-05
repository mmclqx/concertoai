/**
 * 缺 API Key 端到端引导测试（v5.0 T1）。
 *
 * 真实子进程跑 CLI 入口，验证「新用户第一次运行」体验（AGENTS 边缘路径第 ①条）：
 * - 无 Key 时不静默崩溃、不抛 unhandledRejection，而是给出三种可复制的配置方式；
 * - `--version` 等不依赖 Key 的命令不被阻断（不能把无关命令一起卡死）。
 *
 * 隔离措施：清空 DEEPSEEK_API_KEY + 把 HOME/USERPROFILE 指向临时目录，
 * 避免读到开发机上真实的 ~/.concertoai/accounts（否则测试结果随机器而变）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 项目根目录（vitest 以项目根为 cwd 运行）。 */
const PROJECT_ROOT = process.cwd();

let tmpHome: string;

/** 去掉 Key 来源 + 隔离 home 的环境变量。 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.LUMEN_API_KEY;
  // v5.0 T22：入口按 LUMEN_LOCALE > LANG 在 commander 解析前定语言，不钉死会随开发机
  // shell 漂移——本文件断言的是中文引导文案，在英文环境的机器上会全红
  // （同 v3.3「shell 预设 LUMEN_LOCALE 导致 config.test.ts 假失败」的教训）。
  env.LUMEN_LOCALE = 'zh';
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  return env;
}

/** 跑 CLI（Windows 下必须 shell:true，见 tests/e2e/platform-e2e.test.ts 教训）。 */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/cli/index.ts', ...args], {
      cwd: PROJECT_ROOT,
      shell: true,
      windowsHide: true,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'ccai-nokey-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('E2E：缺 API Key 引导（v5.0 T1）', () => {
  it('依赖 Key 的命令缺 Key → 三种配置方式 + 获取地址 + 退出码 1（非静默崩溃）', async () => {
    const { code, stderr } = await runCli(['balance'], isolatedEnv());

    // 退出码：非 0（fail-closed）但不是崩溃
    expect(code).toBe(1);

    // 三种方式都在（新用户照做就能跑通）
    expect(stderr).toContain('DEEPSEEK_API_KEY');
    expect(stderr).toContain('concertoai login');
    expect(stderr).toContain('"apiKey"');
    expect(stderr).toContain('https://platform.deepseek.com/api_keys');
    expect(stderr).toContain('concertoai doctor');

    // 非静默崩溃：不得出现未捕获异常痕迹
    expect(stderr).not.toContain('unhandledRejection');
    expect(stderr).not.toContain('UnhandledPromiseRejection');
    expect(stderr).not.toContain('ERR_UNHANDLED');

    // 不得是"空输出直接退出"（v4.1.1 preflight 静默退出教训）
    expect(stderr.trim().length).toBeGreaterThan(50);
  }, 30_000);

  it('不依赖 Key 的命令（--version）不被缺 Key 阻断', async () => {
    const { code, stdout } = await runCli(['--version'], isolatedEnv());
    expect(code).toBe(0);
    // 版本号形如 x.y.z
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);
});

/**
 * C3 的入口级护栏：**「先说什么」也是行为**（v5.0 自审发现，2026-11-05 修复）。
 *
 * ## 为什么单测不够，非要真起进程
 *
 * C3 的 bug 不在 `runReviewCommand` 里 —— 那函数内部的顺序一直是对的
 * （范围 → Key）。bug 在**入口**：`src/cli/index.ts` 的 review 块先
 * `needsVerbApiKey(runtime) ? await getApiKey() : …`，而 `getApiKey()` 缺 Key 时
 * 打印完整引导并 `process.exit(1)`，于是命令内部「不是 git 仓库 / 没有改动」的分支
 * **永远轮不到执行**。任何只调 `runReviewCommand` 的用例都测不到这段 —— 它在上一行
 * 就把进程结束了。
 *
 * 证据形态（修复前后同一环境、同一命令，实测）：
 * - 修复前：`stdout` 空、`stderr` = 三种配置方式的长引导、`exit 1`；
 * - 修复后：`stdout` = `❌ 当前目录不是 git 仓库…` + `💡 请显式指定要审查的路径`、`stderr` 空。
 *
 * ## 探针必须通电
 *
 * 「stderr 里没有 Key 引导」单独看没有证据力（进程没起来、命令名敲错、引导整段被删掉，
 * 都能让它绿）。所以第二条用例是**正例对照**：同一隔离环境里给一个显式范围，
 * 引导必须照常出现。两条一起才证明「该说的时候说、不该说的时候不说」。
 *
 * 成本：¥0（缺 Key 状态下请求根本发不出去）。
 */
describe('E2E：review 的判定顺序（C3：先说「没东西可审」，再说「缺 Key」）', () => {
  /** 空临时目录：**不是** git 仓库，也没有任何改动可审。 */
  let tmpCwd: string;

  /**
   * tsx 运行时与 CLI 入口的**绝对路径**。
   *
   * 两个都必须绝对：cwd 换到了临时目录，相对路径 `src/cli/index.ts` 在那里不存在。
   * 而 `tsx` 的调用形态是 `tsx <脚本> [参数…]`——**脚本必须显式给**。第一版漏了它
   * （只传 `[TSX_ENTRY, ...args]`），tsx 就把 `review` 当成脚本路径，报
   * `ERR_MODULE_NOT_FOUND: …/review` 并 exit 1；而用例里 `expect(code).toBe(1)`
   * **照样通过**，真正抓出问题的是下一条「stdout 含『不是 git 仓库』」——
   * 「断言退出码」这类弱断言在进程根本没跑起来时会假绿（探针空转，AGENTS 反复记的坑）。
   */
  const TSX_ENTRY = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const CLI_ENTRY = path.join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

  beforeEach(() => {
    tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'ccai-c3-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /**
   * 在指定目录跑 CLI。
   *
   * 与上面的 `runCli` 分开是有意的：那个走 `npx tsx src/cli/index.ts`（依赖 cwd = 项目根），
   * 而本组用例必须**换 cwd**（要一个非 git 的空目录），所以入口用绝对路径、不经 npx
   * （npx 会去 cwd 里找 `src/cli/index.ts`，找到的是空目录 → 报「找不到文件」，
   * 用例就变成测「路径写错」而不是测顺序）。
   */
  function runCliIn(
    cwd: string,
    args: string[],
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_ENTRY, CLI_ENTRY, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        env: isolatedEnv(),
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  it('★ 非 git 空目录 + 缺 Key → 先说「不是 git 仓库」，且一个字都不提 Key', async () => {
    const { code, stdout, stderr } = await runCliIn(tmpCwd, ['review']);

    // ① 不冒充通过：依然 exit 1（「判不了」不等于「审完没问题」）
    expect(code).toBe(1);
    // ② 说的是用户此刻真正的问题，且给了下一步
    //    诊断信息带上 stderr：这条断言就是抓「进程根本没跑起来」的那一条
    //   （exit code 断言在 ERR_MODULE_NOT_FOUND 时同样成立，见上方 TSX_ENTRY 注释）
    expect(stdout, `stderr=${stderr}`).toContain('不是 git 仓库');
    expect(stdout).toContain('concertoai review');
    // ③ 靶子断言：不许抢先让用户去配 Key（stdout / stderr 都要看 —— 引导走的是 stderr）
    expect(stdout).not.toContain('审查需要 API Key');
    expect(stderr).not.toContain('DEEPSEEK_API_KEY');
    expect(stderr).not.toContain('未检测到 DeepSeek API Key');
    // ④ 没有崩溃痕迹（不能把「说错话」修成「崩掉」）
    expect(stderr).not.toContain('unhandledRejection');
    expect(stderr).not.toContain('TypeError');
  }, 120_000);

  it('★ 正例对照：有范围 + 缺 Key → Key 提示与完整三种配置引导照常出现', async () => {
    // 没有这一条，上面那条的 `not.toContain` 可能只是「引导整段丢了」造成的假绿。
    // 显式路径不需要真实存在（review 的 given 分支只校验范围形状，不校验磁盘），
    // 所以这里刻意用一个空目录里不存在的文件名——它证明的顺序，不是文件系统。
    const { code, stdout, stderr } = await runCliIn(tmpCwd, ['review', 'src/cli/review.ts']);

    expect(code).toBe(1);
    expect(stdout).toContain('审查需要 API Key');
    // 完整引导仍要给到（v5.0 T1 的标杆文案：三种真实生效的配置方式 + 获取地址）
    expect(stderr).toContain('DEEPSEEK_API_KEY');
    expect(stderr).toContain('concertoai login');
    expect(stderr).toContain('platform.deepseek.com/api_keys');
    // 反向：这时候不该再冒出「不是 git 仓库」（给了路径就不查 git 了）
    expect(stdout).not.toContain('不是 git 仓库');
  }, 120_000);
});
