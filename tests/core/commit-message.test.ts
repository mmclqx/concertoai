/**
 * commit message 生成测试（v5.0 T17）。
 *
 * ## 这里最容易出的错，不是「文案不好看」
 *
 * 是**骗人**：模型没参与却像模型写的、标题超宽被 GitHub 折行、body 抄了一整段 diff、
 * diff 没截断导致一次提交花掉不可预期的 token。所以用例围绕四条边界写：
 * 1. **证据优先（G7）**：标题按**显示宽度**截断（中文 2 列）、body ≤ 3 点且引用真实文件名；
 * 2. **如实降级**：无 client / 模型报错 / 模型空输出 → 本地兜底 + `fallbackReason` 三态可分；
 * 3. **成本可预期（R10）**：diff 先 `clampDiff`，token 估算与截断在同一份输入上；
 * 4. **纯函数可核对**：解析/格式化不依赖 i18n 之外的任何环境，输入什么就断言什么。
 */

import { describe, expect, it } from 'vitest';

import {
  buildLocalCommitMessage,
  buildMessagePrompt,
  clampDiff,
  estimateCommitTokens,
  formatCommitMessage,
  generateCommitMessage,
  MAX_BODY_POINT_WIDTH,
  MAX_BODY_POINTS,
  MAX_DIFF_CHARS,
  MAX_SUBJECT_WIDTH,
  parseCommitMessage,
  type StagedDiff,
} from '../../src/core/commit-message';
import { DICTS, fmt, setLocale } from '../../src/i18n';
import { zh } from '../../src/i18n/zh';
import type { ModelClient } from '../../src/model/client';
import { displayWidth } from '../../src/utils/text-width';

// ── 样本与工具 ────────────────────────────────────────────────

/** 默认暂存区样本（两个真实文件）。 */
function staged(overrides: Partial<StagedDiff> = {}): StagedDiff {
  return {
    files: ['src/cli/commit.ts', 'src/core/commit-message.ts'],
    stat: ' 2 files changed, 220 insertions(+)',
    diff: [
      'diff --git a/src/cli/commit.ts b/src/cli/commit.ts',
      '+++ b/src/cli/commit.ts',
      '+export async function runCommitCommand(): Promise<number> {}',
    ].join('\n'),
    branch: 'main',
    ...overrides,
  };
}

