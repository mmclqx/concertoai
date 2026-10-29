/**
 * Reviewer autoFix 修复流水线（v4.0 M1 T1.1-T1.5，质量闭环）。
 *
 * 职责：审查报告生成后，对可自动修复的问题（A 类）批量生成补丁 → 批量审批 →
 * 逐个「快照 → 写盘 → 增量 verify → commit / rollback」；需人工判断的问题（B 类）
 * 聚合展示。复用 self-heal snapshot-guard 状态机模式（generateModelFixPlan /
 * SnapshotManager），输入从「tsc type 错误」泛化为「审查问题 ReviewIssue」。
 *
 * 交互次数 ≤ 2：
 * 1. 用户执行 `/review --fix`（1 次）；
 * 2. A 类全部补丁生成后一次批量审批（diff 摘要），y 批准 → 全部执行（fail-closed）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { fmt, t } from '../i18n';
import type { ModelClient } from '../model/client';
import type { SnapshotManager } from '../orchestrator/transaction';
import { planEdit } from '../tools/edit';
import type { ApprovalRequest } from '../tools/registry';
import type { ReviewIssue, ReviewReport } from './types';

// ── 类型定义 ─────────────────────────────────────────────────

/** 修复批次：A 类（可模型生成补丁，自动批处理）/ B 类（需人工判断，聚合展示）。 */
export type FixCategory = 'A' | 'B';

/** 单条修复结果状态。 */
export type FixStatus = 'fixed' | 'manual' | 'rolledback';

/** 单条修复结果。 */
export interface AutoFixItem {
  /** 关联的审查问题。 */
  issue: ReviewIssue;
  /** 分批类别。 */
  category: FixCategory;
  /** 修复状态。 */
  status: FixStatus;
  /** 修复 diff（fixed 时展示摘要）。 */
  diff?: string;
  /** 失败/回滚/人工原因。 */
  reason?: string;
}

/** 修复执行结果（T1.4 修复报告区块消费）。 */
export interface AutoFixResult {
  /** 成功修复数。 */
  fixed: number;
  /** 需人工处理数（B 类 + 补丁生成失败 + 审批拒绝）。 */
  manual: number;
  /** 自动回滚数。 */
  rolledBack: number;
  /** 逐条结果（按原报告顺序）。 */
  items: AutoFixItem[];
}

/** autoFix 执行选项。 */
export interface AutoFixOptions {
  /** 工作目录（沙箱根）。 */
  cwd: string;
  /** 模型客户端（补丁生成；未提供则 A 类全部降级 manual）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
  /** 执行增量 verify（返回是否通过；调用方负责解析——生产全量/单文件、测试注入 fake；缺省不验证）。 */
  runVerify?: () => Promise<{ passed: boolean }>;
  /** 批量审批回调（A 类全部 diff 摘要一次确认；fail-closed，缺省拒绝）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 快照管理器（缺省不启用快照保护——与 self-heal T1.3 语义一致）。 */
  snapshots?: SnapshotManager;
  /** 快照 taskId 前缀（默认 `review-fix`）。 */
  snapshotPrefix?: string;
  /** 进度回调（已修复 / 总数）。 */
  onProgress?: (fixed: number, total: number) => void;
  /** 日志输出。 */
  log?: (message: string) => void;
}

// ── 常量 ─────────────────────────────────────────────────────

/** 快照 taskId 前缀。 */
const DEFAULT_SNAPSHOT_PREFIX = 'review-fix';

// ── A/B 分批（T1.2）──────────────────────────────────────────

/**
 * A/B 分批：A 类 = 🟢 suggestion 且可定位文件（file 非空）——尝试模型生成补丁；
 * B 类 = 🔴 critical / 🟡 medium 或文件不可定位——需人工判断（聚合展示）。
 * 注意：critical/medium 不自动修（安全阀门 fail-closed 语义，修不坏代码）。
 */
export function categorizeIssue(issue: ReviewIssue): FixCategory {
  return issue.severity === 'suggestion' && issue.file !== '' ? 'A' : 'B';
}

// ── 补丁生成（模型）────────────────────────────────────────────

/** 模型修复输出 schema（仅 search/replace；file 由审查问题决定）。 */
const reviewFixSchema = z.object({
  search: z.string(),
  replace: z.string(),
});

/** 模型修复系统提示：只输出一个 SEARCH/REPLACE 修复。 */
const REVIEW_FIX_SYSTEM_PROMPT = [
  '你是代码修复专家。针对给定的「文件 + 审查问题」，生成最小 SEARCH/REPLACE 修复。',
  '输出严格为 JSON（不要 markdown 围栏，不要其他文字），格式：',
  '{"search":"文件中唯一出现的原片段","replace":"替换后的新片段"}',
  '要求：',
  '- search 必须在文件中唯一出现（用足够上下文保证唯一）；',
  '- 只修这个问题；不改变无关代码；不新增多余 import；',
  '- search/replace 保持原文件换行风格；',
  '- 若无法安全修复（如问题描述含糊），输出 {"search":"","replace":""}。',
].join('\n');

