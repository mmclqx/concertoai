/**
 * 进程级崩溃日志（v3.1 M3）。
 *
 * 问题背景：
 * - VS Code 突然关闭时，如果有未捕获异常，用户看不到任何错误信息；
 * - /review 期间"什么都没操作就退出了"——根因是 unhandledRejection /
 *   uncaughtException 直接让 Node.js 退出，TUI 下 stderr 不可见。
 *
 * 策略（fail-closed 精神）：
 * 1. 捕获所有未处理异常，写入 ~/.concertoai/crash.log；
 * 2. 同步写盘（fs.appendFileSync）保证进程退出前落盘；
 * 3. 退出码始终非零，防止调用方误判成功。
 *
 * 限制：
 * - 仅诊断用，不恢复执行（未捕获异常后的进程状态不可信）；
 * - SIGINT / SIGTERM 不拦截（由 Ink / 调用方正常处理退出流程）；
 * - unhandledRejection 收到 AbortError（用户主动 Ctrl+C 中断）视为正常取消：
 *   不写 crash.log、退出码 130（SIGINT 惯例），保证 crash.log 只记录真实异常
 *   （v4.0.1 修复：readline question() 的 AbortError 曾误判为崩溃）。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';

import { crashLogPath, globalDir } from '../store/paths';

/** 确保 ~/.concertoai/ 目录存在。 */
function ensureDir(): void {
  const dir = globalDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 写入一条崩溃日志（同步，保证进程退出前落盘）。 */
function appendCrashEntry(entry: string): void {
  try {
    ensureDir();
    const ts = new Date().toISOString();
    const line = `\n=== ${ts} ===\n${entry}\n`;
    appendFileSync(crashLogPath(), line, 'utf-8');
  } catch {
    // 写盘失败 = 最后手段写 stderr（TUI 下可能不可见，但好过完全静默）
    process.stderr.write(`[ConcertoAI] 崩溃日志写盘失败: ${entry}\n`);
  }
}

/**
 * 安装全局崩溃处理器。
 *
 * 在 CLI 入口最早阶段调用（index.ts 解析前），确保任何异常都能被记录。
 * 幂等：重复调用无副作用（只安装一次）。
 */
let installed = false;

export function installCrashHandlers(): void {
  // 防止重复安装
  if (installed) {
    return;
  }
  installed = true;

  // ── uncaughtException ──
  // 同步异常未被 try/catch 捕获（如 JSON.parse 失败、类型错误等）。
  process.on('uncaughtException', (err: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    const entry = [
      `类型: uncaughtException`,
      `来源: ${origin}`,
      `错误: ${err.message}`,
      `堆栈:\n${err.stack ?? '(无堆栈)'}`,
    ].join('\n');
    appendCrashEntry(entry);
    // 同步写 stderr 以便终端也能看到
    process.stderr.write(`\n[ConcertoAI] 未捕获异常，详情见 ${crashLogPath()}\n`);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });

  // ── unhandledRejection ──
  // Promise 被拒绝但没有 .catch() 处理器。
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // 用户主动中断（Ctrl+C 等 → AbortError）不是崩溃：不写 crash.log、退出码 130（SIGINT 惯例）。
    // 兜底：promptLine 等交互入口已捕获 AbortError，此处防其他位置漏捕获污染 crash.log。
    if (err.name === 'AbortError') {
      process.stderr.write('[ConcertoAI] 已中断\n');
      process.exit(130);
      return;
    }
    const entry = [
      `类型: unhandledRejection`,
      `错误: ${err.message}`,
      `堆栈:\n${err.stack ?? '(无堆栈)'}`,
    ].join('\n');
    appendCrashEntry(entry);
    process.stderr.write(`\n[ConcertoAI] 未处理的 Promise 拒绝，详情见 ${crashLogPath()}\n`);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });

  // ── 多段拒绝警告（同一 promise 多次 reject）──
  process.on('multipleResolves', (type, _promise, reason) => {
    const entry = [
      `类型: multipleResolves (${type})`,
      `原因: ${reason instanceof Error ? reason.message : String(reason)}`,
    ].join('\n');
    // multipleResolves 不致命，仅记录不退出
    appendCrashEntry(entry);
  });

  // ── 未捕获的 Warning ──
  process.on('warning', (warning: Error) => {
    // 仅记录，不退出（Node.js 默认也不退出）
    const entry = [
      `类型: process warning`,
      `名称: ${warning.name}`,
      `错误: ${warning.message}`,
      warning.stack !== undefined ? `堆栈:\n${warning.stack}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    appendCrashEntry(entry);
  });
}
