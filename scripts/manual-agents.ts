/**
 * 手工测试 1.2：多角色 Agent 团队（Architect / Coder / Reviewer）。
 * - 1.2.1 Architect：真实模型生成 spec（不落盘）；
 * - 1.2.2 Coder：真实模型实现 + 修复模式 + 审批拒绝不写盘（内存 writer）；
 * - 1.2.3 Reviewer：注入 Fake engine 验证 approve/reject 判定逻辑。
 */
import { DeepSeekClient } from '../src/model/client';
import { ArchitectAgent, CoderAgent, TeamReviewerAgent } from '../src/agents';
import type { AgentContext } from '../src/orchestrator';
import type { ReviewReport } from '../src/reviewer';

const ctx: AgentContext = {
  sessionId: 'manual-1-2',
  taskId: 'root',
  parentTaskId: undefined,
  dependencies: [],
  artifacts: [],
};

/** 构造一个 ReviewReport（用于 Reviewer 判定逻辑验证）。 */
function makeReport(issues: ReviewReport['issues']): ReviewReport {
  return {
    scope: 'files: a.ts',
    timestamp: new Date().toISOString(),
    testPassed: null,
    issues,
    summary: {
      architecture: { critical: 0, medium: 0, suggestion: 0 },
      style: { critical: 0, medium: 0, suggestion: 0 },
      types: { critical: 0, medium: 0, suggestion: 0 },
      errors: { critical: 0, medium: 0, suggestion: 0 },
      tests: { critical: 0, medium: 0, suggestion: 0 },
      security: { critical: 0, medium: 0, suggestion: 0 },
      performance: { critical: 0, medium: 0, suggestion: 0 },
      maintainability: { critical: 0, medium: 0, suggestion: 0 },
      docs: { critical: 0, medium: 0, suggestion: 0 },
    },
    durationMs: 10,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('DEEPSEEK_API_KEY 未设置');
  }
  const client = new DeepSeekClient({ apiKey });
  const model = 'deepseek-v4-flash';

  // ── 1.2.1 Architect ────────────────────────────────────────
  console.log('===== 1.2.1 Architect Agent（真实模型）=====');
  const architect = new ArchitectAgent({ client, model, onSpec: async () => true });
  const spec = await architect.execute({ description: '实现 TODO 应用' }, ctx);
  console.log('requirement 回显:', spec.requirement.slice(0, 40));
  console.log('interfaces 数:', spec.interfaces.length);
  console.log('files 数:', spec.files.length, '→', spec.files.map((f) => f.path).join(', '));
  console.log('constraints 数:', spec.constraints.length);
  if (spec.files.length === 0) {
    throw new Error('1.2.1 失败：空 spec（无文件）');
  }
  console.log('1.2.1 ✅ spec 结构完整');

  // ── 1.2.2 Coder 实现模式 ───────────────────────────────────
  console.log('\n===== 1.2.2 Coder Agent 实现模式（真实模型，内存 writer）=====');
  const writes: Array<{ path: string; content: string }> = [];
  const coder = new CoderAgent({
    client,
    model,
    writer: {
      async write(relPath: string, content: string): Promise<void> {
        writes.push({ path: relPath, content });
      },
    },
    onApproval: async (files, reason) => {
      console.log('  审批回调触发: reason =', reason, '| files =', files.length);
      return true;
    },
  });
  const impl = await coder.execute({ description: spec.requirement, spec }, ctx);
  console.log('实现输出文件数:', impl.files.length, '→', impl.files.map((f) => f.path).join(', '));
  console.log('内存写盘记录:', writes.length, '（未落盘到项目）');

  // ── 1.2.2 Coder 修复模式 ───────────────────────────────────
  console.log('\n===== 1.2.2 Coder Agent 修复模式 =====');
  const firstPath = impl.files[0]?.path ?? 'src/a.ts';
  const issues = [
    {
      severity: 'critical' as const,
      dimension: 'security' as const,
      file: firstPath,
      line: 1,
      title: '缺少输入校验',
      description: '用户输入未做校验，存在注入风险',
      suggestion: '添加 zod 校验',
    },
  ];
  const fix = await coder.execute({ description: spec.requirement, issues }, ctx);
  console.log('修复输出文件数:', fix.files.length, '→', fix.files.map((f) => f.path).join(', '));
  console.log('修复模式 ✅');

  // ── 1.2.2 Coder 审批拒绝 → 不写盘 ──────────────────────────
  console.log('\n===== 1.2.2 Coder 审批拒绝（fail-closed）=====');
  const coderNo = new CoderAgent({
    client,
    model,
    writer: {
      async write(_relPath: string, _content: string): Promise<void> {
        throw new Error('不应调用 writer（审批被拒绝时禁止写盘）');
      },
    },
    onApproval: async () => false,
  });
  try {
    await coderNo.execute({ description: 'x', spec }, ctx);
    console.log('1.2.2 审批拒绝 ❌ 未抛错（不符合预期）');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('1.2.2 审批拒绝 ✅ 抛错且未写盘:', msg);
  }

  // ── 1.2.3 Reviewer 判定逻辑 ────────────────────────────────
  console.log('\n===== 1.2.3 Reviewer Agent approve/reject 判定 =====');
  const mkReviewer = (report: ReviewReport) =>
    new TeamReviewerAgent({ engine: { review: async () => report } });

  const criticalReport = makeReport([
    {
      dimension: 'security',
      severity: 'critical',
      file: 'a.ts',
      line: 5,
      title: 'SQL 注入',
      description: '拼接用户输入到 SQL',
    },
  ]);
  const r1 = await mkReviewer(criticalReport).execute(
    { description: '审查第 1 轮', scope: { type: 'files', paths: ['a.ts'] } },
    ctx,
  );
  console.log('critical 问题 → action =', r1.action, '| issues =', r1.issues.length, '|', r1.summary);

  const suggestionReport = makeReport([
    {
      dimension: 'style',
      severity: 'suggestion',
      file: 'a.ts',
      title: '变量命名建议',
      description: '建议使用更语义化的命名',
    },
  ]);
  const r2 = await mkReviewer(suggestionReport).execute(
    { description: '审查第 2 轮', scope: { type: 'files', paths: ['a.ts'] } },
    ctx,
  );
  console.log('仅 suggestion → action =', r2.action, '| issues =', r2.issues.length, '|', r2.summary);

  const ok1 = r1.action === 'reject';
  const ok2 = r2.action === 'approve';
  console.log(ok1 && ok2 ? '1.2.3 ✅ 判定逻辑符合预期' : '1.2.3 ❌ 判定逻辑不符');
}

main().catch((err: unknown) => {
  console.error('【FAILED】', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
