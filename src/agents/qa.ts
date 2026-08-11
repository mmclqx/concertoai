/**
 * QA Agent（v3.0 M3 / T3.4，对抗性闭环测试验证角色）。
 *
 * 职责：在沙箱中执行 `npm run verify`，输出结构化测试报告（含失败详情），
 * 失败时把详情格式化为 feedback 消息传回 Coder（T3.5 闭环消费）。
 *
 * 关键设计：
 * - QaRunner 抽象：生产注入 ChildProcessQaRunner（spawn npm run verify，超时保护），
 *   测试注入 Fake runner，避免单测触发真实 verify；
 * - parseVerifyOutput 纯函数：解析 vitest 输出（Test Files / Tests 计数 + FAIL 段），
 *   输出 QaReport（passed / testFiles / testCases / failedItems[] / summary）；
 * - 超时保护：默认 DEFAULT_VERIFY_TIMEOUT_MS = 5min，超时视为失败（timedOut 标记）；
 * - 标准 Agent 契约（T1.2）：输入 description / 输出 QaReport（zod schema 同步）。
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AgentContext, AgentDef } from '../orchestrator';
import { createAgentRuntimeState } from '../orchestrator';
import type { Agent } from './protocol';

// ── 常量 ──────────────────────────────────────────────────────

/** 默认 verify 超时（5 分钟，毫秒）。 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

// ── 类型定义 ──────────────────────────────────────────────────

/** 单个失败项（文件 + 用例 + 错误信息）。 */
export interface QaFailedItem {
  /** 失败测试文件路径。 */
  file: string;
  /** 失败用例名（尽力提取，vitest 输出可能无）。 */
  testName?: string;
  /** 错误信息。 */
  error: string;
}

/** QA 输出：结构化测试报告（含失败详情）。 */
export interface QaReport {
  /** 是否全部通过。 */
  passed: boolean;
  /** 测试文件总数。 */
  testFiles: number;
  /** 测试用例总数。 */
  testCases: number;
  /** 失败项列表（passed 时为空）。 */
  failedItems: QaFailedItem[];
  /** 是否超时（超时视为失败）。 */
  timedOut: boolean;
  /** 执行耗时（毫秒）。 */
  durationMs: number;
  /** 中文摘要（供用户快速了解结果）。 */
  summary: string;
}

/** QA 输入：任务描述（扩展字段预留：可指定测试文件子集）。 */
export interface QaInput {
  /** 任务描述。 */
  description: string;
}

/** QA 输出 zod schema（与 QaReport 同步）。 */
export const qaReportSchema = z.object({
  passed: z.boolean(),
  testFiles: z.number(),
  testCases: z.number(),
  failedItems: z.array(
    z.object({
      file: z.string(),
      testName: z.string().optional(),
      error: z.string(),
    }),
  ),
  timedOut: z.boolean(),
  durationMs: z.number(),
  summary: z.string(),
});

// ── QaRunner 抽象 ─────────────────────────────────────────────

/** verify 执行结果（原始输出 + 退出码）。 */
export interface QaRunResult {
  /** 是否成功退出（exit code 0）。 */
  ok: boolean;
  /** 标准输出。 */
  stdout: string;
  /** 标准错误。 */
  stderr: string;
  /** 是否超时被终止。 */
  timedOut: boolean;
}

/** QA 命令执行器抽象（生产 spawn / 测试注入 Fake）。 */
export interface QaRunner {
  /** 执行 `npm run verify`，返回原始输出与退出状态。 */
  run(timeoutMs: number): Promise<QaRunResult>;
}

/** 沙箱执行器选项。 */
export interface ChildProcessQaRunnerOptions {
  /** 工作目录（默认 process.cwd()）。 */
  cwd?: string;
  /** npm 命令名（Windows 需 npm.cmd）。 */
  npmCommand?: string;
}

/**
 * 生产沙箱执行器：spawn `npm run verify`。
 * 超时后 kill 子进程（含 npm 子进程树），标记 timedOut 并视为失败。
 */
export class ChildProcessQaRunner implements QaRunner {
  private readonly cwd: string;
  private readonly npmCommand: string;

  constructor(options: ChildProcessQaRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.npmCommand = options.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  }

