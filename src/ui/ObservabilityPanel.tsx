/**
 * 可观测性面板（v3.0 M5 / T5.3）。
 *
 * 展示 Agent 协作流程树：节点 = 任务/Agent，含实时状态（🟢🟡🔴）、耗时与消息数。
 * - open=false 时不渲染任何内容（不阻塞主对话流）；
 * - 流程树按 TraceSpan 组织：taskId 分组，parentTaskId 缩进为子树；
 * - 面板纯展示（无副作用），数据由 App 传入（默认收起，'o' 键切换）。
 *
 * 性能基准（§6.1）：50 个节点渲染 < 100ms（ink-testing-library 渲染测试断言）。
 */

import { Box, Text } from 'ink';
import type { TraceSpan } from '../observable';

export interface ObservabilityPanelProps {
  /** 全部追踪跨度（来自 TraceStore.all()）。 */
  spans: TraceSpan[];
  /** 是否展开面板（false = 不渲染，不阻塞主对话流）。 */
  open: boolean;
}

/** 状态徽标：completed → 🟢 / in_progress 等 → 🟡 / failed → 🔴。 */
function statusBadge(span: TraceSpan): string {
  const decision = span.decision ?? '';
  if (decision.includes('failed') || decision.includes('reject')) return '🔴';
  if (decision.includes('completed') || decision.includes('approve')) return '🟢';
  return '🟡';
}

/** 流程树渲染行（含稳定 key：taskId + span.id，避免索引 key）。 */
interface TreeLine {
  id: string;
  text: string;
}

/** 把 spans 按 taskId 组织为流程树（父子缩进），返回渲染行。 */
function buildTreeLines(spans: TraceSpan[]): TreeLine[] {
  // 按 taskId 分组
  const byTask = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    const list = byTask.get(span.taskId) ?? [];
    list.push(span);
    byTask.set(span.taskId, list);
  }

  // 找到根任务（无 parentTaskId 指向、或在 spans 中作为父出现的）
  const childTasks = new Set(
    spans.filter((s) => s.parentTaskId !== undefined).map((s) => s.taskId),
  );
  const roots = [...byTask.keys()].filter((tid) => !childTasks.has(tid) || !byTask.has(tid));

  const lines: TreeLine[] = [];
  const visit = (taskId: string, depth: number): void => {
    const taskSpans = byTask.get(taskId) ?? [];
    const indent = '  '.repeat(depth);
    for (const span of taskSpans) {
      const badge = statusBadge(span);
      const dur = span.durationMs > 0 ? ` · ${span.durationMs}ms` : '';
      const decision = span.decision !== undefined ? ` · ${span.decision}` : '';
      lines.push({
        id: `${taskId}:${span.id}`,
        text: `${indent}${badge} ${span.taskId} · ${span.agentName} (${span.messageType})${dur}${decision}`,
      });
    }
    // 子任务递归
    for (const span of spans) {
      if (span.parentTaskId === taskId) {
        visit(span.taskId, depth + 1);
        break; // 每个子任务只访问一次（taskId 分组已覆盖其全部 spans）
      }
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }
  return lines;
}

/** 可观测性面板组件（纯展示）。 */
export function ObservabilityPanel({ spans, open }: ObservabilityPanelProps) {
  if (!open) {
    return null;
  }
  const lines = buildTreeLines(spans);
  if (lines.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>📡 可观测性：暂无追踪数据（多 Agent 协作运行后自动填充）</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        📡 Agent 协作流程树（{spans.length} 条记录）
      </Text>
      {lines.map((line, i) => (
        <Text key={line.id} dimColor={i % 2 === 1}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
