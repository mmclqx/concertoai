/**
 * Reviewer Agent 工作流引擎（v2.1 M5）。
 *
 * 6 步流程：
 * 1. 上下文收集（审查范围 + 知识库加载）
 * 2. 知识激活（注入子代理系统提示）
 * 3. 并行子代理审查（5 个维度组并行）
 * 4. 结果聚合（去重 → 排序）
 * 5. 自动测试（npm run verify）
 * 6. 自动修正/回滚（仅 🟢 suggestion）
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SubagentSpawner } from '../agent/spawner';
import { fmt, t } from '../i18n';
import { type AutoFixOptions, runAutoFix } from './autofix';
import { classifySubagentFailure, createReviewAgents, tryParseReviewOutput } from './dimensions';
import { formatKnowledgeContext, loadKnowledgeBase } from './knowledge';
import type {
  ReviewAgentGroup,
  ReviewContextArtifact,
  ReviewIncomplete,
  ReviewIssue,
  ReviewOptions,
  ReviewReport,
  ReviewScope,
  ReviewSeverity,
  Severity,
} from './types';
import { AGENT_DIMENSIONS, ALL_DIMENSIONS, incompleteCount, SEVERITY_ICON } from './types';

/**
 * 项目里是否定义了 `npm run verify` 脚本（K7）。
 *
 * **读 package.json，不解析 npm 输出**：靠 `Missing script` 之类英文串判「有没有脚本」
 * 是把第三方输出当协议（AGENTS 第 10 条同类教训）。读文件是确定性的，且能省掉一次 npm 启动。
 * 读不到 / 不是项目 → 视为没有脚本（`review` 在非项目目录本来就已经被范围解析拦住）。
 */
export function hasVerifyScript(cwd: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = (parsed as { scripts?: Record<string, unknown> }).scripts;
    const verify = scripts?.verify;
    return typeof verify === 'string' && verify.trim() !== '';
  } catch {
    return false;
  }
}

/** 把子代理的原始回复压成一句可展示的原因（解析失败时用）。 */
function condenseForReport(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine === '') {
    return '模型未返回内容';
  }
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/** 严重程度排序权重。 */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  medium: 1,
  suggestion: 2,
};

export class ReviewerEngine {
  constructor(
    private readonly spawner: SubagentSpawner,
    private readonly cwd: string,
  ) {}

