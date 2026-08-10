/**
 * 全局路径与旧目录迁移测试（v3.1）。
 *
 * 覆盖：
 * - 各路径函数指向 ~/.concertoai/（v3.0 及以前为 ~/.lumen/）；
 * - migrateLegacyHome 三策略：无旧目录 → 无操作；新目录已存在 → 不覆盖；
 *   旧目录存在且新目录不存在 → 整目录迁移（文件保留）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditDir,
  configPath,
  globalAgentsDir,
  globalDir,
  globalSkillsDir,
  knowledgeDir,
  legacyGlobalDir,
  migrateLegacyHome,
  projectKeyFor,
  projectSessionsDir,
  reviewerKnowledgeDir,
  sessionsDir,
} from '../../src/store/paths';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('全局路径（~/.concertoai/）', () => {
  it('默认目录指向 ~/.concertoai', () => {
    expect(globalDir()).toBe(path.join(os.homedir(), '.concertoai'));
    expect(legacyGlobalDir()).toBe(path.join(os.homedir(), '.lumen'));
  });

  it('各子路径基于 ~/.concertoai', () => {
    expect(configPath()).toBe(path.join(os.homedir(), '.concertoai', 'config.json'));
    expect(sessionsDir()).toBe(path.join(os.homedir(), '.concertoai', 'sessions'));
    expect(globalSkillsDir()).toBe(path.join(os.homedir(), '.concertoai', 'skills'));
    expect(knowledgeDir()).toBe(path.join(os.homedir(), '.concertoai', 'knowledge'));
    expect(auditDir()).toBe(path.join(os.homedir(), '.concertoai', 'audit'));
    expect(globalAgentsDir()).toBe(path.join(os.homedir(), '.concertoai', 'agents'));
    expect(reviewerKnowledgeDir()).toBe(
      path.join(os.homedir(), '.concertoai', 'reviewer', 'knowledge'),
    );
  });
});

describe('项目会话目录（T2.4 隔离矩阵）', () => {
  it('projectKeyFor：普通名保持不变', () => {
    expect(projectKeyFor('demo')).toBe('demo');
    expect(projectKeyFor('my-app')).toBe('my-app');
    expect(projectKeyFor('a.b_c')).toBe('a.b_c');
  });

  it('projectKeyFor：空格/中文/其他字符转 _，空名兜底 unnamed', () => {
    expect(projectKeyFor('my app')).toBe('my_app');
    expect(projectKeyFor('项目 demo')).toBe('___demo');
    expect(projectKeyFor('a/b')).toBe('a_b');
    expect(projectKeyFor('')).toBe('unnamed');
  });

  it('projectKeyFor：. 与 .. 加前缀防隐藏目录', () => {
    expect(projectKeyFor('.')).toBe('p_.');
    expect(projectKeyFor('..')).toBe('p_..');
  });

  it('projectSessionsDir 基于 sessionsDir 拼接项目 key', () => {
    expect(projectSessionsDir('demo')).toBe(path.join(sessionsDir(), 'demo'));
    expect(projectSessionsDir('my_app')).toBe(path.join(sessionsDir(), 'my_app'));
  });

  it('隔离：不同项目 key 指向不同目录，且非项目默认目录互不串', () => {
    const a = projectSessionsDir('projA');
    const b = projectSessionsDir('projB');
    expect(a).not.toBe(b);
    expect(a).not.toBe(sessionsDir());
    expect(b).not.toBe(sessionsDir());
    expect(a.startsWith(sessionsDir() + path.sep)).toBe(true);
  });
});

describe('migrateLegacyHome（~/.lumen → ~/.concertoai）', () => {
  it('旧目录不存在 → 无操作（新安装直接用新版）', () => {
    const legacy = path.join(tmp, 'legacy');
    const next = path.join(tmp, 'next');
    const log: string[] = [];
    expect(migrateLegacyHome((m) => log.push(m), legacy, next)).toBe(false);
    expect(log).toHaveLength(0);
    expect(existsSync(next)).toBe(false);
  });

  it('新目录已存在 → 保留新版，不覆盖旧目录', () => {
    const legacy = path.join(tmp, 'legacy');
    const next = path.join(tmp, 'next');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'config.json'), 'old', 'utf8');
    mkdirSync(next, { recursive: true });
    writeFileSync(path.join(next, 'config.json'), 'new', 'utf8');

    expect(migrateLegacyHome(() => {}, legacy, next)).toBe(false);
    // 新版内容保持不变，旧目录原样保留
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(path.join(next, 'config.json'))).toBe(true);
  });

  it('旧目录存在且新目录不存在 → 整目录迁移，文件保留', () => {
    const legacy = path.join(tmp, 'legacy');
    const next = path.join(tmp, 'next');
    mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
    writeFileSync(path.join(legacy, 'config.json'), '{"schemaVersion":1}', 'utf8');
    writeFileSync(path.join(legacy, 'sessions', 'a.jsonl'), '{}', 'utf8');

    const log: string[] = [];
    expect(migrateLegacyHome((m) => log.push(m), legacy, next)).toBe(true);
    expect(log.length).toBeGreaterThan(0);
    // 旧目录已移动，内容完整保留在新目录
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(next, 'config.json'))).toBe(true);
    expect(existsSync(path.join(next, 'sessions', 'a.jsonl'))).toBe(true);
  });

  it('幂等：迁移完成后再次调用 → false', () => {
    const legacy = path.join(tmp, 'legacy');
    const next = path.join(tmp, 'next');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'config.json'), '{}', 'utf8');

    expect(migrateLegacyHome(() => {}, legacy, next)).toBe(true);
    expect(migrateLegacyHome(() => {}, legacy, next)).toBe(false);
    expect(existsSync(next)).toBe(true);
  });
});
