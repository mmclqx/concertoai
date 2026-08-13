/**
 * 插件权限模型（v4.0 M4 / T4.2）。
 *
 * 六类权限：read / write / network（allowedDomains 白名单）/ shell / knowledge / mcp。
 * - 安装时展示权限清单（彩色图标，一眼看懂）；
 * - 运行时未声明权限 → 拒绝 + 提示 + 审计日志（fail-closed）；
 * - network allowedDomains 白名单生效（未声明域名 → 拒绝）；
 * - shell 权限走审批流（插件不可绕过，由核心审批层兜底）。
 */

import type { AuditLogger } from '../observable/audit';
import type { PluginPermission, PluginPermissionType } from './types';

/** 权限类型 → 彩色图标（安装时权限清单展示）。 */
export const PERMISSION_ICONS: Record<PluginPermissionType, string> = {
  read: '📖',
  write: '✏️',
  network: '🌐',
  shell: '💻',
  knowledge: '🧠',
  mcp: '🔌',
};

/** 权限类型 → 中文名称（权限清单展示）。 */
export const PERMISSION_LABELS: Record<PluginPermissionType, string> = {
  read: '读取',
  write: '写入',
  network: '网络',
  shell: 'Shell 命令',
  knowledge: '知识图谱',
  mcp: 'MCP 服务',
};

/** 权限类型 → 英文名称（en 字典兜底；安装清单以 i18n 键渲染为主）。 */
export const PERMISSION_LABELS_EN: Record<PluginPermissionType, string> = {
  read: 'read',
  write: 'write',
  network: 'network',
  shell: 'shell',
  knowledge: 'knowledge',
  mcp: 'mcp',
};

/** 权限范围描述（如「读取 src/ 目录」「网络 api.github.com」；无范围 → 通用描述）。 */
export function describePermission(p: PluginPermission): string {
  switch (p.type) {
    case 'read':
      return p.paths !== undefined && p.paths.length > 0
        ? `读取 ${p.paths.join('、')}`
        : '读取文件';
    case 'write':
      return p.paths !== undefined && p.paths.length > 0
        ? `写入 ${p.paths.join('、')}`
        : '写入文件';
    case 'network':
      return p.allowedDomains !== undefined && p.allowedDomains.length > 0
        ? `访问 ${p.allowedDomains.join('、')}`
        : '访问网络';
    case 'shell':
      return p.allowlist !== undefined && p.allowlist.length > 0
        ? `执行命令（白名单: ${p.allowlist.join('、')}）`
        : '执行 Shell 命令';
    case 'knowledge':
      return '读写知识图谱';
    case 'mcp':
      return p.servers !== undefined && p.servers.length > 0
        ? `调用 MCP 服务（${p.servers.join('、')}）`
        : '调用 MCP 服务';
  }
}

/** 格式化权限清单（安装时展示，每行「图标 描述」）。 */
export function formatPermissionList(permissions: PluginPermission[]): string {
  if (permissions.length === 0) {
    return '（无权限声明——只读模式，敏感操作一律拒绝）';
  }
  return permissions
    .map((p) => `  ${PERMISSION_ICONS[p.type]} ${describePermission(p)}`)
    .join('\n');
}

/** 检查插件是否声明了指定类型的权限。 */
export function hasPermission(declared: PluginPermission[], type: PluginPermissionType): boolean {
  return declared.some((p) => p.type === type);
}

/** 获取已声明的指定类型权限项（未声明返回 undefined）。 */
export function findPermission(
  declared: PluginPermission[],
  type: PluginPermissionType,
): PluginPermission | undefined {
  return declared.find((p) => p.type === type);
}

/**
 * network allowedDomains 白名单检查。
 * 域名匹配规则：完全匹配或子域匹配（api.github.com 允许 github.com 域下的 host）；
 * 未声明 network 权限 → false（fail-closed）。
 */