/** 返回固定文本的 fake 模型（可记录收到的 prompt，供成本/截断断言）。 */
function fakeClient(texts: readonly string[], sink?: string[]): ModelClient {
  return {
    async *streamChat(params) {
      sink?.push(params.messages.map((message) => message.content).join('\n'));
      for (const text of texts) {
        yield {
          id: 'test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        } as never;
      }
    },
  };
}

/** 一调用就抛错的 fake 模型（网络/限流都长这样）。 */
function failingClient(): ModelClient {
  return {
    // biome-ignore lint/correctness/useYield: 刻意在产出前抛错，模拟模型调用失败
    async *streamChat() {
      throw new Error('socket hang up');
    },
  };
}

setLocale('zh');

// ── clampDiff：成本护栏 ──────────────────────────────────────

describe('clampDiff（成本护栏）', () => {
  it('未超限 → 原样返回且 truncated=false', () => {
    const clamped = clampDiff('diff --git a b\n+1', 100);
    expect(clamped.text).toBe('diff --git a b\n+1');
    expect(clamped.truncated).toBe(false);
  });

  it('超限 → 截到 limit 并标记 truncated（调用方据此提示用户）', () => {
    const clamped = clampDiff('x'.repeat(50), 20);
    expect(clamped.text).toBe('x'.repeat(20));
    expect(clamped.truncated).toBe(true);
  });

  it('按字符切而不是按行切：单行超长（minified js / 单行 JSON）也截断', () => {
    const oneLine = `+${'a'.repeat(MAX_DIFF_CHARS + 5)}`;
    const clamped = clampDiff(oneLine);
    expect(clamped.truncated).toBe(true);
    expect(clamped.text.length).toBe(MAX_DIFF_CHARS);
  });
});

// ── parseCommitMessage：规范化的四道关 ──────────────────────

describe('parseCommitMessage（规范化模型输出）', () => {
  it('标题 + body 要点：去掉 "- " 前缀，正文保留原话', () => {
    const message = parseCommitMessage(
      'feat(cli): 新增 commit 命令\n\n- 新增 src/cli/commit.ts\n- 复用 check 的 runCheck',
    );
    expect(message?.subject).toBe('feat(cli): 新增 commit 命令');
    expect(message?.body).toEqual(['新增 src/cli/commit.ts', '复用 check 的 runCheck']);
    expect(message?.source).toBe('model');
  });

  it('剥掉 markdown 围栏、编号、井号标题与粗体（模型输出形态不统一）', () => {
    const raw = [
      '```diff',
      '**fix(core): 修正宽度**',
      '',
      '1. 修改 src/a.ts',
      '## 说明',
      '```',
    ].join('\n');
    const message = parseCommitMessage(raw);
    expect(message?.subject).toBe('fix(core): 修正宽度');
    expect(message?.body).toEqual(['修改 src/a.ts', '说明']);
  });

  it('标题按**显示宽度**截断到 72 列（40 个汉字 = 80 列，必须截）', () => {
    const longChinese = '修'.repeat(40);
    const message = parseCommitMessage(`${longChinese}\n\n- 修改 src/a.ts`);
    expect(message).toBeDefined();
    expect(message?.subject).not.toBe(longChinese);
    // 关键：按 .length 判 72 会放过 80 列的中文标题（被 GitHub 折行的真实原因）
    expect(displayWidth(message?.subject ?? '')).toBeLessThanOrEqual(MAX_SUBJECT_WIDTH);
    expect(displayWidth(message?.subject ?? '')).toBeGreaterThan(MAX_SUBJECT_WIDTH - 4);
  });

  it('ASCII 标题不超限 → 一字不改（不做无谓替换）', () => {
    const subject = 'feat(cli): add commit command';
    expect(parseCommitMessage(`${subject}\n\n- add src/cli/commit.ts`)?.subject).toBe(subject);
  });

  it(`body 最多 ${MAX_BODY_POINTS} 点且去重（防止把 diff 抄成流水账）`, () => {
    const raw = [
      'chore: 更新 5 个文件',
      '- 修改 src/a.ts',
      '- 修改 src/a.ts',
      '- 修改 src/b.ts',
      '- 修改 src/c.ts',
      '- 修改 src/d.ts',
    ].join('\n');
    const message = parseCommitMessage(raw);
    expect(message?.body).toEqual(['修改 src/a.ts', '修改 src/b.ts', '修改 src/c.ts']);
  });

  it('单点超宽 → 按显示宽度截断（不把整段 diff 塞进 body）', () => {
    const message = parseCommitMessage(`chore: x\n\n- ${'长'.repeat(200)}`);
    expect(message?.body).toHaveLength(1);
    expect(displayWidth(message?.body[0] ?? '')).toBeLessThanOrEqual(MAX_BODY_POINT_WIDTH);
  });

  it('空输出 / 纯空白 → undefined（调用方据此回落本地兜底，不提交空 message）', () => {
    expect(parseCommitMessage('')).toBeUndefined();
    expect(parseCommitMessage('   \n\t\n  ')).toBeUndefined();
  });

  it('text 可直接喂 `git commit -F -`：标题 + 空行 + "- " 要点', () => {
    const message = parseCommitMessage('feat: x\n\n- a\n- b');
    expect(message?.text).toBe('feat: x\n\n- a\n- b');
  });
});

// ── formatCommitMessage / buildLocalCommitMessage ───────────

describe('formatCommitMessage（组装可提交文本）', () => {
  it('无 body → 只有标题，不留尾部空行', () => {
    expect(formatCommitMessage('chore: x', [])).toBe('chore: x');
  });

  it('有 body → 标题 + 空行 + 每点一行', () => {
    expect(formatCommitMessage('feat: x', ['a', 'b'])).toBe('feat: x\n\n- a\n- b');
  });
});

describe('buildLocalCommitMessage（无模型时的如实兜底）', () => {
  it('无暂存文件 → 用「提交暂存区改动」的空态标题，不编造文件', () => {
    const message = buildLocalCommitMessage(staged({ files: [], diff: '' }));
    expect(message.subject).toBe(zh.commit.localEmptySubject);
    expect(message.body).toEqual([]);
    expect(message.source).toBe('local');
  });

  it('文件数 ≤ 3 → 一句一个真实文件点', () => {
    const message = buildLocalCommitMessage(staged());
    expect(message.subject).toBe(fmt(zh.commit.localSubject, { count: 2 }));
    expect(message.body).toEqual([
      fmt(zh.commit.localBodyPoint, { file: 'src/cli/commit.ts' }),
      fmt(zh.commit.localBodyPoint, { file: 'src/core/commit-message.ts' }),
    ]);
  });

  it('文件数 > 3 → 留最后一格给「另有 N 个文件」（否则用户看不到清单被截断）', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const message = buildLocalCommitMessage(staged({ files }));
    expect(message.body).toHaveLength(MAX_BODY_POINTS);
    expect(message.body[0]).toBe(fmt(zh.commit.localBodyPoint, { file: 'a.ts' }));
    expect(message.body[MAX_BODY_POINTS - 1]).toBe(fmt(zh.commit.localMore, { count: 3 }));
  });
});

