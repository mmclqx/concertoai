import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ToolContext, ToolResult } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';
import {
  getPlatformAdapter,
  isAllowlisted,
  MAX_SHELL_OUTPUT_CHARS,
  shellTool,
} from '../../src/tools/shell';

let tmp: string;
let ctx: ToolContext;
let registry: ToolRegistry;
let approvalSpy: ReturnType<typeof vi.fn<(request: ApprovalRequest) => Promise<boolean>>>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  approvalSpy = vi.fn(async () => true);
  ctx = { cwd: tmp, requestApproval: approvalSpy };
  registry = new ToolRegistry().register(shellTool);
});

afterEach(async () => {
  // Windows 上被杀子进程的 cwd 句柄释放有延迟，删除重试避免 EBUSY
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

async function run(
  command: string,
  extra?: { timeoutMs?: number; ctx?: ToolContext },
): Promise<ToolResult> {
  return registry.run('run_command', { command, timeoutMs: extra?.timeoutMs }, extra?.ctx ?? ctx);
}

describe('isAllowlisted', () => {
  it('完全相等或后跟空格命中，词边界不误命中', () => {
    expect(isAllowlisted('npm test', ['npm test'])).toBe(true);
    expect(isAllowlisted('npm test -- --silent', ['npm test'])).toBe(true);
    expect(isAllowlisted('npm testx', ['npm test'])).toBe(false);
    expect(isAllowlisted('npm', ['npm test'])).toBe(false);
    expect(isAllowlisted('git status', undefined)).toBe(false);
  });
});

describe('run_command 白名单', () => {
  it('白名单命中 → 免审批直跑成功，审批回调不被调用', async () => {
    const result = await run('node -e "console.log(123)"', {
      ctx: { cwd: tmp, allowlistedPrefixes: ['node -e'] },
    });
    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string; exitCode: number };
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain('123');
    expect(approvalSpy).not.toHaveBeenCalled();
  });

  it('白名单未命中 → 走审批，通过后执行', async () => {
    const result = await run('node -e "console.log(456)"');
    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string };
    expect(data.stdout).toContain('456');
    expect(approvalSpy).toHaveBeenCalledTimes(1);
  });

  it('审批拒绝 → ok:false 且不执行', async () => {
    const denied = vi.fn(async () => false);
    const result = await run('node -e "console.log(1)"', {
      ctx: { cwd: tmp, requestApproval: denied },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('拒绝');
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('审批回调未配置（非白名单）→ fail-closed 拒绝', async () => {
    const bare = new ToolRegistry().register(shellTool);
    const result = await bare.run(
      'run_command',
      { command: 'node -e "console.log(1)"' },
      { cwd: tmp },
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('拒绝');
  });

  it('审批请求内容正确：kind=shell、summary 与 detail 含命令', async () => {
    await run('node -e "console.log(1)"');
    const firstCall = approvalSpy.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('测试夹具：审批回调未被调用');
    }
    const request = firstCall[0];
    expect(request.kind).toBe('shell');
    expect(request.summary).toContain('console.log');
    expect(request.detail).toBe('node -e "console.log(1)"');
  });
});

describe('run_command 执行行为', () => {
  it('stderr 与非零退出码透传', async () => {
    const result = await run(`node -e "console.error('oops'); process.exit(3)"`);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('3');
    const data = result.data as { exitCode: number; stderr: string };
    expect(data.exitCode).toBe(3);
    expect(data.stderr).toContain('oops');
  });

  it('超时自动终止并返回超时错误', async () => {
    const start = Date.now();
    const result = await run('node -e "setTimeout(()=>{}, 10000)"', { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('超时');
    expect(elapsed).toBeLessThan(5_000);
  });

  it('超时参数上限校验（>300s 拒绝）', async () => {
    const result = await registry.run(
      'run_command',
      { command: 'node -e "1"', timeoutMs: 999_999 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('参数校验失败');
  });

  it('命令输出截断并标记 truncated', async () => {
    const result = await run(`node -e "console.log('x'.repeat(30000))"`);
    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string; truncated: boolean };
    expect(data.stdout.length).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_CHARS);
    expect(data.truncated).toBe(true);
  });

  it('parallelSafe 为 false（shell 不可并行）', () => {
    expect(shellTool.parallelSafe).toBe(false);
  });
});

// ── 跨平台命令兼容体系（v3.0 §3.4）──────────────────────────

describe('getPlatformAdapter（平台检测）', () => {
  it('默认使用当前 process.platform', () => {
    const adapter = getPlatformAdapter();
    expect(adapter.isWindows).toBe(process.platform === 'win32');
    expect(adapter.isMac).toBe(process.platform === 'darwin');
    expect(adapter.isLinux).toBe(process.platform === 'linux');
  });

  it('可注入平台模拟不同系统', () => {
    const win = getPlatformAdapter('win32');
    expect(win.isWindows).toBe(true);
    expect(win.isMac).toBe(false);
    expect(win.isLinux).toBe(false);

    const mac = getPlatformAdapter('darwin');
    expect(mac.isMac).toBe(true);
    expect(mac.isWindows).toBe(false);

    const linux = getPlatformAdapter('linux');
    expect(linux.isLinux).toBe(true);
    expect(linux.isWindows).toBe(false);
  });
});

describe('跨平台命令适配（Windows）', () => {
  const win = getPlatformAdapter('win32');

  it('npx → npx.cmd（行首与 && 连接处）', () => {
    expect(win.adaptCommand('npx tsc --noEmit')).toBe('npx.cmd tsc --noEmit');
    expect(win.adaptCommand('npx')).toBe('npx.cmd');
    expect(win.adaptCommand('npm test && npx tsc')).toBe('npm test && npx.cmd tsc');
    // npx.cmd 已存在时不重复转换
    expect(win.adaptCommand('npx.cmd tsc')).toBe('npx.cmd tsc');
  });

  it('cat FILE → type FILE', () => {
    expect(win.adaptCommand('cat file.txt')).toBe('type file.txt');
  });

  it('tail/head 管道 → PowerShell Select-Object', () => {
    expect(win.adaptCommand('npm test | tail -5')).toBe(
      'npm test | powershell -Command "$input | Select-Object -Last 5"',
    );
    expect(win.adaptCommand('npm test | head -3')).toBe(
      'npm test | powershell -Command "$input | Select-Object -First 3"',
    );
  });

  it('tail/head 独立命令 → PowerShell Get-Content', () => {
    expect(win.adaptCommand('tail -10 log.txt')).toBe(
      'powershell -Command "Get-Content \'log.txt\' -Tail 10"',
    );
    expect(win.adaptCommand('head -5 log.txt')).toBe(
      'powershell -Command "Get-Content \'log.txt\' -Head 5"',
    );
  });

  it('grep → findstr（-i → /i）', () => {
    expect(win.adaptCommand('grep error server.log')).toBe('findstr error server.log');
    expect(win.adaptCommand('grep -i error server.log')).toBe('findstr /i error server.log');
  });

  it('rm -rf DIR → rmdir /s /q DIR', () => {
    expect(win.adaptCommand('rm -rf node_modules')).toBe('rmdir /s /q node_modules');
  });

  it('mkdir -p DIR → mkdir DIR 2>nul', () => {
    expect(win.adaptCommand('mkdir -p dist/app')).toBe('mkdir dist/app 2>nul');
  });

  it('pwd → echo %cd%', () => {
    expect(win.adaptCommand('pwd')).toBe('echo %cd%');
  });

  it('跨平台命令原样保留（node/npm/npm run）', () => {
    expect(win.adaptCommand('node -e "console.log(1)"')).toBe('node -e "console.log(1)"');
    expect(win.adaptCommand('npm run verify')).toBe('npm run verify');
    expect(win.adaptCommand('git status')).toBe('git status');
  });
});

describe('跨平台命令适配（macOS / Linux）', () => {
  it('macOS sed -i 自动补空备份后缀', () => {
    const mac = getPlatformAdapter('darwin');
    expect(mac.adaptCommand("sed -i 's/foo/bar/' a.txt")).toBe("sed -i '' 's/foo/bar/' a.txt");
  });

  it('macOS 其他命令保持原样', () => {
    const mac = getPlatformAdapter('darwin');
    expect(mac.adaptCommand('tail -5 log.txt')).toBe('tail -5 log.txt');
    expect(mac.adaptCommand('npm run verify')).toBe('npm run verify');
  });

  it('Linux 命令原样返回（基准平台）', () => {
    const linux = getPlatformAdapter('linux');
    expect(linux.adaptCommand('tail -5 log.txt')).toBe('tail -5 log.txt');
    expect(linux.adaptCommand('mkdir -p dist')).toBe('mkdir -p dist');
    expect(linux.adaptCommand('grep error server.log')).toBe('grep error server.log');
  });
});
