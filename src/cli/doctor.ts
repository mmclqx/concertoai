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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fetchBalance } from '../balance';
import { fmt, t } from '../i18n';
import { listModels } from '../model/models';
import { getActiveAccount, getApiKeyFor, listAccounts } from '../store/accounts';
import { configPath, sessionsDir } from '../store/paths';
import { type ApiKeySource, maskApiKey } from './common';

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
  ];

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
