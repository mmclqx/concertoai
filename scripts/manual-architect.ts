/**
 * 手工测试 1.2.1：Architect Agent（真实模型，onSpec 自动批准，不写盘）。
 */
import { DeepSeekClient } from '../src/model/client';
import { ArchitectAgent } from '../src/agents';
import type { AgentContext } from '../src/orchestrator';

const ctx: AgentContext = {
  sessionId: 'manual-1-2-1',
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
  const architect = new ArchitectAgent({ client, model: 'deepseek-v4-flash', onSpec: async () => true });
  const spec = await architect.execute({ description: '实现 TODO 应用' }, ctx);
  console.log('requirement 回显:', spec.requirement.slice(0, 60));
  console.log('interfaces 数:', spec.interfaces.length);
  console.log('files 数:', spec.files.length, '→', spec.files.map((f) => f.path).join(', '));
  console.log('constraints 数:', spec.constraints.length);
  if (spec.files.length === 0) {
    throw new Error('1.2.1 失败：空 spec（无文件）');
  }
  console.log('1.2.1 ✅ spec 结构完整（requirement/interfaces/files/constraints）');
}

main().catch((err: unknown) => {
  console.error('【FAILED】', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
