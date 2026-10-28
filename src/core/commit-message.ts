/**
 * commit message 生成（v5.0 M4 / T17）：基于**真实暂存区 diff** 产出符合规范的提交信息。
 *
 * ## 它回答一个问题
 *
 * 「这次改动，用一句话说清是什么？」——把 `git diff --staged` 喂给模型，产出
 * `<type>(<scope>): <摘要>` + 至多 3 条引用真实文件/符号的要点。
 *
 * ## 四条不可妥协的边界
 *
 * 1. **证据优先（G7）**：message 必须基于真实 diff。送模型的输入只有 diff / 文件清单 /
 *    变更统计，prompt 里明确禁止「优化代码」这类空泛套话与编造未发生的改动；
 *    规范化阶段再兜一层：标题按**显示宽度**截断到 72（中文按 2 列算，`String.length`
 *    会把 40 个汉字当成 40 而不是 80 列），body 最多 3 点。
 * 2. **模型调用独立可注入**：本模块只认 `ModelClient` 接口，不自己建客户端、不读环境变量
 *    —— 测试可以注入假模型，CLI 决定用哪个 provider。
 * 3. **无模型也能用（如实降级）**：没有 client（未配 Key）/ 模型报错 / 模型没给可用内容，
 *    一律回落 `buildLocalCommitMessage`——用**真实文件名**拼基础 message，并带
 *    `fallbackReason` 让调用方如实告知用户「这次没调模型」，绝不假装是模型写的。
 * 4. **成本可预期（R10）**：diff 先 `clampDiff` 截断到 `MAX_DIFF_CHARS`，`estimateCommitTokens`
 *    用既有 BPE 计数器算输入 token，调用方在**调模型之前**就能把「约 X tokens」告诉用户。
 *
 * ## 为什么标题上限按显示宽度而不是字符数
 *
 * git 的 `subject` 惯例是 50 列、硬上限约 72 列；「列」是终端/网页的显示宽度，
 * 一个汉字占 2 列。按 `.length` 判 72 会让 40 个汉字的标题实际占 80 列，被 GitHub
 * 等工具直接折行/截断——用户看到的标题和他提交的不是一回事。
 */

import { fmt, t } from '../i18n';
import type { ApiMessage, ModelClient } from '../model/client';
import { countMessageListTokens } from '../model/tokenizer';
import { displayWidth, truncateToWidth } from '../utils/text-width';

// ── 常量 ──────────────────────────────────────────────────────

/** 标题行的显示宽度上限（72 列：中文 36 字，ASCII 72 字）。 */
export const MAX_SUBJECT_WIDTH = 72;

/** body 最多几点（G7：每点引用一条真实改动，多了就是流水账）。 */
export const MAX_BODY_POINTS = 3;

/** 单条要点的显示宽度上限（防止模型把整段 diff 抄进 body）。 */
export const MAX_BODY_POINT_WIDTH = 160;

/** 送进模型的 diff 字符上限（成本护栏：单次调用可预期，R10）。 */
export const MAX_DIFF_CHARS = 12_000;

// ── 类型定义 ──────────────────────────────────────────────────

/** 暂存区改动（commit 从 git 采集，core 只消费，不碰 git）。 */
export interface StagedDiff {
  /** 暂存的文件相对路径（`git diff --staged --name-only`）。 */
  files: string[];
  /** 变更统计（`git diff --staged --stat`；可为空串）。 */
  stat: string;
  /** 完整 diff 文本（调用方已按 `MAX_DIFF_CHARS` 截断）。 */
  diff: string;
  /** diff 是否被截断（如实告知模型「只看到前 N 字符」）。 */
  truncated?: boolean;
  /** 当前分支名（可为空串：detached HEAD / 裸仓库首次提交）。 */
  branch?: string;
}

/** 生成的 commit message。 */
export interface CommitMessage {
  /** 标题行（显示宽度 ≤ `MAX_SUBJECT_WIDTH`）。 */
  subject: string;
  /** body 要点（≤ `MAX_BODY_POINTS` 条，**不带** `- ` 前缀）。 */
  body: string[];
  /** 可直接喂给 `git commit -F -` 的完整文本。 */
  text: string;
  /** 来源：模型生成 / 本地兜底。 */
  source: 'model' | 'local';
  /** `source === 'local'` 时的原因（调用方据此如实告知用户）。 */
  fallbackReason?: 'no-client' | 'model-failed' | 'model-empty';
}

