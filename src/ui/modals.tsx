import { Box, Text } from 'ink';
import { memo, useMemo } from 'react';

import type { ApprovalInsight, RiskLevel } from '../core/approval-insight';
import { fmt, t } from '../i18n';
import type { ApprovalIntent, ApprovalLine, ApprovalLineRole } from './approval-text';
import { isPlainApproval, renderApprovalLines } from './approval-text';

export interface ApprovalModalProps {
  kind: 'edit' | 'shell' | 'model';
  summary: string;
  /** 详细内容（edit：统一 diff；shell：命令文本；model：成本对比）。 */
  detail: string;
  /** 风险洞察（v5.0 T9）：null/undefined = plain 原貌（v4.1.1，G2 铁律的兜底）。 */
  insight?: ApprovalInsight | null;
  /** 编辑意图（new/edit 区分，edit 才传）。 */
  intent?: ApprovalIntent;
  /** `[v]` 展开完整 diff（纯展示态，不产生审批决议）。 */
  fullDiff?: boolean;
  /** `[?]` 内联说明。 */
  showHelp?: boolean;
  /** 影响面是否适用于本次操作（shell/model 传 false）。 */
  impactApplies?: boolean;
  /** 参与匹配的规则条数（「已检查 N 类」）。 */
  ruleCount?: number;
  /** 内容宽度（格）；缺省按终端宽度换算。 */
  width?: number;
}

/**
 * 层级 → 颜色（框线与标题）。
 *
 * `low` 用绿色、**不标红**——「没有发现问题」不该看起来像警告（R2 误报控制）。
 */
function levelColor(insight: ApprovalInsight | null | undefined): 'red' | 'yellow' | 'green' {
  if (insight === null || insight === undefined) {
    return 'yellow';
  }
  return insight.level === 'high' ? 'red' : insight.level === 'medium' ? 'yellow' : 'green';
}

/** 角色 → Ink 文本样式（**只认角色，不解析文本**）。 */
function roleStyle(
  role: ApprovalLineRole,
  level: RiskLevel | undefined,
): { color?: 'red' | 'yellow' | 'green' | 'cyan' | 'white'; bold?: boolean; dimColor?: boolean } {
  switch (role) {
    case 'title':
      return {
        bold: true,
        color:
          level === 'high'
            ? 'red'
            : level === 'medium'
              ? 'yellow'
              : level === 'low'
                ? 'green'
                : 'yellow',
      };
    case 'risk':
      return { color: 'red' };
    case 'attention':
      return { color: 'yellow' };
    case 'notice':
      return { color: 'yellow' };
    case 'focus':
      return { color: 'cyan' };
    case 'diff-add':
      return { color: 'green' };
    case 'diff-del':
      return { color: 'red' };
    case 'diff-hunk':
      return { color: 'cyan' };
    case 'diff-context':
    case 'detail':
    case 'fold':
    case 'buttons':
    case 'help':
      return { dimColor: true };
    default:
      return {};
  }
}

/** 按终端宽度换算卡片内容宽度（留出边框 + 内边距 + 余量，避免折行糊版）。 */
function contentWidth(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const columns = process.stdout.columns;
  const terminal = typeof columns === 'number' && columns > 0 ? columns : 80;
  return Math.max(40, Math.min(terminal - 6, 120));
}

/**
 * 审批框（v5.0 T9 风险教学卡）。
 *
 * **架构铁律（T9.3b）**：本组件不含任何面向用户的文案字面量——全部文本来自
 * `renderApprovalLines`（纯字符串函数，零 Ink 依赖），本组件只负责「着色 + 边框 + 布局」。
 * 因此 plain 降级路径与 TTY 正常路径的文案不可能漂移。
 *
 * **性能（T9.3）**：`memo` 包裹 + `useMemo` 只在入参变化时重算文本行；
 * 默认折叠 ≤ 12 行 diff，按下 `y`/`n` 不触发重新渲染整段 diff。
 */
export const ApprovalModal = memo(function ApprovalModal(props: ApprovalModalProps) {
  const {
    kind,
    summary,
    detail,
    insight = null,
    intent,
    fullDiff = false,
    showHelp = false,
    impactApplies,
    ruleCount,
    width,
  } = props;
  const computedWidth = contentWidth(width);
  const lines: ApprovalLine[] = useMemo(
    () =>
      renderApprovalLines({
        kind,
        summary,
        detail,
        insight,
        intent,
        fullDiff,
        showHelp,
        impactApplies,
        ruleCount,
        width: computedWidth,
      }),
    [
      kind,
      summary,
      detail,
      insight,
      intent,
      fullDiff,
      showHelp,
      impactApplies,
      ruleCount,
      computedWidth,
    ],
  );
  const plain = isPlainApproval({ kind, summary, detail, insight });
  const level = plain ? undefined : (insight?.level ?? undefined);
  const borderColor = levelColor(plain ? null : insight);
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      marginY={1}
    >
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 渲染行由纯函数一次性产出，无重排/无稳定 id
        <Text key={index} {...roleStyle(line.role, level)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
});

/** 编辑审批框（包装 ApprovalModal，kind 固定为 edit）。 */
export function EditConfirm(props: Omit<ApprovalModalProps, 'kind'>) {
  return <ApprovalModal {...props} kind="edit" />;
}

/** 命令审批框（包装 ApprovalModal，kind 固定为 shell）。 */
export function ShellConfirm(props: Omit<ApprovalModalProps, 'kind'>) {
  return <ApprovalModal {...props} kind="shell" />;
}

/** 计划展示最大字符数（超出截断显示，审批详情仍完整）。 */
const PLAN_DISPLAY_MAX = 2_000;

export interface PlanConfirmProps {
  plan: string;
}

import type { ProgressSummary } from '../planner/progress';

// …（上方代码不变）…

/** 计划进度视图：实时展示步骤执行状态。 */
export interface PlanProgressViewProps {
  summary: ProgressSummary;
}

/** 步骤状态 → 图标。 */
const STATUS_ICON: Record<string, string> = {
  pending: '⬜',
  in_progress: '⏳',
  completed: '✅',
  failed: '❌',
  skipped: '⏭️',
};

export function PlanProgressView({ summary }: PlanProgressViewProps) {
  const { total, completed, failed, skipped, steps } = summary;
  const done = completed + failed + skipped;
  const dict = t().plan;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginY={1}>
      <Text bold color="blue">
        {fmt(dict.progressTitle, { done, total })}
        {failed > 0 ? fmt(dict.progressFailedSuffix, { failed }) : ''}
      </Text>
      {steps.map((s) => (
        <Text key={s.step.index} dimColor={s.status === 'pending'}>
          {STATUS_ICON[s.status] ?? '  '}{' '}
          {fmt(dict.progressStep, { index: s.step.index, title: s.step.title })}
          {s.error !== undefined ? ` — ${s.error}` : ''}
        </Text>
      ))}
    </Box>
  );
}

/** 计划审批框：magenta 框 + 计划全文（超长截断）+ 按键提示。 */
export function PlanConfirm({ plan }: PlanConfirmProps) {
  const display =
    plan.length > PLAN_DISPLAY_MAX
      ? `${plan.slice(0, PLAN_DISPLAY_MAX)}\n…（计划已截断显示）`
      : plan;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} marginY={1}>
      <Text bold color="magenta">
        {t().plan.title}
      </Text>
      <Text>{display}</Text>
      <Text dimColor>{t().plan.hint}</Text>
    </Box>
  );
}
