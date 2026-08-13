/**
 * 市场 barrel（v3.0 M4；v4.0 M4 扩展 plugins[]）。
 */

export { fetchVerifiedContent } from './download';
export {
  AgentInstaller,
  type AgentInstallerOptions,
  type AgentPackage,
  type AgentPackageDef,
  agentDefFromPackage,
  compareVersion,
  globalAgentsDir,
  type InstalledAgent,
  type InstallFailureCode,
  type InstallResult,
  parseAgentPackage,
} from './installer';
export {
  agentDefFromScaffold,
  buildScaffoldIndexJs,
  derivePermissions,
  type PromoteFailureCode,
  type PromoteOptions,
  type PromoteResult,
  promoteSkill,
} from './promote';
export {
  DEFAULT_REGISTRY_URL,
  fetchAgentContent,
  fetchMarketRegistry,
  findAgentItem,
  findPluginItem,
  listAgentItems,
  listAllItems,
  listPluginItems,
  loadBuiltinRegistry,
  parseAgentItem,
  parseMarketRegistry,
  searchPluginItems,
} from './registry';
export type {
  AgentRegistryItem,
  MarketRegistry,
  PluginRegistryItem,
  RegistryItem,
  RegistryItemBase,
  RegistryItemType,
  SkillRegistryItem,
} from './types';
export { BUILTIN_AGENT_ITEMS, BUILTIN_PLUGIN_ITEMS, BUILTIN_REGISTRY } from './types';
