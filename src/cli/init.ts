/**
 * `concertoai init` 命令（v5.0 T5）：一次分析，双文件输出。
 *
 * - `AGENTS.md`        → 给 AI 编码助手（项目定位 / 技术栈 / 命令 / 守护要点 / 技术债）
 * - `PROJECT_GUIDE.md` → 给人（最脆弱的地方 / 连锁反应区 / 跑通本地环境）
 *
 * 定位说明：Carbon 的 `init` 只生成给 AI 看的 CARBON.md；ConcertoAI 额外给人一份，
 * 这是「AI 与人的双向守护」的产品落点。
 *
 * 安全与体验约束：
 * - 已存在文件 → **默认不覆盖**（fail-closed），需显式确认；
 * - 非项目目录 → 友好提示退出（不生成空文件污染目录）；
 * - 扫描有界（文件数/单文件大小上限），巨型仓库不卡死；
 * - 生成后只打印 ≤6 行摘要（不要求用户读全文，避免输出淹没）。
 */

import { existsSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';

import { renderAgentsMd, renderProjectGuide, renderSummary } from '../core/guide-render';
import {
  looksLikeProject,
  type ProjectProfile,
  type ScanOptions,
  scanProject,
} from '../core/project-scan';
import { fmt, t } from '../i18n';
import { promptLine } from './prompt';

/** AGENTS.md 文件名（与项目规则加载保持一致）。 */
export const AGENTS_FILE = 'AGENTS.md';

/** 人类指南文件名。 */
export const GUIDE_FILE = 'PROJECT_GUIDE.md';

/** 覆盖策略。 */
export type OverwritePolicy = 'ask' | 'no' | 'yes';

/** init 命令选项。 */
export interface InitCommandOptions {
  /** 目标目录（默认 process.cwd()）。 */
  cwd?: string;
  /** 覆盖策略：ask（默认，交互询问）/ no（永不覆盖）/ yes（直接覆盖，--force）。 */
  overwrite?: OverwritePolicy;
  /** 扫描选项（测试注入上限）。 */
  scan?: ScanOptions;
  /** 确认回调（测试注入；返回 false 表示不覆盖）。 */
  confirmOverwrite?: (file: string) => Promise<boolean>;
  /** 是否交互式终端（非 TTY 时覆盖询问按「不覆盖」处理）。 */
  isTTY?: boolean;
  /** 输出函数（测试注入）。 */
  log?: (line: string) => void;
  /** 错误输出（测试注入）。 */
  logError?: (line: string) => void;
}

/** init 执行结果。 */
export interface InitResult {
  /** 退出码（0 = 成功/无需操作，1 = 失败/被拒绝）。 */
  code: number;
  /** 项目画像（成功时存在）。 */
  profile?: ProjectProfile;
  /** 实际写入的文件（相对路径）。 */
  written: string[];
  /** 已存在且未覆盖的文件。 */
  skipped: string[];
}

/**
 * 执行 init 命令。
 *
 * 分支：
 * 1. 非项目目录 → 友好提示 + 1（不生成空文件）
 * 2. 扫描 → 双渲染 → 逐文件判断覆盖策略 → 写入
 * 3. 全部跳过（用户拒绝覆盖）→ 0 + 明确提示「未做任何更改」
 */
/**
 * 目标路径是否为普通文件。
 *
 * 用途：同名**目录**（或管道等特殊文件）不能被 writeFile 覆盖，
 * 也不该问用户「是否覆盖」——直接放行到写入步骤，让真实错误走 writeFailed 提示。
 */
function isRegularFile(full: string): boolean {
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

export async function runInitCommand(options: InitCommandOptions = {}): Promise<InitResult> {
  const dict = t().init;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));
  const policy = options.overwrite ?? 'ask';
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  const confirmOverwrite =
    options.confirmOverwrite ??
    (async (file: string) => {
      if (!isTTY) {
        return false;
      }
      const answer = await promptLine(fmt(dict.overwritePrompt, { file }));
      // undefined（Ctrl+C / 非 TTY / 超时）→ 按不覆盖处理（fail-closed）
      return answer !== undefined && /^y(es)?$/i.test(answer.trim());
    });

  // ── 1. 非项目目录守卫 ──
  if (!looksLikeProject(cwd)) {
    logError(dict.notAProject);
    logError(dict.notAProjectHint);
    return { code: 1, written: [], skipped: [] };
  }

  // ── 2. 一次分析 ──
  log(dict.scanning);
  const profile = await scanProject(cwd, options.scan ?? {});
  if (profile.truncated) {
    log(fmt(dict.truncated, { count: profile.scannedFiles }));
  }
  if (profile.skippedFiles > 0) {
    log(fmt(dict.skippedFiles, { count: profile.skippedFiles }));
  }

  // ── 3. 双渲染（同源：profile 只扫一次）──
  const agentsContent = renderAgentsMd(profile);
  const guideContent = renderProjectGuide(profile);

  const targets: Array<{ name: string; content: string }> = [
    { name: AGENTS_FILE, content: agentsContent },
    { name: GUIDE_FILE, content: guideContent },
  ];

  // ── 4. 覆盖判定 + 写入 ──
  const written: string[] = [];
  const skipped: string[] = [];

  for (const target of targets) {
    const full = path.join(cwd, target.name);
    const exists = existsSync(full);
    // 存在但**不是普通文件**（同名目录等）→ 不询问覆盖，交给写入步骤暴露真实错误
    const regularFile = exists ? isRegularFile(full) : false;

    if (exists && regularFile) {
      let shouldWrite = false;
      if (policy === 'yes') {
        shouldWrite = true;
      } else if (policy === 'no') {
        shouldWrite = false;
      } else {
        // ask：非 TTY 直接按不覆盖（避免脚本里静默覆盖用户文件）
        shouldWrite = isTTY ? await confirmOverwrite(target.name) : false;
        if (!isTTY) {
          log(fmt(dict.existsNonTty, { file: target.name }));
        }
      }
      if (!shouldWrite) {
        skipped.push(target.name);
        continue;
      }
    }

    try {
      await fs.writeFile(full, target.content, 'utf8');
      written.push(target.name);
    } catch (err) {
      logError(
        fmt(dict.writeFailed, {
          file: target.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // ── 5. 结果汇报 ──
  if (written.length === 0) {
    log(dict.nothingWritten);
    // 有文件存在但用户拒绝 → 不算失败（用户选择），退出 0
    return { code: 0, profile, written, skipped };
  }

  for (const line of renderSummary(profile, AGENTS_FILE, GUIDE_FILE)) {
    log(line);
  }
  if (skipped.length > 0) {
    log(fmt(dict.partiallySkipped, { files: skipped.join('、') }));
  }
  return { code: 0, profile, written, skipped };
}
