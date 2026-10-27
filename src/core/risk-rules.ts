/**
 * 审批风险评估规则表（v5.0 T8，**纯本地、零模型调用、零网络**）。
 *
 * ## 设计原则：先精不先全，宁可漏报不可误报（R2）
 *
 * 误报会让用户对提示麻木（狼来了）——一旦「每次都报风险」，用户就会无条件按 y，
 * 那时提示比不提示更糟（给了安全错觉）。因此：
 * - 每条规则都必须能说清「为什么这是风险」+「该看哪一行」；
 * - 拿不准的一律降级或加 `negativePatterns` 排除，**不许为了覆盖率硬报**；
 * - 命中在注释里的代码（`// rm -rf` 只是说明）不算风险。
 *
 * ## Windows/跨平台红线（W1-W10，改动前必读）
 *
 * - **W2 行尾**：diff 行可能带 `\r`，匹配前统一剥离（`normalizeDiffLine`），否则 `$` 锚点失效；
 * - **W7 BOM**：首行可能带 `\uFEFF`，剥离后再匹配；
 * - **W9 注释判定**：只认**行首**的 `//`、`*`、`#`——`const u = "https://x"` 不是注释行；
 * - **W8 防 ReDoS**：禁用嵌套量词（`.*.*`），单条正则保持简单；配合 `prefilter` 子串粗筛，
 *   10 万字符长行也不会爆；
 * - **禁止动态 `new RegExp`**：规则表全部字面量正则（避免 `lastIndex` 残留坑）。
 *
 * 所有导出均为纯函数/常量，无 IO、无副作用。
 */

/** 风险等级。 */
export type RiskLevel = 'high' | 'medium' | 'low';

/** 命中位置：新增行（AI 加了什么）/ 删除行（AI 删了什么）。 */
export type DiffSide = 'added' | 'removed';

/** 规则作用面。 */
export type RuleTarget = 'added' | 'removed' | 'both';

/** 一条风险规则。 */
export interface RiskRule {
  /** 规则标识（稳定，可被 config `riskRules.disabled` 关闭）。 */
  id: string;
  /** 人类可读类别（进「改动性质」）。 */
  category: string;
  /** 默认风险等级。 */
  level: RiskLevel;
  /** 作用面：只看新增行 / 只看删除行 / 两者都看。 */
  target: RuleTarget;
  /** 命中特征（字面量正则，禁止动态构造）。 */
  patterns: RegExp[];
  /** 排除条件：命中任一即不算风险（如注释行、mock 文件）。 */
  negativePatterns?: RegExp[];
  /**
   * 子串粗筛（小写）：先 `includes` 粗筛再跑正则，长行/大 diff 下避免逐条正则扫描。
   * 缺省表示直接跑正则（仅用于特征极短、正则本身很廉价的规则）。
   */
  prefilter?: string[];
  /** 一句人话：为什么这是风险。 */
  why: string;
  /** 一句建议：该重点看什么。 */
  suggestion: string;
  /** 改动性质的措辞（用于「改动性质：替换网络超时逻辑」）；缺省用 `category`。 */
  nature?: string;
}

/** 一条风险命中。 */
export interface RiskHit {
  /** 规则标识。 */
  ruleId: string;
  /** 人类可读类别。 */
  category: string;
  level: RiskLevel;
  side: DiffSide;
  /** 命中行原文（已 trimEnd）。 */
  line: string;
  /** 命中行在 diff 中的下标（0 基；供 UI 打 ⚠️）。 */
  diffLineIndex: number;
  why: string;
  suggestion: string;
}

/** 等级排序权重（high 最大；用于「总风险等级 = max」与命中排序）。 */
export const RISK_LEVEL_WEIGHT: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };

/** 去掉行尾 `\r`（W2）与首行 BOM（W7）。 */
export function normalizeDiffLine(line: string, index = 0): string {
  let out = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (index === 0 && out.startsWith('\uFEFF')) {
    out = out.slice(1);
  }
  return out;
}

