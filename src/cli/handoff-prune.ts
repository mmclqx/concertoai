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
 * ## v5.4 候选 1（2026-11-15 用户裁决）：从「只看形状」升级为「交叉核验」
 *
 * 原来只认 id 的**形状**，于是「形状合法但会话文件早已不在」的目录全被当证据保留
 * （本机实测 146 个里 145 个属于这种：`项目 = Temp\concertoai-v51-*` 且项目目录已回收，
 * 两条判据本都满足，却因为形状合法而永不清理）。
 *
 * 现在改为问 `sessionFileState()`（三态），并按 **prune 的保守方向**解读：
 *
 * | 形状 | 会话文件 | 结论 |
 * |---|---|---|
 * | 不合法 / 无 id | — | 不构成证据（落到路径判据） |
 * | 合法 | `exists` | `keep-real-session` 保留·证据 |
 * | 合法 | `unknown`（读不到） | `keep-unverified` 保留·未核验（**不能当没有**） |
 * | 合法 | `absent`（查得到、确实没有） | 不构成证据（落到路径判据） |
 *
 * 这就是「统一事实来源、取向各自保守」：`handoff-home-guard` 问的是同一个函数，
 * 但那边把 `unknown` 判红（护栏宁可误报），这边把 `unknown` 保留（删除不可逆）。
 *
 * ## 零网络
 *
 * 只读本地目录并（在 `--yes` 时）`rm` 之；不 import `http`/`net`/`fetch`。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { fmt, t } from '../i18n';
import { handoffsDir } from '../store/paths';
import { isRealSessionIdShape, type SessionFileState, sessionFileState } from '../store/session';

/**
 * 单个目录的处置结论（四类，v5.4 候选 1 起多出第三类）。
 *
 * - `keep-real-session`：形状合法 **且** 会话文件核验存在 ⇒ 证据，保留；
 * - `keep-unverified`：形状合法但**读不到**会话目录 ⇒ 保留但如实标「未核验」；
 * - `keep-project-exists`：项目目录还在 ⇒ 保留（用户下次还要进这个项目）；
 * - `prune`：不构成证据 **且** 项目不在了 ⇒ 可清理（dry-run 才报，`--yes` 才删）。
 */
export type PruneVerdict =
  | 'keep-project-exists'
  | 'keep-real-session'
  | 'keep-unverified'
  | 'prune';

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
 * 判定单个目录该怎么处置（**纯函数**，两个依赖都注入 ⇒ 可阶梯自证）。
 *
 * 判据来源见文件头「两条判据」与「v5.4 候选 1：交叉核验」。
 *
 * @param stateOf 会话 id ⇒ 三态（`exists` / `absent` / `unknown`）。
 *   **默认用真实实现；测试注入假实现来单独验每个分支**。
 * @param projectExists 项目路径 ⇒ 是否还在
 */
export function classifyHandoffDir(
  info: Pick<HandoffDirInfo, 'handoffExists' | 'project' | 'sessionId'>,
  projectExists: (project: string) => boolean,
  stateOf: (id: string) => SessionFileState = sessionFileState,
): { verdict: PruneVerdict; detail: string } {
  // ① 形状合法 ⇒ 才谈得上「证据」，但**形状不等于证据**（v5.4 候选 1 修的就是这个）
  if (info.sessionId !== undefined && isRealSessionIdShape(info.sessionId)) {
    const state = stateOf(info.sessionId);
    if (state === 'exists') {
      return { verdict: 'keep-real-session', detail: `真实会话 ${info.sessionId}（已核验）` };
    }
    if (state === 'unknown') {
      // 读不到 ≠ 没有：删除不可逆，这一档必须保留，且如实告诉用户「没核验到」
      return {
        verdict: 'keep-unverified',
        detail: `会话 ${info.sessionId} 无法核验（读不到会话目录，按保守保留）`,
      };
    }
    // 走到这里 = `absent`：形状对但会话文件确实查无 ⇒ 不构成证据，继续看项目路径
  }
  if (!info.handoffExists) {
    // 没有交接单 ⇒ 无法归属，也没有任何证据可留 ⇒ 孤儿目录
    return { verdict: 'prune', detail: '目录里没有 handoff.md' };
  }
  // ② 项目路径还在 ⇒ 用户可能还要用它
  if (info.project !== undefined && projectExists(info.project)) {
    return { verdict: 'keep-project-exists', detail: `项目仍在 ${info.project}` };
  }
  const why =
    info.sessionId !== undefined && isRealSessionIdShape(info.sessionId)
      ? `会话 ${info.sessionId} 的文件已不存在`
      : undefined;
  const base = info.project === undefined ? '交接单里没有项目路径' : `项目已不存在 ${info.project}`;
  return { verdict: 'prune', detail: why === undefined ? base : `${base}；${why}` };
}

