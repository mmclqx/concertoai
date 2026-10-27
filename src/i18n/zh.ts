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
    workflow: {
      description: '工作流管理（init/run/export/import，DAG 执行）',
    },
    lsp: {
      description: '启动 Language Server（--stdio：保存即诊断 + CodeAction 一键修复）',
      stdioRequired: 'lsp 命令需要 --stdio 参数（当前仅支持 stdio 传输）',
    },
    plugin: {
      description: '插件市场（install/search/list/remove/browse/recommend/popular）',
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
    // v4.1 T2.1：未知异常「下一步」指引（safeAction 兜底）
    fatalNextStep:
      '💡 下一步：运行 `concertoai doctor` 检查环境；若为软件缺陷请附带上方错误报告反馈。',
  },
  // v5.0 T1：缺 API Key 中文引导（命令片段见 src/cli/api-key-guide.ts，跨语言一致故不入字典）
  missingApiKey: {
    title: '⚠️  未检测到 DeepSeek API Key —— ConcertoAI 需要它来调用模型',
    intro: '任选一种方式配置（推荐方式 1，当前终端立即生效）：',
    envTitle: '1. 设置环境变量',
    accountTitle: '2. 登录账号（保存到本地，之后无需重复配置）',
    accountHint: '（交互式输入不回显：concertoai login myname）',
    configTitle: '3. 写入配置文件（目录不存在时需先创建）',
    getKeyLabel: '获取 API Key：',
    nextStep: '💡 配置完成后运行 `concertoai doctor` 验证环境。',
  },
  // v5.0 T1：Node 版本提示（engines 要求 >= 22；不阻断，仅交互式终端提示）
  nodeVersion: {
    tooOld:
      '⚠️  当前 Node {current}，ConcertoAI 要求 {required}。本次命令仍会执行，但部分功能可能异常；如遇问题请先升级 Node。',
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
    provider: 'Provider',
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
    vscodeArgvOk: '{path}（disable-extension 正确，禁用 {count} 个扩展）',
    vscodeArgvWarn: '{path}（存在但未配置 disable-extension）',
    vscodeArgvMissing: '未找到 {path}（无持久禁用配置）',
    vscodeArgvIneffective:
      '⚠️ 无效位置: %APPDATA%\\Code\\argv.json 存在但 VS Code 不读取（实际读取 ~/.vscode/argv.json），建议删除或移走',
    vscodeArgvInvalidField:
      '❌ 字段名错误: 复数 disable-extensions 只接受布尔值（true=禁用全部）；数组需用单数 disable-extension——VS Code 类型不匹配会静默忽略，禁用不生效',
    vscodeArgvInvalidValue: '❌ 值格式错误: disable-extension 必须为字符串数组',
    vscodeArgvPluralAll:
      '⚠️ disable-extensions: true = 禁用全部扩展（如需仅禁用指定扩展，请改用单数 disable-extension 数组）',
    vscodeArgvInvalidId:
      '❌ 扩展 ID 引号错误: 应为 JSON 字符串（以 " 开头和结尾，当前疑似无引号/单引号/尾逗号）',
    // v4.0 M3 T3.2：模型推荐区块
    recommendLabel: '模型推荐',
    recommendLine: '推荐 {provider}/{model}（月成本预估 ¥{monthlyCost}）——{reason}',
    recommendReasonLowLocal: '预算低 + 本地 Ollama 可用，0 成本可离线',
    recommendReasonLowCloud: '预算低 + 无本地模型，DeepSeek 低价位',
    recommendReasonMedium: '默认组合，成本/质量均衡',
    recommendReasonHighLarge: '复杂项目 + 高预算，优先最强模型',
    recommendReasonHighSmall: '高预算 + 轻量项目，OpenAI 性价比档',
    recommendLocalUnavailable: '本地 Ollama 探测失败（未推荐本地模型）',
    // v4.0 M3 T3.5：配置迁移完整性检测
    migrationLabel: '配置迁移完整性',
    migrationOk: 'v4 迁移完成（schema v2 + defaultProvider + providers）',
    migrationNotMigrated: '配置仍为 v3 格式（schema v1），启动时将自动迁移',
    migrationBackupOk: '备份存在: {path}',
    migrationBackupMissing: '备份缺失（未找到 config.v3.bak）',
    migrationSessionOk: '会话格式兼容（v4 只新增字段不破坏 v3 会话）',
    migrationIdempotentOk: '幂等（检测只读，重复执行无副作用）',
  },
  reviewer: {
    // v4.0 M1 T1.6：autoFix 文案（/review --fix，审查→修复闭环）
    autofixBatchSummary: 'autoFix 批量修复 {count} 个建议（A 类）',
    autofixProgress: '正在修复第 {fixed}/{total} 个问题…',
    fixResultTitle: '🔧 修复结果',
    fixResultLine: '✅ 已修复 {fixed} 个 / ⚠ 需人工处理 {manual} 个 / ❌ 自动回滚 {rolledBack} 个',
    fixItemFixed: '✅ {location} — {title}',
    fixItemRolledBack: '❌ {location} — {title}（已自动撤销：{reason}）',
    fixItemManual: '⚠ {location} — {title}（{reason}）',
    reasonVerifyFailed: '修复后验证失败，已自动撤销',
    reasonManual: '需人工处理',
  },
  workflow: {
    // v4.0 M2 T2.6：工作流文案（concertoai workflow + /workflow）
    usage: '用法: concertoai workflow <list|init|run|export|import|create>',
    listEmpty: '暂无已安装工作流',
    listHint:
      '使用 `concertoai workflow init <模板>` 生成，或 `concertoai workflow import <文件>` 导入',
    listHeader: '已安装工作流（{count} 个）',
    initPrompt: '选择工作流模板：',
    initChoice: '输入编号或模板名: ',
    initAborted: '未选择模板，已取消',
    initUnknown: '未知模板: {name}',
    initDone: '已生成工作流 {name} → {file}',
    runMissing: '用法: concertoai workflow run <name>',
    runStart: '▶ 开始执行工作流 {name}（{steps} 个步骤）',
    runProgress: '正在执行 step {current}/{total}: {step}…',
    runOk: '工作流 {name} 执行成功',
    runFailed: '工作流 {name} 执行失败（失败步骤: {step}，跳过 {skipped} 个）',
    // v4.1 P0-1：循环依赖友好提示（不再 crash.log；提示环路径与修复建议）
    runFailedCycle:
      '工作流 {name} 检测到循环依赖（{cycle}）\n💡 请编辑 {name}.yml，移除互相依赖的 depends（如 A 依赖 B 且 B 依赖 A）后重跑。',
    runFailedNext:
      '💡 下一步：修复失败步骤后重跑：\n   concertoai workflow run {name}\n按 A 放弃的改动已自动回滚。',
    workflowNotFound: '工作流不存在: {name}（请先 workflow init 生成或 import 导入）',
    workflowParseError:
      '工作流 {name} 解析失败：{message}\n💡 请检查 YAML 语法（depends/files 请使用块状列表：\n   depends:\n     - lint）',
    exportMissing: '用法: concertoai workflow export <name>',
    exportTitle: '工作流 {name} 定义：',
    importMissing: '用法: concertoai workflow import <file>',
    importDone: '已导入工作流 {name} → {file}',
    importFailed: '导入失败: {error}',
    createMissing: '用法: concertoai workflow create "<自然语言描述>"',
    createFailed: '生成失败，请手动编写 YAML',
    createPreview: '生成的工作流预览（y 确认保存 / 其他取消）：',
    createConfirm: '保存此工作流? (y/N): ',
    createDone: '已保存工作流 {name} → {file}',
    createAborted: '已取消保存',
    failureHeader: '⚠️ 工作流执行失败',
    failureSummary: '💡 摘要：{summary}',
    failureStep: '❌ 步骤 {step} 失败',
    failureOptions: '[R]重试 [S]跳过 [F]修复后重试 [A]放弃',
    failurePrompt: '选择 (R/S/F/A): ',
    failureFixWait:
      'ℹ️ 步骤 {step} 需手动修复。请修改代码后按 Enter 重试；输入 a 放弃（整体回滚）。{seconds} 秒无输入将自动放弃。',
    failureFixPrompt: '等待修复完成 (Enter 重试 / a 放弃): ',
    failureFixInvalid: '无效输入（Enter 重试 / a 放弃）。',
    // v4.1 T1.4：运行前环境预检 + 轻量自动初始化
    preflightMissing: '⚠️ 环境未就绪（{count} 项缺失）：',
    preflightItemScript: '  - 缺少脚本 {name}（可自动初始化）',
    preflightItemDep: '  - 依赖未安装: {name}（可自动安装）',
    preflightItemConfig: '  - 配置文件缺失: {name}（可自动生成）',
    preflightItemManual: '  - 缺少脚本 {name}（不可自动初始化，请手动配置）',
    preflightAskInit: '是否自动初始化以上可修复项? [Y/n]: ',
    preflightPlanTitle: '将执行以下初始化操作（全部需你确认）：',
    preflightPlanCmd: '  $ {command}',
    preflightPlanWrite: '  ✎ 写入 {file}',
    preflightPlanScript: '  ✎ package.json scripts.{name} = {command}',
    preflightConfirm: '确认执行初始化? (y/N): ',
    preflightInitDone: '✅ 环境初始化完成',
    preflightInitFailed: '❌ 初始化失败：{error}（未继续执行，请修复后重试）',
    preflightSkipped: '已跳过初始化，按现有配置继续执行（缺失步骤可能失败）',
    preflightContinue: '仍有不可自动修复的缺失项。是否继续执行? (y/N): ',
    // v4.1 P1-4：用户拒绝继续（n）时明确说明已停止，不再静默退出
    preflightStopped: '已停止执行，请先配置缺失项后重试。',
    preflightNoTty: '非交互环境且环境未就绪，已停止执行。请先配置缺失项后重试。',
    approveStep: '⏸ 步骤需要审批，命令: {command}',
    approvePrompt: '批准执行? (y/N): ',
    inferFound: '检测到步骤间可能存在依赖关系：',
    inferPrompt: '是否添加这些 depends 依赖? (y/N): ',
    inferSkipped: '已跳过依赖推断（保持原配置）',
  },
  plugin: {
    // v4.0 M4 T4.1~T4.5：插件市场文案（concertoai plugin + /plugin）
    usage: '用法: concertoai plugin <install|search|list|remove|browse|recommend|popular>',
    // 分类（browse 展示：图标 + 名称）
    categoryTool: '🔧 工具',
    categoryWorkflow: '📋 工作流',
    categoryAgent: '🤖 Agent',
    // install
    installMissing: '用法: concertoai plugin install <name>',
    installSearching: '🔍 正在匹配注册表: {name}…',
    installStart: '📦 正在安装 {name}@{version}…',
    installOk:
      '✅ 插件 {name}@{version} 安装成功 → {dir}\n\n在 chat 中输入 /plugin list 查看，或按插件文档使用。',
    installUpdated: '✅ 插件 {name} 已更新到 {version} → {dir}',
    installFailed: '❌ 插件安装失败：{message}',
    installCanceled: '已取消安装 {name}（权限未获批准，未写入任何文件）。',
    installAlready: '📦 {message}',
    // 权限清单（T4.2：彩色图标一眼看懂）
    permissionTitle: '🔐 权限清单（安装后运行时可验证，未声明权限一律拒绝）:',
    permissionConfirm: '确认安装? (y/N): ',
    permissionEmpty: '（无权限声明——只读模式，敏感操作一律拒绝）',
    // search
    searchMissing: '用法: concertoai plugin search <keyword>',
    searchTitle: '🔍 插件市场（{count} 个）:',
    searchEmpty: '未找到匹配 "{keyword}" 的插件。',
    searchHint: '\n\n使用 concertoai plugin install <name> 安装。',
    searchInstalled: ' [已安装 {version}]',
    // list
    listEmpty: '暂无已安装插件。',
    listHint:
      '使用 `concertoai plugin browse` 浏览市场，或 `concertoai plugin install <name>` 安装。',
    listHeader: '已安装插件（{count} 个）:',
    // remove
    removeMissing: '用法: concertoai plugin remove <name>',
    removeOk: '✅ 插件 {name} 已卸载。',
    removeNotFound: '❌ 插件 {name} 未安装（无法卸载）。',
    // browse（T4.1a：分类浏览含下载量 + 评分）
    browseMissing: '用法: concertoai plugin browse [category]（category: tool / workflow / agent）',
    browseHeader: '📚 插件市场（{category}，{count} 个）:',
    browseAll: '全部',
    browseLine: '- **{name}** {version} — {description}（⬇ {downloads} ⭐ {rating}）',
    browseEmpty: '该分类暂无插件。',
    // recommend（T4.1a：项目特征启发式）
    recommendHeader: '💡 检测到项目特征，为你推荐:',
    recommendReasonExpress: '检测到 Express → 推荐 api-docs（自动扫描路由生成 API 文档）',
    recommendReasonTodo: '检测到 TODO/FIXME 标记 → 推荐 todo-tracker（跟踪待办生成清单）',
    recommendReasonRelease: '检测到 package.json → 推荐 release-helper（版本检查 → 门禁 → 发布）',
    recommendReasonGit: '检测到 git 仓库 → 推荐 git-status（一键查看分支/暂存/未跟踪）',
    recommendEmpty: '未检测到明确项目特征，试试 `concertoai plugin browse` 浏览全部插件。',
    // popular（T4.1a：Top 10）
    popularHeader: '🔥 社区热门插件 Top {count}:',
  },
  provider: {
    // v4.0 M3 T3.1/T3.2b：Provider 管理文案
    listTitle: '可用 Provider：',
    statusOk: '可用',
    statusDegraded: '降级',
    statusUnavailable: '不可用',
    defaultLabel: '默认',
    ollamaLocalHint: '本地模型（Ollama）——成本 0，可离线',
    switchHint: '切换：concertoai provider switch <name> 或 concertoai --provider <name> 临时切换',
    switchUnknown: '未知 Provider: {name}（请先配置 providers.{name}）',
    switchDone: '已持久化切换默认 Provider → {name}',
    authUnknown: '未知 Provider: {name}（仅支持 deepseek / openai）',
    authPrompt: '输入 {name} API Key（不回显）:',
    authNoTty: '非交互终端无法回显隐藏输入，请用 --key <key> 非交互注入',
    authEmpty: 'API Key 不能为空',
    authCanceled: '已取消认证（Ctrl+C）',
    authFailed: '❌ Key 验证失败：',
    authOk: '✅ Key 验证通过',
    authVerifyOnly: '（--verify 仅验证，未保存）',
    authSaved: '✅ 已保存 {name} API Key 至 accounts/（0600）+ 设为 active',
    authSaveFailed: '❌ 保存失败：',
    // T3.4 fallback + T3.2a 成本提示（状态条）
    fallbackNote: '主模型 {primary} 不可用，已切换至 {fallback}（原因：{reason}）',
    costCompare: '已切换至 {current}，预估成本约为 {baseline} 的 {ratio} 倍',
    costCompareLocal: '当前使用本地模型（Ollama），成本为 0，可离线',
    sessionCostCompare: '本次消费 ¥{actual}（{current}），如用 {baseline} 约 ¥{estimate}',
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
    // repair.ts 调试日志（v4.0 M1 T1.6：I4 遗留，日志语言化）
    logLintFixAttempt:
      '[self-heal] 第 {attempt} 次尝试：执行 npm run lint:fix（{count} 个 lint 错误）',
    logLintFixFailed: '[self-heal] lint:fix 执行失败，剩余 type 错误已跳过（环境问题），转人工',
    logModelFixAttempt: '[self-heal] 第 {attempt} 次尝试：模型修复类型错误 {code} @ {file}:{line}',
    logRemainingManual: '[self-heal] 剩余错误不可自动修复，转人工',
  },
  team: {
    // v4.0 M5：多 Agent 并行执行（team --parallel）
    parallel: {
      taskPrefix: '任务 {taskId} ',
      taskDone: '⚡ 任务 {taskId} 并行完成',
      taskFailed: '❌ 任务 {taskId} 并行失败',
      fallbackSerial: '无法拆解为可并行任务，已按顺序执行',
      conflict: '⚠️ {taskA} 和 {taskB} 都修改了 {file}，请检查保留哪个版本',
      summaryOk: '✅ {count} 个任务全部完成',
      summaryPartial: '⚠️ 完成 {ok} 个 / 失败 {failed} 个（{failedIds}）',
    },
  },
  ui: {
    thinking: '思索中',
    toolRunning: '执行工具: {name}',
    toolDone: '工具完成: {name}',
    quit: '已退出。会话已保存。',
  },
  welcome: {
    // v4.1 T2.2：首次运行欢迎引导（用户反馈 3：新手不知流程）
    title: '🎉 欢迎使用 ConcertoAI！',
    line1: '  直接输入需求开始对话；/help 查看斜杠命令',
    line2: '  常用：/plan 先生成计划再执行 · /review 代码审查 · /workflow 运行工作流',
    line3: '  环境检查：concertoai doctor · 退出：Ctrl+C（会话已保存）',
  },
  help: {
    // v4.1 T2.2：--help 分组 + 新手三步（用户反馈 3）
    gettingStarted: '开始使用（新手三步）',
    step1: '  ① 环境检查：concertoai doctor',
    step2: '  ② 开始对话：concertoai chat（或直接 concertoai）',
    step3: '  ③ 运行工作流：concertoai workflow init && concertoai workflow run <name>',
    commands: '命令速览',
    exampleChat: '  示例：concertoai chat（对话） · concertoai run "修复这个 bug"（一次性任务）',
    exampleProject:
      '  示例：concertoai project add demo .（注册项目） · concertoai team "..."（团队执行）',
    exampleOps: '  示例：concertoai balance · doctor · self-heal · audit export',
    exampleMarket: '  示例：concertoai plugin browse · provider list · config set provider <name>',
  },
} as const;

export type ZhDict = typeof zh;

/** 占位符替换：fmt('模型调用失败：{message}', { message: 'x' }) → '模型调用失败：x'；缺失参数保留原样。 */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}
