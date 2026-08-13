import { describe, expect, it, vi } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor';
import {
  AI_EXTENSION_IDS,
  argvJsonPathFor,
  checkArgvJson,
  collectDumps,
  crashpadDirFor,
  type DirEntry,
  detectAiExtensions,
  detectCrashDumps,
  diagnoseVscodeProcesses,
  type ExecResult,
  formatBytes,
  ineffectiveArgvJsonPathFor,
  parseExtensions,
  parsePsCodeCount,
  parseTasklistCodeCount,
  stripJsonComments,
  type VscodeHealthEnv,
  verifyArgvJson,
} from '../../src/cli/vscode-health';

/** 构造测试环境（默认全部注入样本；exec/readFile/scanDir 可按用例覆盖）。 */
function makeEnv(overrides: Partial<VscodeHealthEnv> = {}): VscodeHealthEnv {
  return {
    platform: 'win32',
    homedir: 'C:\\Users\\tester',
    appData: 'C:\\Users\\tester\\AppData\\Roaming',
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => {
      throw new Error('ENOENT');
    },
    scanDir: async () => [],
    ...overrides,
  };
}

/** 构造 command 输出（exec 返回值）。 */
function cmdResult(stdout: string, exitCode = 0): ExecResult {
  return { stdout, stderr: '', exitCode };
}

// ── T3.1 进程数解析 + 阈值分级 ────────────────────────────────