  run(timeoutMs: number): Promise<QaRunResult> {
    return new Promise((resolve) => {
      // npmCommand 已在构造器按平台处理（win32 → npm.cmd），此处直接使用；
      // 若再追加 `.cmd` 会变成 `npm.cmd.cmd`（ENOENT，v3.1.1 Windows 回归）。
      const child = spawn(this.npmCommand, ['run', 'verify'], {
        cwd: this.cwd,
        shell: true,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // Windows 下 kill 子进程树（npm 会 spawn 子 node 进程）
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr, timedOut });
      });
    });
  }
}

// ── 输出解析（纯函数）────────────────────────────────────────

/** 解析 vitest 输出的 Test Files 行，如 `Test Files  51 passed (51)`。 */
const TEST_FILES_RE = /Test Files\s+(\d+)\s+(passed|failed)\s*\((\d+)\)/;
/** 解析 vitest 输出的 Tests 行，如 `Tests  577 passed (577)`。 */
const TESTS_RE = /Tests\s+(\d+)\s+(passed|failed)\s*\((\d+)\)/;
/** 匹配 vitest 失败文件段起始：` ❯ path/to/file.test.ts (N tests | M failed)` 或 `FAIL path`。
 *  负向前瞻 (?!:) 排除错误定位行 `❯ path.test.ts:10:5`（其后是冒号，不是文件段）。 */
const FAIL_FILE_RE = /(?:❯|FAIL)\s+([^\s(:]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))(?!:)/;
/** 匹配失败用例行：`   ✗ 用例名` 或 `   × 用例名`。 */
const FAIL_TEST_RE = /^\s*(?:✗|×|✖)\s+(.+)$/;

/**
 * 从 `npm run verify` 输出解析结构化测试报告。
 *
 * 成功：Test Files / Tests 计数行提取；失败：FAIL/❯ 段提取文件 + 用例 + 错误。
 * 解析是尽力而为（vitest 版本差异），失败项文件至少保留一行上下文。
 */
export function parseVerifyOutput(stdout: string, stderr: string, durationMs: number): QaReport {
  const combined = `${stdout}\n${stderr}`;

  // 计数提取（默认 0）；优先取括号内的总数（如 `51 passed (51)`）
  const filesMatch = combined.match(TEST_FILES_RE);
  const testsMatch = combined.match(TESTS_RE);
  const testFiles =
    filesMatch?.[3] !== undefined ? Number(filesMatch[3]) : Number(filesMatch?.[1] ?? 0);
  const testCases =
    testsMatch?.[3] !== undefined ? Number(testsMatch[3]) : Number(testsMatch?.[1] ?? 0);
  const filesFailed = filesMatch?.[2] === 'failed';
  const testsFailed = testsMatch?.[2] === 'failed';

  // 失败项提取：按文件分段（用非全局正则逐行匹配，避免 /g 状态泄漏）
  const failedItems: QaFailedItem[] = [];
  const segments: Array<{ file: string; lines: string[] }> = [];
  let current: { file: string; lines: string[] } | undefined;

  const lines = combined.split('\n');
  for (const line of lines) {
    const fileMatch = line.match(FAIL_FILE_RE);
    if (fileMatch?.[1] !== undefined) {
      current = { file: fileMatch[1], lines: [line] };
      segments.push(current);
      continue;
    }
    if (current !== undefined) {
      current.lines.push(line);
    }
  }

  for (const seg of segments) {
    let testName: string | undefined;
    for (const l of seg.lines) {
      const tm = l.match(FAIL_TEST_RE);
      if (tm?.[1] !== undefined) {
        testName = tm[1];
        break;
      }
    }
    // 错误信息：段内含 assert/Error 的行（取首条）。
    // 跳过段首行（文件头行 `❯ file.test.ts (...)`，其中的 "failed" 会误匹配 FAIL）；
    // ✗/× 已由 FAIL_TEST_RE 识别用例名，此处不再匹配（否则用例行先于 Error 行命中）；
    // FAIL 已由 FAIL_FILE_RE 承担文件识别，此处仅匹配精确错误行。
    const bodyLines = seg.lines.slice(1);
    const errorLine =
      bodyLines.find((l) => /(?:Error|assert|expect|AssertionError|FAIL)/i.test(l)) ??
      bodyLines[0] ??
      seg.lines[0] ??
      '';
    failedItems.push({
      file: seg.file,
      testName,
      error: errorLine.trim().slice(0, 500),
    });
  }

  // 通过条件：无失败计数、无失败段、且至少解析到一条计数行（防无输出误判通过）
  const hasCountLine = filesMatch !== null || testsMatch !== null;
  const passed = hasCountLine && !filesFailed && !testsFailed && failedItems.length === 0;
  const timedOut = /(?:timed out|ETIMEDOUT|超时)/i.test(combined);
  const summary = buildQaSummary(passed, testFiles, testCases, failedItems.length);

  return { passed, testFiles, testCases, failedItems, timedOut, durationMs, summary };
}

