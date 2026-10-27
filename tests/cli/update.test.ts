/**
 * `concertoai update` 测试（v5.0 T2）。
 *
 * 全部走依赖注入（不打真实网络、不改全局 npm 环境）。
 * 覆盖：版本对比 / 已最新 / npx 拒绝升级 / 确认与 --yes / 非 TTY fail-closed /
 *      取消 / 查询失败 / 安装失败 / 边缘路径（首次无安装、超长错误截断、二次确认）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  compareVersions,
  type InstallKind,
  MAX_ERROR_DISPLAY,
  runUpdateCommand,
  truncateError,
  type UpdateCommandOptions,
} from '../../src/cli/update';

/** 收集输出的 log 函数。 */
function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

/** 构建默认注入选项：默认「有新版 5.0.0、全局安装、交互 TTY」。 */
function makeOptions(overrides: UpdateCommandOptions = {}) {
  const { lines, log } = collector();
  const install = vi.fn(async () => ({ ok: true }));
  const confirm = vi.fn(async () => true);
  const options: UpdateCommandOptions = {
    currentVersion: '4.1.1',
    fetchLatestVersion: async () => ({ latest: '5.0.0' }),
    runInstall: install,
    detectInstallKind: async (): Promise<InstallKind> => 'global',
    confirm,
    isTTY: true,
    log,
    ...overrides,
  };
  return { options, lines, install, confirm };
}

describe('compareVersions（v5.0 T2）', () => {
  it('大小比较正确', () => {
    expect(compareVersions('5.0.0', '4.1.1')).toBe(1);
    expect(compareVersions('4.1.1', '5.0.0')).toBe(-1);
    expect(compareVersions('4.1.1', '4.1.1')).toBe(0);
  });

  it('位数不同时按缺失补 0（4.2 vs 4.2.0 相等）', () => {
    expect(compareVersions('4.2', '4.2.0')).toBe(0);
    expect(compareVersions('4.2.1', '4.2')).toBe(1);
  });

  it('忽略 v 前缀与预发布后缀', () => {
    expect(compareVersions('v5.0.0', '4.1.1')).toBe(1);
    expect(compareVersions('5.0.0-beta.1', '5.0.0')).toBe(0);
  });

  it('多位数按数字比较而非字符串（4.10 > 4.9）', () => {
    // 字符串比较会得 4.10 < 4.9（'1' < '9'），这里必须按数字
    expect(compareVersions('4.10.0', '4.9.0')).toBe(1);
  });

  it('畸形版本串不抛错（按 0 处理）', () => {
    expect(() => compareVersions('', 'abc')).not.toThrow();
    expect(compareVersions('abc', '0.0.0')).toBe(0);
  });
});