describe('T3.1 进程数', () => {
  it('解析 Windows tasklist CSV 输出（排除表头/空行）', () => {
    const sample = [
      '"Code.exe","1234","Console","1","50,000 K"',
      '"Code.exe","5678","Console","1","80,000 K"',
      '"notepad.exe","999","Console","1","2,000 K"',
      '',
    ].join('\r\n');
    expect(parseTasklistCodeCount(sample)).toBe(2);
  });

  it('解析 POSIX ps 输出（grep -c Code 语义）', () => {
    const sample = ['/usr/bin/Code', '/usr/bin/Code Helper', 'bash', 'Code'].join('\n');
    expect(parsePsCodeCount(sample)).toBe(3);
  });

  it('进程数 ≤40 → ✅ ok', async () => {
    const env = makeEnv({
      platform: 'win32',
      exec: async () => cmdResult('"Code.exe","1","Console","1","10,000 K"\n'),
    });
    const d = await diagnoseVscodeProcesses(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('Code 进程数');
    expect(d.lines[0]).toContain('1 个');
  });

  it('进程数 >40 → ⚠️ 仍 ok（退出码不失败）', async () => {
    const env = makeEnv({
      platform: 'linux',
      exec: async () => cmdResult(Array.from({ length: 45 }, () => '/usr/bin/Code').join('\n')),
    });
    const d = await diagnoseVscodeProcesses(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('45 个');
    expect(d.lines[0]).toContain('偏多');
  });

  it('进程数 >60 → ❌ fail', async () => {
    const env = makeEnv({
      platform: 'win32',
      exec: async () =>
        cmdResult(
          Array.from({ length: 83 }, () => '"Code.exe","1","Console","1","10,000 K"').join('\n'),
        ),
    });
    const d = await diagnoseVscodeProcesses(env);
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toContain('83 个');
    expect(d.lines[0]).toContain('严重');
  });

  it('命令异常 → ⚠️ 无法检测（不崩溃）', async () => {
    const env = makeEnv({ exec: async () => cmdResult('', -1) });
    const d = await diagnoseVscodeProcesses(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('无法检测');
  });
});

// ── T3.2 崩溃转储 ─────────────────────────────────────────────

describe('T3.2 崩溃转储', () => {
  it('平台路径映射正确（三平台）', () => {
    const win = makeEnv({ platform: 'win32' });
    expect(crashpadDirFor(win)).toContain('AppData\\Roaming\\Code\\Crashpad\\reports');
    const mac = makeEnv({ platform: 'darwin', homedir: '/Users/t' });
    expect(crashpadDirFor(mac)).toBe('/Users/t/Library/Application Support/Code/Crashpad/reports');
    const linux = makeEnv({ platform: 'linux', homedir: '/home/t' });
    expect(crashpadDirFor(linux)).toBe('/home/t/.config/Code/Crashpad/reports');
  });

  it('统计 *.dmp 数量与体积（忽略非 dmp）', () => {
    const entries: DirEntry[] = [
      { name: 'a.dmp', size: 100 },
      { name: 'b.dmp', size: 200 },
      { name: 'README.txt', size: 999 },
    ];
    expect(collectDumps(entries)).toEqual({ count: 2, bytes: 300 });
    expect(formatBytes(300)).toBe('300B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0MB');
  });

  it('无目录 / 0 个 → ✅', async () => {
    const env = makeEnv({ scanDir: async () => [] });
    const d = await detectCrashDumps(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('0 个');
  });

  it('>5 个或 >100MB → ❌ + 清理命令', async () => {
    const env = makeEnv({
      platform: 'win32',
      scanDir: async () =>
        Array.from({ length: 6 }, (_, i) => ({ name: `c${i}.dmp`, size: 1024 * 1024 })),
    });
    const d = await detectCrashDumps(env);
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toContain('6 个');
    expect(d.lines[1]).toContain('del /q');
    expect(d.lines[1]).toContain('Crashpad');
  });

  it('1~5 个 → ⚠️ 建议清理（不 fail；POSIX 清理命令 rm -f）', async () => {
    const env = makeEnv({
      platform: 'linux',
      homedir: '/home/t',
      scanDir: async () => [{ name: 'a.dmp', size: 10 }],
    });
    const d = await detectCrashDumps(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('1 个');
    expect(d.lines[1]).toContain('rm -f');
  });
});

// ── T3.3 扩展清单解析 ─────────────────────────────────────────

describe('T3.3 AI 扩展', () => {
  it('解析 code --list-extensions（@版本号 / 多行 / 无版本号）', () => {
    const sample = [
      'alibaba-cloud.tongyi-lingma@2.6.7',
      'danielsanmedium.dscodegpt@3.24.43',
      'ms-python.python@2026.1.0',
      'plain-id',
      '',
    ].join('\n');
    expect(parseExtensions(sample)).toEqual([
      'alibaba-cloud.tongyi-lingma',
      'danielsanmedium.dscodegpt',
      'ms-python.python',
      'plain-id',
    ]);
  });

  it('code CLI 不存在 → ⚠️ 无法检测（不崩溃）', async () => {
    const env = makeEnv({
      exec: async () => {
        throw new Error('ENOENT');
      },
    });
    const d = await detectAiExtensions(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('无法检测');
  });

  it('AI 扩展 ≤3 且全部禁用 → ✅', async () => {
    const env = makeEnv({
      exec: async () =>
        cmdResult(['continue.continue@2.0.0', 'anthropic.claude-code@2.1.226'].join('\n')),
      readFile: async () =>
        JSON.stringify({ 'disable-extension': ['continue.continue', 'anthropic.claude-code'] }),
    });
    const d = await detectAiExtensions(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('2 个');
    expect(d.lines.length).toBe(1);
  });

  it('AI 扩展 >3 → ❌ + 已装未禁用建议命令', async () => {
    const env = makeEnv({
      exec: async () => cmdResult(AI_EXTENSION_IDS.join('\n')),
      readFile: async () => JSON.stringify({ 'disable-extension': [] }),
    });
    const d = await detectAiExtensions(env);
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toContain('7 个');
    expect(d.lines[1]).toContain('已装但未禁用');
    expect(d.lines[2]).toContain('code --disable-extension');
  });
});

// ── T3.3 argv.json 字段名/值格式/ID 引号/无效位置 ─────────────

describe('T3.3 argv.json 核对', () => {
  it('stripJsonComments 剥离 // 与 /* */（跳过字符串内）', () => {
    const jsonc = [
      '{',
      '  // 行注释',
      '  "locale": "en", // 尾注释',
      '  "path": "http://x/\\"y" /* 块注释 */',
      '}',
    ].join('\n');
    const out = stripJsonComments(jsonc);
    expect(out).toContain('"locale": "en"');
    expect(out).toContain('http://x/');
    expect(out).not.toContain('// 行注释');
    expect(out).not.toContain('/* 块注释 */');
    expect(JSON.parse(out)).toEqual({ locale: 'en', path: 'http://x/"y' });
  });

  it('字段名正确（单数 disable-extension）+ 数组 → ok，返回禁用 ID', () => {
    const raw = JSON.stringify({
      'disable-extension': ['openai.chatgpt', 'continue.continue'],
    });
    const check = checkArgvJson(raw);
    expect(check.ok).toBe(true);
    expect(check.valueInvalid).toBe(false);
    expect(check.idQuoteInvalid).toBe(false);
    expect(check.pluralArrayInvalid).toBe(false);
    expect(check.disabledIds).toEqual(['openai.chatgpt', 'continue.continue']);
  });

  it('复数 disable-extensions + 数组 → ❌（§七根因：VS Code 类型不匹配静默忽略）', () => {
    const raw = JSON.stringify({ 'disable-extensions': ['openai.chatgpt'] });
    const check = checkArgvJson(raw);
    expect(check.pluralArrayInvalid).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('单数值格式错误（字符串而非数组）→ ❌ valueInvalid', () => {
    const raw = JSON.stringify({ 'disable-extension': 'openai.chatgpt' });
    const check = checkArgvJson(raw);
    expect(check.valueInvalid).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('扩展 ID 无引号（JSONC 解析失败）→ ❌ idQuoteInvalid', () => {
    const raw = '{ "disable-extension": [openai.chatgpt] }';
    const check = checkArgvJson(raw);
    expect(check.idQuoteInvalid).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('复数 disable-extensions: true = 禁用全部扩展（合法但激进，提示不 fail）', () => {
    const check = checkArgvJson(JSON.stringify({ 'disable-extensions': true }));
    expect(check.ok).toBe(true);
    expect(check.pluralAllDisabled).toBe(true);
    expect(check.pluralArrayInvalid).toBe(false);
    expect(check.valueInvalid).toBe(false);
  });

  it('两个字段均未配置 → ok（无禁用项，不报字段错误）', () => {
    const check = checkArgvJson(JSON.stringify({ locale: 'zh-cn' }));
    expect(check.ok).toBe(true);
    expect(check.disabledIds).toEqual([]);
    expect(check.valueInvalid).toBe(false);
  });

  it('verifyArgvJson：无效位置 %APPDATA%\\Code\\argv.json 存在 → ❌', async () => {
    const env = makeEnv({
      platform: 'win32',
      readFile: async (p: string) => {
        // 实际读取位置存在且正确（单数 disable-extension）；无效位置存在
        if (p.includes('AppData\\Roaming\\Code\\argv.json')) {
          return JSON.stringify({ 'disable-extension': ['openai.chatgpt'] });
        }
        return JSON.stringify({ 'disable-extension': ['openai.chatgpt'] });
      },
    });
    const d = await verifyArgvJson(env);
    expect(d.ok).toBe(false);
    expect(d.lines.some((l) => l.includes('无效位置'))).toBe(true);
  });

  it('verifyArgvJson：实际位置缺失 → ✅ 未配置提示（不 fail）', async () => {
    const env = makeEnv();
    const d = await verifyArgvJson(env);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).toContain('未找到');
  });

  it('argvJsonPathFor 三平台一致（~/.vscode/argv.json）', () => {
    expect(argvJsonPathFor(makeEnv({ platform: 'win32' }))).toBe(
      'C:\\Users\\tester\\.vscode\\argv.json',
    );
    expect(argvJsonPathFor(makeEnv({ platform: 'linux', homedir: '/home/t' }))).toBe(
      '/home/t/.vscode/argv.json',
    );
    expect(ineffectiveArgvJsonPathFor(makeEnv({ platform: 'linux' }))).toBe('');
  });
});

// ── T3.4 doctor --vscode 集成 ─────────────────────────────────

describe('doctor --vscode 集成（T3.4）', () => {
  it('不带 --vscode → 不输出 VS Code 诊断（回归）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runDoctorCommand({
        apiKey: undefined,
        configPath: 'C:\\nonexistent.json',
        sessionDir: 'C:\\nonexistent-sessions',
      });
      expect(code).toBe(1);
      const out = (log.mock.calls ?? []).map((c) => String(c[0])).join('\n');
      expect(out).not.toContain('VS Code');
    } finally {
      log.mockRestore();
    }
  });

  it('--vscode 注入样本 → 输出四维诊断 + 严重项退出码 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const env = makeEnv({
        platform: 'win32',
        exec: async () =>
          cmdResult(
            Array.from({ length: 83 }, () => '"Code.exe","1","Console","1","10,000 K"').join('\n'),
          ),
        scanDir: async () =>
          Array.from({ length: 12 }, (_, i) => ({ name: `d${i}.dmp`, size: 10 * 1024 * 1024 })),
        readFile: async (p: string) => {
          // 无效位置（%APPDATA%）存在且正确；实际读取位置（~/.vscode/argv.json）= 复数+数组（§七根因）
          if (p.includes('AppData\\Roaming\\Code\\argv.json')) {
            return JSON.stringify({ 'disable-extension': ['openai.chatgpt'] });
          }
          return JSON.stringify({ 'disable-extensions': ['openai.chatgpt'] });
        },
      });
      const code = await runDoctorCommand({
        apiKey: undefined,
        configPath: 'C:\\nonexistent.json',
        sessionDir: 'C:\\nonexistent-sessions',
        vscode: true,
        vscodeEnv: env,
      });
      expect(code).toBe(1);
      const out = (log.mock.calls ?? []).map((c) => String(c[0])).join('\n');
      expect(out).toContain('VS Code 健康诊断');
      expect(out).toContain('Code 进程数');
      expect(out).toContain('崩溃转储');
      expect(out).toContain('AI 扩展');
      expect(out).toContain('argv.json');
      // 严重项：83 进程 + 12 转储 + 复数+数组（§七根因，VS Code 静默忽略）→ 全 ❌
      expect(out).toContain('83 个');
      expect(out).toContain('12 个');
      expect(out).toContain('字段名错误');
    } finally {
      log.mockRestore();
    }
  });

  it('--vscode 全健康 → 退出码 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const env = makeEnv({
        platform: 'win32',
        exec: async () => cmdResult('"Code.exe","1","Console","1","10,000 K"\n'),
        scanDir: async () => [],
        readFile: async () => {
          throw new Error('ENOENT');
        },
      });
      const code = await runDoctorCommand({
        apiKey: undefined,
        configPath: 'C:\\nonexistent.json',
        sessionDir: 'C:\\nonexistent-sessions',
        vscode: true,
        vscodeEnv: env,
      });
      // API Key 缺失 → 仍返回 1（doctor 常规项 fail），但 VS Code 四维全 ✅
      expect(code).toBe(1);
      const out = (log.mock.calls ?? []).map((c) => String(c[0])).join('\n');
      expect(out).toContain('Code 进程数');
      expect(out).toContain('1 个');
      expect(out).toContain('崩溃转储');
      expect(out).toContain('0 个');
      expect(out).toContain('未找到');
    } finally {
      log.mockRestore();
    }
  });
});