// ── buildMessagePrompt / estimateCommitTokens ───────────────

describe('buildMessagePrompt（送模型的输入）', () => {
  it('分支 / 文件清单 / 变更统计 / diff 全部进 prompt', () => {
    const prompt = buildMessagePrompt(staged());
    expect(prompt).toHaveLength(2);
    expect(prompt[0]?.role).toBe('system');
    const user = prompt[1]?.content ?? '';
    expect(user).toContain('当前分支：main');
    expect(user).toContain('src/cli/commit.ts');
    expect(user).toContain('2 files changed');
    expect(user).toContain('runCommitCommand');
  });

  it('system 提示写明 type 范围与「禁止空泛套话」（证据优先）', () => {
    const system = buildMessagePrompt(staged())[0]?.content ?? '';
    expect(system).toContain('feat');
    expect(system).toContain('chore');
    expect(system).toContain('禁止');
  });

  it('truncated=true → 明确告诉模型只看到前 N 字符；空 diff → 「（空）」', () => {
    const truncated = buildMessagePrompt(staged({ diff: 'x', truncated: true }))[1]?.content ?? '';
    expect(truncated).toContain('已截断到前 1 字符');
    const empty = buildMessagePrompt(staged({ diff: '' }))[1]?.content ?? '';
    expect(empty).toContain('（空）');
  });
});

describe('estimateCommitTokens（调用前成本提示）', () => {
  it('输入越大约贵：同一份样本上，截断后的 diff token 数严格小于原始 diff', () => {
    const small = estimateCommitTokens(staged({ diff: '+a' }));
    const big = estimateCommitTokens(staged({ diff: `+${'长'.repeat(4000)}` }));
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });

  it('clampDiff 后 token 估算有界（成本可预期，R10）', () => {
    const huge = staged({ diff: `+${'a'.repeat(MAX_DIFF_CHARS + 5000)}` });
    const clamped = clampDiff(huge.diff, MAX_DIFF_CHARS);
    const bounded = estimateCommitTokens({ ...huge, diff: clamped.text, truncated: true });
    const unbounded = estimateCommitTokens(huge);
    expect(bounded).toBeLessThan(unbounded);
  });
});

