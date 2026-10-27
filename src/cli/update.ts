/**
 * `concertoai update` 命令（v5.0 T2）：检查 npm 最新版并升级。
 *
 * 设计要点：
 * - **可测**：版本查询与安装执行全部可注入（`fetchLatestVersion` / `runInstall`），
 *   测试不打真实网络、不改全局环境；
 * - **fail-closed 精神**：默认需确认才升级（`--yes` 才跳过），且**只升到 latest**；
 * - **npx 场景拒绝升级**（R2）：未全局安装时升级会装到一个临时目录、对用户无意义 →
 *   明确提示「请先 npm install -g」而不是假装升级成功；
 * - **不误伤**：网络失败 / 权限失败 → 友好提示 + 可操作下一步，非崩溃。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fmt, t } from '../i18n';
import { VERSION } from '../version';
import { promptLine } from './prompt';

const execFileAsync = promisify(execFile);

/** npm 包名（与 package.json 保持一致）。 */
export const PACKAGE_NAME = '@concertoai/cli';

/** 安装类型。 */
export type InstallKind = 'global' | 'npx' | 'unknown';

/** 版本查询结果。 */
export interface LatestVersionResult {
  /** 最新版本号；查询失败为 undefined。 */
  latest: string | undefined;
  /** 失败原因（供提示）。 */
  error?: string;
}

/** update 命令选项（全部可注入，便于测试）。 */
export interface UpdateCommandOptions {
  /** 当前版本（默认 VERSION）。 */
  currentVersion?: string;
  /** 查询最新版本（默认走 npm view）。 */
  fetchLatestVersion?: () => Promise<LatestVersionResult>;
  /** 安装执行（默认 npm install -g）。 */
  runInstall?: (version: string) => Promise<{ ok: boolean; error?: string }>;
  /** 安装类型检测（默认查全局 node_modules）。 */
  detectInstallKind?: () => Promise<InstallKind>;
  /** 交互式确认（默认 readline；测试注入）。 */
  confirm?: (message: string) => Promise<boolean>;
  /** 跳过确认（--yes）。 */
  yes?: boolean;
  /** 是否交互式终端（非 TTY 时不给确认，走 fail-closed）。 */
  isTTY?: boolean;
  /** 输出函数（测试注入）。 */
  log?: (line: string) => void;
}