/** 生成选项（模型全部可注入）。 */
export interface GenerateCommitMessageOptions {
  /** 暂存区改动（真实 diff）。 */
  diff: StagedDiff;
  /** 模型客户端（缺省 → 本地兜底，不假装调用过）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
}

// ── 纯函数：截断与规范化 ──────────────────────────────────────

/**
 * 截断 diff 到 `limit` 字符。
 *
 * 按字符切（不按行切）是刻意的：diff 的一行可能很长（压缩后的单行 JSON / minified js），
 * 按行截断会让「大改动」完整塞进模型，成本不可控。
 */
export function clampDiff(
  diff: string,
  limit = MAX_DIFF_CHARS,
): { text: string; truncated: boolean } {
  if (diff.length <= limit) {
    return { text: diff, truncated: false };
  }
  return { text: diff.slice(0, limit), truncated: true };
}

/** 剥掉模型偶尔加的 markdown 围栏（```diff / ```）。 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return fence?.[1] ?? trimmed;
}

/**
 * 去掉行首的列表符号 / 编号 / 标题井号 / 粗体标记（模型输出形态不统一）。
 *
 * ⚠️ 顺序敏感：**必须先删 `**` 再剥行首符号**。反过来（先剥 `^[-*•·]`）会把
 * `**feat: x**` 的第一个 `*` 当成列表符号吃掉，剩下 `*feat: x**` 再删 `**`，
 * 于是标题里留下一颗孤零零的 `*`——用户提交记录里就真的带着这个 `*`
 * （单元测试 `**fix(core): 修正宽度**` 用例发现）。
 */
function stripListMarker(line: string): string {
  return line
    .replace(/\*\*/g, '')
    .replace(/^[-*•·]\s*/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/^#+\s*/, '')
    .trim();
}

/**
 * 解析模型输出为规范 message（纯函数）。
 *
 * - 第一个非空行 = 标题（按显示宽度截断到 72）；
 * - 其余非空行 = body 要点（去列表符号、去重，最多 3 条）；
 * - 空标题 → `undefined`（调用方据此回落本地兜底，不拿空 message 去提交）。
 */
export function parseCommitMessage(raw: string): CommitMessage | undefined {
  const lines = stripFence(raw).split(/\r?\n/);
  let subject = '';
  const rawPoints: string[] = [];
  for (const line of lines) {
    const cleaned = stripListMarker(line);
    if (cleaned === '') {
      continue;
    }
    if (subject === '') {
      subject = cleaned;
      continue;
    }
    rawPoints.push(cleaned);
  }
  if (subject === '') {
    return undefined;
  }
  const seen = new Set<string>();
  const body: string[] = [];
  for (const point of rawPoints) {
    if (seen.has(point)) {
      continue;
    }
    seen.add(point);
    body.push(truncateToWidth(point, MAX_BODY_POINT_WIDTH));
    if (body.length >= MAX_BODY_POINTS) {
      break;
    }
  }
  const finalSubject = truncateToWidth(subject, MAX_SUBJECT_WIDTH);
  return {
    subject: finalSubject,
    body,
    text: formatCommitMessage(finalSubject, body),
    source: 'model',
  };
}

/** 组装成 `git commit -F -` 的文本（标题 + 空行 + `- ` 要点）。 */
export function formatCommitMessage(subject: string, body: readonly string[]): string {
  if (body.length === 0) {
    return subject;
  }
  return `${subject}\n\n${body.map((point) => `- ${point}`).join('\n')}`;
}

/**
 * 本地兜底 message（无 Key / 模型失败时用）。
 *
 * 只引用**真实文件名**（证据优先的最低版本），不编造改动性质——模型没参与，
 * 就不假装懂代码意图。`fallbackReason` 由调用方（`generateCommitMessage`）补上。
 */
export function buildLocalCommitMessage(diff: StagedDiff): CommitMessage {
  const dict = t().commit;
  const files = diff.files;
  const subject =
    files.length === 0
      ? truncateToWidth(dict.localEmptySubject, MAX_SUBJECT_WIDTH)
      : truncateToWidth(fmt(dict.localSubject, { count: files.length }), MAX_SUBJECT_WIDTH);

  const body: string[] = [];
  if (files.length > MAX_BODY_POINTS) {
    // 留最后一条位置给「另有 N 个文件」，否则用户看不到清单被截断
    for (const file of files.slice(0, MAX_BODY_POINTS - 1)) {
      body.push(truncateToWidth(fmt(dict.localBodyPoint, { file }), MAX_BODY_POINT_WIDTH));
    }
    body.push(
      truncateToWidth(
        fmt(dict.localMore, { count: files.length - (MAX_BODY_POINTS - 1) }),
        MAX_BODY_POINT_WIDTH,
      ),
    );
  } else {
    for (const file of files) {
      body.push(truncateToWidth(fmt(dict.localBodyPoint, { file }), MAX_BODY_POINT_WIDTH));
    }
  }

  return {
    subject,
    body,
    text: formatCommitMessage(subject, body),
    source: 'local',
  };
}

// ── 提示词与成本 ──────────────────────────────────────────────

/**
 * 系统提示（G7 证据优先）。
 *
 * 三条硬约束都是为了「用户能看懂且能核对」：限定 type 让分类可预期、限宽让标题不被折行、
 * 强制引用真实文件/符号让每句话都能被 diff 验证。
 */
const COMMIT_SYSTEM_PROMPT = [
  '你是 Git 提交信息作者。根据下面给出的**暂存区 diff** 写一条提交信息。',
  '硬性要求：',
  '1. 第一行是标题，格式 `<type>(<scope>): <摘要>`，type 取 feat/fix/docs/refactor/test/chore/perf/build/ci 之一，scope 可省略；整行显示宽度 ≤ 72 列（一个汉字算 2 列）；',
  '2. 标题后空一行，再写 0~3 条要点，每条以 "- " 开头，且必须引用 diff 里真实出现的文件名或函数/符号名；',
  '3. 只写 diff 里真实发生的改动；禁止「优化代码」「提升体验」「更新相关逻辑」这类空泛套话，禁止编造 diff 里没有的改动；',
  '4. 不要输出 markdown 围栏、不要解释你的思路、不要粘贴 diff 内容、不要写「本次提交」这类废话；',
  '5. 用中文书写，文件路径 / 标识符 / 专有名词保留原文。',
].join('\n');

/** 组装送模型的消息（分支 + 文件清单 + 变更统计 + diff）。 */
export function buildMessagePrompt(diff: StagedDiff): ApiMessage[] {
  const header: string[] = [];
  if (diff.branch !== undefined && diff.branch !== '') {
    header.push(`当前分支：${diff.branch}`);
  }
  header.push(`暂存文件（${diff.files.length} 个）：`);
  header.push(diff.files.length === 0 ? '（无）' : diff.files.join('\n'));
  if (diff.stat !== '') {
    header.push('');
    header.push('变更统计：');
    header.push(diff.stat);
  }
  header.push('');
  header.push(diff.truncated === true ? `diff（已截断到前 ${diff.diff.length} 字符）：` : 'diff：');
  header.push(diff.diff === '' ? '（空）' : diff.diff);
  return [
    { role: 'system', content: COMMIT_SYSTEM_PROMPT },
    { role: 'user', content: header.join('\n') },
  ];
}

/**
 * 估算本次生成会消耗的输入 token（BPE，复用既有计数器）。
 *
 * 只算输入：输出（标题 + 3 条要点）通常 < 200 token，量级可忽略；
 * 成本提示的价值在于让用户知道「这将花一次模型调用」，而不是精确计费。
 */
export function estimateCommitTokens(diff: StagedDiff): number {
  return countMessageListTokens(buildMessagePrompt(diff));
}

// ── 生成主入口 ────────────────────────────────────────────────

/**
 * 生成 commit message。
 *
 * 三条降级路径都走**同一个**本地兜底，并用 `fallbackReason` 区分原因，
 * 保证调用方永远不会误报「模型已生成」（T15 假通过教训的同款防线）。
 */
export async function generateCommitMessage(
  options: GenerateCommitMessageOptions,
): Promise<CommitMessage> {
  const { diff, client, model } = options;
  if (client === undefined || model === undefined) {
    return { ...buildLocalCommitMessage(diff), fallbackReason: 'no-client' };
  }

  const parts: string[] = [];
  try {
    for await (const chunk of client.streamChat({
      model,
      messages: buildMessagePrompt(diff),
      temperature: 0.2,
    })) {
      for (const choice of chunk.choices) {
        const text = choice.delta.content ?? '';
        if (text !== '') {
          parts.push(text);
        }
      }
    }
  } catch {
    return { ...buildLocalCommitMessage(diff), fallbackReason: 'model-failed' };
  }

  const parsed = parseCommitMessage(parts.join(''));
  if (parsed === undefined) {
    return { ...buildLocalCommitMessage(diff), fallbackReason: 'model-empty' };
  }
  return parsed;
}

/** 导出给调用方做断言/展示用（避免各处重复算宽度）。 */
export { displayWidth };
