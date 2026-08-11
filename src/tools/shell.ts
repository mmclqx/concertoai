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

import { TOOL_ERROR_SUGGESTIONS, ToolErrorCode, toolError } from './error-codes';
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

/**
 * 终止子进程整棵树并等待完成（T6.5 对齐 qa.ts killTree）：
 * Windows 用 taskkill /T /F 并等待其退出（不等待会残留 npm/node 子进程树）；
 * POSIX 用进程组 SIGKILL（shell: true 子进程同进程组，-pid 杀整组）。
 */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程已退出
      }
    }
    resolve();
  });
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
      // 立即返回超时结果；进程树清理在后台等待 taskkill 完成（不阻塞 finish）
      void killTree(child);
      finish(
        toolError(ToolErrorCode.TIMEOUT, `命令执行超时（${timeoutMs}ms），已终止:\n  ${command}`, {
          data: buildData(-1),
        }),
      );
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
          ? `\n💡 命令不存在或无法启动，请检查命令名是否正确（Windows 已自动适配 npx.cmd/cat→type/tail→Get-Content/grep→findstr 等，若仍失败请用 node -e / dir / type 替代）`
          : '';
      finish(
        toolError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? ToolErrorCode.COMMAND_NOT_FOUND
            : ToolErrorCode.EXIT_CODE,
          `命令启动失败: ${error.message}\n  命令: ${command}\n  目录: ${cwd}${hint}`,
          { data: buildData(-1) },
        ),
      );
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
          code: `EXIT_${exitCode}`,
          suggestion: TOOL_ERROR_SUGGESTIONS[ToolErrorCode.EXIT_CODE],
          // Windows "无结果"不算可修复失败（findstr/dir 找不到是正常结果）
          repairable: isNoResults ? false : undefined,
        });
      }
    });
  });
}

// ── 跨平台命令兼容体系（v3.0 §3.4）──────────────────────────

/** 平台适配器：检测操作系统并转换命令，保证 Windows/macOS/Linux 一致可用。 */
export interface PlatformAdapter {
  /** 是否 Windows（process.platform === 'win32'）。 */
  isWindows: boolean;
  /** 是否 macOS（process.platform === 'darwin'）。 */
  isMac: boolean;
  /** 是否 Linux。 */
  isLinux: boolean;
  /** 按当前平台转换命令（跨平台兼容层核心）。 */
  adaptCommand: (command: string) => string;
}

/**
 * 获取平台适配器。
 *
 * @param platform 平台标识（默认 process.platform；测试可注入模拟不同系统）。
 */
export function getPlatformAdapter(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  return {
    isWindows: platform === 'win32',
    isMac: platform === 'darwin',
    isLinux: platform === 'linux',
    adaptCommand: (command) => adaptCommandForPlatform(command, platform),
  };
}

/** 按平台分派命令转换；Linux 视为基准（原样返回，保持最大兼容）。 */
function adaptCommandForPlatform(command: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return translateWindowsCommand(command);
  }
  if (platform === 'darwin') {
    return translateMacCommand(command);
  }
  return command;
}

/**
 * Windows 命令兼容翻译。
 * 检测到 npx、head/tail/cat/grep/rm/mkdir/pwd 等命令时，
 * 自动转为 Windows 原生 / PowerShell 等效命令。
 */
function translateWindowsCommand(command: string): string {
  // 1. npx → npx.cmd（行首或 && 连接处，规避 Windows 脚本执行策略）
  command = command.replace(/^(npx)(?=\s|$)/gm, 'npx.cmd');
  command = command.replace(/(&&\s+)npx(?=\s|$)/g, '$1npx.cmd');

  // 2. | head -N → PowerShell Select-Object -First N
  command = command.replace(
    /\|\s*head\s+-(\d+)/g,
    '| powershell -Command "$input | Select-Object -First $1"',
  );

  // 3. | tail -N → PowerShell Select-Object -Last N
  command = command.replace(
    /\|\s*tail\s+-(\d+)/g,
    '| powershell -Command "$input | Select-Object -Last $1"',
  );

  // 4. 独立 tail -N FILE → PowerShell Get-Content FILE -Tail N
  command = command.replace(
    /^tail\s+-(\d+)\s+(.+)$/gm,
    'powershell -Command "Get-Content \'$2\' -Tail $1"',
  );

  // 5. 独立 head -N FILE → PowerShell Get-Content FILE -Head N
  command = command.replace(
    /^head\s+-(\d+)\s+(.+)$/gm,
    'powershell -Command "Get-Content \'$2\' -Head $1"',
  );

  // 6. 独立 cat FILE → type FILE
  command = command.replace(/^cat\s+(.+)$/gm, 'type $1');

  // 7. 独立 grep PATTERN → findstr PATTERN（基本模式；-i → /i 常见参数适配）
  command = command.replace(
    /^grep\s+(-i\s+)?(.+)$/gm,
    (_match, flag: string | undefined, rest: string) => {
      const findstrFlag = flag !== undefined ? '/i ' : '';
      return `findstr ${findstrFlag}${rest}`;
    },
  );

  // 8. rm -rf DIR → rmdir /s /q DIR
  command = command.replace(/^rm\s+-rf\s+(.+)$/gm, 'rmdir /s /q $1');

  // 9. mkdir -p DIR → mkdir DIR 2>nul（cmd 自动创建中间目录，2>nul 抑制"已存在"错误）
  command = command.replace(/^mkdir\s+-p\s+(.+)$/gm, 'mkdir $1 2>nul');

  // 10. pwd → echo %cd%
  if (/^pwd\s*$/m.test(command)) {
    command = 'echo %cd%';
  }

  return command;
}

/**
 * macOS 命令兼容翻译（BSD 工具链差异）。
 * 处理 sed -i：BSD sed 要求备份后缀，自动补空后缀 ''。
 */
function translateMacCommand(command: string): string {
  // sed -i 's/a/b/' file → sed -i '' 's/a/b/' file
  command = command.replace(/sed\s+-i(?=\s+)/g, "sed -i ''");
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
        return toolError(ToolErrorCode.SHELL_REJECTED, '命令执行被拒绝', {
          repairable: false,
        });
      }
    }

    const command = getPlatformAdapter().adaptCommand(args.command);
    return runShellCommand(command, ctx.cwd, timeoutMs);
  },
};
