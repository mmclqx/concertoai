/**
 * `concertoai doctor` 命令：环境诊断，含 DeepSeek 账户余额显示。
 *
 * 逐项检查（单项失败不中断，全部执行完再汇总退出码）：
 * 1. Node.js 版本 / 平台
 * 2. DEEPSEEK_API_KEY 是否设置（不泄露内容）
 * 3. 配置文件 ~/.concertoai/config.json 可读性（区分不存在/损坏）
 * 4. 会话目录可写性（mkdir + 探测文件写入后删除）
 * 5. 模型表是否可加载
 * 6. 账户余额（有 key 时查询，展示总额/赠送/充值）
 *
 * 任一 ❌ 项存在 → 返回 1；全部 ✅ → 返回 0。
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fetchBalance } from '../balance';
import {
  defaultMetricsPath,
  readMetrics,
  SUMMARY_WINDOW,
  summarizeMetrics,
} from '../core/metrics-store';
import { fmt, t } from '../i18n';
import { listModels } from '../model/models';
import { listOllamaModels } from '../model/providers/ollama';
import { detectComplexity, recommendProvider } from '../model/recommend';
import { getActiveAccount, getApiKeyFor, listAccounts } from '../store/accounts';
import { checkMigrationIntegrity } from '../store/migration';
import { configPath, sessionsDir } from '../store/paths';
import { type ApiKeySource, maskApiKey } from './common';
import { formatMetricsSummary, resolveMetricsEnabled } from './metrics';
import {
  defaultVscodeHealthEnv,
  detectAiExtensions,
  detectCrashDumps,
  diagnoseVscodeProcesses,
  type VscodeHealthEnv,
  verifyArgvJson,
} from './vscode-health';

/** doctor 命令选项。 */
export interface DoctorCommandOptions {
  /** DeepSeek API Key；undefined = 未设置（余额项标记跳过）。 */
  apiKey?: string;
  /** Key 来源（v3.1 M3）：env / account 等；余额行标注账号。 */
  keySource?: ApiKeySource;
  /** source=account 时的账号名。 */
  keyAccountName?: string;
  /** API 基础地址（测试注入）。 */
  baseUrl?: string;
  /** fetch 实现（测试注入）。 */
  fetchImpl?: typeof fetch;
  /** 配置文件路径（测试注入；默认 ~/.concertoai/config.json）。 */
  configPath?: string;
  /** 会话目录（测试注入；默认 ~/.concertoai/sessions）。 */
  sessionDir?: string;
  /** accounts 根目录（v3.2 M4 / T4.4 账号完整性检查；测试注入；默认 ~/.concertoai/accounts）。 */
  accountsRoot?: string;
  /** 是否输出 VS Code 健康诊断（v3.4 M3 / doctor --vscode）。 */
  vscode?: boolean;
  /** VS Code 健康诊断环境（测试注入样本；默认生产环境）。 */
  vscodeEnv?: VscodeHealthEnv;
  /** 当前工作目录（v4.0 M3 T3.2 模型推荐复杂度检测；默认 process.cwd()）。 */
  cwd?: string;
  /** 预算档位（v4.0 M3 T3.2 模型推荐；low / medium / high；默认 medium）。 */
  budget?: 'low' | 'medium' | 'high';
  /** 是否输出本地指标汇总（v5.0 T21 / `doctor --metrics`）。 */
  metrics?: boolean;
  /** 指标文件路径（测试注入；默认 ~/.concertoai/metrics.jsonl）。 */
  metricsFile?: string;
  /** 指标开关（测试注入；默认走 `resolveMetricsEnabled` = config + 环境变量）。 */
  metricsEnabled?: boolean;
}

interface Diagnostic {
  ok: boolean;
  lines: string[];
}

function diagnoseApiKey(
  apiKey: string | undefined,
  source: ApiKeySource | undefined,
  accountName: string | undefined,
): Diagnostic {
  const dict = t().doctor;
  if (apiKey === undefined || apiKey === '') {
    return { ok: false, lines: [`${dict.fail} ${dict.apiKeyLabel}: ${dict.apiKeyMissing}`] };
  }
  // v3.1 M3 T3.3：标注 Key 来源（环境变量优先 / 账号），不泄露完整 Key
  let note = '';
  if (source === 'env') {
    note = '（环境变量优先）';
  } else if (source === 'account' && accountName !== undefined) {
    note = `（账号: ${accountName} ${maskApiKey(apiKey)}）`;
  }
  return { ok: true, lines: [`${dict.ok} ${dict.apiKeyLabel}: ${dict.apiKeySet}${note}`] };
}

