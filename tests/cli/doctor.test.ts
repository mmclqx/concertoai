import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor';

let tmp: string;
let log: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-doctor-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log?.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBalance = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

const output = (): string => (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');

describe('runDoctorCommand', () => {
  it('全部正常时返回 0，输出环境信息与账户余额', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(cfg, '{"schemaVersion":1,"defaultModel":"deepseek-v4-flash"}', 'utf8');

    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });

    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('ConcertoAI 环境诊断');
    expect(out).toContain('✅ Node.js');
    expect(out).toContain('✅ API Key: 已设置');
    expect(out).toContain('✅ 配置文件');
    expect(out).toContain('schema v1');
    expect(out).toContain('✅ 会话目录');
    expect(out).toContain('✅ 模型表');
    expect(out).toContain('💰 账户余额: 账户可用');
    expect(out).toContain('CNY: 总额 110.00');
  });

  it('缺少 API Key 时返回 1 且余额标记跳过', async () => {
    const code = await runDoctorCommand({
      apiKey: undefined,
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      // Ollama 探测 stub（404 → 本地不可用，避免真实网络请求 localhost）
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(code).toBe(1);
    const out = output();
    expect(out).toContain('❌ API Key');
    expect(out).toContain('未设置（无法查询余额）');
    // v5.0 K2：措辞不能只说「缺 DEEPSEEK_API_KEY」——三种来源任意一种都算配好了
    expect(out).toContain('未查询（未配置 API Key');
    expect(out).toContain('concertoai login');
    expect(out).toContain('config.json');
  });

  it('余额查询失败时返回 1 且输出失败原因', async () => {
    const code = await runDoctorCommand({
      apiKey: 'bad',
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => new Response('{"error":{}}', { status: 401 }),
    });
    expect(code).toBe(1);
    expect(output()).toContain('❌ 账户余额: 查询失败');
  });

  it('配置文件损坏时返回 1 并报告读取失败', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(cfg, 'not-json{', 'utf8');
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(1);
    expect(output()).toContain('❌ 配置文件');
    expect(output()).toContain('读取失败');
  });

  it('配置文件不存在时按正常处理（使用默认配置）', async () => {
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: path.join(tmp, 'missing.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    expect(output()).toContain('✅ 配置文件');
    expect(output()).toContain('不存在，使用默认配置');
  });

  // ── 账号完整性（v3.2 M4 / T4.4）──

  it('无 active 账号 → 账号完整性 ok（提示可登录）', async () => {
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      accountsRoot: path.join(tmp, 'accounts'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    expect(output()).toContain('✅ 账号完整性');
    expect(output()).toContain('无 active 账号');
  });

  it('active 指针指向缺失账号 → fail + 可复制修复命令', async () => {
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('ghost', path.join(tmp, 'accounts'));
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      accountsRoot: path.join(tmp, 'accounts'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(1);
    expect(output()).toContain('❌ 账号完整性');
    expect(output()).toContain('concertoai login ghost');
  });

  // ── 模型推荐（v4.0 M3 T3.2）──

  it('模型推荐区块：medium 预算 + 空目录（small 复杂度）+ 无本地 → deepseek-v4-flash', async () => {
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      cwd: tmp, // 空 tmp 目录 → small 复杂度
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('💰 模型推荐');
    expect(out).toContain('deepseek-v4-flash');
    expect(out).toContain('月成本预估 ¥');
    expect(out).toContain('本地 Ollama 探测失败');
  });

  it('模型推荐区块：low 预算 + 本地可用 → ollama（成本 0）', async () => {
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      cwd: tmp,
      budget: 'low',
      // 模拟 Ollama /api/tags 返回本地模型列表（其余请求走余额 stub）
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
        if (url.includes('/api/tags')) {
          return jsonResponse({ models: [{ name: 'qwen3.6:27b-q4_K_M' }] });
        }
        return jsonResponse(okBalance);
      },
    });
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('💰 模型推荐');
    expect(out).toContain('ollama');
    expect(out).toContain('qwen3.6:27b-q4_K_M');
  });

  // ── 配置迁移完整性（v4.0 M3 T3.5）──

  it('v4 配置 + 备份存在 → 迁移完整性 ok', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-flash' } },
        _migrated: true,
      }),
      'utf8',
    );
    writeFileSync(`${cfg}.v3.bak`, '{"schemaVersion":1}', 'utf8');
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('✅ 配置迁移完整性');
    expect(out).toContain('v4 迁移完成');
    expect(out).toContain('备份存在');
  });

  it('v3 配置（待迁移）→ 迁移完整性 ok（启动自动迁移，非故障）', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(cfg, '{"schemaVersion":1,"defaultModel":"deepseek-v4-flash"}', 'utf8');
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('✅ 配置迁移完整性');
    expect(out).toContain('配置仍为 v3 格式');
  });

  /**
   * v5.2 N1（补完）：上面那条只断言了第一句，于是**第二句自我打脸漏检**。
   *
   * 实测现场（2026-11-13 手工验收，隔离 HOME 的真 `doctor`）：
   *
   * ```
   * ✅ 配置迁移完整性: 配置仍为 v3 格式（schema v1），启动时将自动迁移
   *   无需备份（本机未做过 v3→v4 迁移，config 一开始就是 v4 格式）
   * ```
   *
   * 第一句说「你是 v3」，第二句说「你一开始就是 v4」——**同屏两份事实互相否认**，
   * 与 N1 修掉的那个 bug 是同一个病，只是换了半边脸。
   * 真相是：`migrateV3ToV4` 迁移前会把原文件复制成 `config.v3.bak`，所以该说「会备份到哪」。
   *
   * 判据：v3 分支必须 ① 给出备份路径 ② **不得**出现「无需备份」（否定面，精确到那句错话）。
   * 改坏方式：把 `dict.migrationBackupPlanned` 换回 `dict.migrationBackupNotNeeded` ⇒ 这条红。
   */
  it('★ v3 待迁移 → 说「迁移前会备份」，不得说「无需备份」/「一开始就是 v4」（否定面，v5.2 N1 补完）', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(cfg, '{"schemaVersion":1,"defaultModel":"deepseek-v4-flash"}', 'utf8');
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const out = output();
    const migrationSection = out.slice(out.indexOf('配置迁移完整性'));
    // 正例：说清会备份到哪（用户据此知道「迁坏了能回滚」）
    expect(migrationSection).toContain('迁移前会自动把原配置备份到');
    expect(migrationSection).toContain('config.json.v3.bak');
    // 否定面：这两句都是与「配置仍为 v3 格式」直接矛盾的话
    expect(migrationSection).not.toContain('无需备份');
    expect(migrationSection).not.toContain('一开始就是 v4 格式');
  });

  /**
   * v5.2 N1：**配置文件根本不存在**这条状态此前没有任何用例，
   * 而它正是「doctor 同屏自我打脸」的现场：
   *
   * ```
   * ✅ 配置迁移完整性: 配置仍为 v3 格式（schema v1），启动时将自动迁移
   *   无需备份（本机未做过 v3→v4 迁移，config 一开始就是 v4 格式）
   * ```
   *
   * 第一句说「你是旧格式」，第二句说「你一开始就是 v4」——用户该信哪句？
   * 真相是**根本没有配置文件**，两句话都不该出现。
   */
  it('★ 无配置文件 → 说「尚无配置文件」，且**全文不含 v3**（否定面，v5.2 N1）', async () => {
    // 刻意不创建 config.json
    const cfg = path.join(tmp, 'no-such-config.json');
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const out = output();
    // 正例：如实说「没有配置文件」
    expect(out).toContain('✅ 配置迁移完整性');
    expect(out).toContain('尚无配置文件');
    // **否定面（核心）**：不许说「配置仍为 v3 格式」——那是事实错误。
    // 改坏方式：把 `configExists` 判断删掉（回退到只看 migrated）⇒ 这条红。
    //
    // ⚠️ 断言必须精确到**错误的那句话**，不能笼统到「不含 v3」：
    // 首版我写的是 `not.toContain('v3')`，结果红在
    // 「会话格式兼容（v4 只新增字段不破坏 v3 会话）」——这句**是对的**
    // （v3 指会话格式，不是配置格式）。笼统断言会让护栏因为正确的话而红，
    // 那不是护栏，是噪声；而且它还会掩盖真正的症状。
    const migrationSection = out.slice(out.indexOf('配置迁移完整性'));
    expect(migrationSection).not.toContain('配置仍为 v3 格式');
    // 也不该提备份：没有配置就没有「迁移前的备份」这回事
    expect(migrationSection).not.toContain('无需备份');
  });

  it('无配置文件时不误报故障（exit 0，迁移完整性不是阻塞项）', async () => {
    const cfg = path.join(tmp, 'missing.json');
    expect(
      await runDoctorCommand({
        apiKey: 'k',
        configPath: cfg,
        sessionDir: path.join(tmp, 'sessions'),
        fetchImpl: async () => jsonResponse(okBalance),
      }),
    ).toBe(0);
    expect(output()).not.toContain('❌ 配置迁移完整性');
  });
});

