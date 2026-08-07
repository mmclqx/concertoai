import { Box, Text } from 'ink';

import { zh } from '../i18n/zh';

export interface ApprovalModalProps {
  kind: 'edit' | 'shell';
  summary: string;
  /** 详细内容（edit：统一 diff；shell：命令文本）。 */
  detail: string;
}

/** 通用审批框：黄框 + 标题 + 摘要 + 详情 + 按键提示。 */
export function ApprovalModal({ kind, summary, detail }: ApprovalModalProps) {
  const title = kind === 'edit' ? zh.approval.editTitle : zh.approval.shellTitle;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        {title}: {summary}
      </Text>
      <Text>{detail}</Text>
      <Text dimColor>
        {zh.approval.confirm} / {zh.approval.reject}
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