/** 默认版本查询：`npm view <pkg> version`。 */
export async function defaultFetchLatestVersion(): Promise<LatestVersionResult> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', PACKAGE_NAME, 'version'], {
      shell: process.platform === 'win32',
      timeout: 20_000,
      windowsHide: true,
    });
    const latest = stdout.trim();
    if (latest === '') {
      return { latest: undefined, error: 'npm 返回空版本号' };
    }
    return { latest };
  } catch (err) {
    return { latest: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 默认安装执行：`npm install -g <pkg>@<version>`。 */
async function defaultRunInstall(version: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync('npm', ['install', '-g', `${PACKAGE_NAME}@${version}`], {
      shell: process.platform === 'win32',
      timeout: 120_000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 检测安装类型：全局安装（npm root -g 下存在本包）vs npx 临时安装。
 *
 * 判据：`npm root -g` 输出的目录下是否存在 `@concertoai/cli/package.json`。
 * 检测失败（npm 不可用）→ 'unknown'（此时按「不可升级」处理，提示用户手动确认）。
 */
export async function defaultDetectInstallKind(): Promise<InstallKind> {
  try {
    const { stdout } = await execFileAsync('npm', ['root', '-g'], {
      shell: process.platform === 'win32',
      timeout: 20_000,
      windowsHide: true,
    });
    const globalRoot = stdout.trim();
    if (globalRoot === '') {
      return 'unknown';
    }
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkgJson = join(globalRoot, ...PACKAGE_NAME.split('/'), 'package.json');
    return existsSync(pkgJson) ? 'global' : 'npx';
  } catch {
    return 'unknown';
  }
}

/**
 * 语义化版本比较：返回 -1（a<b）/ 0（相等）/ 1（a>b）。
 *
 * 只比较数字段（忽略预发布后缀），足够用于 "是否有新版" 判定。
 * 非法输入按 0 处理（不抛错——版本串来自外部 npm，必须容错）。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const core = v.trim().replace(/^v/, '').split('-')[0] ?? '';
    return core.split('.').map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 错误信息最大展示长度（超出截断——npm 错误可能含数千字符，会淹没终端）。 */
export const MAX_ERROR_DISPLAY = 300;

/** 截断错误信息用于展示（保留头部，尾部加省略标记）。 */
export function truncateError(message: string, max = MAX_ERROR_DISPLAY): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…（已截断）`;
}

/**
 * 执行 update 命令；返回进程退出码（0 = 已最新或升级成功，1 = 失败/被拒绝）。
 *
 * 分支：
 * 1. 查询失败 → 提示 + 1（附手动升级命令）
 * 2. 已最新 → 提示 + 0
 * 3. 非全局安装（npx）→ 提示先全局安装 + 1（**不假装升级**）
 * 4. 有新版本 → 确认（--yes 跳过）→ 安装 → 结果提示
 */
export async function runUpdateCommand(options: UpdateCommandOptions = {}): Promise<number> {
  const dict = t().update;
  const log = options.log ?? ((line: string) => console.log(line));
  const current = options.currentVersion ?? VERSION;
  const fetchLatest = options.fetchLatestVersion ?? defaultFetchLatestVersion;
  const runInstall = options.runInstall ?? defaultRunInstall;
  const detectKind = options.detectInstallKind ?? defaultDetectInstallKind;
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  const confirm =
    options.confirm ??
    (async (message: string) => {
      const answer = await promptLine(`${message} [y/N] `);
      // undefined = 非 TTY / Ctrl+C / 超时（见 promptLine 语义）→ 按拒绝处理（fail-closed）
      if (answer === undefined) {
        return false;
      }
      return /^y(es)?$/i.test(answer.trim());
    });

  // ── 步骤 1：查询最新版本 ──
  log(fmt(dict.checking, { current }));
  const { latest, error } = await fetchLatest();
  if (latest === undefined) {
    log('');
    log(fmt(dict.fetchFailed, { error: truncateError(error ?? 'unknown') }));
    log(fmt(dict.manualHint, { command: `npm install -g ${PACKAGE_NAME}@latest` }));
    return 1;
  }

  // ── 步骤 2：已是最新 ──
  if (compareVersions(latest, current) <= 0) {
    log(fmt(dict.upToDate, { current }));
    return 0;
  }

  // ── 步骤 3：确认安装方式（npx 场景不升级） ──
  const kind = await detectKind();
  log('');
  log(fmt(dict.newVersion, { current, latest }));
  if (kind === 'npx') {
    log(fmt(dict.npxHint, { command: `npm install -g ${PACKAGE_NAME}@latest` }));
    return 1;
  }

  // ── 步骤 4：确认升级 ──
  if (options.yes !== true) {
    if (!isTTY) {
      // 非交互式且未加 --yes：fail-closed（不擅自改全局环境）
      log(fmt(dict.needConfirmNonTty, { command: 'concertoai update --yes' }));
      return 1;
    }
    const ok = await confirm(fmt(dict.confirmPrompt, { latest }));
    if (!ok) {
      log(dict.cancelled);
      return 0;
    }
  }

  // ── 步骤 5：执行安装 ──
  log(fmt(dict.installing, { latest }));
  const result = await runInstall(latest);
  if (!result.ok) {
    log('');
    log(fmt(dict.installFailed, { error: truncateError(result.error ?? 'unknown') }));
    log(fmt(dict.manualHint, { command: `npm install -g ${PACKAGE_NAME}@latest` }));
    return 1;
  }
  log(fmt(dict.installOk, { latest }));
  return 0;
}
