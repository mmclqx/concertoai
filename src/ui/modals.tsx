import { Box, Text } from 'ink';

import { t } from '../i18n';

export interface ApprovalModalProps {
  kind: 'edit' | 'shell' | 'model';
  summary: string;
  /** 详细内容（edit：统一 diff；shell：命令文本；model：成本对比）。 */
  detail: string;
}

/** 通用审批框：黄框 + 标题 + 摘要 + 详情 + 按键提示。 */
export function ApprovalModal({ kind, summary, detail }: ApprovalModalProps) {
  const dict = t().approval;
  const title =
    kind === 'edit' ? dict.editTitle : kind === 'shell' ? dict.shellTitle : dict.modelTitle;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        {title}: {summary}
      </Text>
      <Text>{detail}</Text>
      <Text dimColor>
        {t().approval.confirm} / {t().approval.reject}
      </Text>
    </Box>
  );
}

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
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginY={1}>
      <Text bold color="blue">
        执行进度 {done}/{total}
        {failed > 0 ? `（${failed} 失败）` : ''}
      </Text>
      {steps.map((s) => (
        <Text key={s.step.index} dimColor={s.status === 'pending'}>
          {STATUS_ICON[s.status] ?? '  '} 步骤{s.step.index}. {s.step.title}
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
