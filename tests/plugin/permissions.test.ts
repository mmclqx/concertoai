/**
 * 插件权限测试（v4.0 M4 / T4.2）。
 *
 * 覆盖验收标准：
 * - 安装时展示权限清单（彩色图标，一眼看懂）；
 * - 运行时未声明权限被拦截 + 提示 + 审计日志（fail-closed）；
 * - network allowedDomains 白名单生效；
 * - shell 权限走审批流（插件不可绕过，guard 白名单拦截）；
 * - 六类权限 read/write/network/shell/knowledge/mcp 描述与图标。
 */
import { describe, expect, it } from 'vitest';
import type { AuditLogger } from '../../src/observable/audit';
import {
  describePermission,
  findPermission,
  formatPermissionList,
  hasPermission,
  isDomainAllowed,
  isKnowledgeAllowed,
  isMcpAllowed,
  isShellAllowed,
  PERMISSION_ICONS,
  PERMISSION_LABELS,
  PermissionEnforcer,
} from '../../src/plugin/permissions';
import type { PluginPermission } from '../../src/plugin/types';

// ── 权限清单展示（T4.2 验收 1：彩色图标一眼看懂）──────────────

describe('权限清单展示', () => {
  it('六类权限均有彩色图标 + 中文标签', () => {
    expect(PERMISSION_ICONS.read).toBe('📖');
    expect(PERMISSION_ICONS.write).toBe('✏️');
    expect(PERMISSION_ICONS.network).toBe('🌐');
    expect(PERMISSION_ICONS.shell).toBe('💻');
    expect(PERMISSION_ICONS.knowledge).toBe('🧠');
    expect(PERMISSION_ICONS.mcp).toBe('🔌');
    expect(PERMISSION_LABELS.shell).toBe('Shell 命令');
  });

  it('formatPermissionList：每行「图标 描述」，含范围详情', () => {
    const perms: PluginPermission[] = [
      { type: 'read', paths: ['src/'] },
      { type: 'network', allowedDomains: ['api.github.com'] },
    ];
    const list = formatPermissionList(perms);
    expect(list).toContain('📖');
    expect(list).toContain('src/');
    expect(list).toContain('🌐');
    expect(list).toContain('api.github.com');
  });

  it('formatPermissionList：空权限 → 只读提示（敏感操作一律拒绝）', () => {
    expect(formatPermissionList([])).toContain('只读模式');
  });

  it('describePermission：无范围回退通用描述', () => {
    expect(describePermission({ type: 'write' })).toBe('写入文件');
    expect(describePermission({ type: 'knowledge' })).toBe('读写知识图谱');
    expect(describePermission({ type: 'shell', allowlist: ['npm run verify'] })).toContain(
      'npm run verify',
    );
  });
});

// ── 权限声明检查 ──────────────────────────────────────────────

describe('hasPermission / findPermission', () => {
  const declared: PluginPermission[] = [
    { type: 'read', paths: ['src'] },
    { type: 'network', allowedDomains: ['api.github.com'] },
  ];

  it('已声明 → true；未声明 → false', () => {
    expect(hasPermission(declared, 'read')).toBe(true);
    expect(hasPermission(declared, 'write')).toBe(false);
    expect(hasPermission(declared, 'shell')).toBe(false);
  });

  it('findPermission 返回首个匹配项', () => {
    expect(findPermission(declared, 'network')?.type).toBe('network');
    expect(findPermission(declared, 'mcp')).toBeUndefined();
  });
});

// ── network 白名单（T4.2 验收 3）──────────────────────────────

describe('isDomainAllowed（network allowedDomains 白名单）', () => {
  it('完全匹配 → 允许', () => {
    expect(
      isDomainAllowed(
        [{ type: 'network', allowedDomains: ['api.github.com'] }],
        'https://api.github.com/repos',
      ),
    ).toBe(true);
  });

  it('子域匹配（host 以 .domain 结尾）→ 允许', () => {
    expect(
      isDomainAllowed(
        [{ type: 'network', allowedDomains: ['github.com'] }],
        'https://api.github.com/x',
      ),
    ).toBe(true);
  });

  it('未声明 network 权限 → 拒绝（fail-closed）', () => {
    expect(isDomainAllowed([{ type: 'read' }], 'https://api.github.com')).toBe(false);
    expect(isDomainAllowed([], 'https://api.github.com')).toBe(false);
  });

  it('声明 network 但无白名单 → 允许任意（显式「访问网络」）', () => {
    expect(isDomainAllowed([{ type: 'network' }], 'https://example.com')).toBe(true);
  });

  it('非法 URL / 不匹配域名 → 拒绝', () => {
    expect(
      isDomainAllowed([{ type: 'network', allowedDomains: ['api.github.com'] }], 'not a url'),
    ).toBe(false);
    expect(
      isDomainAllowed(
        [{ type: 'network', allowedDomains: ['api.github.com'] }],
        'https://evil.com',
      ),
    ).toBe(false);
  });
});

