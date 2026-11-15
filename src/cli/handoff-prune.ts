/**
 * `concertoai handoff list / prune`（v5.3 B4，2026-11-15 用户裁决）。
 *
 * ## 它解决什么问题
 *
 * 交接单落点是 `~/.concertoai/handoffs/<项目名>-<路径哈希>/handoff.md`，**一个路径一个目录**。
 * 每次跑全量测试都会用几十个临时 cwd 渲染真 `App`，于是那个目录会无界增长
 * （本机实测每次 `npm run test` +43 个，累计 1162 个）。测试侧已由「套件级默认隔离」
 * 治住新增（`tests/setup.ts`），本命令负责**存量**：让用户自己看清楚、自己决定删。
 *
 * ## 产品取向：默认不动，显式才删
 *
 * 与 `metrics` 默认 off、零上传同一条：**不替用户删数据**。故：
 * - 默认 **dry-run**：只列清单与判据，一个目录都不动；
 * - 必须 `--yes` 才真删（非交互环境尤其如此，与 `reflect clear` 同一套 fail-closed）。
 *
 * ## 两条判据（用户 2026-11-15 裁决，缺一不删）
 *
 * 1. **路径已不存在**——`handoff.md` 头部的 `> 项目:` 指向的目录当前不在了（临时目录已回收）；
 * 2. **无真实会话 id**——`> 会话:` 不是 `YYYYMMDD-HHMMSS-mmm` 形状（或干脆没有）。
 *
 * ## 为什么判据顺序是「先看会话，再看路径」
 *
 * 一份**带真实会话 id 的交接单是证据**（「那次为什么退出」的唯一记录）。
 * 即使它的项目目录已被删除（用户挪了项目 / 删了目录），那也是「过去发生过的事实」，
 * 不该因为「路径不在了」就被清掉——**真话不会因为不方便而变成垃圾**。
 * 故 `keep-real-session` 优先于 `prune`。
 *
 * ## 零网络
 *
 * 只读本地目录并（在 `--yes` 时）`rm` 之；不 import `http`/`net`/`fetch`。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { fmt, t } from '../i18n';
import { handoffsDir } from '../store/paths';
import { isRealSessionIdShape } from '../store/session';

/** 单个目录的处置结论。 */
export type PruneVerdict = 'keep-project-exists' | 'keep-real-session' | 'prune';

/** 扫描出来的单条记录（纯数据，便于单测直接断言）。 */
export interface HandoffDirInfo {
  /** `~/.concertoai/handoffs/` 下的目录名（`<项目名>-<hash12>`）。 */
  name: string;
  /** 目录里有没有 `handoff.md`。 */
  handoffExists: boolean;
  /** 交接单头部 `> 项目:` 的值（绝对路径）；取不到为 `undefined`。 */
  project: string | undefined;
  /** 交接单头部 `> 会话:` 的值；取不到 / 为「无」时为 `undefined`。 */
  sessionId: string | undefined;
  /** 处置结论。 */
  verdict: PruneVerdict;
  /** 人读的判定依据（打印用，也是测试断言的落点）。 */
  detail: string;
}

/**
 * 从交接单正文里取某个头部字段的值。
 *
 * **边界按结构定义，不按行形态**（AGENTS round-trip 条款）：只在 `## ①` 第一个小节
 * 之前的「头部区」里找，且遇到第一个 `## ` 就停。第一版在 `handoff.md` 里踩过这个坑
 * （`headerValue` 遇到首行 `# 标题` 就 break ⇒ 永远读不到 `> 项目:`）。
 */
export function headerValue(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let inHeader = true;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inHeader = false;
      break;
    }
    if (!inHeader) {
      break;
    }
    const m = new RegExp(`^>\\s*${key}:\\s*(.*)$`).exec(line);
    if (m !== null) {
      const value = (m[1] ?? '').trim();
      return value === '' || value === '无' ? undefined : value;
    }
  }
  return undefined;
}

/**
 * 判定单个目录该怎么处置（**纯函数**，`projectExists` 注入 ⇒ 可阶梯自证）。
 *
 * 判据来源见文件头「两条判据」。
 */
export function classifyHandoffDir(
  info: Pick<HandoffDirInfo, 'handoffExists' | 'project' | 'sessionId'>,
  projectExists: (project: string) => boolean,
): { verdict: PruneVerdict; detail: string } {
  // ① 真实会话 id ⇒ 证据优先，任何情况下都不删
  if (info.sessionId !== undefined && isRealSessionIdShape(info.sessionId)) {
    return { verdict: 'keep-real-session', detail: `真实会话 ${info.sessionId}` };
  }
  if (!info.handoffExists) {
    // 没有交接单 ⇒ 无法归属，也没有任何证据可留 ⇒ 孤儿目录
    return { verdict: 'prune', detail: '目录里没有 handoff.md' };
  }
  // ② 项目路径还在 ⇒ 用户可能还要用它
  if (info.project !== undefined && projectExists(info.project)) {
    return { verdict: 'keep-project-exists', detail: `项目仍在 ${info.project}` };
  }
  return {
    verdict: 'prune',
    detail: info.project === undefined ? '交接单里没有项目路径' : `项目已不存在 ${info.project}`,
  };
}

