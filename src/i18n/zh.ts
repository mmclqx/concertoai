/**
 * 中文文案表：全项目唯一的用户可见文案来源（提示语/错误/审批框/状态条）。
 * 占位符格式 {key}，运行时用 fmt() 替换。
 */

import { MAX_LOOP_TURNS, MAX_TURNS_CAP } from '../loop/loop';

/**
 * 达到轮数上限的提示模板（`{turns}` = 本次**真实生效**的上限）。
 *
 * 为什么是模板而不是写死数字：上限可被 CLI `-t/--max-turns` 或 `config.maxTurns` 覆盖，
 * 文案若写死默认 50，用户设了 `-t 5` 却看到「已达 50 轮上限」——等于对用户说假话。
 * 调用方用 `fmt(t().errors.loopMaxTurnsTemplate, { turns })` 填入实际值。
 */
const LOOP_MAX_TURNS_TEMPLATE =
  '工具调用已达 {turns} 轮上限，进度已保留。你可以继续输入以让助手继续工作。';

export const zh = {
  cli: {
    // v5.0 T22：定位重写（用户定稿文案，勿改写）——把「安全约束」翻译成「你敢用」的产品价值
    description:
      'ConcertoAI —— 敢让你用来改生产代码的个人超级 CLI（终端 AI 开发助手，自带风险审批与一键治愈）',
    chat: {
      description: '进入交互式对话',
    },
    run: {
      description: '一次性执行任务',
      argument: '任务描述',
      autoApprove: '自动批准编辑与命令执行（谨慎使用；默认全部拒绝）',
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
      autoApprove: '自动批准计划与编辑/命令执行（谨慎使用）',
    },
    model: {
      description: '指定模型（默认 deepseek-v4-flash）',
    },
    // v5.0 架构修正：工具循环轮数上限（优先级 -t > config.maxTurns > 默认 MAX_LOOP_TURNS）
    // 范围与默认值都用常量拼（不写死数字）：改 `MAX_TURNS_CAP` / `MAX_LOOP_TURNS` 时
    // 帮助与报错自动跟随，不会出现「代码收 1-500、帮助说过 1-100」这种自相矛盾。
    maxTurns: {
      description: `工具循环轮数上限（1-${MAX_TURNS_CAP}；优先级：本次传参 > config.maxTurns > 默认 ${MAX_LOOP_TURNS}）`,
      invalid: `⚠️  -t/--max-turns 只接受 1-${MAX_TURNS_CAP} 的正整数（收到 {value}），已忽略本次传参，按配置或默认值执行。`,
    },
    balance: {
      description: '查询 DeepSeek 账户余额',
    },
    update: {
      description: '检查并升级到最新版本（--yes 跳过确认）',
      yes: '跳过确认直接升级',
    },
    init: {
      description: '分析项目并生成两份指南（AGENTS.md 给 AI + PROJECT_GUIDE.md 给人）',
      force: '覆盖已存在的文件（默认不覆盖，交互询问）',
    },
    // v5.0 T15：check 命令（提交前只读体检）
    check: {
      description: '提交前一条命令体检（只读，不修任何东西）',
      json: '输出结构化 JSON（供脚本/自动化消费）',
    },
    // v5.0 T16：fix 命令（报错自动修，self-heal 的推荐入口）
    fix: {
      description: '报错自动修（self-heal 薄入口：分类 → 修复 → 复验 → 回滚，每次写盘都审批）',
      dryRun: '只诊断并给出修复策略，不写盘（零写入，不需要 API Key）',
      autoApprove: '自动批准全部修复（谨慎；默认开跑前与每次写盘都要确认）',
    },
    // v5.0 T17：commit 命令（先体检 → 生成 message → 审批 → 本地提交）
    commit: {
      description: '一条命令提交（先体检，再生成 message 供你审批；只做本地提交，不推送到远程）',
      yes: '跳过 message 审批直接提交（CI 用；不会跳过体检）',
    },
    // v5.0 T18：review 命令（CLI 直达 9 维审查，与 TUI /review 同一引擎同一输出）
    review: {
      description: '按 9 个维度审查代码（默认审 git 改动的文件；与 /review 同一引擎）',
      fix: '审查后自动修可自动修的问题（建议级；每次写盘都会审批）',
      severity: '审查阈值：strict / normal / lenient（默认 normal）',
    },
    doctor: {
      description: '环境诊断（含 DeepSeek 账户余额）',
      // v5.0 T21：本地指标汇总开关（默认关闭时不记录，也不冒充有数据）
      metrics: '追加本地体验指标汇总（近 100 条：审批耗时/拒绝率、提示采纳、体检通过率、动词分布）',
      vscode: '追加 VS Code 健康诊断（进程数 / 崩溃转储 / AI 扩展 / argv.json）',
    },
    workflow: {
      description: '工作流管理（init/run/export/import，DAG 执行）',
    },
    lsp: {
      // v5.0 T20：功能冻结标注（FEATURE_FREEZE.md）——「只修不扩」在用户可见处说清楚
      description:
        '启动 Language Server（--stdio：保存即诊断 + CodeAction 一键修复）· 维护模式（只修不扩）',
      stdioRequired: 'lsp 命令需要 --stdio 参数（当前仅支持 stdio 传输）',
      stdio: 'stdio 模式（Content-Length 帧，供 VS Code 等客户端连接）',
    },
    plugin: {
      // v5.0 T20：功能冻结标注——插件市场停扩（新功能 PR 默认拒绝，见 FEATURE_FREEZE.md）
      description:
        '插件市场（install/search/list/remove/browse/recommend/popular）· 维护模式（停扩，只修 bug）',
      yes: '自动批准权限（非交互安装；默认逐项确认，fail-closed）',
    },
    reflect: {
      description: '拒绝复盘记录（list 查看 / clear 清空；本地 JSONL，零上传）',
      limit: '展示条数（默认 20）',
      yes: '清空时跳过确认（非交互环境必需）',
    },
    // ═══ v5.0 T22：以下文案此前**硬编码中文写在 cli/index.ts 里** ═══
    // 后果：修好 locale 之后，英文 help 只剩分段标题是英文、命令与选项描述仍中文，
    // 呈现「英中混排」——比全中文更难看。全部搬进字典后 zh/en 才有机会一致。
    snapshot: {
      description: '管理多文件事务快照（T3.6）',
    },
    project: {
      description: '多项目管理（v3.1 M2）：project add/list/remove/info',
    },
    team: {
      description:
        'Orchestrator 团队执行（v3.1 M5）：拆解需求 → 对抗性闭环（Architect/Coder/Reviewer/QA）→ 事务回滚兜底 · 维护模式（停扩，只修 bug）',
      dryRun: '仅输出拆解清单，不执行任何 Agent',
      autoApprove: '自动批准拆解方案与代码写盘（谨慎使用；默认全部审批）',
      parallel: '并行模式：拆解出的独立任务同时执行（也可自然语言触发）· 维护模式（停扩）',
    },
    selfHeal: {
      description: 'AI 自我修复闭环（v3.1 M1）：执行 npm run verify，失败自动分类→修复→验证→回滚',
      autoApprove: '自动批准模型修复（谨慎使用；默认全部拒绝）',
    },
    audit: {
      description: '审计日志（v3.1 M5）：audit export [--out <file>] 导出保序 JSON',
      out: '导出目标文件（缺省打印 stdout）',
    },
    login: {
      description: '登录账号（v3.1 M3）：交互输入 API Key 不回显；--key 非交互注入',
      key: '非交互注入 API Key（CI 场景）',
    },
    logout: {
      description: '登出账号（v3.1 M3）：清除 active 指针；--purge 删除账号文件',
      purge: '同时删除账号目录（含 Key 配置）',
    },
    whoami: {
      description: '显示当前账号（v3.1 M3）：账号名 + Key 后 4 位（打码）',
    },
    account: {
      description: '账号管理（v3.1 M3）：account list / switch <name>',
    },
    provider: {
      description:
        'Provider 管理（v4.0 M3）：provider list / auth <name> [--verify] / switch <name>',
      key: '非交互注入 API Key（auth 场景；CI 使用）',
      verify: '仅验证 Key 不保存（auth 场景）',
    },
    config: {
      description:
        '配置管理：config set provider <name> | config set approvalInsight <rich|plain> | config set reflections <on|off> | config set hints <on|off> | config set metrics <on|off> | config restore',
    },
    /** 跨命令共享选项：`--lang`（十几个命令都带）。 */
    lang: {
      description: '界面语言',
    },
    /** 全局（顶层）选项：`concertoai --project` / `--provider`。 */
    globalOptions: {
      project: '按已注册项目启动（等价 cd 到项目目录）',
      provider: '临时切换 Provider（本次进程生效；不写 config）',
    },
  },
  errors: {
    noApiKey: '未找到 DEEPSEEK_API_KEY 环境变量，请先设置后再启动。',
    noTty:
      'chat 模式需要交互式终端。请直接运行 `concertoai chat`（不要通过管道/脚本调用），或使用 `concertoai run "<任务>"` 一次性执行。',
    modelCallFailed: '模型调用失败：{message}',
    /** 轮数上限提示模板（调用方用 fmt 填入本次生效上限，见 LOOP_MAX_TURNS_TEMPLATE）。 */
    loopMaxTurnsTemplate: LOOP_MAX_TURNS_TEMPLATE,
    /** 不掌握生效上限时的旧入口（等价「默认 MAX_LOOP_TURNS」）。 */
    get loopMaxTurns() {
      return fmt(LOOP_MAX_TURNS_TEMPLATE, { turns: MAX_LOOP_TURNS });
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
  // v5.0 T5：init 命令（双输出）
  init: {
    scanning: '🔍 正在分析项目（package.json / 源码 / 配置 / TODO）…',
    truncated: '⚠️  已达扫描上限 {count} 个文件，结果可能不完整',
    skippedFiles: 'ℹ️  跳过 {count} 个文件（超大或读取失败）',
    overwritePrompt: '{file} 已存在，是否覆盖？[y/N] ',
    existsNonTty: 'ℹ️  {file} 已存在，非交互环境不覆盖（如需覆盖用 --force）',
    writeFailed: '❌ 写入 {file} 失败：{error}',
    nothingWritten: '未写入任何文件（已存在且未覆盖）。如需重新生成请加 --force。',
    partiallySkipped: 'ℹ️  已跳过（保持原文件）：{files}',
    notAProject:
      '⚠️  当前目录看起来不是项目根目录（未找到 package.json / src / pyproject.toml / Cargo.toml / go.mod）',
    notAProjectHint: '💡 请在项目根目录运行 `concertoai init`，不会生成空文件污染目录。',
  },
  // v5.0 T15：check 命令（提交前只读体检：只读、零写入、不静默成功）
  check: {
    title: '🔍 提交前体检',
    modeVerify: '🔍 提交前体检（npm run verify）',
    modePerStage: '🔍 提交前体检（分项检测：{scripts}）',
    stagePass: '通过',
    stageFail: '{count} 个问题：{summary}',
    stageFailNoCount: '失败：{summary}',
    stageSkipped: '未执行（前一段失败）',
    stageUnknown: '结果无法判定（请查看原始输出）',
    stageNoScript: '未配置检测脚本',
    outputTruncated: '（该段输出共 {total} 行，已显示前 {limit} 行）',
    allPass: '✅ 可以提交（{stages} 全部通过，耗时 {seconds}s）',
    failed: '❌ {count} 项待修（{stages}）',
    conclusionHintSelfHeal:
      '💡 体检只读、不修任何东西；要自动修可以跑 `concertoai self-heal`（失败会自动回滚）。',
    nextTitle: '💡 下一步：',
    nextItem: '{index}. {command} — {why}',
    whySelfHeal: '跑 verify，失败自动分类修复（失败自动回滚）',
    whyLintFix: '自动修可自动修的格式与 lint 问题',
    noPackageJson: '⚠️  当前目录没有可读取的 package.json —— 这里不是 Node 项目，无法体检。',
    noPackageJsonHint:
      '💡 请在项目根目录运行；非 Node 项目请用对应生态的工具（如 pytest / cargo test）。',
    noScripts:
      '⚠️  未找到任何检测脚本（build / lint / typecheck / test 都缺）——没做检测就不算通过。',
    noScriptsHint:
      '💡 在 package.json 补上 lint / typecheck / test 脚本后重试，或运行 `concertoai init` 生成项目指南（含常用命令）。',
    runFailed: '❌ 执行 {script} 失败：{error}',
    timedOut: '⏱ {script} 超时（>{seconds}s），视为失败',
  },
  // v5.0 T16：fix 命令（报错自动修：self-heal 薄入口 + --dry-run 只诊断）
  fix: {
    title: '🔧 修复诊断（npm run verify）',
    passed: '✅ verify 全部通过，无需修复。',
    unattributed:
      '⚠️ verify 退出码非 0，但输出里没能定位到具体错误（修不修得先看清楚，请运行 `concertoai check` 看分段结论或人工查看原始输出）。',
    summaryLine:
      '共 {count} 个问题：可 lint 直修 {lint} 个 / 需要模型修复（写盘前审批）{model} 个 / 需人工 {manual} 个',
    planTitle: '💡 修复策略（最多尝试 {attempts} 次，超限转人工并保留现场）：',
    planLine: '{index}. [{stage}] {location}{code} — {action}{why}：{message}',
    moreErrors: '… 另有 {count} 条未显示（先跑 `concertoai check` 看分段结论，避免刷屏）',
    dryRunNotice: 'ℹ️  --dry-run：只诊断，未写任何文件、未执行 lint:fix、未建快照、未调用模型。',
    dryRunNext: '💡 去掉 --dry-run 即执行修复：`concertoai fix`（每次写盘都会单独征求你的同意）。',
    dryRunRunning: '[fix] 执行 npm run verify（只读诊断）…',
    verifyRunFailed: '❌ 无法执行 verify：{error}（请确认当前目录是项目根目录）',
    needsTty:
      '❌ 需要交互式终端来确认修复（编辑与命令一律审批）。先用 `concertoai fix --dry-run` 看诊断，或在 CI 中显式加 --auto-approve。',
    confirmStart:
      '即将运行 npm run verify 并尝试自动修复（最多 {attempts} 次；每次写盘都会单独确认）。继续？[y/N] ',
    cancelled: '已取消，未做任何修改。',
    approvalTitle: '🔧 即将写入：{summary}',
    approvalPrompt: '批准这次修复写盘？[y/N] ',
    noApiKey:
      'ℹ️  未提供 API Key：只执行 lint 直修，模型修复已跳过（配好 Key 后可自动修类型错误）。',
    failedHint: '❌ 已尝试 {attempts} 次仍未全部通过，转人工处理（修复无效的改动已自动回滚）。',
    sceneKept:
      '🗂  现场已保留：残留快照目录 {path}（用 `concertoai snapshot list` 查看、`concertoai snapshot clean` 清理）。',
    actionLintFix: 'lint 直修（npm run lint:fix）',
    actionModelFix: '模型修复（写盘前审批）',
    actionManual: '不自动修（转人工）',
  },
  // v5.0 T17：commit 命令（先体检 → 生成 message → 审批 → 本地提交；不碰远程）
  commit: {
    title: '📝 准备提交',
    branch: '📌 当前分支：{branch}',
    notRepo: '❌ 当前目录不是 git 仓库（找不到 .git）。',
    notRepoHint:
      '💡 先初始化仓库：`git init`，然后 `git add` 你的改动，再运行 `concertoai commit`。',
    gitMissing: '❌ 找不到 git 命令（可能未安装，或不在 PATH 里）。',
    gitMissingHint: '💡 安装 git 后重试（Windows: https://git-scm.com/download/win）。',
    conflict: '❌ 仓库正处于合并冲突中（存在 .git/MERGE_HEAD），现在提交会把冲突标记一起提交进去。',
    conflictHint: '💡 先解决冲突并对已解决的文件 `git add`，再运行 `concertoai commit`。',
    detached: '⚠️  当前处于 detached HEAD（不在任何分支上）。',
    detachedHint:
      '💡 提交后这些提交不属于任何分支，切走后容易丢；如需保留请先 `git switch -c <新分支名>`。',
    noStaged: '⚠️  暂存区是空的——没有可提交的改动。',
    noStagedHint: '💡 先 `git add <文件>`（或 `git add -A`）把改动放进暂存区。',
    untracked: 'ℹ️  还有 {count} 个未跟踪文件（当前不会被提交）。',
    addAllPrompt: '要自动执行 `git add -A` 把全部改动加入暂存区吗？[y/N] ',
    addAllNeedsTty:
      '❌ 需要交互式终端才能确认 `git add -A`（默认 N）；非交互环境请先自己 `git add` 再重试。',
    addAllSkipped: 'ℹ️  未自动暂存（默认 N）。',
    addAllDone: '✅ 已暂存 {count} 个文件。',
    addAllFailed: '❌ `git add -A` 失败：{error}',
    nothingToCommit: '没有可提交的改动，已退出（一条都没提交）。',
    checking: '[commit] 先体检（复用 concertoai check）…',
    checkPassed: '✅ 体检通过（耗时 {seconds}s）',
    checkFailed: '❌ 体检没过，本次不提交（一条都没提交）。',
    checkFailedHint: '💡 先运行 `concertoai fix` 修掉问题，再回来 `concertoai commit`。',
    costNotice: '💡 将调用模型生成 commit message（输入约 {tokens} tokens）。',
    localNotice: 'ℹ️  未调用模型（{reason}）：已按真实改动生成基础 message，请审批时核对内容。',
    localReasonNoClient: '未配置 API Key',
    localReasonModelFailed: '模型调用失败',
    localReasonModelEmpty: '模型没给出可用内容',
    messageTitle: '📝 生成的 commit message：',
    filesTitle: '📦 将提交 {count} 个文件：',
    filesMore: '  … 另有 {count} 个文件',
    diffTruncated: 'ℹ️  diff 超过 {limit} 字符，送模型时已截断（message 可能没覆盖最末尾的改动）。',
    confirmPrompt: '提交这条 message？[y/N] ',
    needsTty:
      '❌ 需要交互式终端来审批 commit message（默认 N）。非交互环境请显式加 --yes（--yes 也不会跳过体检）。',
    cancelled: '已取消，一条都没提交（暂存区保持原样）。',
    commitOk: '✅ 已提交。',
    commitOutput: '   {line}',
    commitFailed: '❌ 提交失败：{error}',
    localOnly: 'ℹ️  只做了本地提交，本次操作没有推送到任何远程仓库。',
    localSubject: 'chore: 更新 {count} 个文件',
    localEmptySubject: 'chore: 提交暂存区改动',
    localBodyPoint: '修改 {file}',
    localMore: '另有 {count} 个文件一并提交',
  },
  // v5.0 T18：review 命令（CLI 直达 9 维审查；默认审 git 改动文件，--fix 修可自动修的问题）
  review: {
    scopeChanged: '📂 审查范围：{count} 个改动文件（工作区 + 暂存区 + 未跟踪）',
    scopeTruncated:
      '  … 另有 {count} 个文件未纳入本次审查（一次最多审 {limit} 个；可显式传 path 分批审）',
    scopeGiven: '📂 审查范围：{path}',
    noChanges: 'ℹ️  没有可审查的改动（工作区 / 暂存区 / 未跟踪文件都是空的）。',
    noChangesHint: '💡 指定路径审查：`concertoai review <文件或目录>`。',
    notRepo: '❌ 当前目录不是 git 仓库，无法自动确定改动文件。',
    notRepoHint: '💡 请显式指定要审查的路径：`concertoai review src/`。',
    gitMissing: '❌ 找不到 git 命令（可能未安装，或不在 PATH 里）。',
    gitMissingHint:
      '💡 安装 git 后重试（Windows: https://git-scm.com/download/win），或直接指定路径：`concertoai review src/`。',
    invalidSeverity: '❌ 非法 severity 值: {value}。合法值: {values}',
    needsApiKey: '❌ 审查需要 API Key（9 维审查由 5 个审查子代理并行完成）。',
    needsApiKeyHint: '💡 先设置 DEEPSEEK_API_KEY，或运行 `concertoai provider auth deepseek`。',
    reviewing: '[review] 正在审查 {scope}（5 个审查子代理并行，可能要 1-2 分钟）…',
    gradingTitle: '🧮 9 维分级（A 级 = 严重 / B 级 = 中等 / C 级 = 建议）',
    dimLine: '  {dimension}：A{a} · B{b} · C{c}{evidence}',
    dimLineEmpty: '  {dimension}：无问题',
    evidence: '  证据 {locations}{more}',
    evidenceMore: ' 等 {count} 处',
    conclusionClean: '✅ 结论：无 A 级（严重）问题，可以继续（退出码 0）。',
    conclusionBlocked: '❌ 结论：{count} 个 A 级（严重）问题，先修再提交 / 合并（退出码 1）。',
    nextStep:
      '💡 下一步：`concertoai review --fix` 自动修可自动修的问题（建议级；每次写盘都会审批）；严重 / 中等级问题需你判断。',
    fixScope:
      '🔧 --fix 修复范围：可自动修的问题（建议级且能定位文件）；严重 / 中等级一律转人工，不动你的逻辑。',
    fixNoAuto: 'ℹ️  没有可自动修的问题，未做任何改动。',
    fixNeedsTty: '❌ 需要交互式终端来审批修复（编辑一律审批）；非交互环境请看完报告后人工修复。',
    fixProgress: '[review --fix] 正在修复第 {fixed}/{total} 个问题…',
    approvalTitle: '🔧 即将写入：{summary}',
    approvalPrompt: '批准这次修复写盘？[y/N] ',
    fixDone: '🔧 修复结果：已修 {fixed} 个 / 需人工 {manual} 个 / 已回滚 {rolledBack} 个。',
    fixRollbackHint: 'ℹ️  修复后体检没通过的问题已自动回滚，代码保持原样。',
  },
  // v5.0 T2：update 命令
  update: {
    checking: '🔍 正在检查更新（当前版本 {current}）…',
    upToDate: '✅ 已是最新版本（{current}），无需更新。',
    newVersion: '📦 发现新版本：{current} → {latest}',
    npxHint:
      '⚠️  当前为 npx 临时运行（未全局安装），升级到临时目录对您无意义。\n💡 请先全局安装：{command}',
    needConfirmNonTty: '提示：非交互式环境不会自动升级。如需升级请运行：{command}',
    confirmPrompt: '是否升级到 {latest}？',
    cancelled: '已取消，未做任何更改。',
    installing: '⏳ 正在安装 {latest} …',
    installOk: '✅ 已升级到 {latest}。重新运行 concertoai 生效。',
    installFailed: '❌ 安装失败：{error}',
    fetchFailed: '❌ 检查更新失败：{error}',
    manualHint: '💡 可手动升级：{command}',
  },
  // v5.0 T1：Node 版本提示（engines 要求 >= 22；不阻断，仅交互式终端提示）
  nodeVersion: {
    tooOld:
      '⚠️  当前 Node {current}，ConcertoAI 要求 {required}。本次命令仍会执行，但部分功能可能异常；如遇问题请先升级 Node。',
  },
  approval: {
    editTitle: '编辑文件',
    shellTitle: '执行命令',
    // v5.0 T6：模型切换审批（成本将上升时的确认框标题）
    modelTitle: '切换模型（成本将上升）',
    summaryEdit: '编辑文件 {path}',
    summaryShell: '执行命令: {command}',
    confirm: '批准 (y / Enter)',
    reject: '拒绝 (n / Esc)',
    // ── v5.0 T9：风险教学卡（rich 路径）。上面 6 个键是 plain 路径（v4.1.1 原貌）专用，
    //    两条路径共用 src/ui/approval-text.ts 同一套渲染函数，文案只需维护在这里。
    // ⚠️ 措辞红线：本组文案**不得出现「危险」二字**（medium 规则易误报，夸张措辞会让用户
    //    对全部提示麻木，见 ADR-040 已知局限 + ADR-041）。medium 统一用「中风险 / 建议重点关注」。
    levelTitle: {
      high: '⚠️ 高风险审批',
      medium: '🟡 中风险审批',
      low: '✅ 低风险审批',
    },
    action: {
      edit: '编辑',
      shell: '执行命令',
      model: '切换模型',
    },
    intentLabel: '操作意图：',
    intent: {
      create: '新建文件',
      modify: '局部修改（SEARCH/REPLACE）',
    },
    natureLabel: '改动性质：',
    noRiskPattern: '✅ 未检测到已知风险模式（已检查 {count} 类规则）',
    riskLabel: '风险点：',
    // medium / 易误报规则专用措辞（不是结论，只是「建议看一眼」）
    attentionLabel: '🟡 建议重点关注（中风险提示，非阻断）：',
    focusLabel: '💡 建议重点关注：第 {line} 行（{why}）',
    impactLabel: '影响面：',
    impactOk: '该文件被 {count} 个文件引用（{paths}）',
    impactOkZero: '未发现其他文件引用该文件（已扫描 {scanned} 个文件）',
    impactSkippedFiles: '，另有 {count} 个文件读取失败已跳过',
    // ⚠️ 措辞红线：未分析 ≠ 无影响。status 非 ok 时禁止出现「无影响」「0 个引用」。
    impactTimeout: '影响面未分析（超时 {ms}ms）',
    impactSkipped: '影响面未分析（项目过大，文件数超过 {maxFiles}）',
    impactError: '影响面未分析（读取失败）',
    // 第五态（T11）：低风险不做影响面扫描——如实说「没扫」，不说「项目过大」也不说「无影响」
    impactNotNeeded: '低风险改动，未做影响面扫描（仅中高风险才扫）',
    impactNotApplicable: '不适用（该操作不涉及文件引用）',
    hugeDiff: '共 {count} 行改动，风险分析已跳过（超大 diff）',
    diffFold: '… 还有 {count} 行未显示，按 v 查看完整 diff',
    diffTruncated: '… diff 已截断（共 {total} 行，仅显示前 {limit} 行）',
    diffFocusMark: ' ⚠️',
    keyApprove: '[y] 批准',
    keyReject: '[n] 拒绝（AI 将尝试更保守的方案）',
    keyExpand: '[v] 完整 diff',
    keyCollapse: '[v] 收起 diff',
    keyHelp: '[?] 说明',
    keyHelpClose: '[?] 收起说明',
    helpTitle: '这一屏在说什么',
    helpHigh: '⚠️ 高风险：命中高危规则（删除/覆盖/鉴权/密钥/越界），建议逐行看。',
    helpMedium: '🟡 中风险：命中易误报规则（超时/断言/依赖变更），只是「建议重点关注」，不是结论。',
    helpLow: '✅ 低风险：未命中已知规则；规则表覆盖有限，不代表一定安全。',
    helpSource: '规则来源：本地内置规则表（{count} 类），零模型调用、零网络、代码不上传。',
    helpDisable: '关闭方式：config.approvalInsight = "plain"（恢复 v4.1.1 原貌）。',
    helpKeys: '按键：[y] 批准 · [n] 拒绝 · [v] 展开完整 diff · [?] 收起本说明',
  },
  prompt: {
    placeholder: '输入你的需求…（Enter 发送 / Shift+Enter 换行 / Esc 退出）',
    // v5.0 T13：等待回复期间输入框是活的（否则断网时 /hints off 敲不进去），
    // 此时提交普通需求会被忽略——必须说清楚，不能静默吞掉（假按钮）。
    busyWaiting: '⏳ 正在等待模型回复…（Ctrl+C 中断；/hints off 可静音提示）',
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
    // v5.0 T9：计划进度视图文案（原先硬编码在 modals.tsx，迁到 i18n 以满足
    // 「Ink 组件内零文案字面量」的护栏要求）
    progressTitle: '执行进度 {done}/{total}',
    progressFailedSuffix: '（{failed} 失败）',
    progressStep: '步骤{index}. {title}',
  },
  // v5.0 T10：拒绝复盘记录（本地 JSONL，零上传；`concertoai reflect` + 拒绝后的提示行）
  reflect: {
    listTitle: '拒绝复盘（{count} 条，最新在前）',
    listEmpty: '暂无复盘记录。拒绝一次编辑后会自动记一条（纯本地 JSONL，零上传）。',
    listSkipped: '⚠️ 跳过 {count} 条损坏行（文件被手工编辑或写入被打断）',
    listHint: '清空：concertoai reflect clear　·　关闭记录：concertoai config set reflections off',
    colTime: '时间',
    colLevel: '级别',
    colFile: '文件',
    colCategories: '风险类别',
    levelHigh: '⚠️ 高',
    levelMedium: '🟡 中',
    levelLow: '✅ 低',
    // 未分析 ≠ 低风险（与审批卡同一套措辞红线）
    levelUnknown: '— 未分析',
    noFile: '—',
    noCategories: '—',
    clearConfirm: '确定清空全部复盘记录？（y/N）',
    clearCanceled: '已取消，复盘记录未变更。',
    clearEmpty: '复盘记录本来就是空的，无需清空。',
    clearNeedsYes: '❌ 非交互环境需显式加 --yes 才能清空（避免脚本误删复盘历史）。',
    cleared: '✅ 已清空复盘记录：{path}',
    clearFailed: '❌ 清空失败：{message}',
    unknownAction: '未知 reflect 子命令: {action}（支持 list / clear）',
    usage: '用法: concertoai reflect list [--limit 20] | concertoai reflect clear [--yes]',
    limitInvalid: '⚠️ --limit 需为正整数，已按默认 {limit} 处理',
    // App 拒绝后的提示行（G8：只提示本地，绝不暗示上传）
    recorded:
      '📝 已记录到本地复盘（concertoai reflect list 查看，concertoai config set reflections off 可关闭）',
    recordFailed: '📝 复盘记录写入失败（已忽略，不影响审批结果）',
  },
  // v5.0 T12：场景提示（M3 场景可发现）。渲染在输入框上方单行灰字：
  // 不弹框、不进消息流、不打断流式；命令必须完整可直接复制执行（禁占位符）。
  hints: {
    missingProjectRules:
      '💡 这个项目还没有规则文件，concertoai init 可以生成 AGENTS.md（给 AI）+ PROJECT_GUIDE.md（给你）',
    repeatedVerifyFailure:
      '💡 构建或测试连续 2 轮没通过，可以让 AI 尝试自动定位并修复（失败会自动回滚）',
    // {file} 由引擎填充为具体文件路径；路径含空格时引擎会降级到下面那条文案
    repeatedEditRejection:
      '💡 你已经连续 2 次拒绝 {file} 的改动，可以让 Reviewer Agent 全面扫一遍再重试',
    // 拿不到可用文件路径时的降级文案（配合 `/review` auto 模式，不含占位符）
    repeatedEditRejectionNoFile:
      '💡 你已经连续 2 次拒绝了 AI 的改动，可以让 Reviewer Agent 扫一遍最近修改的文件再重试',
  },
  // v5.0 T13：`/hints` 斜杠命令（会话内静音 / 恢复 / 查看状态）
  hintsCmd: {
    off: '🔇 已关闭场景提示（仅本次会话）。恢复：/hints on　·　永久关闭：concertoai config set hints off',
    on: '💡 已开启场景提示（很克制：每会话最多 3 条，同一条 10 分钟内不重复）',
    statusOn: '💡 场景提示：已开启（每会话最多 {max} 条，同一条 {minutes} 分钟内不重复）',
    statusOff: '🔇 场景提示：已关闭（恢复：/hints on）',
    usage: '用法：/hints on | /hints off | /hints status',
    unknownAction: '未知 hints 子命令：{action}（支持 on / off / status）',
  },
  // v5.0 T21：`/metrics` 斜杠命令（本地指标开关，默认 off、零上传）
  metricsCmd: {
    on: '📊 已开启本地指标（仅本次会话）。永久开启：concertoai config set metrics on　·　查看汇总：concertoai doctor --metrics',
    off: '📊 已关闭本地指标（仅本次会话，已有数据不动）。永久关闭：concertoai config set metrics off',
    statusOn:
      '📊 本地指标：已开启（只写本机 {path}，零上传；汇总：concertoai doctor --metrics；清空：/metrics clear）',
    // v5.0 T21：关闭态也给出文件位置——`/metrics status` 的契约是「开着没 + 文件在哪 +
    // 怎么汇总」，关了反而更需要知道文件在哪（要清空 / 要确认没在偷偷写）
    statusOff:
      '📊 本地指标：已关闭（文件位置：{path}，未开启时不写盘；开启：/metrics on；永久开启：concertoai config set metrics on）',
    cleared: '✅ 已清空本地指标（清掉 {count} 条）',
    clearedEmpty: '本地指标本来就是空的，无需清空。',
    clearFailed: '❌ 清空本地指标失败：{message}',
    usage: '用法：/metrics on | /metrics off | /metrics status | /metrics clear',
    unknownAction: '未知 metrics 子命令：{action}（支持 on / off / status / clear）',
  },
  // v5.0 T21：`doctor --metrics` 汇总（近 100 条；没数据就说没数据，不打印一堆 0%）
  metrics: {
    title: '本地体验指标',
    enabled: '已开启（本地 JSONL，零上传）',
    disabled: '未开启（默认关闭；开启：concertoai config set metrics on）',
    fileLine: '存储位置：{path}',
    empty: '暂无指标数据（开启后随使用自动累积）',
    skipped: '⚠️ 跳过 {count} 条损坏行（文件被手工编辑或写入被打断）',
    approvalLine: '审批：{count} 次 ｜ 平均 {avg}ms ｜ 中位 {median}ms ｜ 拒绝率 {rate}',
    suggestionLine:
      '提示：{count} 条 ｜ 可观测 {observed} 条 ｜ 采纳率 {rate}（无法观测 {unobservable} 条）',
    suggestionLineUnobservable: '提示：{count} 条 ｜ 采纳率无法评估（这份数据里没有可观测的行为）',
    checkLine: '体检：{count} 次 ｜ 通过率 {rate}',
    verbLine: '动词使用：{list}',
    noVerbs: '—',
  },
  balance: {
    available: '账户可用',
    unavailable: '账户不可用',
    empty: '无余额信息',
    line: '💰 余额：{symbol}{total}',
    // v5.0 T7：当前时段真实单价（高峰/空闲标注）
    priceTier:
      '📊 当前{model} {tier}：输入 ¥{input}/百万 · 缓存命中 ¥{cacheHit}/百万 · 输出 ¥{output}/百万',
    // v5.0 T7 修订：未配置节假日表时的如实提示（不静默算错）
    holidayNotConfigured:
      'ℹ️ 未配置法定节假日表（config.pricingHolidays）：节假日与调休日仍按「周一~周五 9-12 / 14-18」判断，可能显示错误档位。',
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
    // v5.0 T14：首屏精简——分层只留「快速开始 → 常用 → 交互 → 高级折叠」，
    // 不再平铺命令清单（21 条平铺实测 46 行，新手直接被淹没）。
    fastStart: '快速开始（3 步）',
    fast1: '  ① 检查环境    concertoai doctor',
    fast2: '  ② 生成规则    concertoai init      （生成 AGENTS.md 给 AI + PROJECT_GUIDE.md 给你）',
    fast3: '  ③ 开始对话    concertoai chat      （或直接 concertoai；/help 看斜杠命令）',
    common: '常用命令',
    commonHint: '（完整清单：concertoai --help --all）',
    slash: '交互（chat 内以 / 开头）',
    slashPlan: '先生成计划再执行',
    slashReview: '代码审查（可指定文件）',
    slashWorkflow: '运行工作流',
    slashHints: '场景提示开关（on / off / status）',
    advanced: '高级',
    advancedHint: '  以上命令均可用 concertoai <命令> --help 查看详细用法',
  },
} as const;

export type ZhDict = typeof zh;

/** 占位符替换：fmt('模型调用失败：{message}', { message: 'x' }) → '模型调用失败：x'；缺失参数保留原样。 */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}