/**
 * 是否为「整行注释」（W9：只认行首，`https://` 不算）。
 *
 * 覆盖 `//`、`/*`、`*`（块注释续行）、`#`（shell/yaml/py 注释）。
 */
export function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*|#)/.test(line);
}

/**
 * 规则表（15 条；≥14 满足 T8 验收）。
 *
 * 顺序即「同类命中时的展示优先级」，无功能依赖。
 */
export const RISK_RULES: readonly RiskRule[] = [
  {
    id: 'dangerous-delete',
    category: '删除/破坏性操作',
    nature: '删除文件或递归删除',
    level: 'high',
    target: 'added',
    prefilter: ['rm -rf', 'unlink', 'rmdir', 'fs.rm', 'removeall'],
    patterns: [/rm\s+-rf\b/i, /\bunlink\s*\(/i, /\brmdir\s*\(/i, /\.rm\s*\(/i],
    negativePatterns: [/recursive:\s*false/i],
    why: '新增了删除文件/目录的操作，误删后无法恢复',
    suggestion: '确认删除路径是变量还是写死、有没有前置校验',
  },
  {
    id: 'destructive-write',
    category: '覆盖写',
    nature: '覆盖写入文件/表',
    level: 'high',
    target: 'added',
    prefilter: ['writefile', 'truncate', 'drop table', 'writefilesync'],
    patterns: [
      /writeFile(Sync)?\s*\(/i,
      // 自动初始化/脚手架里的「对象形态写文件」（`writeFile: { file: 'tsconfig.json', … }`）——
      // 实测漏报（fixtures/approval/23-preflight-auto-writefile.diff）：这类改动会**自动往用户
      // 项目里写配置文件**，与函数调用形态同样有覆盖风险。
      // 限定 `: { file:` 三段相邻，避免把类型声明（`writeFile?: { … }`）也算成风险。
      /\bwriteFile(Sync)?\s*:\s*\{\s*file\s*:/i,
      /\btruncate\b/i,
      /drop\s+table/i,
    ],
    negativePatterns: [/flag:\s*'a'/i, /{\s*flag:\s*'a'/i],
    why: '覆盖写会丢失原内容，且不经确认不可逆',
    suggestion: '确认目标文件是否允许被整体覆盖（还是应追加/局部修改）',
  },
  {
    // 顺序说明：db-mutation 必须排在 state-deletion 之前——`DELETE FROM t` 会同时命中
    // state-deletion 的 `/delete\s+\w+/`，而「数据库写」是更具体、更有指导性的判断
    // （一行只报第一条命中规则，见 analyzeDiff 的 break）。同类「更具体优先」下同。
    id: 'db-mutation',
    category: '数据库写操作',
    nature: '写入/修改数据库',
    level: 'high',
    target: 'added',
    prefilter: ['delete from', 'update ', 'insert into', 'create table', 'alter table'],
    patterns: [
      /delete\s+from/i,
      /update\s+\w+\s+set/i,
      /insert\s+into/i,
      /(create|alter)\s+table/i,
    ],
    why: '数据库写操作可能影响真实数据，且难以回滚',
    suggestion: '确认是否有 WHERE 条件、是否在事务内、是否需要备份',
  },
  {
    id: 'state-deletion',
    category: '状态删除',
    nature: '删除或清空状态',
    level: 'high',
    target: 'both',
    prefilter: ['delete ', '.splice(', '.clear(', 'reset('],
    patterns: [/\bdelete\s+\w+/i, /\.splice\s*\(/i, /\.clear\s*\(\s*\)/i, /\breset\s*\(/i],
    why: '删除/清空状态可能导致用户数据或运行时上下文丢失',
    suggestion: '确认删除后是否有恢复路径、是否影响已持久化的数据',
  },
  {
    id: 'auth-change',
    category: '鉴权/权限',
    nature: '改动鉴权或权限逻辑',
    level: 'high',
    target: 'both',
    prefilter: ['auth', 'permission', 'role', 'jwt', 'isadmin', 'canaccess', 'session'],
    patterns: [
      /\bauth\w*/i,
      /\bpermission\w*/i,
      /\brole\w*/i,
      /\bjwt\b/i,
      /\bisAdmin\b/i,
      /\bcanAccess\b/i,
    ],
    // 仅 import 引入模块不改逻辑 → 不算（避免「引入 auth 工具就报高风险」）
    negativePatterns: [/^\s*import\b/, /^\s*\}\s*from\b/, /^\s*from\b/],
    why: '鉴权/权限逻辑一旦放宽，等于把受保护能力开放出去',
    suggestion: '确认判断方向没有取反（`允许` vs `拒绝`）、失败路径仍是拒绝',
  },
  {
    id: 'secret-hardcode',
    category: '密钥/凭据',
    nature: '引入密钥或凭据',
    level: 'high',
    target: 'added',
    prefilter: ['sk-', 'apikey', 'api_key', 'password', 'secret', 'token ='],
    patterns: [
      /sk-[A-Za-z0-9]{8,}/,
      /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
      /password\s*[:=]\s*['"][^'"]+['"]/i,
      /secret\s*[:=]\s*['"][^'"]+['"]/i,
    ],
    // 读环境变量 / 空串 / 占位符 → 不是硬编码
    negativePatterns: [
      /process\.env/i,
      /[:=]\s*['"]\s*['"]/,
      /['"](?:your|xxx|<|\.\.\.|placeholder|example)/i,
      /['"]sk-\*+['"]/,
    ],
    why: '硬编码密钥会进版本库与日志，泄露后需全量轮换',
    suggestion: '确认密钥是否应从环境变量/密钥管理读取',
  },
  {
    id: 'network-timeout',
    category: '网络请求/超时',
    nature: '改动网络请求或超时',
    level: 'medium',
    target: 'both',
    // ⚠️ prefilter 必须覆盖下面每条 pattern 的**字面特征**，否则 pattern 永远跑不到：
    // `maxRetries` 不含子串 `retry`（是 retries），只写 'retry' 会把新加的 maxRetries 规则变成死代码。
    prefilter: [
      'fetch(',
      'timeout',
      'retry',
      'retries',
      'maxretries',
      'abortcontroller',
      'axios',
      'http.request',
    ],
    patterns: [
      /\bfetch\s*\(/i,
      /http\.request/i,
      /\baxios\b/i,
      /\btimeout\b/i,
      // ⚠️ `/\btimeout\b/` 匹配不到 `setTimeout(...)`（`T` 前是词字符 `t`，无边界）——
      // 而「把 5000 改成 10000」正是最常见的超时改动写法（实测基准里漏报过）
      /set(?:Timeout|Interval)\s*\(/i,
      // ⚠️ 裸 `/\bretry\b/i` 会命中英文**文案**（实测误报：`'… then retry.'` 这类 i18n 字符串），
      // 且「retry」在注释/提示语里太常见。只认代码形态：`retry: 3` / `retries = 2` / `retry(` / `maxRetries`。
      /\bretr(?:y|ies)\b\s*[:(=]/i,
      /\bmaxRetries\b/i,
      /AbortController/i,
    ],
    negativePatterns: [/^\s*\/\//, /^\s*\*/],
    why: '超时/重试参数变化会改变失败时的行为（过久卡住、过短误判）',
    suggestion: '确认超时值变化方向与失败重试次数是否与预期一致',
  },
  {
    id: 'silent-catch',
    category: '静默吞错',
    nature: '吞掉异常不处理',
    level: 'medium',
    target: 'added',
    prefilter: ['catch'],
    patterns: [/catch\s*\{\s*\}/, /catch\s*\(\s*_?\w*\s*\)\s*\{\s*\}/, /\?\?\s*undefined/],
    // 空的 catch 后面紧接 throw / 打日志 → 不是静默吞错
    negativePatterns: [/\bthrow\b/, /console\.(error|warn)/, /logger\./],
    why: '空 catch 会把错误吞掉，故障现场消失、排查成本转移到线上',
    suggestion: '确认这里是否应该至少记录日志或向上抛出',
  },
  {
    id: 'error-branch-removal',
    category: '错误分支删除',
    nature: '删除错误处理分支',
    level: 'high',
    target: 'removed',
    prefilter: ['throw', 'catch', 'reject(', 'return err'],
    patterns: [/\bthrow\b/, /\bcatch\b/, /\breject\s*\(/i, /return\s+err/i],
    why: '删掉错误分支后，异常将不再被处理（可能静默失败或崩溃）',
    suggestion: '确认这条错误处理是被移到别处，还是真的不需要了',
  },
  {
    id: 'concurrency',
    category: '并发/锁',
    nature: '改动并发或锁',
    level: 'medium',
    target: 'both',
    prefilter: ['lock', 'mutex', 'semaphore', 'promise.all', 'setinterval', 'worker'],
    patterns: [
      /\block\b/i,
      /\bmutex\b/i,
      /\bsemaphore\b/i,
      /Promise\.all/i,
      /setInterval\s*\(/i,
      /\bworker\b/i,
    ],
    why: '并发/锁相关改动容易引入竞态或死锁，且问题复现不稳定',
    suggestion: '确认加锁范围是否覆盖全部共享状态访问、有无死锁顺序反转',
  },
  {
    id: 'config-env',
    category: '配置/环境变量',
    nature: '改动配置或环境变量',
    level: 'medium',
    target: 'added',
    prefilter: ['process.env'],
    patterns: [/process\.env\.\w+/],
    negativePatterns: [/^\s*import\b/, /^\s*\/\//],
    why: '新增环境变量依赖，未配置时可能取到 undefined 而走异常分支',
    suggestion: '确认该 env 有默认值或缺失时给出可读报错',
  },
  {
    id: 'fs-boundary',
    category: '文件系统越界',
    nature: '涉及路径拼接/越界写',
    level: 'high',
    target: 'added',
    // W1：`../` 与 Windows 的 `..\` **两种写法都必须命中**——只写 `\/` 会让
    // 反斜杠路径（Windows 用户最常见写法）完全逃过检测，这是 v4.1.1 踩过的同类坑
    prefilter: ['../', '..\\', 'path.resolve', 'path.join'],
    patterns: [/\.\.[\\/]/, /path\.resolve\s*\(/i, /path\.join\s*\([^)]*\.\./i],
    negativePatterns: [
      // 在沙箱包裹内（resolveSafe）→ 已有越界防护
      /resolveSafe\s*\(/,
      // ⚠️ 模块 import 路径里的 `../` 完全正常，**不是**文件系统越界。
      // 实测（scripts/verify-false-positive.mjs，40 段真实 hunk）：fs-boundary 的
      // 5 条命中**全部**是 `import … from '../core/x'` 这类误报，且都是 high 级——
      // high 级误报最伤信任（狼来了），必须收窄。
      // 只排除「specifier 是字符串字面量」的形态；`await import(path.join('..', x))`
      // 这类真正的动态拼接仍会命中（真风险不能一起放过）。
      /^\s*(?:import|export)\b.*\bfrom\s+['"]/,
      /^\s*\}\s*from\s+['"]/,
      /^\s*from\s+['"]/,
      /^\s*(?:import|export)\s+['"]/,
      /\brequire\s*\(\s*['"]/,
    ],
    why: '用户/模型可控路径拼接可能越界访问沙箱外文件',
    suggestion: '确认路径经过沙箱校验（resolveSafe），未被外部输入直接拼接',
  },
  {
    id: 'dependency-change',
    category: '依赖变更',
    nature: '调整依赖版本',
    level: 'medium',
    target: 'both',
    // ⚠️ prefilter 必须覆盖**全部 pattern 的字面特征**，否则 pattern 成死代码（同 network-timeout 的坑）：
    // 旧值 `['": "^', '": "~']` 只覆盖「带引号的键」，导致无引号键形态（`zod: "~1.2"`）永远过不了粗筛，
    // 形态② 实测从未生效。收成 `': "'`（冒号 + 空格 + 引号）即可覆盖 ①②③，且仍能挡掉绝大多数普通代码行。
    prefilter: ['"dependencies"', '"devdependencies"', ': "'],
    patterns: [
      // ⚠️ W8 实测教训（scripts/bench-approval.mjs，10 万字符长行）：
      // 旧写法 `['"]?\w[\w-]*['"]?\s*:\s*['"][\^~><=]*\d+\.\d+` 的 `\w[\w-]*` 是**无界**量词，
      // 在长标识符上每个起点都要贪到行尾再逐字回溯 → 退化为 O(n²)，实测单条规则 **1766ms**
      // （预算 20ms，超 88 倍，直接踩 W8 ReDoS 红线，审批会卡死用户终端）。
      // 修法：把键长收成**上界**，并让起点靠 `["']` / `\b` 定位（长串内部每个位置立刻失败）→ 线性。
      // 形态①：package.json 真实形态（键与版本号都带引号）
      /["'][\w@/.-]{1,40}["']\s*:\s*["'][\^~><=]*\d+\.\d+/,
      // 形态②：无引号键（JS 对象字面量 / 文本形态）；`\b` 使长标识符内部每个起点 O(1) 失败
      /\b[\w-]{1,40}\s*:\s*["'][\^~><=]*\d+\.\d+/,
      // 形态③：依赖段整体出现（`"dependencies": {` / `"devDependencies": {`）
      /"(?:dev)?[dD]ependencies"\s*:/,
    ],
    // 工具类 devDependencies（不影响运行时）→ 降级由 level 调整，这里不整条排除
    why: '依赖版本变化可能引入破坏性变更或隐式升级',
    suggestion: '确认版本范围是否被放宽（如 ^ → *），以及是否有 lockfile 一并更新',
  },
  {
    id: 'test-assertion-change',
    category: '测试断言弱化',
    nature: '改动测试断言',
    level: 'medium',
    target: 'removed',
    prefilter: ['expect(', 'tobe', 'tothrow', 'assert'],
    patterns: [/\bexpect\s*\(/, /\.toBe\w*\s*\(/, /\.toThrow\w*\s*\(/, /\bassert\b/],
    why: '删除断言等于降低测试保护力度，回归可能悄悄发生',
    suggestion: '确认断言是被移到别处，还是为了让测试通过而被删',
  },
  {
    id: 'process-exit',
    category: '进程退出',
    nature: '新增进程退出',
    level: 'medium',
    target: 'added',
    prefilter: ['process.exit'],
    patterns: [/process\.exit\s*\(/],
    why: '新增的进程退出会让调用方（库使用者/上层命令）被强制中断',
    suggestion: '确认是否应改抛异常或用退出码而非直接 exit',
  },
];

/** 按 id 取规则（未知返回 undefined）。 */
export function getRiskRule(id: string): RiskRule | undefined {
  return RISK_RULES.find((rule) => rule.id === id);
}

/**
 * 过滤规则表：`disabled` 中的 id 被移除（config `riskRules.disabled` 消费）。
 *
 * 未知 id 静默忽略（用户可能写了旧版本规则名，不该因此报错崩溃）。
 */
export function activeRiskRules(disabled?: readonly string[]): readonly RiskRule[] {
  if (disabled === undefined || disabled.length === 0) {
    return RISK_RULES;
  }
  const off = new Set(disabled);
  return RISK_RULES.filter((rule) => !off.has(rule.id));
}
