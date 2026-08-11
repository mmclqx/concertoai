/**
 * 中文文案表：全项目唯一的用户可见文案来源（提示语/错误/审批框/状态条）。
 * 占位符格式 {key}，运行时用 fmt() 替换。
 */

import { MAX_LOOP_TURNS } from '../loop/loop';

export const zh = {
  cli: {
    description: 'ConcertoAI —— 面向个人开发者的中文优先终端编码助手',
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
    list: {
      description: '仅列出历史会话，不进入对话',
    },
    plan: {
      description: '先生成执行计划，批准后自动执行',
    },
    model: {
      description: '指定模型（默认 deepseek-v4-flash）',
    },
    balance: {
      description: '查询 DeepSeek 账户余额',
    },
    doctor: {
      description: '环境诊断（含 DeepSeek 账户余额）',
    },
  },
  errors: {
    noApiKey: '未找到 DEEPSEEK_API_KEY 环境变量，请先设置后再启动。',
    noTty:
      'chat 模式需要交互式终端。请直接运行 `concertoai chat`（不要通过管道/脚本调用），或使用 `concertoai run "<任务>"` 一次性执行。',
    modelCallFailed: '模型调用失败：{message}',
    get loopMaxTurns() {
      return `工具调用已达 ${MAX_LOOP_TURNS} 轮上限，进度已保留。你可以继续输入以让助手继续工作。`;
    },
    streamAborted: '生成已中断，已保留已生成内容。可重新输入继续。',
    streamInterrupted: '网络中断：{message}。已保留已生成内容，请重试。',
    planNeedsTty: 'plan 模式需要交互式终端来批准计划（或使用 --auto-approve）',
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
    confirm: '批准 (y / Enter)',
    reject: '拒绝 (n / Esc)',
  },
  prompt: {
    placeholder: '输入你的需求…（Enter 发送 / Shift+Enter 换行 / Esc 退出）',
  },
  status: {
    model: '模型',
    tokens: 'token',
    cost: '成本',
    yuan: '元',
    real: '真实',
    cacheHit: '缓存命中',
  },
  session: {
    resumed: '已恢复会话 {id}（{count} 条消息）',
    newSession: '新会话',
    listTitle: '历史会话（最新在前）',
    empty: '暂无历史会话',
    saved: '会话已保存: {id}',
    pickerHint: '↑/↓ 选择，Enter 确认，Esc 取消',
    noUserMessage: '（无用户消息）',
  },
  plan: {
    title: '执行计划',
    hint: '批准 (y / Enter) / 拒绝 (n / Esc)',
    approved: '计划已批准，开始执行',
    rejected: '计划已拒绝，未执行',
  },
  balance: {
    available: '账户可用',
    unavailable: '账户不可用',
    empty: '无余额信息',
    line: '💰 余额：{symbol}{total}',
  },
  peakTime: {
    askSwitch:
      '当前处于高峰时段（工作日 9-12 / 14-18 点），是否切换到本地模型 {model}（{baseUrl}）以节省 API 成本？',
    switched: '已切换到本地模型 {model}（{baseUrl}）',
    declined: '已保持主模型 {model}',
    ignored: '高峰时段已配置为忽略切换，保持主模型 {model}',
    noInteractive: '非交互环境，跳过高峰模型切换，保持主模型 {model}',
  },
  doctor: {
    title: 'ConcertoAI 环境诊断',
    ok: '✅',
    fail: '❌',
    money: '💰',
    nodeLabel: 'Node.js',
    platformLabel: '平台',
    apiKeyLabel: 'API Key',
    apiKeySet: '已设置',
    apiKeyMissing: '未设置（无法查询余额）',
    configLabel: '配置文件',
    configOk: '{path}（可读，schema v{version}）',
    configMissing: '{path}（不存在，使用默认配置）',
    configBroken: '{path}（读取失败：{message}）',
    sessionDirLabel: '会话目录',
    sessionWritable: '{path}（可写）',
    sessionNotWritable: '{path}（不可写：{message}）',
    modelsLabel: '模型表',
    modelsCount: '{count} 个模型（{ids}）',
    modelsEmpty: '模型表为空',
    accountsLabel: '账号完整性',
    accountNoActive: '无 active 账号（可运行 concertoai login <name> 登录）',
    accountOk: 'active: {name}（账号完整）',
    accountBroken: 'active: {name}（账号配置缺失，请运行 concertoai login {name}）',
    balanceLabel: '账户余额',
    balanceAvailable: '账户可用',
    balanceUnavailable: '账户不可用',
    balanceSkipped: '未查询（缺少 DEEPSEEK_API_KEY）',
    balanceFailed: '查询失败：{message}',
    balanceEntry: '{currency}: 总额 {total} ｜ 赠送 {granted} ｜ 充值 {toppedUp}',
    // VS Code 健康诊断（v3.4 M3 / doctor --vscode）
    vscodeTitle: 'VS Code 健康诊断',
    vscodeProcessLabel: 'Code 进程数',
    vscodeProcessOk: '{count} 个（正常）',
    vscodeProcessWarn: '{count} 个（偏多，建议关闭多余窗口，合并工作区）',
    vscodeProcessFail: '{count} 个（严重，疑似多窗口×AI 扩展组合爆炸，请立即关闭多余窗口）',
    vscodeProcessUnavailable: '无法检测（命令执行失败或超时）',
    vscodeDumpLabel: '崩溃转储',
    vscodeDumpOk: '无堆积（0 个）',
    vscodeDumpWarn: '{count} 个 / {size}（建议清理）',
    vscodeDumpFail: '{count} 个 / {size}（严重堆积，请清理）',
    vscodeDumpCleanCmd: '清理命令: {command}',
    vscodeAiExtLabel: 'AI 扩展',
    vscodeAiExtOk: '{count} 个（≤3，正常）',
    vscodeAiExtWarn: '{count} 个（>3，冗余 AI 扩展建议禁用/卸载）',
    vscodeAiExtUnavailable: '无法检测（code CLI 不在 PATH）',
    vscodeAiExtNotDisabled: '已装但未禁用: {ids}',
    vscodeAiExtSuggest: '建议: {command} 或写入 argv.json',
    vscodeArgvLabel: 'argv.json',
    vscodeArgvOk: '{path}（disable-extensions 正确，禁用 {count} 个扩展）',
    vscodeArgvWarn: '{path}（存在但未配置 disable-extensions）',
    vscodeArgvMissing: '未找到 {path}（无持久禁用配置）',
    vscodeArgvIneffective:
      '⚠️ 无效位置: %APPDATA%\\Code\\argv.json 存在但 VS Code 不读取（实际读取 ~/.vscode/argv.json），建议删除或移走',
    vscodeArgvInvalidField:
      '❌ 字段名错误: 应为 disable-extensions（复数），检测到 disable-extension（单数）——VS Code 不识别，禁用不生效',
    vscodeArgvInvalidValue: '❌ 值格式错误: disable-extensions 必须为数组或 true',
    vscodeArgvInvalidId:
      '❌ 扩展 ID 引号错误: 应为 JSON 字符串（以 " 开头和结尾，当前疑似无引号/单引号/尾逗号）',
  },
  selfHeal: {
    // 阶段标签（v3.3 S1：selfHealPhaseLabel 移入 i18n）
    phaseVerify: '执行 verify',
    phaseLintFix: 'lint 修复',
    phaseModelFix: '模型修复',
    phaseVerifyFix: '修复后验证',
    phaseRollback: '回滚',
    phaseDone: '完成',
    // 尝试动作标签（v3.3 S1：actionLabel 移入 i18n）
    actionLintFix: 'lint 直修',
    actionModelFix: '模型修复',
    actionSkip: '跳过',
    // 报告文案（formatSelfHealReport）
    verifyPassedNoFix: '✅ verify 全部通过，无需修复',
    repairedPassed: '✅ self-heal 修复完成：verify 全部通过',
    exceeded: '❌ 修复超限（已尝试全部次数），请人工处理',
    verifyFailed: '❌ verify 失败，请人工处理',
    repairProcessTitle: '### 修复过程',
    attemptLine: '{n}. 第 {attempt} 次尝试：{action}{fixes} {outcome}',
    unknownReason: '未知原因',
    rolledBack: '→ ❌ 已回滚（{reason}）',
    notFixed: '→ ⏭ 未修复（{suggestion}）',
    skipped: '→ ⏭ 跳过',
    verifyPassed: '→ ✅ verify 通过',
    keepGoing: '→ 🔁 继续（仍有错误）',
    remainingTitle: '### 剩余错误（{count} 个，转人工）',
    snapshotCommitted: '快照已提交，无残留。',
    snapshotProtection:
      '⚠️ 已启用快照保护：修复无效的变更已回滚；残留快照可用 `concertoai snapshot list` 查看。',
    snapshotWarning:
      '⚠️ 快照保护未生效：本次模型修复快照登记失败，无法自动回滚（请人工检查变更内容）。',
    // feedback 数据层（v3.4 T1.4 I1：suggestion 文案走 i18n，--lang en 下报告不混合中英）
    feedbackBuildFailed: '构建失败：请检查 tsup.config.ts 入口、缺失依赖或导出语法',
    feedbackTestFailed: '测试失败：请检查测试断言或被测试模块实现（self-heal 不自动修测试）',
    feedbackTypeError:
      '类型错误（{code}）：请手动补全类型标注或调整类型（self-heal 仅自动修缺 import / 缺标注）',
    feedbackFormatError: '格式错误：请运行 npm run lint:fix 自动修复',
    feedbackUnknown: '未知错误：请人工检查',
    feedbackDenied: '用户拒绝了自动修复，请手动处理',
    feedbackWriteFailedRolledBack: '修复写盘失败，已回滚，请手动处理',
    feedbackWriteFailed: '修复写盘失败，请手动处理',
  },
  ui: {
    thinking: '思索中',
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
