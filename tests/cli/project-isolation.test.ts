/**
 * 多项目隔离测试（v3.1 M2 / T2.3 + T2.4 + T2.5）。
 *
 * 覆盖隔离矩阵（§4.3）：
 * - resolveProjectForCwd：按 cwd 精确匹配已注册项目；未匹配 → undefined（全局默认）；
 * - mergeAllowlist：全局白名单 + 项目级白名单去重合并（全局前缀 + 项目追加）；
 * - 会话目录：项目 A/B 会话写入各自 ~/.concertoai/sessions/<projectKey>/，互不串；
 * - MCP 服务：项目 A/B 各自 mcpServers 声明互不影响；
 * - 默认模式兼容：无项目时 resolveProjectForCwd 返回 undefined。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeAllowlist, resolveProjectForCwd } from '../../src/cli/common';
import { userMessage } from '../../src/loop/messages';
import { projectKeyFor } from '../../src/store/paths';
import { ProjectRegistry } from '../../src/store/projects';
import { SessionStore } from '../../src/store/session';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'project-iso-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const regFile = (): string => path.join(tmp, 'projects.json');

/** 建注册表并注册两个项目 A/B（各自带不同白名单与 MCP 声明）。 */
async function seedTwoProjects(): Promise<void> {
  const reg = await ProjectRegistry.load(regFile());
  reg.add('projA', path.join(tmp, 'projA'));
  reg.add('projB', path.join(tmp, 'projB'));
  reg.updateConfig('projA', {
    whitelist: ['npm run build', 'git status'],
    mcpServers: [
      {
        name: 'fs-a',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/a'],
      },
    ],
  });
  reg.updateConfig('projB', {
    whitelist: ['npm test'],
    mcpServers: [
      {
        name: 'fs-b',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/b'],
      },
    ],
  });
  await reg.save();
}

describe('resolveProjectForCwd（T2.3 按 cwd 探测）', () => {
  it('精确匹配已注册项目 → 返回项目上下文', async () => {
    await seedTwoProjects();
    const hit = await resolveProjectForCwd(path.join(tmp, 'projA'), regFile());
    expect(hit?.name).toBe('projA');
    expect(hit?.path).toBe(path.join(tmp, 'projA').replace(/\\/g, '/'));
    expect(hit?.whitelist).toContain('npm run build');
  });

  it('未匹配（未注册目录）→ undefined（使用全局默认）', async () => {
    await seedTwoProjects();
    const hit = await resolveProjectForCwd(path.join(tmp, 'other'), regFile());
    expect(hit).toBeUndefined();
  });

  it('注册表损坏 → 宽松降级为 undefined（不崩溃）', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(regFile(), '{broken', 'utf8');
    const hit = await resolveProjectForCwd(tmp, regFile());
    expect(hit).toBeUndefined();
  });
});

describe('mergeAllowlist（T2.3/T2.4 白名单合并）', () => {
  it('全局 + 项目去重合并：全局前缀 + 项目追加', () => {
    const merged = mergeAllowlist(['npm test', 'git status'], ['git status', 'npm run build']);
    expect(merged).toEqual(['npm test', 'git status', 'npm run build']);
  });

  it('无项目白名单 → 仅全局（顺序不变）', () => {
    expect(mergeAllowlist(['npm test'], undefined)).toEqual(['npm test']);
  });

  it('无全局 → 仅项目白名单', () => {
    expect(mergeAllowlist(undefined, ['npm run build'])).toEqual(['npm run build']);
  });

  it('两者均无 → 空数组', () => {
    expect(mergeAllowlist(undefined, undefined)).toEqual([]);
  });
});

describe('会话目录隔离（T2.4）', () => {
  // 目录用 tmp 下的模拟项目目录（projectKeyFor/projectSessionsDir 的拼接在
  // tests/store/paths.test.ts 单独验证；此处验证隔离语义，不碰真实 ~/.concertoai）。
  const projectSessionDir = (name: string): string =>
    path.join(tmp, 'sessions', projectKeyFor(name));

  it('项目 A/B 会话写入各自目录，互不串（list 互不可见）', async () => {
    const dirA = projectSessionDir('projA');
    const dirB = projectSessionDir('projB');
    expect(dirA).not.toBe(dirB);

    const storeA = new SessionStore(dirA);
    const storeB = new SessionStore(dirB);
    const idA = await storeA.create([userMessage('项目A的会话')]);
    const idB = await storeB.create([userMessage('项目B的会话')]);

    // 各自列表只含自己的会话
    expect((await storeA.list()).map((s) => s.id)).toEqual([idA]);
    expect((await storeB.list()).map((s) => s.id)).toEqual([idB]);
  });

  it('默认目录与会话目录分离：无项目时默认目录不受项目会话影响', async () => {
    const storeA = new SessionStore(projectSessionDir('projA'));
    await storeA.create([userMessage('仅项目A')]);
    const storeDefault = new SessionStore(path.join(tmp, 'sessions-default'));
    expect(await storeDefault.list()).toHaveLength(0);
  });
});

describe('MCP 配置隔离（T2.4）', () => {
  it('项目 A/B 各自 mcpServers 声明互不影响', async () => {
    await seedTwoProjects();
    const hitA = await resolveProjectForCwd(path.join(tmp, 'projA'), regFile());
    const hitB = await resolveProjectForCwd(path.join(tmp, 'projB'), regFile());
    expect(hitA?.mcpServers?.[0]?.name).toBe('fs-a');
    expect(hitB?.mcpServers?.[0]?.name).toBe('fs-b');
    // 两个服务的挂载路径不同（args 尾元素），证明声明各自独立
    expect(hitA?.mcpServers?.[0]?.args?.at(-1)).toBe('/a');
    expect(hitB?.mcpServers?.[0]?.args?.at(-1)).toBe('/b');
  });

  it('未配置 MCP 的项目 → mcpServers 为 undefined（回退全局）', async () => {
    const reg = await ProjectRegistry.load(regFile());
    reg.add('plain', path.join(tmp, 'plain'));
    await reg.save();
    const hit = await resolveProjectForCwd(path.join(tmp, 'plain'), regFile());
    expect(hit?.mcpServers).toBeUndefined();
  });
});
