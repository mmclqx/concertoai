/**
 * 自然语言 → 工作流 YAML（v4.0 M2 T2.2）。
 *
 * 用户描述流程 → 模型生成工作流 YAML → zod 校验 → 展示确认。
 * 模型产出非法 YAML / 校验失败 → 返回 error，由调用方降级为人工编辑兜底
 * （提示「AI 生成失败，请手动编辑 YAML 或重试」）。
 */

import type { ModelClient } from '../model/client';
import { parseWorkflowYaml } from './parser';
import type { Workflow } from './types';

// ── 类型 ──────────────────────────────────────────────────────

/** NL 生成结果：成功返回 workflow；失败返回 error（降级人工编辑）。 */
export interface NlWorkflowResult {
  /** 生成的工作流（成功时）。 */
  workflow?: Workflow;
  /** 失败原因（失败时；模型不可用 / 输出非 YAML / 校验不通过）。 */
  error?: string;
  /** 模型原始输出（供人工编辑参考）。 */
  raw?: string;
}

/** 生成选项。 */
export interface NlWorkflowOptions {
  /** 模型客户端（未提供则直接返回错误，不降级到本地启发式）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
}

/** 模型系统提示：输出工作流 YAML 结构约束。 */
const NL_WORKFLOW_SYSTEM_PROMPT = [
  '你是工作流设计专家。根据用户描述生成一个 ConcertoAI 工作流 YAML。',
  '输出严格为 YAML（不要 markdown 围栏，不要其他文字）。',
  '格式：',
  'name: <英文短名>',
  'description: <用途>',
  'steps:',
  '  - name: <步骤名>',
  '    run: <shell 命令>',
  '    depends:',
  '      - <依赖步骤名>',
  '    require: approval   # 可选：需要用户审批的步骤',
  '    files:              # 可选：该步骤修改的文件（供失败回滚）',
  '      - <文件路径>',
  '要求：',
  '- 步骤名只允许字母/数字/下划线/连字符；至少 1 个步骤；',
  '- depends 引用的步骤必须已定义；避免循环依赖；',
  '- run 必须是可执行 shell 命令；',
  '- 需要审批的步骤（如 publish/删除/部署）加 require: approval；',
  '- 修改文件且希望失败回滚的步骤声明 files。',
].join('\n');

/**
 * 从自然语言生成工作流定义。
 *
 * 流程：组装 prompt → 模型流式输出 → 剥离 ```yaml 围栏 → parseWorkflowYaml 校验。
 * 任一环节失败返回 { error }（不抛错），调用方降级人工编辑兜底。
 */
export async function generateWorkflowFromNl(
  description: string,
  options: NlWorkflowOptions,
): Promise<NlWorkflowResult> {
  if (options.client === undefined || options.model === undefined) {
    return { error: '未配置模型，无法生成工作流（请手动编写 YAML）' };
  }

  const parts: string[] = [];
  try {
    for await (const chunk of options.client.streamChat({
      model: options.model,
      messages: [
        { role: 'system', content: NL_WORKFLOW_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `请为以下流程生成工作流 YAML：\n${description}`,
        },
      ],
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
    return { error: '模型调用失败，无法生成工作流（请手动编写 YAML 或重试）' };
  }

  const raw = parts.join('');
  const trimmed = raw.trim();
  // 剥离 ```yaml / ``` 围栏
  const fenceMatch = trimmed.match(/^```(?:yaml|yml)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;

  try {
    const workflow = parseWorkflowYaml(candidate);
    return { workflow, raw: trimmed };
  } catch (err) {
    return {
      error: `AI 生成失败（${err instanceof Error ? err.message : String(err)}），请手动编辑 YAML 或重试`,
      raw: trimmed,
    };
  }
}
