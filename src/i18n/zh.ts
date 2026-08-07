/**
 * 中文文案表：全项目唯一的用户可见文案来源（提示语/错误/审批框/状态条）。
 * 占位符格式 {key}，运行时用 fmt() 替换。
 */

export const zh = {
  cli: {
    description: 'Lumen —— 面向个人开发者的中文优先终端编码助手',
    chat: {
      description: '进入交互式对话',
    },
    run: {
      description: '一次性执行任务',
      argument: '任务描述',
    },
    resume: {
      description: '继续上次会话',
      argument: '会话 ID（省略时列出全部会话）',
    },
    model: {
      description: '指定模型（默认 deepseek-v4-flash）',
    },
  },
  errors: {
    noApiKey: '未找到 DEEPSEEK_API_KEY 环境变量，请先设置后再启动。',
    noTty:
      'chat 模式需要交互式终端。请直接运行 `lumen chat`（不要通过管道/脚本调用），或使用 `lumen run "<任务>"` 一次性执行。',
    modelCallFailed: '模型调用失败：{message}',
    loopMaxTurns: '工具循环超过最大轮数，已终止',
    unknownTool: '未知工具: {name}',
    invalidSessionId: '非法的会话 id: {id}',
    sessionNotFound: '会话不存在: {id}',
    projectRulesReadFailed: '项目规则读取失败',
  },
  approval: {
    editTitle: '编辑文件',
    shellTitle: '执行命令',
    summaryEdit: '编辑文件 {path}',
    summaryShell: '执行命令: {command}',
    confirm: '批准 (y)',
    reject: '拒绝 (n)',
  },
  prompt: {
    placeholder: '输入你的需求…（Enter 发送 / Shift+Enter 换行 / Esc 退出）',
  },
  status: {
    model: '模型',
    tokens: 'token',
    cost: '成本',
    yuan: '元',
  },
  session: {
    resumed: '已恢复会话 {id}（{count} 条消息）',
    newSession: '新会话',
    listTitle: '历史会话（最新在前）',
    empty: '暂无历史会话',
    saved: '会话已保存: {id}',
  },
  ui: {
    thinking: '思考中…',
    toolRunning: '执行工具: {name}',
    toolDone: '工具完成: {name}',
    quit: '已退出。会话已保存。',
  },
} as const;

export type ZhDict = typeof zh;

/** 占位符替换：fmt('模型调用失败：{message}', { message: 'x' }) → '模型调用失败：x'；缺失参数保留原样。 */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}
