/**
 * 端点点不通的端到端体验测试（K17）。
 *
 * ## 为什么必须有这一层（不能只靠单测）
 *
 * 单测能断言「`normalizeFetchError` 抛什么类型」「`describeFatalError` 返回什么对象」，
 * 但 K17 的用户症状发生在**三层之外**：`runLoop` → `runTask` → **commander action 有没有
 * 包 `safeAction`** → crash-handler。前两层随便哪层忘了接，异常都会以
 * `unhandledRejection` 落到 `crash-handler`，把「端点配错」渲染成「程序崩了 + undici 堆栈」。
 * 这条链路只有真起一个进程才测得出来。
 *
 * ## 探针必须通电（AGENTS「注入类必须先自证」）
 *
 * 「stderr 里没有 `TypeError`」这条断言**单独看没有证据力**：Key 缺失早退、参数解析失败、
 * 进程根本没跑起来，都能让它绿。所以这里同时断言：
 * - stderr **必须包含被注入的 baseUrl**（证明配置真被读到，失败真的发生在网络层）；
 * - 退出码 1（证明走的是错误路径而不是提前成功）。
 *
 * ## 成本
 *
 * ¥0：假 Key + 本机必然无监听的端口，请求出不了本机。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();

/**
 * 断言用的端点：本机高位端口，必然无人监听 → `ECONNREFUSED`。
 *
 * 刻意**不用** `127.0.0.1:9`（K17 现场用的那个）：9 属于 fetch 规范里的禁用端口，
 * Node 报的是 `bad port` 而不是真正的连接失败。两种形态都要被测到（单测覆盖 bad port，
 * 这里覆盖真实拒绝连接），否则「归一逻辑只认 code」这类漏网会再次发生。
 */
const BASE_URL = 'http://127.0.0.1:59999/v1';
const FULL_URL = `${BASE_URL}/chat/completions`;
const CRASH_MARK = '未处理的 Promise 拒绝';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'ccai-k17-e2e-'));
  // 隔离 HOME：写一份只指向本机死端口的配置（含假 Key，绝不外发）
  const dir = path.join(tmpHome, '.concertoai');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: { deepseek: { apiKey: 'sk-k17-e2e-fake', baseUrl: BASE_URL } },
      },
      null,
      2,
    ),
    'utf8',
  );
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** 去掉外部 Key 来源 + 钉死 locale（不依赖开发机 shell，AGENTS 全局状态隔离）。 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.LUMEN_API_KEY;
  env.LUMEN_LOCALE = 'zh';
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  return env;
}

/** 跑 CLI（Windows 下必须 shell:true）。 */
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

describe('E2E：端点点不通（K17）', () => {
  it('★ run：说清连不上哪个端点 + 给下一步，不砸堆栈、不写 crash.log', async () => {
    // 任务只用一个**不带空格的词**：`spawn(..., { shell: true })` 下参数会被 shell 重新分词，
    // 传 `'say hi'` 会变成两个 token → commander 报 `too many arguments for 'run'`，
    // 用例就变成「测参数解析」而不是「测端点不可达」（本轮实测踩到，靠下面的「探针通电」
    // 断言 `toContain(FULL_URL)` 才暴露——它红着告诉我：请根本没跑到网络层）。
    const { code, stderr } = await runCli(['run', 'hi'], isolatedEnv());

    // ① 失败但体面：退出码 1（fail-closed）
    expect(code).toBe(1);

    // ② 探针通电：配置真被读到 —— 端点原样出现在提示里
    expect(stderr).toContain(FULL_URL);

    // ③ 不砸屏：无未处理拒绝、无堆栈帧、不指向崩溃日志
    expect(stderr).not.toContain(CRASH_MARK);
    expect(stderr).not.toContain('TypeError');
    expect(stderr).not.toContain('at async ');
    expect(stderr).not.toContain('crash.log');

    // ④ 给下一步：指向配置项，而不是「去反馈软件缺陷」
    expect(stderr).toContain('baseUrl');
    expect(stderr).not.toContain('软件缺陷');

    // ⑤ crash.log 没被这类错误污染（它只该记录真缺陷）
    expect(existsSync(path.join(tmpHome, '.concertoai', 'crash.log'))).toBe(false);
  }, 120_000);

  it('plan（--auto-approve）：同样不砸堆栈 —— 证明两个入口都包了 safeAction', async () => {
    // run 与 plan 此前**都**没包 safeAction。只测 run 会让「plan 忘了包」漏网，
    // 而 plan 的计划阶段同样会打模型。
    const { code, stderr } = await runCli(['plan', 'hi', '--auto-approve'], isolatedEnv());

    expect(code).toBe(1);
    expect(stderr).toContain(FULL_URL);
    expect(stderr).not.toContain(CRASH_MARK);
    expect(stderr).not.toContain('TypeError');
    expect(stderr).toContain('baseUrl');
  }, 120_000);

  it('反向自证：同一个隔离环境里 `--version` 正常退出（证明隔离配置本身没有把 CLI 打瘸）', async () => {
    // 没有这条，「所有命令都失败」也能让上面两条断言绿（比如隔离 HOME 写坏了配置）。
    const { code, stdout } = await runCli(['--version'], isolatedEnv());
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  it('英文环境：整段都是英文（含前缀），零中文 —— 证明文案真走字典而不是硬编码', async () => {
    // K17 收尾实测发现：兜底前缀 `[ConcertoAI] 命令执行失败:` 一直硬编码中文，
    // 于是 en 用户拿到「命令执行失败: Cannot reach the model endpoint…」中英混排。
    // 这条用例同时守住「en 无中文」与「zh 必须有中文」两个方向（防恒真的空断言）。
    const env = isolatedEnv();
    env.LUMEN_LOCALE = 'en';
    const { code, stderr } = await runCli(['run', 'hi'], env);

    expect(code).toBe(1);
    // 端点仍是硬事实（与语言无关）
    expect(stderr).toContain(FULL_URL);
    expect(stderr).not.toMatch(/[\u4e00-\u9fff]/);

    // 反向自证：同一命令在 zh 下必须含中文（否则「en 无中文」可被「什么都没打印」骗过）
    const zhRun = await runCli(['run', 'hi'], isolatedEnv());
    expect(zhRun.stderr).toMatch(/[\u4e00-\u9fff]/);
  }, 120_000);
});
