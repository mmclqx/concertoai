/**
 * Reviewer Agent 审查报告渲染组件（v2.1 M5）。
 *
 * 将 ReviewReport 渲染为 ANSI 彩色终端输出。
 */

import { Box, Text } from 'ink';
import type { FC } from 'react';

import { formatTestStatus, incompleteReasonText } from '../reviewer';
import type { ReviewReport } from '../reviewer/types';
import { ALL_DIMENSIONS, incompleteCount, isReviewIncomplete } from '../reviewer/types';

interface ReviewReportProps {
  report: ReviewReport;
}

export const ReviewReportView: FC<ReviewReportProps> = ({ report }) => {
  const critical = report.issues.filter((i) => i.severity === 'critical');
  const medium = report.issues.filter((i) => i.severity === 'medium');
  const suggestions = report.issues.filter((i) => i.severity === 'suggestion');
  // K16：审查不完整时不许说「未发现明显问题」（TUI 与 CLI 同口径）
  const incomplete = isReviewIncomplete(report);
  const missingDimensions = incompleteCount(report);

  return (
    <Box flexDirection="column">
      <Text bold>📋 Reviewer Agent 审查报告</Text>
      <Text dimColor>──────────────────────────────</Text>

      <Box flexDirection="column" marginY={1}>
        <Text>审查范围：{report.scope}</Text>
        <Text>审查时间：{report.timestamp}</Text>
        <Text>自动测试：{formatTestStatus(report)}</Text>
        <Text>
          严重程度：🔴 严重 × {critical.length} · 🟡 中等 × {medium.length} · 🟢 建议 ×{' '}
          {suggestions.length}
        </Text>
      </Box>

      {incomplete && (
        <Box flexDirection="column" marginY={1}>
          <Text bold color="yellow">
            ⚠️ 本次审查未完成（{ALL_DIMENSIONS.length - missingDimensions}/9 维已审）
          </Text>
          <Text dimColor>这不是「没问题」——下面这些维度没有审到，请先解决原因再重跑。</Text>
          {(report.incomplete ?? []).map((item) => (
            <Text key={item.group} color="yellow">
              • {item.dimensions.join(' / ')}：{incompleteReasonText(item.reason)}（{item.detail}）
            </Text>
          ))}
        </Box>
      )}

      {report.issues.length === 0 &&
        (incomplete ? (
          <Text color="yellow">
            ⚠️ 本次没有发现问题，但审查未完成（见上），不能当作「代码没问题」。
          </Text>
        ) : (
          <Text color="green">✅ 未发现明显问题，代码质量良好。</Text>
        ))}

      {critical.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text bold color="red">
            🔴 严重问题（{critical.length}）
          </Text>
          {critical.map((issue) => (
            <Box
              key={`${issue.file}:${issue.line ?? 0}:${issue.title}`}
              flexDirection="column"
              marginLeft={2}
            >
              <Text color="red">
                [{issue.dimension}] {issue.file}
                {issue.line !== undefined ? `:${issue.line}` : ''} — {issue.title}
              </Text>
              <Text dimColor>{issue.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {medium.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text bold color="yellow">
            🟡 中等问题（{medium.length}）
          </Text>
          {medium.map((issue) => (
            <Box
              key={`${issue.file}:${issue.line ?? 0}:${issue.title}`}
              flexDirection="column"
              marginLeft={2}
            >
              <Text color="yellow">
                [{issue.dimension}] {issue.file}
                {issue.line !== undefined ? `:${issue.line}` : ''} — {issue.title}
              </Text>
              <Text dimColor>{issue.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {suggestions.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text bold color="green">
            🟢 改进建议（{suggestions.length}）
          </Text>
          {suggestions.map((issue) => (
            <Box
              key={`${issue.file}:${issue.line ?? 0}:${issue.title}`}
              flexDirection="column"
              marginLeft={2}
            >
              <Text color="green">
                [{issue.dimension}] {issue.file}
                {issue.line !== undefined ? `:${issue.line}` : ''} — {issue.title}
              </Text>
              <Text dimColor>{issue.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginY={1}>
        <Text bold>📊 维度汇总</Text>
        {ALL_DIMENSIONS.map((dim) => {
          const s = report.summary[dim];
          if (s.critical + s.medium + s.suggestion === 0) return null;
          return (
            <Text key={dim}>
              {dim}: 🔴{s.critical} 🟡{s.medium} 🟢{s.suggestion}
            </Text>
          );
        })}
      </Box>

      {report.fixResult !== undefined && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>🔧 修复结果</Text>
          <Text>
            ✅ 已修复 {report.fixResult.fixed} 个 / ⚠ 需人工处理 {report.fixResult.manual} 个 / ❌
            自动回滚 {report.fixResult.rolledBack} 个
          </Text>
          {report.fixResult.items.map((item) => {
            const loc = `${item.issue.file}${item.issue.line !== undefined ? `:${item.issue.line}` : ''}`;
            const icon = item.status === 'fixed' ? '✅' : item.status === 'rolledback' ? '❌' : '⚠';
            const reason = item.reason !== undefined ? `（${item.reason}）` : '';
            return (
              <Box
                key={`${item.issue.file}:${item.issue.line ?? 0}:${item.issue.title}:${item.status}`}
                marginLeft={2}
              >
                <Text>
                  {icon} {loc} — {item.issue.title}
                  {reason}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
};