export function isDomainAllowed(declared: PluginPermission[], url: string): boolean {
  const perm = findPermission(declared, 'network');
  if (perm === undefined || perm.type !== 'network') {
    return false;
  }
  const domains = perm.allowedDomains ?? [];
  if (domains.length === 0) {
    // 声明了 network 但无白名单 → 允许任意（显式「访问网络」）
    return true;
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => {
    const domain = d.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** shell allowlist 白名单检查（命令前缀匹配，词边界；未声明 shell → false）。 */
export function isShellAllowed(declared: PluginPermission[], command: string): boolean {
  const perm = findPermission(declared, 'shell');
  if (perm === undefined || perm.type !== 'shell') {
    return false;
  }
  const allowlist = perm.allowlist ?? [];
  if (allowlist.length === 0) {
    return true;
  }
  const trimmed = command.trim();
  return allowlist.some((prefix) => {
    const p = prefix.trim();
    return trimmed === p || trimmed.startsWith(`${p} `);
  });
}

/** 知识图谱权限检查。 */
export function isKnowledgeAllowed(declared: PluginPermission[]): boolean {
  return hasPermission(declared, 'knowledge');
}

/** MCP 服务权限检查（servers 白名单；未声明 → false）。 */
export function isMcpAllowed(declared: PluginPermission[], server: string): boolean {
  const perm = findPermission(declared, 'mcp');
  if (perm === undefined || perm.type !== 'mcp') {
    return false;
  }
  const servers = perm.servers ?? [];
  if (servers.length === 0) {
    return true;
  }
  return servers.includes(server);
}

/**
 * 运行时权限强制器（T4.2 验收标准：运行时未声明权限被拦截 + 提示 + 审计日志）。
 *
 * 用法：每个插件一个 enforcer（声明权限 = 安装时从 plugin.json 读取），
 * 插件发起 read/write/network/shell/knowledge/mcp 操作前调用 guard()，
 * 返回 false = 拒绝（不执行）+ 写审计日志。
 */
export class PermissionEnforcer {
  constructor(
    private readonly declared: PluginPermission[],
    private readonly pluginName: string,
    private readonly audit?: AuditLogger,
  ) {}

  /**
   * 运行时权限守卫。
   *
   * 分层语义（v4.0 M4 设计修正）：
   * - 无 detail（工具调用门槛层，ToolRegistry.permissionCheck）→ 仅检查是否声明了该权限
   *   类型（粗粒度，fail-closed 于「未声明」）；白名单匹配需要具体操作对象（URL/命令/服务），
   *   门槛层拿不到，退化为声明检查；
   * - 有 detail（插件运行时 ctx.guard）→ 白名单细粒度匹配（network allowedDomains /
   *   shell allowlist / mcp servers）。
   *
   * @param type 请求的权限类型
   * @param detail 附加详情（network: { url } / shell: { command } / mcp: { server }）
   * @returns true = 允许；false = 拒绝（未声明 / 白名单不通过）
   */
  guard(
    type: PluginPermissionType,
    detail?: { url?: string; command?: string; server?: string; path?: string },
  ): boolean {
    let allowed = false;
    switch (type) {
      case 'read':
      case 'write':
        allowed = hasPermission(this.declared, type);
        break;
      case 'network':
        allowed =
          detail?.url === undefined || detail.url === ''
            ? hasPermission(this.declared, 'network')
            : isDomainAllowed(this.declared, detail.url);
        break;
      case 'shell':
        allowed =
          detail?.command === undefined || detail.command === ''
            ? hasPermission(this.declared, 'shell')
            : isShellAllowed(this.declared, detail.command);
        break;
      case 'knowledge':
        allowed = isKnowledgeAllowed(this.declared);
        break;
      case 'mcp':
        allowed =
          detail?.server === undefined || detail.server === ''
            ? hasPermission(this.declared, 'mcp')
            : isMcpAllowed(this.declared, detail.server);
        break;
    }
    if (!allowed) {
      // 审计日志：权限拒绝事件（kind=approval，detail 结构化）
      void this.audit?.append({
        kind: 'approval',
        detail: {
          action: 'plugin-permission-denied',
          plugin: this.pluginName,
          permission: type,
          ...detail,
          ts: Date.now(),
        },
      });
    }
    return allowed;
  }
}
