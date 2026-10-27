/**
 * 配置与降级收尾测试（v5.0 T11）。
 *
 * 三条验收：
 * | # | 约束 | 为什么必须测 |
 * |---|---|---|
 * | T11-a | `plain` 输出与 v4.1.1 **逐字节一致** | 「恢复原味审批」是给用户的逃生舱，走样就是失信 |
 * | T11-b | 非 TTY / CI / 超大 diff **自动降级**为 plain | 慢机器与 CI 不该被分析拖住 |
 * | T11-c | 降级判定**单一来源**（只在 `core/approval-insight.ts`） | App 与 T8 各写一份 → 迟早出现「一边降一边不降」 |
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeApproval, emptyImpact } from '../../src/core/approval-insight';
import { setLocale } from '../../src/i18n';
import type { ToolCall } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { readFileTool } from '../../src/tools/read';
import { ToolRegistry } from '../../src/tools/registry';
import { App } from '../../src/ui/App';
import {
  isPlainApproval,
  renderApprovalLines,
  renderApprovalText,
} from '../../src/ui/approval-text';

class FakeModel implements ModelClient {
  constructor(private readonly script: { content?: string; toolCalls?: ToolCall[] }[]) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const reply = this.script.shift();
    if (reply === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    if (reply.content !== undefined) {
      yield chunk({ content: reply.content });
    }
    let index = 0;
    for (const tc of reply.toolCalls ?? []) {
      yield chunk({
        tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.arguments } }],
      });
      index += 1;
    }
    yield chunk({}, 'stop');
  }
}

function chunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(assert: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      assert();
      return;
    } catch (error) {
      lastError = error;
      await sleep(20);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  assert();
}

let tmp: string;
let registry: ToolRegistry;

beforeEach(() => {
  setLocale('zh');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-t11-'));
  registry = new ToolRegistry().register(readFileTool).register(editFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 一份会被规则命中的 diff（保证 rich 模式一定有内容可渲染）。 */
const RISKY_DIFF = [
  '@@ -1,2 +1,3 @@',
  ' const keep = 1;',
  '-rmSync(target, { recursive: true });',
  '+console.log(1);',
].join('\n');

describe('T11-a：plain 模式与 v4.1.1 逐字节一致', () => {
  const base = { kind: 'edit' as const, summary: '编辑文件 a.ts', detail: 'const a = 1' };

  it('rich=false 时只有三行：标题 / 详情 / 按键（v4.1.1 原貌）', () => {
    const lines = renderApprovalLines({ ...base, rich: false });
    expect(lines.map((l) => l.role)).toEqual(['title', 'detail', 'buttons']);
    expect(lines.map((l) => l.text)).toEqual([
      '编辑文件: 编辑文件 a.ts',
      'const a = 1',
      '批准 (y / Enter) / 拒绝 (n / Esc)',
    ]);
  });

  it('detail 原样输出（不做宽度截断 / 不折行）——v4.1.1 就是原样渲染 diff', () => {
    const long = `${'x'.repeat(500)}`;
    const text = renderApprovalText({ ...base, detail: long, rich: false });
    expect(text).toContain(long);
    expect(text).not.toContain('…');
  });

  it('shell / model 标题与 v4.1.1 一致', () => {
    expect(
      renderApprovalText({ kind: 'shell', summary: 'npm test', detail: 'npm test', rich: false }),
    ).toBe(['执行命令: npm test', 'npm test', '批准 (y / Enter) / 拒绝 (n / Esc)'].join('\n'));
    expect(
      renderApprovalText({ kind: 'model', summary: '切到 pro', detail: '成本 +3.7x', rich: false }),
    ).toBe(
      ['切换模型（成本将上升）: 切到 pro', '成本 +3.7x', '批准 (y / Enter) / 拒绝 (n / Esc)'].join(
        '\n',
      ),
    );
  });

  it('isPlainApproval：无 insight / 降级原因 / 显式 rich=false 三条路径', () => {
    expect(isPlainApproval(base)).toBe(true); // 没 insight → plain
    expect(isPlainApproval({ ...base, rich: false })).toBe(true);
    expect(
      isPlainApproval({
        ...base,
        insight: {
          level: 'low',
          changeNatures: [],
          hits: [],
          focusLines: [],
          // 用 emptyImpact 而非手写对象：ImpactSummary 加字段时这里不会漏（单一来源）
          impact: emptyImpact(),
          degraded: true,
          degradeReason: 'config-off',
          elapsedMs: 0,
        },
      }),
    ).toBe(true);
  });
});