// ── generateCommitMessage：三条降级路径 ────────────────────

describe('generateCommitMessage（生成主入口）', () => {
  it('无 client → 本地兜底 + fallbackReason=no-client（不假装调过模型）', async () => {
    const message = await generateCommitMessage({ diff: staged() });
    expect(message.source).toBe('local');
    expect(message.fallbackReason).toBe('no-client');
    expect(message.subject).toBe(fmt(zh.commit.localSubject, { count: 2 }));
  });

  it('有 client 但没给 model → 同样走 no-client（绝不拿 undefined 当模型名去调用）', async () => {
    let called = false;
    const client: ModelClient = {
      async *streamChat() {
        called = true;
        yield { choices: [] } as never;
      },
    };
    const message = await generateCommitMessage({ diff: staged(), client });
    expect(called).toBe(false);
    expect(message.fallbackReason).toBe('no-client');
  });

  it('模型调用失败 → 本地兜底 + fallbackReason=model-failed', async () => {
    const message = await generateCommitMessage({
      diff: staged(),
      client: failingClient(),
      model: 'deepseek-v4-flash',
    });
    expect(message.source).toBe('local');
    expect(message.fallbackReason).toBe('model-failed');
  });

  it('模型没给可用内容 → 本地兜底 + fallbackReason=model-empty', async () => {
    const message = await generateCommitMessage({
      diff: staged(),
      client: fakeClient(['  \n']),
      model: 'deepseek-v4-flash',
    });
    expect(message.source).toBe('local');
    expect(message.fallbackReason).toBe('model-empty');
  });

  it('模型正常 → source=model，分片流式拼接后仍是同一条 message', async () => {
    const message = await generateCommitMessage({
      diff: staged(),
      // 真实流式会把标题切成好几片吐出来，必须拼回一条
      client: fakeClient(['feat(cli): ', '新增 commit 命令', '\n- 新增 src/cli/commit.ts']),
      model: 'deepseek-v4-flash',
    });
    expect(message.source).toBe('model');
    expect(message.fallbackReason).toBeUndefined();
    expect(message.subject).toBe('feat(cli): 新增 commit 命令');
    expect(message.body).toEqual(['新增 src/cli/commit.ts']);
    expect(message.text).toBe('feat(cli): 新增 commit 命令\n\n- 新增 src/cli/commit.ts');
  });

  it('模型把 diff 内容也吐出来 → 送模型的是截断后的 diff（不是全量）', async () => {
    const sink: string[] = [];
    const huge = staged({ diff: `+${'a'.repeat(MAX_DIFF_CHARS * 2)}` });
    const clamped = clampDiff(huge.diff, MAX_DIFF_CHARS);
    await generateCommitMessage({
      diff: { ...huge, diff: clamped.text, truncated: clamped.truncated },
      client: fakeClient(['chore: x'], sink),
      model: 'deepseek-v4-flash',
    });
    expect(sink).toHaveLength(1);
    expect(sink[0]?.length).toBeLessThan(MAX_DIFF_CHARS + 2000);
  });
});

// ── 双语字典：commit 键不能只写一份 ─────────────────────────

describe('commit 文案双语齐备', () => {
  it('zh / en 的 commit 字典键一一对应（缺一个键 = en 用户看到 undefined）', () => {
    const zhKeys = Object.keys(DICTS.zh.commit).sort();
    const enKeys = Object.keys(DICTS.en.commit).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('title 等占位符与 zh 一致（fmt 用同一套 {name}）', () => {
    for (const key of Object.keys(DICTS.zh.commit)) {
      const zhValue = (DICTS.zh.commit as Record<string, string>)[key] ?? '';
      const enValue = (DICTS.en.commit as Record<string, string>)[key] ?? '';
      const placeholders = (text: string) => (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
      expect(placeholders(enValue), `en.commit.${key} 的占位符与 zh 不一致`).toEqual(
        placeholders(zhValue),
      );
    }
  });
});
