import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ToolContext, ToolResult } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';
import { isAllowlisted, MAX_SHELL_OUTPUT_CHARS, shellTool } from '../../src/tools/shell';

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