// ── shell / knowledge / mcp 白名单 ────────────────────────────

describe('isShellAllowed / isKnowledgeAllowed / isMcpAllowed', () => {
  it('shell 前缀白名单：完全匹配或命令前缀 + 空格', () => {
    const declared: PluginPermission[] = [{ type: 'shell', allowlist: ['npm run verify'] }];
    expect(isShellAllowed(declared, 'npm run verify')).toBe(true);
    expect(isShellAllowed(declared, 'npm run verify --force')).toBe(true);
    expect(isShellAllowed(declared, 'npm run lint')).toBe(false);
    expect(isShellAllowed(declared, 'rm -rf /')).toBe(false);
  });

  it('shell 未声明 → 拒绝；声明无白名单 → 允许', () => {
    expect(isShellAllowed([{ type: 'read' }], 'npm run verify')).toBe(false);
    expect(isShellAllowed([{ type: 'shell' }], 'anything')).toBe(true);
  });

  it('knowledge 权限：声明才允许', () => {
    expect(isKnowledgeAllowed([{ type: 'knowledge' }])).toBe(true);
    expect(isKnowledgeAllowed([{ type: 'read' }])).toBe(false);
  });

  it('mcp 权限：servers 白名单；未声明 → 拒绝', () => {
    expect(isMcpAllowed([{ type: 'mcp', servers: ['filesystem'] }], 'filesystem')).toBe(true);
    expect(isMcpAllowed([{ type: 'mcp', servers: ['filesystem'] }], 'github')).toBe(false);
    expect(isMcpAllowed([{ type: 'mcp' }], 'anything')).toBe(true);
    expect(isMcpAllowed([{ type: 'read' }], 'filesystem')).toBe(false);
  });
});

// ── PermissionEnforcer 运行时拦截（T4.2 验收 2/4）─────────────

describe('PermissionEnforcer（运行时权限守卫）', () => {
  it('已声明 read → guard 通过；未声明 write → 拒绝', () => {
    const enforcer = new PermissionEnforcer([{ type: 'read', paths: ['src'] }], 'demo');
    expect(enforcer.guard('read')).toBe(true);
    expect(enforcer.guard('write')).toBe(false);
  });

  it('network 白名单不通过 → 拒绝（含 detail.url）', () => {
    const enforcer = new PermissionEnforcer(
      [{ type: 'network', allowedDomains: ['api.github.com'] }],
      'demo',
    );
    expect(enforcer.guard('network', { url: 'https://api.github.com/x' })).toBe(true);
    expect(enforcer.guard('network', { url: 'https://evil.com' })).toBe(false);
  });

  it('未注册/空声明插件 → 一律拒绝（fail-closed）', () => {
    const enforcer = new PermissionEnforcer([], 'demo');
    expect(enforcer.guard('read')).toBe(false);
    expect(enforcer.guard('shell', { command: 'npm run verify' })).toBe(false);
    expect(enforcer.guard('mcp', { server: 'filesystem' })).toBe(false);
  });

  it('拒绝事件写入审计日志（kind=approval + 结构化 detail）', () => {
    const appended: Array<{ kind: string; detail: Record<string, unknown> }> = [];
    const audit: AuditLogger = {
      append: async (entry: { kind: string; detail: Record<string, unknown> }) => {
        appended.push(entry);
      },
    } as AuditLogger;
    const enforcer = new PermissionEnforcer([{ type: 'read' }], 'demo', audit);
    enforcer.guard('network', { url: 'https://evil.com' });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.kind).toBe('approval');
    expect(appended[0]?.detail.action).toBe('plugin-permission-denied');
    expect(appended[0]?.detail.plugin).toBe('demo');
    expect(appended[0]?.detail.permission).toBe('network');
  });

  it('允许时不写审计日志', () => {
    const appended: unknown[] = [];
    const audit: AuditLogger = {
      append: async (entry: unknown) => {
        appended.push(entry);
      },
    } as AuditLogger;
    const enforcer = new PermissionEnforcer([{ type: 'knowledge' }], 'demo', audit);
    expect(enforcer.guard('knowledge')).toBe(true);
    expect(appended).toHaveLength(0);
  });
});
