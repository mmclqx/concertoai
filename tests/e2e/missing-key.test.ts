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
