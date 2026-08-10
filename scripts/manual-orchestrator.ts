/**
 * 手工测试 1.1：Orchestrator 任务拆解与调度（真实模型）。
 *
 * 安全策略（报告已知问题 #5 建议控制成本）：
 * - architect：真实模型（spec 生成，onSpec 自动批准，不写盘）；
 * - coder：真实模型 + 内存 writer（不落盘，避免污染项目；onApproval 自动批准）；
 * - reviewer：Fake engine（approve）、qa：Fake runner（passed）——控制成本。
 */
import { DeepSeekClient } from '../src/model/client';
import {
  ArchitectAgent,
  CoderAgent,
  InMemoryAgentRegistry,
  Orchestrator,
  QaAgent,
  TeamReviewerAgent,
} from '../src/agents';
import type { AgentContext } from '../src/orchestrator';

const fakeReviewEngine = {
  review: async () => ({
    summary: '审查通过（Fake engine，手工测试控制成本）',
    passed: true,
    checks: [],
    issues: [],
    score: 95,
  }),
};

const fakeQaRunner = {
  run: async () => ({
    ok: true,
    stdout: 'Test Files  1 passed (1)\nTests  1 passed (1)\n',
    stderr: '',
    timedOut: false,
  }),
};

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('DEEPSEEK_API_KEY 未设置');
  }
  const client = new DeepSeekClient({ apiKey });
  const model = 'deepseek-v4-flash';
  const registry = new InMemoryAgentRegistry();

  const memoryWriter = {
    writes: [] as Array<{ path: string; content: string }>,
    async write(relPath: string, content: string): Promise<void> {
      this.writes.push({ path: relPath, content });
    },
  };

  const architect = new ArchitectAgent({ client, model, onSpec: async () => true });
  const coder = new CoderAgent({
    client,
    model,
    writer: memoryWriter,
    onApproval: async () => true,
  });
  const reviewer = new TeamReviewerAgent({ engine: fakeReviewEngine });
  const qa = new QaAgent({ runner: fakeQaRunner });

  registry.register(architect.def, architect);
  registry.register(coder.def, coder);
  registry.register(reviewer.def, reviewer);
  registry.register(qa.def, qa);

  const orch = new Orchestrator({
    client,
    model,
    registry,
    concurrency: 3,
    onPlan: async (tasks) => {
      console.log('【拆解结果】任务数 =', tasks.length);
      for (const t of tasks) {
        console.log(
          `  - ${t.id} [${t.agent}] deps=[${t.dependencies.join(',')}] files=[${(t.files ?? []).join(',')}]`,
        );
        console.log(`      ${t.description}`);
      }
      return true;
    },
  });

  const ctx: AgentContext = {
    sessionId: 'manual-1-1',
    taskId: 'root',
    parentTaskId: undefined,
    dependencies: [],
    artifacts: [],
  };

  const result = await orch.run('实现一个 TODO 应用（含认证）', ctx);
  console.log('\n【聚合结果】');
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        order: result.order,
        failed: result.failed,
        skipped: result.skipped,
        executions: result.executions.map((e) => ({
          taskId: e.taskId,
          agent: e.agent,
          ok: e.ok,
        })),
        artifactTypes: [...new Set(result.artifacts.map((a) => a.type))],
        summary: result.summary,
      },
      null,
      2,
    ),
  );
  console.log('【Coder 内存写盘记录】', memoryWriter.writes.length, '个文件（未落盘）');
  for (const w of memoryWriter.writes) {
    console.log('  -', w.path, `(${w.content.length} chars)`);
  }
}

main().catch((err: unknown) => {
  console.error('【FAILED】', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
