/**
 * 记忆管理斜杠命令处理器：/remember /forget /memories。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 * 返回非 null 表示已处理（不应再走模型调用），返回的消息用于 UI 显示。
 */

import type { ChatMessage } from '../../loop/types';
import type { MemoryStore } from '../../store/memory-store';

// ── 命令解析 ──

export type SlashMemoryCommand =
  | { type: 'remember'; content: string }
  | { type: 'forget'; keyword: string }
  | { type: 'memories' }
  | { type: 'unknown' };

/** 解析用户输入，识别记忆管理命令。 */
export function parseMemoryCommand(input: string): SlashMemoryCommand | null {
  const trimmed = input.trim();

  if (trimmed === '/memories') {
    return { type: 'memories' };
  }
  if (trimmed.startsWith('/remember ')) {
    const content = trimmed.slice('/remember '.length).trim();
    if (content !== '') {
      return { type: 'remember', content };
    }
  }
  if (trimmed === '/remember') {
    return { type: 'unknown' }; // 无参数 → 提示用法
  }
  if (trimmed.startsWith('/forget ')) {
    const keyword = trimmed.slice('/forget '.length).trim();
    if (keyword !== '') {
      return { type: 'forget', keyword };
    }
  }
  if (trimmed === '/forget') {
    return { type: 'unknown' }; // 无参数 → 提示用法
  }

  return null; // 非记忆命令 → 走正常模型调用
}

// ── 命令执行（同步 / 异步） ──

export interface MemoryCommandResult {
  /** 显示给用户的消息。 */
  message: ChatMessage;
  /** 是否已处理（true = 不再走 runLoop）。 */
  handled: boolean;
}

function assistantReply(text: string): ChatMessage {
  return { role: 'assistant', content: text };
}

/** 执行记忆命令。返回结果显示给用户的消息。 */
export async function executeMemoryCommand(
  cmd: SlashMemoryCommand,
  store: MemoryStore,
): Promise<MemoryCommandResult> {
  switch (cmd.type) {
    case 'remember': {
      // 简化版：直接写入，标题取前 60 字符
      const title = cmd.content.length > 60 ? `${cmd.content.slice(0, 57)}…` : cmd.content;
      const entry = await store.create(title, cmd.content);
      return {
        handled: true,
        message: assistantReply(`✅ 已记忆：**${entry.title}**\n\`/memories\` 查看全部，\`/forget <关键词>\` 删除`),
      };
    }

    case 'forget': {
      const matches = await store.search(cmd.keyword, { limit: 5 });
      if (matches.length === 0) {
        return {
          handled: true,
          message: assistantReply(`未找到匹配「${cmd.keyword}」的记忆。`),
        };
      }
      if (matches.length === 1) {
        const entry = matches[0]!;
        await store.delete(entry.id);
        return {
          handled: true,
          message: assistantReply(`✅ 已删除记忆：**${entry.title}**`),
        };
      }
      // 多条匹配 → 列出来让用户精确删除
      const list = matches
        .map((m, i) => `${i + 1}. ${m.title}`)
        .join('\n');
      return {
        handled: true,
        message: assistantReply(
          `找到 ${matches.length} 条匹配「${cmd.keyword}」的记忆：\n${list}\n\n请用 \`/forget <完整标题>\` 精确删除。`,
        ),
      };
    }

    case 'memories': {
      const all = await store.list();
      if (all.length === 0) {
        return {
          handled: true,
          message: assistantReply('暂无项目记忆。用 `/remember <内容>` 创建第一条。'),
        };
      }
      const list = all
        .map((m) => `- **${m.title}** ${m.tags.length > 0 ? `\`${m.tags.join(', ')}\`` : ''}`)
        .join('\n');
      return {
        handled: true,
        message: assistantReply(`📋 项目记忆（${all.length} 条）：\n${list}\n\n\`/forget <关键词>\` 删除`),
      };
    }

    case 'unknown':
      return {
        handled: true,
        message: assistantReply(
          '记忆命令用法：\n- `/remember <内容>` — 记住一条信息\n- `/forget <关键词>` — 搜索并删除记忆\n- `/memories` — 查看所有记忆',
        ),
      };
  }
}
