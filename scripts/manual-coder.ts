/**
 * 手工测试 1.2.2：Coder Agent（真实模型）。
 * - 先由 Architect 生成 spec（1 次 API），再 Coder 实现（1 次 API）；
 * - 内存 writer（不落盘）+ onApproval 自动批准；
 * - 审批拒绝场景：onApproval 返回 false → 抛错且 writer 不被调用。
 */
import { DeepSeekClient } from '../src/model/client';
import { ArchitectAgent, CoderAgent } from '../src/agents';
import type { AgentContext } from '../src/orchestrator';

const ctx: AgentContext = {
  sessionId: 'manual-1-2-2',
  taskId: 'root',
  parentTaskId: undefined,
  dependencies: [],
  artifacts: [],
};

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('DEEPSEEK_API_KEY 未设置');
  }
  const client = new DeepSeekClient({ apiKey });
  const model = 'deepseek-v4-flash';

  // 1) Architect 生成 spec
  const architect = new ArchitectAgent({ client, model, onSpec: async () => true });
  const spec = await architect.execute({ description: '实现 TODO 应用' }, ctx);
  console.log('spec 文件数:', spec.files.length);

  // 2) Coder 实现模式（内存 writer）
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
      console.log('  审批回调: reason =', reason, '| files =', files.length);
      return true;
    },
  });
  const impl = await coder.execute({ description: spec.requirement, spec }, ctx);
  console.log('实现输出文件数:', impl.files.length, '→', impl.files.map((f) => f.path).join(', '));
  console.log('内存写盘记录:', writes.length, '（未落盘到项目）');
  if (impl.files.length === 0) {
    throw new Error('1.2.2 失败：实现无文件输出');
  }
  console.log('1.2.2 实现模式 ✅');

  // 3) Coder 修复模式
  const issues = [
    {
      severity: 'critical' as const,
      dimension: 'security' as const,
      file: impl.files[0]?.path ?? 'src/a.ts',
      line: 1,
      title: '缺少输入校验',
      description: '用户输入未做校验，存在注入风险',
      suggestion: '添加 zod 校验',
    },
  ];
  const fix = await coder.execute({ description: spec.requirement, issues }, ctx);
  console.log('修复输出文件数:', fix.files.length, '→', fix.files.map((f) => f.path).join(', '));
  console.log('1.2.2 修复模式 ✅');

  // 4) 审批拒绝 → 不写盘
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
}

main().catch((err: unknown) => {
  console.error('【FAILED】', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