async function diagnoseConfig(cfgPath: string): Promise<Diagnostic> {
  const dict = t().doctor;
  try {
    const raw = await readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
    const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : '?';
    return {
      ok: true,
      lines: [
        `${dict.ok} ${dict.configLabel}: ${fmt(dict.configOk, {
          path: cfgPath,
          version: String(version),
        })}`,
      ],
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: true,
        lines: [`${dict.ok} ${dict.configLabel}: ${fmt(dict.configMissing, { path: cfgPath })}`],
      };
    }
    return {
      ok: false,
      lines: [
        `${dict.fail} ${dict.configLabel}: ${fmt(dict.configBroken, {
          path: cfgPath,
          message: err instanceof Error ? err.message : String(err),
        })}`,
      ],
    };
  }
}

async function diagnoseSessionDir(dir: string): Promise<Diagnostic> {
  const dict = t().doctor;
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-probe-${process.pid}`);
    await writeFile(probe, '', 'utf8');
    await rm(probe, { force: true });
    return {
      ok: true,
      lines: [`${dict.ok} ${dict.sessionDirLabel}: ${fmt(dict.sessionWritable, { path: dir })}`],
    };
  } catch (err) {
    return {
      ok: false,
      lines: [
        `${dict.fail} ${dict.sessionDirLabel}: ${fmt(dict.sessionNotWritable, {
          path: dir,
          message: err instanceof Error ? err.message : String(err),
        })}`,
      ],
    };
  }
}

function diagnoseModels(): Diagnostic {
  const dict = t().doctor;
  const models = listModels();
  if (models.length === 0) {
    return { ok: false, lines: [`${dict.fail} ${dict.modelsLabel}: ${dict.modelsEmpty}`] };
  }
  const ids = models.map((m) => m.id).join(' / ');
  return {
    ok: true,
    lines: [
      `${dict.ok} ${dict.modelsLabel}: ${fmt(dict.modelsCount, {
        count: String(models.length),
        ids,
      })}`,
    ],
  };
}

/**
 * 账号完整性检查（v3.2 M4 / T4.4）：
 * - 无 active 指针 → ok（尚未登录，提示可运行 login）；
 * - active 指针指向账号且 config.json 可读 → ok；
 * - 指针指向缺失/损坏账号 → fail（给出可复制的修复命令）。
 */
async function diagnoseAccounts(accountsRoot: string | undefined): Promise<Diagnostic> {
  const dict = t().doctor;
  const active = await getActiveAccount(accountsRoot);
  if (active === undefined) {
    return { ok: true, lines: [`${dict.ok} ${dict.accountsLabel}: ${dict.accountNoActive}`] };
  }
  const names = await listAccounts(accountsRoot);
  if (!names.includes(active)) {
    return {
      ok: false,
      lines: [`${dict.fail} ${dict.accountsLabel}: ${fmt(dict.accountBroken, { name: active })}`],
    };
  }
  try {
    await getApiKeyFor(active, accountsRoot);
    return {
      ok: true,
      lines: [`${dict.ok} ${dict.accountsLabel}: ${fmt(dict.accountOk, { name: active })}`],
    };
  } catch {
    return {
      ok: false,
      lines: [`${dict.fail} ${dict.accountsLabel}: ${fmt(dict.accountBroken, { name: active })}`],
    };
  }
}

async function diagnoseBalance(options: DoctorCommandOptions): Promise<Diagnostic> {
  const dict = t().doctor;
  if (options.apiKey === undefined || options.apiKey === '') {
    return { ok: false, lines: [`${dict.fail} ${dict.balanceLabel}: ${dict.balanceSkipped}`] };
  }
  try {
    const balance = await fetchBalance(options.apiKey, {
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    const status = balance.is_available ? dict.balanceAvailable : dict.balanceUnavailable;
    // v3.1 M3 T3.3：余额行标注使用的账号（如 账号: work (sk-****abcd)）
    const accountNote =
      options.keySource === 'account' && options.keyAccountName !== undefined
        ? `（账号: ${options.keyAccountName} ${maskApiKey(options.apiKey)}）`
        : options.keySource === 'env'
          ? '（环境变量优先）'
          : '';
    const lines = [`${dict.money} ${dict.balanceLabel}: ${status}${accountNote}`];
    for (const info of balance.balance_infos) {
      lines.push(
        `${dict.money}   ${fmt(dict.balanceEntry, {
          currency: info.currency,
          total: info.total_balance,
          granted: info.granted_balance,
          toppedUp: info.topped_up_balance,
        })}`,
      );
    }
    return { ok: true, lines };
  } catch (err) {
    return {
      ok: false,
      lines: [
        `${dict.fail} ${dict.balanceLabel}: ${fmt(dict.balanceFailed, {
          message: err instanceof Error ? err.message : String(err),
        })}`,
      ],
    };
  }
}

/** 项目复杂度检测（v4.0 M3 T3.2）：顶层条目数 + package.json 依赖数 → 启发式档位。 */
async function detectProjectComplexity(cwd: string): Promise<{
  complexity: ReturnType<typeof detectComplexity>;
  fileCount: number;
  dependencyCount: number;
}> {
  let fileCount = 0;
  let dependencyCount = 0;
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    fileCount = entries.length;
    // package.json 依赖数（dependencies + devDependencies）
    try {
      const pkgRaw = await readFile(path.join(cwd, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      dependencyCount =
        Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    } catch {
      // 无 package.json → 依赖数 0
    }
  } catch {
    // cwd 不可读 → 视为 small
  }
  return {
    complexity: detectComplexity({ fileCount, dependencyCount }),
    fileCount,
    dependencyCount,
  };
}

/** 模型推荐诊断（v4.0 M3 T3.2）：复杂度 + 预算 + 本地 Ollama → 推荐组合 + 月成本。 */
async function diagnoseRecommend(options: DoctorCommandOptions): Promise<Diagnostic> {
  const dict = t().doctor;
  const cwd = options.cwd ?? process.cwd();
  const { complexity } = await detectProjectComplexity(cwd);
  // 本地 Ollama 探测（失败 → 未推荐本地模型，降级提示）
  const localModels = await listOllamaModels({ fetchImpl: options.fetchImpl });
  const localAvailable = localModels.length > 0;
  const result = recommendProvider({
    complexity,
    budget: options.budget ?? 'medium',
    localAvailable,
  });
  const reasonKey = `recommendReason${result.reason.charAt(0).toUpperCase()}${result.reason.slice(1)}`;
  const reason = (dict as unknown as Record<string, string>)[reasonKey] ?? result.reason;
  const lines = [
    `${dict.money} ${dict.recommendLabel}: ${fmt(dict.recommendLine, {
      provider: result.provider,
      model: result.model,
      monthlyCost: result.monthlyCost.toFixed(2),
      reason,
    })}`,
  ];
  if (!localAvailable) {
    lines.push(`  ${dict.recommendLocalUnavailable}`);
  }
  // ok 恒为 true（推荐是建议性信息，不阻塞退出码）
  return { ok: true, lines };
}

/** 配置迁移完整性诊断（v4.0 M3 T3.5）：迁移成功 / 备份存在 / 会话兼容 / 幂等。 */
async function diagnoseMigration(options: DoctorCommandOptions): Promise<Diagnostic> {
  const dict = t().doctor;
  const cfgPath = options.configPath ?? configPath();
  const sessionDir = options.sessionDir ?? sessionsDir();
  const integrity = await checkMigrationIntegrity(cfgPath, sessionDir);
  // 语义：v3 待迁移 → ok（loadConfig 启动时自动迁移，非环境故障）；配置不存在 → ok（无配置可迁移）；
  // 仅「已迁移但备份缺失」（迁移成功但 config.v3.bak 被删，无法回滚）→ fail。
  const migrated = integrity.migrated;
  const ok = migrated ? integrity.backupExists : true;
  const lines: string[] = [];
  if (migrated) {
    lines.push(`${dict.ok} ${dict.migrationLabel}: ${dict.migrationOk}`);
    lines.push(
      integrity.backupExists
        ? `  ${fmt(dict.migrationBackupOk, { path: `${cfgPath}.v3.bak` })}`
        : `  ${dict.migrationBackupMissing}`,
    );
  } else {
    lines.push(`${dict.ok} ${dict.migrationLabel}: ${dict.migrationNotMigrated}`);
    lines.push(`  ${dict.migrationBackupMissing}`);
  }
  lines.push(integrity.sessionCompatible ? `  ${dict.migrationSessionOk}` : '');
  lines.push(integrity.idempotent ? `  ${dict.migrationIdempotentOk}` : '');
  return { ok, lines: lines.filter((l) => l !== '') };
}

/**
 * VS Code 健康诊断（v3.4 M3 / doctor --vscode）：进程数 / 崩溃转储 / AI 扩展 / argv.json 四维，
 * 每项返回 { ok, lines }（ok=false 计入退出码；诊断只读，破坏性动作仅输出建议命令）。
 */
async function runVscodeDiagnostics(env: VscodeHealthEnv): Promise<Diagnostic[]> {
  return [
    await diagnoseVscodeProcesses(env),
    await detectCrashDumps(env),
    await detectAiExtensions(env),
    await verifyArgvJson(env),
  ];
}

/**
 * 本地指标汇总（v5.0 T21 / `doctor --metrics`）。
 *
 * **恒为 `ok: true`**：没开指标、一条数据都没有都不是「环境故障」——诊断项的 ok 只用于
 * 退出码，把「你没开这个可选功能」算成失败会让 `doctor` 白变红（与 `recommend` 同口径）。
 *
 * 顺带说明为什么这里只读**近 100 条**：指标的用处是「最近的体验」，全量汇总会让
 * 三个月前的慢审批一直拖住平均值（`SUMMARY_WINDOW` 是唯一窗口定义处）。
 */
async function diagnoseMetrics(options: DoctorCommandOptions): Promise<Diagnostic> {
  const file = options.metricsFile ?? defaultMetricsPath();
  const enabled = options.metricsEnabled ?? (await resolveMetricsEnabled());
  const { entries, skipped } = await readMetrics({ file, limit: SUMMARY_WINDOW });
  return {
    ok: true,
    lines: formatMetricsSummary({ summary: summarizeMetrics(entries), file, enabled, skipped }),
  };
}

/** 执行 doctor 命令；返回进程退出码（0 = 全部正常，1 = 存在诊断失败项）。 */
export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  console.log(t().doctor.title);
  const diagnostics: Diagnostic[] = [
    {
      ok: true,
      lines: [`${t().doctor.ok} ${t().doctor.nodeLabel}: ${process.version}`],
    },
    {
      ok: true,
      lines: [`${t().doctor.ok} ${t().doctor.platformLabel}: ${process.platform}`],
    },
    diagnoseApiKey(options.apiKey, options.keySource, options.keyAccountName),
    await diagnoseConfig(options.configPath ?? configPath()),
    await diagnoseSessionDir(options.sessionDir ?? sessionsDir()),
    diagnoseModels(),
    // v3.2 M4 / T4.4：账号完整性检查（active 指针 → 账号存在 + config 可读）
    await diagnoseAccounts(options.accountsRoot),
    await diagnoseBalance(options),
    // v4.0 M3 T3.2：模型推荐区块（复杂度 + 预算 + 本地 Ollama → 组合 + 月成本）
    await diagnoseRecommend(options),
    // v4.0 M3 T3.5：配置迁移完整性检测（迁移 / 备份 / 会话兼容 / 幂等）
    await diagnoseMigration(options),
  ];

  // v3.4 M3 / doctor --vscode：追加 VS Code 四维健康诊断
  if (options.vscode === true) {
    console.log(t().doctor.vscodeTitle);
    diagnostics.push(
      ...(await runVscodeDiagnostics(options.vscodeEnv ?? defaultVscodeHealthEnv())),
    );
  }

  // v5.0 T21 / doctor --metrics：追加本地体验指标汇总（默认 off 时如实说「未开启」）
  if (options.metrics === true) {
    diagnostics.push(await diagnoseMetrics(options));
  }

  let failed = false;
  for (const d of diagnostics) {
    if (!d.ok) {
      failed = true;
    }
    for (const line of d.lines) {
      console.log(line);
    }
  }
  return failed ? 1 : 0;
}