  /**
   * 执行完整审查流程。
   */
  async review(options: ReviewOptions): Promise<ReviewReport> {
    const startedAt = Date.now();

    // Step 1: 上下文收集
    const scope = this.resolveScope(options.scope);
    // v3.0 I2：显式上下文中的代码工件（Coder 产出）内联注入审查 prompt，
    // 保证 Reviewer 能看到上下文中的代码（含无磁盘路径的虚拟工件）
    const artifactCtx = formatContextArtifacts(options.contextArtifacts);
    const kb = loadKnowledgeBase(this.cwd);
    const knowledgeCtx = formatKnowledgeContext(kb);

    // Step 2: 知识激活 → 创建审查子代理
    const agents = createReviewAgents(knowledgeCtx);
    const ag = this.spawner;
    for (const def of agents) {
      ag.register(def);
    }

    // Step 3: 并行子代理审查
    const agentResults = await Promise.allSettled(
      agents.map(async (def) => {
        const result = await ag.spawn({
          agentName: def.name,
          prompt: `请审查以下代码质量：\n${scope}${artifactCtx}\n\n严格按照你负责的维度进行审查，输出 JSON 格式结果。`,
        });
        return { group: def.name as ReviewAgentGroup, result };
      }),
    );

    // Step 4: 结果聚合
    //
    // K16（v5.0 T23.3 实测）：此前失败分支只是「静默跳过」，于是 5 个组全失败 = 0 条问题
    // = 报告「✅ 未发现明显问题」+ exit 0。断网 / Key 过期 / 余额耗尽 / 代理不通任何一种，
    // `review` 都会变成绿灯放行。现在失败必须**逐组记账**（含原因分类），报告与退出码都要表态。
    const allIssues: ReviewIssue[] = [];
    const incomplete: ReviewIncomplete[] = [];
    for (let i = 0; i < agentResults.length; i += 1) {
      const def = agents[i];
      const r = agentResults[i];
      if (def === undefined || r === undefined) {
        continue;
      }
      const group = def.name as ReviewAgentGroup;
      const dimensions = AGENT_DIMENSIONS[group];
      if (r.status === 'rejected') {
        const classified = classifySubagentFailure(
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
        incomplete.push({ group, dimensions, ...classified });
        continue;
      }
      const { result } = r.value;
      if (!result.ok) {
        // 子代理自己的失败原因（含 HTTP 状态 / 超时毫秒 / 网络错误）
        const classified = classifySubagentFailure(result.error ?? result.summary);
        incomplete.push({ group, dimensions, ...classified });
        continue;
      }
      const parsed = tryParseReviewOutput(result.summary, group);
      if (parsed === null) {
        // 回了，但不是可解析的 JSON —— 同样等于「这维没审到」，不能算「没问题」
        incomplete.push({
          group,
          dimensions,
          reason: 'parse-failed',
          detail: condenseForReport(result.summary),
        });
        continue;
      }
      allIssues.push(...parsed);
    }

    const issues = this.dedupAndSort(allIssues);

    // Step 5: 自动测试
    //
    // K7（v5.0 T23.3 实测）：项目**没有** `verify` 脚本时，跑 `npm run verify` 会得到
    // Missing script → 旧实现判成「❌ 失败」，读起来像「你的测试挂了」。先看 package.json，
    // 没有脚本就压根不跑（省一次 npm 启动），并如实标 `no-verify-script`。
    let testPassed: boolean | null = null;
    let testNotRunReason: ReviewReport['testNotRunReason'];
    if (hasVerifyScript(this.cwd)) {
      try {
        execSync('npm run verify', { cwd: this.cwd, timeout: 120_000, stdio: 'pipe' });
        testPassed = true;
      } catch {
        testPassed = false;
      }
    } else {
      testNotRunReason = 'no-verify-script';
    }

    // Step 6: 汇总
    const summary = this.buildSummary(issues);
    const scopeDesc = this.describeScope(options.scope);
    const severity: ReviewSeverity = options.severity ?? 'normal';

    return {
      scope: scopeDesc,
      timestamp: new Date().toISOString(),
      testPassed,
      ...(testNotRunReason !== undefined ? { testNotRunReason } : {}),
      ...(incomplete.length > 0 ? { incomplete } : {}),
      severity,
      issues,
      summary,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 自动修复审查问题（v4.0 M1 T1.1-T1.5 真正实现）。
   *
   * 委托 autofix.runAutoFix：A/B 分批 → 批量审批（fail-closed）→
   * 快照 → 写盘 → 增量 verify → commit / rollback。
   * 返回修正后的报告（fixResult 附加到 report，formatReport 渲染「修复结果」区块）。
   */
  async autoFix(
    report: ReviewReport,
    options: AutoFixOptions,
  ): Promise<{ report: ReviewReport; fixed: number; rolledBack: boolean; manual: number }> {
    // T1.1 无问题可修 → 直接结束（不进入修复流程，也不附加「修复结果」区块）
    if (report.issues.length === 0) {
      return { report, fixed: 0, rolledBack: false, manual: 0 };
    }
    const result = await runAutoFix(report, options);
    report.fixResult = {
      fixed: result.fixed,
      manual: result.manual,
      rolledBack: result.rolledBack,
      items: result.items,
    };
    return {
      report,
      fixed: result.fixed,
      rolledBack: result.rolledBack > 0,
      manual: result.manual,
    };
  }

  /**
   * 生成审查报告的 markdown 文本。
   */
  static formatReport(report: ReviewReport): string {
    const dict = t().reviewer;
    const critical = report.issues.filter((i) => i.severity === 'critical');
    const medium = report.issues.filter((i) => i.severity === 'medium');
    const suggestions = report.issues.filter((i) => i.severity === 'suggestion');
    const missing = incompleteCount(report);

    const lines: string[] = [
      '## 📋 Reviewer Agent 审查报告',
      '',
      `**审查范围**：${report.scope}`,
      `**审查时间**：${report.timestamp}`,
      `**自动测试**：${formatTestStatus(report)}`,
      `**严重程度**：🔴 严重 × ${critical.length} · 🟡 中等 × ${medium.length} · 🟢 建议 × ${suggestions.length}`,
      '',
    ];

    // K16：审查不完整必须**排在问题列表之前**——否则用户先看到「🔴×0」就走人了
    if (report.incomplete !== undefined && report.incomplete.length > 0) {
      lines.push(`### ${fmt(dict.incompleteTitle, { done: ALL_DIMENSIONS.length - missing })}`, '');
      lines.push(dict.incompleteHint, '');
      for (const item of report.incomplete) {
        lines.push(
          fmt(dict.incompleteItem, {
            dimensions: item.dimensions.join(' / '),
            reason: incompleteReasonText(item.reason),
            detail: item.detail,
            action: incompleteReasonAction(item.reason),
          }),
        );
      }
      lines.push('');
    }

    if (critical.length > 0) {
      lines.push('### 🔴 严重问题', '');
      for (const issue of critical) {
        lines.push(formatIssue(issue));
      }
    }

    if (medium.length > 0) {
      lines.push('### 🟡 中等问题', '');
      for (const issue of medium) {
        lines.push(formatIssue(issue));
      }
    }

    if (suggestions.length > 0) {
      lines.push('### 🟢 改进建议', '');
      for (const issue of suggestions) {
        lines.push(formatIssue(issue));
      }
    }

    if (report.issues.length === 0) {
      // K16：「没有发现问题」只有在**审完**时才能这么说
      lines.push(missing > 0 ? dict.incompleteNoIssues : '✅ 未发现明显问题，代码质量良好。');
    }

    lines.push('', '### 📊 汇总', '');
    lines.push('| 维度 | 🔴 | 🟡 | 🟢 |');
    lines.push('|------|----|----|-----|');
    for (const dim of ALL_DIMENSIONS) {
      const dc = report.summary[dim];
      if (dc.critical + dc.medium + dc.suggestion > 0) {
        lines.push(`| ${dim} | ${dc.critical} | ${dc.medium} | ${dc.suggestion} |`);
      }
    }

    // v4.0 M1 T1.4：修复结果区块（/review --fix 后附加；文案走 i18n，T1.6）
    if (report.fixResult !== undefined) {
      const { fixed, manual, rolledBack, items } = report.fixResult;
      const d = t().reviewer;
      lines.push('', `### ${d.fixResultTitle}`, '');
      lines.push(fmt(d.fixResultLine, { fixed, manual, rolledBack }), '');
      for (const item of items) {
        const loc = `${item.issue.file}${item.issue.line !== undefined ? `:${item.issue.line}` : ''}`;
        const title = item.issue.title;
        if (item.status === 'fixed') {
          lines.push(`- ${fmt(d.fixItemFixed, { location: loc, title })}`);
          const diffBlock = compactDiff(item.diff);
          if (diffBlock !== '') {
            lines.push(diffBlock);
          }
        } else if (item.status === 'rolledback') {
          lines.push(
            `- ${fmt(d.fixItemRolledBack, {
              location: loc,
              title,
              reason: item.reason ?? d.reasonVerifyFailed,
            })}`,
          );
          const diffBlock = compactDiff(item.diff);
          if (diffBlock !== '') {
            lines.push(diffBlock);
          }
        } else {
          lines.push(
            `- ${fmt(d.fixItemManual, { location: loc, title, reason: item.reason ?? d.reasonManual })}`,
          );
        }
      }
    }

    return lines.join('\n');
  }

  // ── 内部方法 ─────────────────────────────────────────────

  private resolveScope(scope: ReviewScope): string {
    if (scope.type === 'files') {
      return `审查目标文件：\n${scope.paths.map((p) => `- ${p}`).join('\n')}`;
    }
    if (scope.type === 'pr') {
      return `PR 变更 diff：\n\`\`\`diff\n${scope.diff}\n\`\`\``;
    }
    return '审查当前项目最近修改的代码（使用 git diff 或搜索最近变更文件）';
  }

  private describeScope(scope: ReviewScope): string {
    if (scope.type === 'files') return scope.paths.join(', ');
    if (scope.type === 'pr') return 'PR diff';
    return '最近修改';
  }

  /** 按 (file, title) 去重，按 severity 排序。 */
  private dedupAndSort(issues: ReviewIssue[]): ReviewIssue[] {
    const seen = new Set<string>();
    const unique: ReviewIssue[] = [];
    for (const issue of issues) {
      const key = `${issue.file}:${issue.line ?? 0}:${issue.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(issue);
      }
    }
    return unique.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }

  private buildSummary(issues: ReviewIssue[]): ReviewReport['summary'] {
    const summary: ReviewReport['summary'] = {} as ReviewReport['summary'];
    for (const dim of ALL_DIMENSIONS) {
      summary[dim] = { critical: 0, medium: 0, suggestion: 0 };
    }
    for (const issue of issues) {
      summary[issue.dimension][issue.severity] += 1;
    }
    return summary;
  }
}

/**
 * 将显式上下文中的代码工件格式化为内联代码块（v3.0 I2 修复）。
 *
 * 审查子代理直接阅读工件内容（优先于磁盘文件），保证 Reviewer 能看到
 * Coder 产出的代码（含无磁盘路径的虚拟工件）。无工件时返回空字符串。
 */
export function formatContextArtifacts(artifacts: ReviewContextArtifact[] | undefined): string {
  if (artifacts === undefined || artifacts.length === 0) {
    return '';
  }
  const lines = artifacts.map((a) => {
    const header = `文件：${a.path ?? '（无路径工件）'}`;
    return `${header}\n\`\`\`\n${a.content}\n\`\`\``;
  });
  return `\n\n上下文代码工件（Coder 产出，优先于磁盘文件）：\n${lines.join('\n\n')}`;
}

/**
 * 修复 diff 摘要（T1.4：修复结果区块每条带 diff 摘要）。
 * 截断为前 8 行，超出追加省略标记；空 diff 返回空字符串（不渲染）。
 */
function compactDiff(diff: string | undefined): string {
  if (diff === undefined || diff === '') {
    return '';
  }
  const lines = diff.split('\n');
  const shown = lines.slice(0, 8);
  const suffix = lines.length > 8 ? `\n  …（共 ${lines.length} 行）` : '';
  return `  \`\`\`diff\n  ${shown.join('\n  ')}\n  \`\`\`${suffix}`;
}

/**
 * 「自动测试」一行的文案（K7 三态）。
 *
 * `passed` / `failed` / `未运行（项目未定义 verify 脚本）` 三者必须**互相区分**：
 * 旧实现把「没脚本」也算「失败」，用户看到 ❌ 会去查自己的测试，而实际原因是没有脚本。
 */
export function formatTestStatus(report: ReviewReport): string {
  const dict = t().reviewer;
  if (report.testPassed === null) {
    return report.testNotRunReason === 'no-verify-script' ? dict.testNotRunNoScript : '未运行';
  }
  return report.testPassed ? '✅ 通过' : '❌ 失败';
}

/** 未完成原因 → 用户能读的短语（K16）。 */
export function incompleteReasonText(reason: ReviewIncomplete['reason']): string {
  const dict = t().reviewer;
  const map: Record<ReviewIncomplete['reason'], string> = {
    unauthorized: dict.reasonUnauthorized,
    quota: dict.reasonQuota,
    network: dict.reasonNetwork,
    timeout: dict.reasonTimeout,
    'parse-failed': dict.reasonParseFailed,
    'turn-limit': dict.reasonTurnLimit,
    error: dict.reasonError,
  };
  return map[reason];
}

/** 未完成原因 → 下一步该做什么（K16：不只说「未完成」，要说「然后呢」）。 */
export function incompleteReasonAction(reason: ReviewIncomplete['reason']): string {
  const dict = t().reviewer;
  const map: Record<ReviewIncomplete['reason'], string> = {
    unauthorized: dict.actionUnauthorized,
    quota: dict.actionQuota,
    network: dict.actionNetwork,
    timeout: dict.actionTimeout,
    'parse-failed': dict.actionParseFailed,
    'turn-limit': dict.actionTurnLimit,
    error: dict.actionError,
  };
  return map[reason];
}

/** 格式化单个问题为 markdown。 */ function formatIssue(issue: ReviewIssue): string {
  const icon = SEVERITY_ICON[issue.severity];
  const location = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
  const lines = [
    `#### ${icon} [${issue.dimension}] ${location}`,
    `**${issue.title}**`,
    '',
    issue.description,
  ];
  if (issue.suggestion !== undefined) {
    lines.push('', `**修复建议**：${issue.suggestion}`);
  }
  lines.push('');
  return lines.join('\n');
}
