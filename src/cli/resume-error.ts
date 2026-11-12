/**
 * `chat -r <id>` 读取失败的**说人话**层（v5.2 边缘路径修复）。
 *
 * ## 它解决的问题
 *
 * 手工验收实测（2026-11-13，隔离 HOME，真 TTY）：
 *
 * ```
 * concertoai chat -r 20200101-000000-000
 * [ConcertoAI] 未处理的 Promise 拒绝，详情见 …\.concertoai\crash.log
 * Error: ENOENT: no such file or directory, open '…\sessions\20200101-000000-000.jsonl'
 *     at async open (node:internal/fs/promises:639:25)
 *     at async readFile (node:internal/fs/promises:1252:14)
 *     at async SessionStore.read …
 * ```
 *
 * 退出码是对的（1、自己退出、不挂起），但**用户看到的是一段 Node 堆栈**——
 * 而这条路径恰恰是 v5.2 新能力 `/approvals` 的入口（先 `chat -r` 才能查昨天的自动放行）。
 * 而 `-r` 的 id 是 `20261113-024243-266` 这种形状，**手抄必错**，所以这条失败路径的命中率不低。
 *
 * ## 为什么拆成纯函数
 *
 * 与 `slash/approvals.ts` 同构：不读时钟、不碰进程、无副作用，输入（id / 错误 / 最近会话）→
 * 输出要打印的行。这样「三种失败各自说什么」能被单测直接打穿，而不是只能靠真机手抄。
 *
 * ## 三种失败必须分开说（N1 同源教训）
 *
 * | 事实 | 说什么 |
 * |---|---|
 * | id 不合法（含路径分隔符等） | 「会话 id 不合法」+ 允许的字符集 |
 * | 文件不存在（ENOENT） | 「没有这个会话」+ **最近 5 个真实 id**（用户多半是记错） |
 * | 其他读取失败（权限/磁盘） | 「读取会话失败：<原因>」，**不许说成「不存在」** |
 *
 * 把「读失败的**所有**原因」压成一句「没有这个会话」，就是 `doctor` N1 那个 bug 的同款错误
 * （见 `docs/09-踩坑记录/2026-11-13-修同屏打脸只修了被截图的那一句.md`）。
 */

import { fmt, t } from '../i18n';
import type { SessionSummary } from '../store/session';
import { isValidSessionId } from '../store/session';

/** 失败归类（决定用哪句文案）。 */
export type ResumeFailureKind = 'invalid-id' | 'not-found' | 'unreadable';

/**
 * 最多列出几个「最近的会话」。
 *
 * 为什么是 5：这条消息出现在**启动期**，用户此刻只想赶紧把命令敲对；
 * 列 20 个会把真正的错误行挤出屏幕（与 `/approvals` 的 20 条上限同理，只是场景更急）。
 */
export const MAX_RECENT_SESSIONS = 5;

/** 把「读会话失败」归类成三种事实之一。 */
export function classifyResumeError(id: string, error: unknown): ResumeFailureKind {
  if (!isValidSessionId(id)) {
    return 'invalid-id';
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' ? 'not-found' : 'unreadable';
}

/**
 * 生成要打印的行（每行一条，调用方逐行 `console.error`）。
 *
 * **绝不含堆栈**：细节已经由全局 crash 处理器写进 `crash.log`，屏幕上只留人能读的部分。
 */
export function describeResumeFailure(params: {
  id: string;
  error: unknown;
  /** 已存在的会话（调用方给 `store.list()` 的结果；取不到时给空数组）。 */
  recent: readonly SessionSummary[];
}): string[] {
  const dict = t().session;
  const kind = classifyResumeError(params.id, params.error);

  if (kind === 'invalid-id') {
    return [fmt(dict.resumeInvalid, { id: params.id }), dict.resumeListHint];
  }
  if (kind === 'unreadable') {
    // 只取首行并截断：错误信息可能很长（含路径），启动期屏幕放不下
    const reason = firstLineOf(params.error);
    return [fmt(dict.resumeReadFailed, { id: params.id, reason }), dict.resumeListHint];
  }

  const lines = [fmt(dict.resumeNotFound, { id: params.id })];
  if (params.recent.length === 0) {
    // 「没有任何会话」和「记错了 id」是两件事，别让用户以为记录丢了
    lines.push(dict.empty);
  } else {
    lines.push(dict.resumeRecentTitle);
    for (const s of params.recent.slice(0, MAX_RECENT_SESSIONS)) {
      lines.push(`  ${s.id}  ${s.messageCount} ${dict.resumeRecentCountSuffix}`);
    }
  }
  lines.push(dict.resumeListHint);
  return lines;
}

/** 取错误信息首行并截断（`ENOENT: no such file …` 这类前缀已经足够定位）。 */
function firstLineOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