describe('T11-b：环境自动降级（判定单一来源 = approval-insight.ts）', () => {
  it('非 TTY → degraded=non-tty，且 insight 契约仍可渲染', async () => {
    const insight = await analyzeApproval(RISKY_DIFF, { isTTY: false, isCI: false, cwd: tmp });
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('non-tty');
    // 可渲染性：不抛错、字段齐全
    expect(Array.isArray(insight.hits)).toBe(true);
  });

  it('CI → degraded=ci', async () => {
    const insight = await analyzeApproval(RISKY_DIFF, { isTTY: true, isCI: true, cwd: tmp });
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('ci');
  });

  it('config -off（mode=plain）→ degraded=config-off', async () => {
    const insight = await analyzeApproval(RISKY_DIFF, {
      isTTY: true,
      isCI: false,
      mode: 'plain',
      cwd: tmp,
    });
    expect(insight.degraded).toBe(true);
    expect(insight.degradeReason).toBe('config-off');
  });

  it('TTY + 非 CI + rich → 不做环境降级（真跑规则）', async () => {
    const insight = await analyzeApproval(RISKY_DIFF, { isTTY: true, isCI: false, cwd: tmp });
    expect(insight.degraded).toBe(false);
    expect(insight.degradeReason).toBeUndefined();
    // 是否命中取决于规则表细节（不在此断言风险级别，那是 T8 的用例职责）；
    // 本测试只锁定「rich 路径真的跑了分析」而不是被环境降级短路
    expect(insight.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('T11-c：降级判断不重复实现（源码护栏）', () => {
  it('App.tsx 不自己读 isTTY / CI 做判定，只透传注入', () => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'ui', 'App.tsx'), 'utf8');
    // 先剥离注释：JSDoc 里「缺省读 process.stdout.isTTY」是**说明**而非判定逻辑
    // （不剥注释的护栏会把文档写成红灯，反过来逼人删掉好注释——错误的激励）
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 允许出现 insightEnv?.isTTY（透传），但不得出现环境读取或降级决策
    expect(code).not.toMatch(/process\.stdout\.isTTY/);
    expect(code).not.toMatch(/process\.env\.CI/);
    expect(code).not.toContain("degradeReason: '");
    // 反向确认：注入通道确实存在（否则上面三条可以靠「删掉功能」通过）
    expect(code).toMatch(/insightEnv\?\.isTTY/);
  });

  it('approval-insight.ts 是降级判定的唯一出处', () => {
    const core = readFileSync(
      path.join(process.cwd(), 'src', 'core', 'approval-insight.ts'),
      'utf8',
    );
    expect(core).toMatch(/process\.stdout\.isTTY/);
    expect(core).toMatch(/process\.env\.CI/);
    // 五类降级原因集中在此文件（单一来源）
    for (const reason of ['non-tty', 'ci', 'huge-diff', 'config-off', 'error']) {
      expect(core).toContain(reason);
    }
  });
});

describe('T11 集成：plain 配置在真实 App 里生效', () => {
  it('approvalInsightMode=plain → 审批帧无「风险 / 影响面」区块', async () => {
    const model = new FakeModel([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'edit_file',
            arguments: '{"path":"a.ts","search":"","replace":"const a = 1"}',
          },
        ],
      },
      { content: '已创建' },
    ]);
    const app = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        approvalInsightMode="plain"
        insightEnv={{ isTTY: true, isCI: false }}
      />,
    );
    app.stdin.write('改');
    await sleep(50);
    app.stdin.write('\r');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    await sleep(200); // 若错误地跑了 rich，这一刻会补上风险区块
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('编辑文件:');
    expect(frame).not.toContain('风险点');
    expect(frame).not.toContain('影响面');
    expect(frame).not.toContain('建议重点关注');
    app.stdin.write('y');
    app.unmount();
  });

  it('rich（TTY）配置下同一操作会显示风险区块——对照组', async () => {
    const model = new FakeModel([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'edit_file',
            // 新建文件（search 为空）：diff 全为新增行，`unlink(...)` 命中 dangerous-delete 规则
            // （注意 `rmSync(...)` **不在**规则表里——规则认的是 `rm -rf` / `unlink(` / `rmdir(` / `.rm(`）
            arguments: JSON.stringify({
              path: 'b.ts',
              search: '',
              replace: 'unlink(targetPath);',
            }),
          },
        ],
      },
      { content: '已创建' },
    ]);
    const app = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        approvalInsightMode="rich"
        insightEnv={{ isTTY: true, isCI: false }}
      />,
    );
    app.stdin.write('改');
    await sleep(50);
    app.stdin.write('\r');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    await sleep(400); // 等异步洞察补齐
    const richFrame = app.lastFrame() ?? '';
    // 命中规则后 rich 卡片会给出「风险点 / 建议重点关注 / 改动性质」之一
    expect(/风险点|建议重点关注|改动性质/.test(richFrame), richFrame).toBe(true);
    app.stdin.write('y');
    app.unmount();
  });
});
