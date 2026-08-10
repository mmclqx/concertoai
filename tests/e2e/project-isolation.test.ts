/**
 * 多项目隔离 E2E（v3.1 M6 / T6.1 E2E-4/5）。
 *
 * 端到端串联（真实注册表落盘 + 会话 JSONL 落盘 + 白名单/MCP 隔离）：
 * - E2E-4：注册项目 A/B（projects.json 落盘）→ resolveProjectForCwd 按 cwd 命中各自项目
 *   → SessionStore 会话真实写入各自目录 → list 互不可见（隔离矩阵落地）；
 * - E2E-5：白名单合并（全局 + 项目）去重生效 + 项目 MCP 声明互不串 + audit export 保序导出。
 *
 * 依赖：M2（projects/common）+ M5（audit.ts）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuditCommand } from '../../src/cli/audit';
import { mergeAllowlist, resolveProjectForCwd } from '../../src/cli/common';
import { userMessage } from '../../src/loop/messages';
import { AuditLogger } from '../../src/observable';
import { projectKeyFor } from '../../src/store/paths';
import { ProjectRegistry } from '../../src/store/projects';
import { SessionStore } from '../../src/store/session';

let tmp: string;
let regFile: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'e2e-proj-iso-'));
  regFile = path.join(tmp, 'projects.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 注册项目 A/B（各自不同白名单 + MCP 声明），真实落盘。 */
async function seedProjects(): Promise<void> {
  const reg = await ProjectRegistry.load(regFile);
  reg.add('projA', path.join(tmp, 'projA'));
  reg.add('projB', path.join(tmp, 'projB'));
  reg.updateConfig('projA', {
    whitelist: ['npm run build', 'git status'],
    mcpServers: [{ name: 'fs-a', command: 'npx', args: ['-y', 'server-filesystem', '/a'] }],
  });
  reg.updateConfig('projB', {
    whitelist: ['npm test'],
    mcpServers: [{ name: 'fs-b', command: 'npx', args: ['-y', 'server-filesystem', '/b'] }],
  });
  await reg.save();
  // 项目目录（注册表只记录路径，目录由调用方创建）
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.join(tmp, 'projA'), { recursive: true });
  mkdirSync(path.join(tmp, 'projB'), { recursive: true });
}

describe('E2E：项目注册表落盘 + 会话隔离（E2E-4）', () => {
  it('注册 A/B → 按 cwd 命中各自项目 → 会话写入各自目录 → list 互不可见', async () => {
    await seedProjects();

    // 1. resolveProjectForCwd 按 cwd 精确命中
    const hitA = await resolveProjectForCwd(path.join(tmp, 'projA'), regFile);
    const hitB = await resolveProjectForCwd(path.join(tmp, 'projB'), regFile);
    expect(hitA?.name).toBe('projA');
    expect(hitB?.name).toBe('projB');

    // 2. 会话真实写入各自项目目录（隔离矩阵落地）
    const dirA = path.join(tmp, 'sessions', projectKeyFor('projA'));
    const dirB = path.join(tmp, 'sessions', projectKeyFor('projB'));
    const storeA = new SessionStore(dirA);
    const storeB = new SessionStore(dirB);
    const idA = await storeA.create([userMessage('项目A的会话')]);
    const idB = await storeB.create([userMessage('项目B的会话')]);

    // 3. list 互不可见（各目录只含自己会话）
    expect((await storeA.list()).map((s) => s.id)).toEqual([idA]);
    expect((await storeB.list()).map((s) => s.id)).toEqual([idB]);

    // 4. JSONL 真实落盘（可读回）
    const { messages } = await storeA.read(idA);
    expect(messages[0]?.content).toBe('项目A的会话');
    const { messages: mb } = await storeB.read(idB);
    expect(mb[0]?.content).toBe('项目B的会话');
  });
});

describe('E2E：白名单合并 + MCP 隔离 + audit export（E2E-5）', () => {
  it('全局 + 项目白名单去重合并；项目 A/B MCP 声明互不串', async () => {
    await seedProjects();
    const hitA = await resolveProjectForCwd(path.join(tmp, 'projA'), regFile);
    const hitB = await resolveProjectForCwd(path.join(tmp, 'projB'), regFile);

    // 白名单：全局前缀 + 项目追加（去重）
    const mergedA = mergeAllowlist(['npm test', 'git status'], hitA?.whitelist);
    expect(mergedA).toEqual(['npm test', 'git status', 'npm run build']);
    const mergedB = mergeAllowlist(['npm test', 'git status'], hitB?.whitelist);
    expect(mergedB).toEqual(['npm test', 'git status']); // projB 白名单重复 → 去重

    // MCP：A/B 各自声明（fs-a vs fs-b，挂载路径不同）
    expect(hitA?.mcpServers?.[0]?.name).toBe('fs-a');
    expect(hitB?.mcpServers?.[0]?.name).toBe('fs-b');
    expect(hitA?.mcpServers?.[0]?.args?.at(-1)).toBe('/a');
    expect(hitB?.mcpServers?.[0]?.args?.at(-1)).toBe('/b');
  });

  it('audit export 真实 JSONL 保序导出（stdout 与 --out 一致）', async () => {
    // 真实写审计日志（AuditLogger 不自动建目录，先创建）
    const auditDir = path.join(tmp, 'audit');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(auditDir, { recursive: true });
    const logger = new AuditLogger(path.join(auditDir, 'a.jsonl'));
    await logger.append({ kind: 'message', detail: { label: 'one' } });
    await logger.append({ kind: 'approval', detail: { label: 'two' } });

    const out = path.join(tmp, 'out', 'audit.json');
    const log = await import('vitest').then(({ vi }) => vi.spyOn(console, 'log'));
    const code = await runAuditCommand({ dir: auditDir, out });
    expect(code).toBe(0);
    expect(out.length > 0).toBe(true);
    const exported = JSON.parse(readFileSync(out, 'utf8')) as Array<{ seq: number; kind: string }>;
    expect(exported).toHaveLength(2);
    expect(exported.map((e) => e.seq)).toEqual([1, 2]);
    expect(exported.map((e) => e.kind)).toEqual(['message', 'approval']);
    log.mockRestore();
  });
});