/** 扫描根目录下的所有交接单目录（只读）。 */
export function scanHandoffDirs(
  root: string = handoffsDir(),
  projectExists: (project: string) => boolean = (project) => existsSync(project),
  stateOf: (id: string) => SessionFileState = sessionFileState,
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
      stateOf,
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
  options: {
    root?: string;
    apply?: boolean;
    projectExists?: (project: string) => boolean;
    sessionStateOf?: (id: string) => SessionFileState;
  } = {},
): PruneResult {
  const root = options.root ?? handoffsDir();
  const infos = scanHandoffDirs(root, options.projectExists, options.sessionStateOf);
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
  /** 会话文件三态注入（测试用；默认问真实 `~/.concertoai/sessions/`）。 */
  sessionStateOf?: (id: string) => SessionFileState;
  /** 输出注入（测试用）。 */
  log?: (message: string) => void;
}

/** 每类结论打印时的中文标签。 */
function verdictLabel(verdict: PruneVerdict): string {
  const dict = t().handoff;
  switch (verdict) {
    case 'keep-real-session':
      return dict.keepRealSession;
    case 'keep-unverified':
      return dict.keepUnverified;
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

  const infos = scanHandoffDirs(root, undefined, options.sessionStateOf);
  if (infos.length === 0) {
    log(fmt(dict.empty, { path: root }));
    return 0;
  }

  const counts = {
    keepRealSession: infos.filter((i) => i.verdict === 'keep-real-session').length,
    keepUnverified: infos.filter((i) => i.verdict === 'keep-unverified').length,
    keepProjectExists: infos.filter((i) => i.verdict === 'keep-project-exists').length,
    prune: infos.filter((i) => i.verdict === 'prune').length,
  };
  /**
   * 可清理里「因为**会话文件查无**而进清单」的那部分（v5.4 候选 1，用户要求分开计数）：
   * 只给一个「可清理 145 个」，用户没法分辨到底是「会话文件查无」还是「项目路径不存在」——
   * 而这两者该不该删的判断完全不同。判据：形状合法（本该是证据）但走到了 prune ⇒ 只能是
   * `absent` 这条路（`unknown` 会留在 keep-unverified）。
   */
  const pruneAbsent = infos.filter(
    (i) =>
      i.verdict === 'prune' &&
      i.handoffExists &&
      i.sessionId !== undefined &&
      isRealSessionIdShape(i.sessionId),
  ).length;

  log(fmt(dict.title, { path: root, total: infos.length }));
  log(
    fmt(dict.summary, {
      keepRealSession: counts.keepRealSession,
      keepUnverified: counts.keepUnverified,
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

  const result = pruneHandoffs({
    root,
    apply: options.yes === true,
    sessionStateOf: options.sessionStateOf,
  });
  if (options.yes !== true) {
    if (result.candidates.length === 0) {
      log(dict.nothingToPrune);
      return 0;
    }
    log(fmt(dict.dryRun, { count: result.candidates.length }));
    log(dict.dryRunHint);
    return 0;
  }

  /**
   * ## 真删之前必须先把账念一遍（v5.4 候选 1，用户明确要求）
   *
   * `--yes` 的意思是「**跳过审批**」，不是「跳过摘要」。删除不可逆，所以真删那一刻
   * 屏幕上必须先出现一行「将删几个、每个理由是什类、留了几个、其中几个是没核验过的」。
   * 少了这行，用户点完 --yes 就只剩「删了 145 个」一个数字，**事后无法复盘删了什么**。
   */
  log(
    fmt(dict.confirmYes, {
      count: result.candidates.length,
      absentCount: pruneAbsent,
      keepRealSession: counts.keepRealSession,
      keepUnverified: counts.keepUnverified,
      keepProjectExists: counts.keepProjectExists,
    }),
  );

  log(fmt(dict.pruned, { count: result.removed.length }));
  if (result.failed.length > 0) {
    for (const f of result.failed) {
      log(`  ❌ ${f}`);
    }
    return 1;
  }
  return 0;
}
