/**
 * config v3→v4 迁移器测试（M0 T0.2 骨架 + M3 T3.5 完整实现）。
 * 覆盖：isV3Config 判定 / 字段映射 / 备份 / 幂等 / 完整性检测 / 回滚。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkMigrationIntegrity,
  isV3Config,
  migrateV3ToV4,
  V4_CONFIG_SCHEMA_VERSION,
} from '../../src/store/migration';

describe('isV3Config 判定', () => {
  it('schemaVersion === 1 → v3（需迁移）', () => {
    expect(isV3Config({ schemaVersion: 1, defaultModel: 'deepseek-chat' })).toBe(true);
  });

  it('schemaVersion === 2 → 非 v3（已迁移，无需重复迁移）', () => {
    expect(isV3Config({ schemaVersion: V4_CONFIG_SCHEMA_VERSION })).toBe(false);
  });

  it('无 schemaVersion 但含 defaultModel → v3（兼容旧配置）', () => {
    expect(isV3Config({ defaultModel: 'deepseek-chat' })).toBe(true);
  });

  it('空配置 → 非 v3（无迁移必要）', () => {
    expect(isV3Config({})).toBe(false);
  });
});

describe('migrateV3ToV4（M3 T3.5）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-migration-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const cfgPath = () => path.join(tmp, 'config.json');

  function writeV3(config: Record<string, unknown>): void {
    writeFileSync(cfgPath(), JSON.stringify(config, null, 2), 'utf8');
  }

  it('字段映射：defaultModel → providers.deepseek + ollama 配置迁移', async () => {
    writeV3({
      schemaVersion: 1,
      defaultModel: 'deepseek-chat',
      allowlist: ['npm test'],
      approvalPolicy: 'ask',
      peakTimeStrategy: 'switch',
      ollamaModel: 'qwen3.6:27b',
      ollamaBaseUrl: 'http://localhost:11434/v1',
    });
    const result = await migrateV3ToV4(JSON.parse(readFileSync(cfgPath(), 'utf8')), cfgPath());
    expect(result.migrated).toBe(true);
    expect(result.backupExists).toBe(true);
    const migrated = JSON.parse(readFileSync(cfgPath(), 'utf8'));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.defaultProvider).toBe('deepseek');
    expect(migrated.providers.deepseek).toEqual({ type: 'deepseek', model: 'deepseek-chat' });
    expect(migrated.providers.ollama).toEqual({
      type: 'ollama',
      model: 'qwen3.6:27b',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(migrated._migrated).toBe(true);
    // legacy 直通
    expect(migrated.legacy.allowlist).toEqual(['npm test']);
    expect(migrated.legacy.approvalPolicy).toBe('ask');
    expect(migrated.legacy.peakTimeStrategy).toBe('switch');
    // 备份存在且为原内容
    const backup = JSON.parse(readFileSync(`${cfgPath()}.v3.bak`, 'utf8'));
    expect(backup.defaultModel).toBe('deepseek-chat');
  });

  it('备份失败（配置文件不存在）→ 不迁移（fail-closed）', async () => {
    const result = await migrateV3ToV4({ schemaVersion: 1, defaultModel: 'x' }, cfgPath());
    expect(result.migrated).toBe(false);
    expect(result.failedFields).toEqual([]); // ENOENT 分支：无备份必要，不迁移
  });

  it('幂等：重复执行 isV3Config=false 跳过（不重复备份）', async () => {
    writeV3({ schemaVersion: 1, defaultModel: 'deepseek-chat' });
    const config = JSON.parse(readFileSync(cfgPath(), 'utf8'));
    const result = await migrateV3ToV4(config, cfgPath());
    expect(result.migrated).toBe(true);
    // 第二次：已迁移（schemaVersion=2）→ isV3Config false → migrated=false
    const migrated = JSON.parse(readFileSync(cfgPath(), 'utf8'));
    expect(isV3Config(migrated)).toBe(false);
    const second = await migrateV3ToV4(migrated, cfgPath());
    expect(second.migrated).toBe(false);
    // 备份未重复（config.v3.bak 仍是首次备份）
    const backup = JSON.parse(readFileSync(`${cfgPath()}.v3.bak`, 'utf8'));
    expect(backup.defaultModel).toBe('deepseek-chat');
  });

  it('checkMigrationIntegrity：迁移后四检测通过', async () => {
    writeV3({ schemaVersion: 1, defaultModel: 'deepseek-chat' });
    const config = JSON.parse(readFileSync(cfgPath(), 'utf8'));
    await migrateV3ToV4(config, cfgPath());
    const integrity = await checkMigrationIntegrity(cfgPath());
    expect(integrity.migrated).toBe(true);
    expect(integrity.backupExists).toBe(true);
    expect(integrity.sessionCompatible).toBe(true);
    expect(integrity.idempotent).toBe(true);
    // v5.0 K1：真迁过 → everMigrated=true（doctor 据此才敢要求备份存在）
    expect(integrity.everMigrated).toBe(true);
  });

  it('checkMigrationIntegrity：未迁移（v3）→ migrated=false', async () => {
    writeV3({ schemaVersion: 1, defaultModel: 'deepseek-chat' });
    const integrity = await checkMigrationIntegrity(cfgPath());
    expect(integrity.migrated).toBe(false);
    expect(integrity.everMigrated).toBe(false);
  });

  /**
   * v5.0 K1 的核心区分：**「现在是 v4 形状」≠「本机迁过」**。
   *
   * 新用户（v4 起才装）／手写 v4 配置的人都是「v4 形状 + 无 .v3.bak + 无 _migrated」——
   * 旧判定把他们当成「迁移备份丢失」→ doctor 屏幕全绿却 exit 1。
   */
  it('checkMigrationIntegrity：v4 形状但没迁过（无 _migrated）→ migrated=true / everMigrated=false', async () => {
    writeFileSync(
      cfgPath(),
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-flash' } },
      }),
      'utf8',
    );
    const integrity = await checkMigrationIntegrity(cfgPath());
    expect(integrity.migrated).toBe(true);
    expect(integrity.everMigrated).toBe(false);
    expect(integrity.backupExists).toBe(false);
  });
});