describe('runUpdateCommand：主路径（v5.0 T2）', () => {
  it('已是最新 → 提示 upToDate、退出 0、不安装', async () => {
    const { options, lines, install } = makeOptions({
      fetchLatestVersion: async () => ({ latest: '4.1.1' }),
    });
    const code = await runUpdateCommand(options);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('已是最新版本');
    expect(install).not.toHaveBeenCalled();
  });

  it('本地版本高于 registry（预发布）→ 也视为已最新', async () => {
    const { options, install } = makeOptions({
      currentVersion: '5.0.0',
      fetchLatestVersion: async () => ({ latest: '4.1.1' }),
    });
    expect(await runUpdateCommand(options)).toBe(0);
    expect(install).not.toHaveBeenCalled();
  });

  it('有新版 + 确认 → 安装并提示成功，退出 0', async () => {
    const { options, lines, install } = makeOptions();
    const code = await runUpdateCommand(options);
    expect(code).toBe(0);
    expect(install).toHaveBeenCalledWith('5.0.0');
    const text = lines.join('\n');
    expect(text).toContain('4.1.1 → 5.0.0');
    expect(text).toContain('已升级到 5.0.0');
  });

  it('--yes 跳过确认直接安装', async () => {
    const { options, confirm, install } = makeOptions({ yes: true });
    expect(await runUpdateCommand(options)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
  });

  it('用户拒绝确认 → 取消、不安装、退出 0', async () => {
    const { options, lines, install } = makeOptions({ confirm: async () => false });
    const code = await runUpdateCommand(options);
    expect(code).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('已取消');
  });
});

describe('runUpdateCommand：npx 与非 TTY（R2 fail-closed，v5.0 T2）', () => {
  it('npx 临时运行（非全局安装）→ 提示先全局安装、**不执行安装**、退出 1', async () => {
    const { options, lines, install } = makeOptions({
      detectInstallKind: async (): Promise<InstallKind> => 'npx',
    });
    const code = await runUpdateCommand(options);
    expect(code).toBe(1);
    expect(install).not.toHaveBeenCalled();
    const text = lines.join('\n');
    expect(text).toContain('npx');
    expect(text).toContain('npm install -g @concertoai/cli@latest');
  });

  it('非 TTY 且未 --yes → fail-closed：不擅自升级、提示加 --yes、退出 1', async () => {
    const { options, lines, install } = makeOptions({ isTTY: false });
    const code = await runUpdateCommand(options);
    expect(code).toBe(1);
    expect(install).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('concertoai update --yes');
  });

  it('非 TTY 但显式 --yes → 允许升级（CI 场景）', async () => {
    const { options, install } = makeOptions({ isTTY: false, yes: true });
    expect(await runUpdateCommand(options)).toBe(0);
    expect(install).toHaveBeenCalledOnce();
  });

  it('installKind=unknown（npm 不可用）→ 仍走确认流程，不跳过', async () => {
    const { options, confirm } = makeOptions({
      detectInstallKind: async (): Promise<InstallKind> => 'unknown',
    });
    expect(await runUpdateCommand(options)).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe('runUpdateCommand：失败与边缘路径（v5.0 T2）', () => {
  it('查询失败（网络）→ 友好提示 + 手动升级命令 + 退出 1，不崩溃', async () => {
    const { options, lines } = makeOptions({
      fetchLatestVersion: async () => ({
        latest: undefined,
        error: 'ENOTFOUND registry.npmjs.org',
      }),
    });
    const code = await runUpdateCommand(options);
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('检查更新失败');
    expect(text).toContain('npm install -g @concertoai/cli@latest');
  });

  it('安装失败（权限）→ 友好提示 + 手动命令 + 退出 1', async () => {
    const { options, lines } = makeOptions({
      runInstall: async () => ({ ok: false, error: 'EACCES: permission denied' }),
    });
    const code = await runUpdateCommand(options);
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('安装失败');
    expect(text).toContain('EACCES');
    expect(text).toContain('npm install -g @concertoai/cli@latest');
  });

  it('超长错误信息被截断（不淹没终端，保留头部关键信息）', async () => {
    const huge = `${'x'.repeat(5000)}EACCES`;
    const { options, lines } = makeOptions({
      runInstall: async () => ({ ok: false, error: huge }),
    });
    await runUpdateCommand(options);
    const text = lines.join('\n');
    // 真实截断：单行长度受控（不因 5000 字符撑爆终端）
    expect(text.length).toBeLessThan(500);
    expect(text).toContain('已截断');
    // 输出行数也受控
    expect(lines.length).toBeLessThan(20);
  });

  it('truncateError：短错误不截断、空白折叠、长错误保留头部', () => {
    expect(truncateError('EACCES')).toBe('EACCES');
    expect(truncateError('line1\n\n  line2')).toBe('line1 line2');
    const long = truncateError('A'.repeat(400));
    expect(long).toContain('已截断');
    expect(long.startsWith('AAA')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(MAX_ERROR_DISPLAY + 10);
  });

  it('首次运行场景（无全局安装 + npm 查询可用）→ 走 npx 提示而非静默成功', async () => {
    const { options, install } = makeOptions({
      detectInstallKind: async (): Promise<InstallKind> => 'npx',
      currentVersion: '0.0.0',
    });
    expect(await runUpdateCommand(options)).toBe(1);
    expect(install).not.toHaveBeenCalled();
  });
});