// ── K1（v5.0 T23.3 手工测试实测缺陷）：退出码与屏幕必须同时表态 ──────────

describe('K1：doctor 的退出码与屏幕一致性', () => {
  /** 造一份「v4 形状、无 .v3.bak、无 _migrated 标记」的配置 = 新用户（v4 起才装）。 */
  const writeV4Config = (extra: Record<string, unknown> = {}): string => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-flash' } },
        ...extra,
      }),
      'utf8',
    );
    return cfg;
  };

  const run = (cfg: string): Promise<number> =>
    runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });

  it('★ 新用户（v4 形状 + 无 .v3.bak + 无 _migrated）→ 全绿且 exit 0（旧版这里 exit 1）', async () => {
    const code = await run(writeV4Config());
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('✅ 配置迁移完整性');
    // 不许出现 ❌ —— 「屏幕全绿 + exit 1」正是 K1 的原始症状
    expect(out).not.toContain('❌ 配置迁移完整性');
    // 也不许说「备份缺失」：没迁过的人本来就不需要备份
    expect(out).toContain('无需备份');
  });

  it('★ 曾迁移过（_migrated: true）但 .v3.bak 丢失 → 屏幕出现 ❌ 且 exit 1（真故障）', async () => {
    const code = await run(writeV4Config({ _migrated: true }));
    expect(code).toBe(1);
    const out = output();
    expect(out).toContain('❌ 配置迁移完整性');
    expect(out).toContain('备份丢失');
  });

  it('曾迁移过 + 备份仍在 → ✅ 且 exit 0', async () => {
    const cfg = writeV4Config({ _migrated: true });
    writeFileSync(`${cfg}.v3.bak`, '{"schemaVersion":1}', 'utf8');
    expect(await run(cfg)).toBe(0);
    expect(output()).toContain('✅ 配置迁移完整性');
  });

  it('一致性铁律：任何 ok=false 的项，它的输出里必须出现 ❌（防「全绿 exit 1」再犯）', async () => {
    // 造两种失败：备份丢失（迁移项）+ 余额查询失败
    const cfg = writeV4Config({ _migrated: true });
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => new Response('{}', { status: 500 }),
    });
    expect(code).toBe(1);
    expect(output()).toContain('❌');
    expect(output()).toContain('❌ 配置迁移完整性');
  });
});

