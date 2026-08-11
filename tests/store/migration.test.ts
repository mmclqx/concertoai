/**
 * M0 T0.2：config v3→v4 迁移器骨架测试。
 * 仅覆盖可立即交付的纯判定逻辑 isV3Config；
 * migrateV3ToV4 实现归 M3 T3.5（届时补充字段映射/备份/幂等/回滚用例）。
 */
import { describe, expect, it } from 'vitest';

import { isV3Config, V4_CONFIG_SCHEMA_VERSION } from '../../src/store/migration';

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