/** 解析模型修复输出（容忍 ```json 围栏；结构不合法抛错）。 */
export function parseReviewFixOutput(text: string): { search: string; replace: string } {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `autoFix 模型输出不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。原文: ${trimmed.slice(0, 200)}`,
    );
  }
  const result = reviewFixSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`autoFix 模型输出结构不符合协议（${issues}）。原文: ${trimmed.slice(0, 200)}`);
  }
  // 无法安全修复（空 search/replace）→ 视为未生成
  if (result.data.search === '' && result.data.replace === '') {
    throw new Error('模型判定无法安全修复该问题');
  }
  return result.data;
}

/**
 * 为单个审查问题调用模型生成 SEARCH/REPLACE 修复计划（不落盘）。
 * 读取问题文件 → 组装 prompt → 模型输出 JSON → planEdit 校验唯一性 → 返回计划。
 * 模型调用/解析/校验失败返回 undefined（降级 manual，不中断整体流程）。
 */
export async function generateReviewFixPlan(
  issue: ReviewIssue,
  fileContent: string,
  client: ModelClient,
  model: string,
): Promise<{ search: string; replace: string; diff: string; newContent: string } | undefined> {
  const location = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
  const userPrompt = [
    `文件: ${issue.file}`,
    `问题位置: ${location}`,
    `问题标题: ${issue.title}`,
    `问题描述: ${issue.description}`,
    issue.suggestion !== undefined ? `修复建议: ${issue.suggestion}` : '',
    '',
    '===== 文件内容 =====',
    fileContent.slice(0, 20_000),
  ].join('\n');

  const parts: string[] = [];
  try {
    for await (const chunk of client.streamChat({
      model,
      messages: [
        { role: 'system', content: REVIEW_FIX_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    })) {
      for (const choice of chunk.choices) {
        const text = choice.delta.content ?? '';
        if (text !== '') {
          parts.push(text);
        }
      }
    }
  } catch {
    return undefined;
  }

  let input: { search: string; replace: string };
  try {
    input = parseReviewFixOutput(parts.join(''));
  } catch {
    return undefined;
  }
  try {
    const plan = planEdit(fileContent, input.search, input.replace);
    return {
      search: input.search,
      replace: input.replace,
      diff: plan.diff,
      newContent: plan.newContent,
    };
  } catch {
    return undefined;
  }
}

// ── 修复执行引擎（T1.3 + T1.5）────────────────────────────────

/**
 * 执行 autoFix 修复流水线。
 *
 * 流程：
 * 1. 分批：A/B 分类（categorizeIssue）；
 * 2. 补丁生成：A 类逐个读文件 + 模型生成补丁；生成失败 → manual（B 类语义）；
 * 3. 批量审批：A 类全部补丁生成成功后，聚合 diff 摘要一次 requestApproval
 *    （fail-closed：拒绝 → 全部 manual，不写盘）；
 * 4. 逐个执行：快照登记（begin + recordWrite）→ 写盘 → 增量 verify →
 *    通过 commit / 失败自动 rollback（T1.5 安全阀门）。
 */
export async function runAutoFix(
  report: ReviewReport,
  options: AutoFixOptions,
): Promise<AutoFixResult> {
  const log = options.log ?? (() => {});
  const items: AutoFixItem[] = [];

  // Step 1-2: 分批 + 补丁生成
  const patches: Array<{
    item: AutoFixItem;
    issue: ReviewIssue;
    plan: { search: string; replace: string; diff: string; newContent: string };
  }> = [];

  for (const issue of report.issues) {
    const category = categorizeIssue(issue);
    if (category === 'B') {
      items.push({
        issue,
        category,
        status: 'manual',
        reason:
          issue.severity === 'suggestion' ? '无法定位文件，需人工处理' : '复杂问题，需人工判断',
      });
      continue;
    }

    // A 类：缺少「生成补丁」的两件必需品 → 降级 manual。
    // **两种缺失必须分开说**：v5.0 T23.3 K10 就是因为把「没有客户端」与「没有模型」
    // 并成同一句「未配置模型」，把 CLI 侧的一个参数传递缺陷（`--fix` 拿到未解析的 model）
    // 谎报成「用户没配模型」——用户明明配好了，排查方向被直接带偏。
    if (options.client === undefined) {
      items.push({
        issue,
        category,
        status: 'manual',
        reason: '缺少模型客户端，无法生成修复补丁',
      });
      continue;
    }

    if (options.model === undefined) {
      items.push({
        issue,
        category,
        status: 'manual',
        reason: '未配置模型，无法生成修复补丁',
      });
      continue;
    }

    // 读文件（相对 cwd；失败 → manual）
    const absolute = path.resolve(options.cwd, issue.file);
    let fileContent: string;
    try {
      fileContent = await fs.readFile(absolute, 'utf8');
    } catch {
      items.push({
        issue,
        category,
        status: 'manual',
        reason: '文件不存在或不可读，需人工处理',
      });
      continue;
    }

    const plan = await generateReviewFixPlan(issue, fileContent, options.client, options.model);
    if (plan === undefined) {
      items.push({
        issue,
        category,
        status: 'manual',
        reason: '模型无法生成安全补丁，需人工处理',
      });
      continue;
    }
    const item: AutoFixItem = {
      issue,
      category,
      status: 'manual', // 暂定，审批通过后置 fixed / rolledback
      diff: plan.diff,
      reason: '待批量审批',
    };
    patches.push({ item, issue, plan });
    items.push(item);
  }

  // Step 3: 批量审批（A 类全部补丁一次确认）
  if (patches.length > 0) {
    const diffSummary = patches
      .map(
        (p, i) =>
          `### ${i + 1}. ${p.issue.file}${p.issue.line !== undefined ? `:${p.issue.line}` : ''} — ${p.issue.title}\n\`\`\`diff\n${p.plan.diff}\n\`\`\``,
      )
      .join('\n\n');
    const approved =
      (await options.requestApproval?.({
        kind: 'edit',
        summary: fmt(t().reviewer.autofixBatchSummary, { count: patches.length }),
        detail: diffSummary,
      })) ?? false;
    if (!approved) {
      for (const p of patches) {
        p.item.status = 'manual';
        p.item.reason = '用户拒绝批量审批，需人工处理';
        p.item.diff = undefined;
      }
      log(`[autoFix] 用户拒绝批量审批（${patches.length} 个 A 类建议）`);
    } else {
      // Step 4: 逐个执行（快照 → 写盘 → verify → commit/rollback）
      const total = patches.length;
      let done = 0;
      for (const p of patches) {
        const status = await applyOneFix(p.issue, p.plan, options);
        p.item.status =
          status === 'fixed' ? 'fixed' : status === 'rolledback' ? 'rolledback' : 'manual';
        if (p.item.status === 'fixed') {
          p.item.reason = undefined;
        } else if (p.item.status === 'rolledback') {
          // 修正 reason 语义：写盘后 verify 失败被回滚，而非「待批量审批」（真实端到端发现）
          p.item.reason = t().reviewer.reasonVerifyFailed;
        }
        done += 1;
        options.onProgress?.(done, total);
      }
    }
  }

  // 汇总
  const fixed = items.filter((i) => i.status === 'fixed').length;
  const rolledBack = items.filter((i) => i.status === 'rolledback').length;
  const manual = items.length - fixed - rolledBack;
  return { fixed, manual, rolledBack, items };
}

/** 单条修复执行：快照登记 → 写盘 → verify → commit / rollback。 */
async function applyOneFix(
  issue: ReviewIssue,
  plan: { search: string; replace: string; diff: string; newContent: string },
  options: AutoFixOptions,
): Promise<FixStatus> {
  const log = options.log ?? (() => {});
  const absolute = path.resolve(options.cwd, issue.file);
  // taskId 加随机后缀：多文件修复可能落在同一毫秒，避免快照目录冲突
  const taskId = `${options.snapshotPrefix ?? DEFAULT_SNAPSHOT_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const snapshots = options.snapshots;
  let txStarted = false;
  if (snapshots !== undefined) {
    try {
      await snapshots.begin(taskId, [issue.file]);
      await snapshots.recordWrite(taskId, issue.file, plan.newContent);
      txStarted = true;
    } catch (err) {
      // 快照登记失败 → 放弃回滚保护继续写盘（与 self-heal T1.3 语义一致）
      await snapshots.commit(taskId).catch(() => {});
      log(
        `[autoFix] 快照登记失败，跳过回滚保护: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    await fs.writeFile(absolute, plan.newContent, 'utf8');
  } catch (err) {
    log(`[autoFix] 写盘失败: ${err instanceof Error ? err.message : String(err)}`);
    if (txStarted && snapshots !== undefined) {
      await snapshots.rollback(taskId).catch(() => {});
    }
    return 'manual';
  }

  // 增量 verify（缺省不验证——仅测试降级；生产由调用方注入 runVerify）
  if (options.runVerify !== undefined) {
    let passed = false;
    try {
      const out = await options.runVerify();
      passed = out.passed;
    } catch {
      passed = false;
    }
    if (!passed) {
      log(`[autoFix] 修复后 verify 失败，自动回滚: ${issue.file}`);
      if (txStarted && snapshots !== undefined) {
        const rb = await snapshots.rollback(taskId);
        return rb.ok ? 'rolledback' : 'manual';
      }
      return 'rolledback';
    }
  }

  // verify 通过 → 提交快照
  if (txStarted && snapshots !== undefined) {
    await snapshots.commit(taskId);
  }
  log(`[autoFix] 修复成功: ${issue.file}`);
  return 'fixed';
}
