/**
 * shell 命令工具（run_command）。
 *
 * 安全基线：
 * - 白名单前缀（如 npm test、git status）命中即免审批直跑（用户提前授权）；
 * - 其余命令每次执行前强制审批，审批未配置时默认拒绝（fail-closed）；
 * - 超时自动终止子进程；stdout/stderr 按长度截断，防止上下文膨胀；
 * - 命令以 shell 方式执行（跨平台，Windows 走 cmd.exe），因此必须经过审批把关。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolResult, ToolSpec } from './registry';
import { requestApproval } from './registry';

/** 默认命令超时（毫秒）。 */
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
/** 允许的最大超时（毫秒）。 */
export const MAX_SHELL_TIMEOUT_MS = 300_000;
/** stdout/stderr 各自回填的最大字符数。 */
export const MAX_SHELL_OUTPUT_CHARS = 20_000;

const runCommandSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(MAX_SHELL_TIMEOUT_MS).optional(),
});

interface ShellArgs {
  command: string;
  timeoutMs?: number;
}

interface ShellOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** 执行的完整命令。 */
  command: string;
  /** 命令执行的工作目录。 */
  cwd: string;
}

/**
 * 白名单匹配：命令与白名单条目完全相同，或以其后跟空格开头
 * （'npm test' 命中 'npm test -- --silent'，但不命中 'npm testx'）。
 */
export function isAllowlisted(command: string, prefixes: readonly string[] | undefined): boolean {
  if (prefixes === undefined) {
    return false;
  }
  return prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

/** 终止子进程整棵树：Windows 用 taskkill /T /F，POSIX 用进程组 SIGKILL。 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const buildData = (exitCode: number): ShellOutput => ({
      exitCode,
      stdout: stdout.slice(0, MAX_SHELL_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_SHELL_OUTPUT_CHARS),
      truncated: stdout.length > MAX_SHELL_OUTPUT_CHARS || stderr.length > MAX_SHELL_OUTPUT_CHARS,
      command,
      cwd,
    });

    const finish = (result: ToolResult): void => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      killTree(child);
      finish({
        ok: false,
        error: `命令执行超时（${timeoutMs}ms），已终止:\n  ${command}`,
        data: buildData(-1),
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      const hint =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `\n💡 命令不存在或无法启动，请检查命令名是否正确（Windows cmd 不支持 pwd/ls/cat 等 UNIX 命令，请用 node -e / dir / type 替代）`
          : '';
      finish({
        ok: false,
        error: `命令启动失败: ${error.message}\n  命令: ${command}\n  目录: ${cwd}${hint}`,
        data: buildData(-1),
      });
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      const data = buildData(exitCode);
      if (exitCode === 0) {
        finish({ ok: true, data });
      } else {
        const hasStderr = data.stderr.trim() !== '';
        // Windows 下 findstr/dir 等工具退出码 1 且无 stderr = "没有找到匹配"，不是真错误
        const isNoResults = exitCode === 1 && !hasStderr && process.platform === 'win32';

        const lines = [`命令退出码 ${exitCode}`];
        lines.push(`  命令: ${command}`);
        lines.push(`  目录: ${cwd}`);
        if (hasStderr) {
          lines.push(`  stderr: ${data.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`);
        }
        // 解释常见退出码
        if (exitCode === 255 || exitCode === 127) {
          lines.push('  💡 退出码 255/127 通常表示命令不存在。');
        } else if (isNoResults) {
          lines.push(
            '  💡 Windows 下 findstr/dir 退出码 1 且无 stderr = 没找到匹配。这不计入可修复失败。',
          );
        } else if (exitCode === 1) {
          lines.push('  💡 退出码 1 = 命令执行出错（参数错误或运行时错误）。');
        }

        finish({
          ok: false,
          error: lines.join('\n'),
          data,
          // Windows "无结果"不算可修复失败（findstr/dir 找不到是正常结果）
          repairable: isNoResults ? false : undefined,
        });
      }
    });
  });
}

/**
 * Windows 命令兼容翻译。
 * 检测到 head/tail/cat 等 Linux 命令时，自动转为 PowerShell 等效命令。
 */
function translateWindowsCommand(command: string): string {
  if (process.platform !== 'win32') return command;

  // 1. | head -N → PowerShell Select-Object -First N
  command = command.replace(/\|\s*head\s+-(\d+)/g, '| powershell -Command "$input | Select-Object -First $1"');

  // 2. | tail -N → PowerShell Select-Object -Last N
  command = command.replace(/\|\s*tail\s+-(\d+)/g, '| powershell -Command "$input | Select-Object -Last $1"');

  // 3. 独立 cat file → type file
  command = command.replace(/^cat\s+(.+)$/gm, 'type $1');

  // 4. pwd → echo %cd%
  if (/^pwd\s*$/m.test(command)) {
    command = 'echo %cd%';
  }

  return command;
}

export const shellTool: ToolSpec = {
  name: 'run_command',
  description: `在项目目录执行 shell 命令。白名单前缀（如 npm test、git status）免审批直跑；其余命令每次执行前需要审批。默认超时 ${DEFAULT_SHELL_TIMEOUT_MS}ms。`,
  parameters: runCommandSchema,
  parallelSafe: false,
  execute: async (rawArgs, ctx): Promise<ToolResult> => {
    const args = rawArgs as ShellArgs;
    const timeoutMs = args.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;

    if (!isAllowlisted(args.command, ctx.allowlistedPrefixes)) {
      const approved = await requestApproval(ctx, {
        kind: 'shell',
        summary: `执行命令: ${args.command}`,
        detail: args.command,
      });
      if (!approved) {
        return { ok: false, error: '命令执行被拒绝', repairable: false };
      }
    }

    const command = translateWindowsCommand(args.command);
    return runShellCommand(command, ctx.cwd, timeoutMs);
  },
};
