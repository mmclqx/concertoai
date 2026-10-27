/**
 * Node 版本检查（v5.0 T1，来自 npx 零安装实测发现）。
 *
 * 背景：`package.json` 声明 `engines.node >= 22`，但 Node 20 仍是 active LTS（用户量大）。
 * 实测 Node 20 下 `npx @concertoai/cli --version` 能跑，但 npm 会刷 4+ 条英文
 * `EBADENGINE Unsupported engine` 警告——新手第一眼会以为"装坏了"。
 *
 * 设计取舍（不添噪音，G3）：
 * - **不阻断**：版本不足也允许运行（`--version` / `--help` 等仍可用）；
 * - **只在交互式终端提示**：CI / 管道 / 脚本场景静默（避免污染日志）；
 * - **纯函数**：版本号与 isTTY 均可注入，便于单测。
 */

import { fmt, t } from '../i18n';

/** 支持的最低 Node 主版本（与 package.json engines 保持一致）。 */
export const MIN_NODE_MAJOR = 22;

/** 版本检查结果。 */
export interface NodeVersionCheck {
  /** 是否满足要求。 */
  ok: boolean;
  /** 当前主版本号（解析失败为 0）。 */
  major: number;
  /** 当前完整版本串。 */
  current: string;
  /** 提示文案；满足要求或非交互式终端时为空串。 */
  warning: string;
}

/**
 * 检查 Node 版本是否满足 engines 要求。
 *
 * @param current process.versions.node（可注入测试）
 * @param options.isTTY 是否交互式终端（默认 true；CI/管道传 false 不提示）
 * @param options.suppressed 用户显式静默（环境变量，默认 false）
 */
export function checkNodeVersion(
  current: string = process.versions.node,
  options: { isTTY?: boolean; suppressed?: boolean } = {},
): NodeVersionCheck {
  const major = Number.parseInt(current.split('.')[0] ?? '0', 10);
  const majorSafe = Number.isNaN(major) ? 0 : major;
  const ok = majorSafe >= MIN_NODE_MAJOR;
  const isTTY = options.isTTY ?? true;
  const suppressed = options.suppressed ?? false;
  const warning =
    ok || !isTTY || suppressed
      ? ''
      : fmt(t().nodeVersion.tooOld, { current, required: `Node ${MIN_NODE_MAJOR}+` });
  return { ok, major: majorSafe, current, warning };
}

/** 静默 Node 版本提示的环境变量名（用户嫌吵时可设置）。 */
export const SUPPRESS_NODE_WARN_ENV = 'CONCERTOAI_NO_NODE_WARN';

/** 当前环境是否要求静默 Node 版本提示。 */
export function isNodeWarnSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SUPPRESS_NODE_WARN_ENV];
  return raw === '1' || raw === 'true';
}