/** 扫描根目录下的所有交接单目录（只读）。 */
export function scanHandoffDirs(
  root: string = handoffsDir(),
  projectExists: (project: string) => boolean = (project) => existsSync(project),
): HandoffDirInfo[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: HandoffDirInfo[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = path.join(root, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue; // 读不到就跳过：扫清理清单不该因为一个坏目录整体失败
    }
    if (!isDir) {
      continue;
    }
    const file = path.join(dir, 'handoff.md');
    let handoffExists = false;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
      handoffExists = true;
    } catch {
      handoffExists = false;
    }
    const project = handoffExists ? headerValue(text, '项目') : undefined;
    const sessionId = handoffExists ? headerValue(text, '会话') : undefined;
    const { verdict, detail } = classifyHandoffDir(
      { handoffExists, project, sessionId },
      projectExists,
    );
    out.push({ name, handoffExists, project, sessionId, verdict, detail });
  }
  return out;
}

export interface PruneResult {
  /** 判定为可删的目录名。 */
  candidates: string[];
  /** 实际删掉的目录名（dry-run 时为空）。 */
  removed: string[];
  /** 删除失败的 `名字: 原因`。 */
  failed: string[];
}

/**
 * 执行清理。
 * @param apply `false`（默认）= 只看不动；`true` = 真删（CLI 层的 `--yes` 才传 true）
 */
export function pruneHandoffs(
  options: { root?: string; apply?: boolean; projectExists?: (project: string) => boolean } = {},
): PruneResult {
  const root = options.root ?? handoffsDir();
  const infos = scanHandoffDirs(root, options.projectExists);
  const candidates = infos.filter((i) => i.verdict === 'prune').map((i) => i.name);
  const result: PruneResult = { candidates, removed: [], failed: [] };
  if (options.apply !== true) {
    return result;
  }
  for (const name of candidates) {
    try {
      rmSync(path.join(root, name), { recursive: true, force: true });
      result.removed.push(name);
    } catch (err) {
      result.failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export interface RunHandoffCommandOptions {
  /** 子命令（list / prune）。 */
  action: string;
  /** `prune` 时是否真删（缺省 dry-run）。 */
  yes?: boolean;
  /** 根目录注入（测试用）。 */
  root?: string;
  /** 输出注入（测试用）。 */
  log?: (message: string) => void;
}

/** 每类结论打印时的中文标签。 */
function verdictLabel(verdict: PruneVerdict): string {
  const dict = t().handoff;
  switch (verdict) {
    case 'keep-real-session':
      return dict.keepRealSession;
    case 'keep-project-exists':
      return dict.keepProjectExists;
    default:
      return dict.prune;
  }
}

/**
 * 执行 handoff 命令。
 * @returns 退出码（0 正常；1 未知子命令 / 有删除失败）
 */
export function runHandoffCommand(options: RunHandoffCommandOptions): number {
  const dict = t().handoff;
  const log = options.log ?? ((message: string): void => console.log(message));
  const root = options.root ?? handoffsDir();

  if (options.action !== 'list' && options.action !== 'prune') {
    log(fmt(dict.unknownAction, { action: options.action }));
    return 1;
  }

  const infos = scanHandoffDirs(root);
  if (infos.length === 0) {
    log(fmt(dict.empty, { path: root }));
    return 0;
  }

  const counts = {
    keepRealSession: infos.filter((i) => i.verdict === 'keep-real-session').length,
    keepProjectExists: infos.filter((i) => i.verdict === 'keep-project-exists').length,
    prune: infos.filter((i) => i.verdict === 'prune').length,
  };

  log(fmt(dict.title, { path: root, total: infos.length }));
  log(
    fmt(dict.summary, {
      keepRealSession: counts.keepRealSession,
      keepProjectExists: counts.keepProjectExists,
      prune: counts.prune,
    }),
  );

  // 逐条列出**判据**（不只给个数字：用户要能自己核对为什么这个能删）
  for (const info of infos) {
    log(`  ${verdictLabel(info.verdict).padEnd(12)} ${info.name}  ← ${info.detail}`);
  }

  if (options.action === 'list') {
    log(dict.listHint);
    return 0;
  }

  const result = pruneHandoffs({ root, apply: options.yes === true });
  if (options.yes !== true) {
    if (result.candidates.length === 0) {
      log(dict.nothingToPrune);
      return 0;
    }
    log(fmt(dict.dryRun, { count: result.candidates.length }));
    log(dict.dryRunHint);
    return 0;
  }

  log(fmt(dict.pruned, { count: result.removed.length }));
  if (result.failed.length > 0) {
    for (const f of result.failed) {
      log(`  ❌ ${f}`);
    }
    return 1;
  }
  return 0;
}