/** 构造 QA 中文摘要。 */
export function buildQaSummary(
  passed: boolean,
  testFiles: number,
  testCases: number,
  failedCount: number,
): string {
  if (passed) {
    return `✅ npm run verify 通过：${testFiles} 个文件 / ${testCases} 个用例全部通过`;
  }
  return `❌ npm run verify 失败：${testFiles} 个文件 / ${testCases} 个用例，${failedCount} 项失败`;
}

/**
 * 将失败详情格式化为 feedback 消息的 issues 列表（传回 Coder 修复）。
 * 每条：`[文件] 用例：错误信息`；无失败项时返回空数组。
 */
export function formatFeedbackIssues(report: QaReport): string[] {
  return report.failedItems.map((item) => {
    const test = item.testName !== undefined ? `[${item.file}] ${item.testName}` : `[${item.file}]`;
    return `${test}: ${item.error}`;
  });
}

// ── QA Agent ──────────────────────────────────────────────────

/** QA Agent 选项。 */
export interface QaAgentOptions {
  /** 命令执行器（生产 ChildProcessQaRunner / 测试 Fake）。 */
  runner: QaRunner;
  /** verify 超时（默认 DEFAULT_VERIFY_TIMEOUT_MS = 5min）。 */
  timeoutMs?: number;
}

/**
 * QA Agent（标准 Agent 契约）。
 *
 * execute：执行 npm run verify → 解析输出为 QaReport。
 * 超时/失败不抛错（报告 passed=false 携带失败详情），由 T3.5 闭环决定修复。
 */
export class QaAgent implements Agent {
  /** Agent 定义（name=qa，输入 description / 输出 QaReport，权限 = run_command 白名单）。 */
  readonly def: AgentDef = {
    name: 'qa',
    version: '1.0.0',
    interfaces: {
      input: z.object({ description: z.string() }),
      output: qaReportSchema,
      version: '1.0.0',
    },
    permissions: [
      // qa 执行 verify（白名单命令 npm run verify），fail-closed：不写文件
      { tool: 'run_command', args: { command: 'npm run verify' } },
    ],
  };

  /** 运行时状态（与任务级 AgentState 解耦，ADR-016 #3）。 */
  runtimeState = createAgentRuntimeState();

  private readonly options: QaAgentOptions;

  constructor(options: QaAgentOptions) {
    this.options = options;
  }

  /** 执行核心：跑 verify → 解析报告（退出码非 0 / 超时均兜底判失败）。 */
  async execute(_input: QaInput, _context: AgentContext): Promise<QaReport> {
    const startedAt = Date.now();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const result = await this.options.runner.run(timeoutMs);
    const durationMs = Date.now() - startedAt;
    const report = parseVerifyOutput(result.stdout, result.stderr, durationMs);
    // 超时由 runner 标记 → 强制 passed=false
    if (result.timedOut) {
      return {
        ...report,
        passed: false,
        timedOut: true,
        failedItems:
          report.failedItems.length > 0
            ? report.failedItems
            : [{ file: 'npm run verify', error: `执行超时（>${timeoutMs}ms）` }],
        summary: `❌ npm run verify 超时（>${Math.round(timeoutMs / 1000)}s），视为失败`,
      };
    }
    // 退出码非 0 兜底：输出未解析出 FAIL 段时也判失败（防御性，防解析漏判）
    if (!result.ok && report.passed) {
      return {
        ...report,
        passed: false,
        failedItems:
          report.failedItems.length > 0
            ? report.failedItems
            : [{ file: 'npm run verify', error: '命令退出码非 0（verify 失败）' }],
        summary: `❌ npm run verify 失败（退出码非 0）：${report.testFiles} 个文件 / ${report.testCases} 个用例`,
      };
    }
    return report;
  }

  /** 发送消息（闭环暂未启用，no-op 占位）。 */
  async send(): Promise<void> {
    // 闭环消息路由由 T3.5 编排层接入。
  }

  /** 接收消息（闭环暂未启用，返回无回复）。 */
  async receive(): Promise<undefined> {
    return undefined;
  }
}