// ── K2（v5.0 T23.3 手工测试实测缺陷）：Key 来源标注 ────────────────────

describe('K2：doctor 认 config 来源的 Key', () => {
  it('★ keySource=config（来自 config.json）→ 报「已设置」并注明来源，exit 0', async () => {
    const code = await runDoctorCommand({
      apiKey: 'sk-config-only',
      keySource: 'config',
      configPath: path.join(tmp, 'missing.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('✅ API Key: 已设置');
    expect(out).toContain('来自配置文件');
    // 余额行也要标同一来源（两处说法一致，不能一处说 env 一处说 config）
    expect(out).toContain('账户可用');
  });

  it('keySource=env / account 的既有标注保持不变（不因新增 config 分支而回退）', async () => {
    await runDoctorCommand({
      apiKey: 'sk-env-xxxx',
      keySource: 'env',
      configPath: path.join(tmp, 'missing.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(output()).toContain('环境变量优先');

    log?.mockClear();
    await runDoctorCommand({
      apiKey: 'sk-acct-xxxx',
      keySource: 'account',
      keyAccountName: 'work',
      configPath: path.join(tmp, 'missing.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(output()).toContain('账号: work');
    // maskApiKey：`sk-acct-xxxx` 含连字符 → 不加 `sk-` 前缀，只留后 4 位
    expect(output()).toContain('****xxxx');
    expect(output()).not.toContain('sk-acct-xxxx');
  });
});
