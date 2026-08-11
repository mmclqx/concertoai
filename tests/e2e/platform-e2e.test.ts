/**
 * 跨平台 E2E（v3.2 M6 / T6.1）。
 *
 * 端到端串联真实子进程与项目注册表（覆盖 v3.2 跨平台基线）：
 * - E2E-A：命令兼容层映射的命令真实 spawn 成功——Windows 下 `npx` → `npx.cmd` 且 `shell: true`
 *   （规避 v3.1.1 教训：shell:false 直跑 .cmd → ENOENT）；非 Windows 走 `npx`；
 * - E2E-B：project 注册表 add UNC 网络共享路径 → normalize 规范化 + findByPath 精确匹配
 *   （v3.2 M1 / T1.3 UNC 边界，不真实访问网络共享，仅验证注册表逻辑）。
 *
 * 依赖：M1（getPlatformAdapter / projects.ts UNC 规范化）+ v3.1（ProjectRegistry）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../src/store/projects';
import { getPlatformAdapter } from '../../src/tools/shell';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'e2e-platform-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('E2E：Windows spawn 回归（命令兼容层 + shell:true，v3.2 M6 / T6.1）', () => {
  it('npx → npx.cmd（win32）/ npx（其他）映射后真实 spawn 成功', async () => {
    const adapter = getPlatformAdapter();
    const adapted = adapter.adaptCommand('npx --version');
    // Windows：npx.cmd --version；其他：npx --version
    expect(adapted.startsWith(adapter.isWindows ? 'npx.cmd' : 'npx')).toBe(true);

    // 真实 spawn：必须 shell:true（Windows 下 .cmd 无法被 CreateProcess 直接执行，v3.1.1 教训）
    const [bin, ...args] = adapted.split(' ');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin ?? 'npx', args, { shell: true, cwd: tmp, windowsHide: true });
      let out = '';
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(out);
        } else {
          reject(new Error(`spawn 退出码 ${code}：${bin} ${args.join(' ')}`));
        }
      });
    });
    // npx --version 输出形如 "10.x.x"
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('shell:false 直跑 npx.cmd（Windows 旧问题）→ 在 Windows 上会 ENOENT（回归说明）', () => {
    if (!getPlatformAdapter().isWindows) {
      // 非 Windows 无 .cmd 语义，跳过
      return;
    }
    // 仅验证事实：不真正触发 ENOENT（避免跨平台误报），断言适配器确实翻译了命令
    expect(getPlatformAdapter().adaptCommand('npx --version')).toBe('npx.cmd --version');
  });
});

describe('E2E：UNC 路径规范化（project 注册表，v3.2 M6 / T6.1）', () => {
  it('add UNC 网络共享路径 → normalize 规范化 + findByPath 精确匹配（分隔符边界）', async () => {
    const regFile = path.join(tmp, 'projects.json');
    const reg = await ProjectRegistry.load(regFile);
    const uncRaw = '\\\\server\\share\\demo';
    reg.add('share', uncRaw);
    await reg.save();

    // 磁盘持久化 + 重新加载：路径已规范化为 //server/share/demo
    const onDisk = await ProjectRegistry.load(regFile);
    expect(onDisk.get('share')?.path).toBe('//server/share/demo');
    // findByPath 精确匹配项目根（cwd 探测语义：-p 先 chdir 到项目根）
    expect(onDisk.findByPath('//server/share/demo')?.name).toBe('share');
    // 反斜杠原始形态同样命中（normalize 统一分隔符）
    expect(onDisk.findByPath('\\\\server\\share\\demo')?.name).toBe('share');
    // 子目录不命中（精确匹配；子目录探测由 isNested 单元覆盖）
    expect(onDisk.findByPath('//server/share/demo/src')?.name).toBeUndefined();
    // 同前缀非子目录不命中（分隔符边界，非前缀误判）
    expect(onDisk.findByPath('//server/share/demo2')?.name).toBeUndefined();
  });
});
