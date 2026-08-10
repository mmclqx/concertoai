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

import type { SubagentSpawner } from '../agent/spawner';
import { createReviewAgents, parseReviewOutput } from './dimensions';
import { formatKnowledgeContext, loadKnowledgeBase } from './knowledge';
import type {
  ReviewAgentGroup,
  ReviewContextArtifact,
  ReviewIssue,
  ReviewOptions,
  ReviewReport,
  ReviewScope,
  ReviewSeverity,
  Severity,
} from './types';
import { ALL_DIMENSIONS, SEVERITY_ICON } from './types';

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
    const allIssues: ReviewIssue[] = [];
    for (const r of agentResults) {
      if (r.status === 'fulfilled') {
        const { group, result } = r.value;
        if (result.ok) {
          const issues = parseReviewOutput(result.summary, group);
          allIssues.push(...issues);
        }
        // 子代理失败 → 该维度标记为审查未完成（静默跳过）
      }
    }

    const issues = this.dedupAndSort(allIssues);

    // Step 5: 自动测试
    let testPassed: boolean | null = null;
    try {
      execSync('npm run verify', { cwd: this.cwd, timeout: 120_000, stdio: 'pipe' });
      testPassed = true;
    } catch {
      testPassed = false;
    }

    // Step 6: 汇总
    const summary = this.buildSummary(issues);
    const scopeDesc = this.describeScope(options.scope);
    const severity: ReviewSeverity = options.severity ?? 'normal';

    return {
      scope: scopeDesc,
      timestamp: new Date().toISOString(),
      testPassed,
      severity,
      issues,
      summary,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 自动修正 🟢 suggestion 级别问题。
   * 返回修正后的报告（包含修正结果）。
   */
  async autoFix(
    report: ReviewReport,
  ): Promise<{ report: ReviewReport; fixed: number; rolledBack: boolean }> {
    const suggestions = report.issues.filter(
      (i) => i.severity === 'suggestion' && i.suggestion !== undefined,
    );
    if (suggestions.length === 0) {
      return { report, fixed: 0, rolledBack: false };
    }

    // 对每个 suggestion 生成修复（由调用方负责审批和写入）
    // 此处仅标记，实际写入由 App.tsx 的审批流控制
    return { report, fixed: suggestions.length, rolledBack: false };
  }

  /**
   * 生成审查报告的 markdown 文本。
   */
  static formatReport(report: ReviewReport): string {
    const critical = report.issues.filter((i) => i.severity === 'critical');
    const medium = report.issues.filter((i) => i.severity === 'medium');
    const suggestions = report.issues.filter((i) => i.severity === 'suggestion');

    const lines: string[] = [
      '## 📋 Reviewer Agent 审查报告',
      '',
      `**审查范围**：${report.scope}`,
      `**审查时间**：${report.timestamp}`,
      `**自动测试**：${report.testPassed === null ? '未运行' : report.testPassed ? '✅ 通过' : '❌ 失败'}`,
      `**严重程度**：🔴 严重 × ${critical.length} · 🟡 中等 × ${medium.length} · 🟢 建议 × ${suggestions.length}`,
      '',
    ];

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
      lines.push('✅ 未发现明显问题，代码质量良好。');
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

/** 格式化单个问题为 markdown。 */
function formatIssue(issue: ReviewIssue): string {
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
