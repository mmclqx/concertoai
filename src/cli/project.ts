/**
 * `concertoai project` 命令组（v3.1 M2 / T2.2）。
 *
 * 子命令：
 * - `concertoai project add <name> [path]`：注册项目（path 缺省用 cwd；重名报错）；
 * - `concertoai project list`：表格列出 name / path / addedAt；
 * - `concertoai project remove <name>`：卸载项目（不删除项目目录）；
 * - `concertoai project info <name>`：显示 path / whitelist / mcpServers。
 *
 * 注册表：~/.concertoai/projects.json（ProjectRegistry）。
 * 命令无副作用：add/remove 不触碰项目目录内容。
 */

import { ProjectRegistry, ProjectRegistryError } from '../store/projects';

/** project 命令选项。 */
export interface ProjectCommandOptions {
  /** 工作目录（add 缺省 path 时使用）。 */
  cwd: string;
  /** 子动作。 */
  action: 'add' | 'list' | 'remove' | 'info';
  /** 项目名（add/remove/info 必需）。 */
  name?: string;
  /** 项目路径（仅 add；缺省用 cwd）。 */
  path?: string;
  /** 注册表文件路径（测试注入；缺省 ~/.concertoai/projects.json）。 */
  registryFile?: string;
}

/** 执行 project 命令。 */
export async function runProjectCommand(options: ProjectCommandOptions): Promise<void> {
  const registry = await ProjectRegistry.load(options.registryFile);

  switch (options.action) {
    case 'add':
      await addProject(registry, options);
      break;
    case 'list':
      listProjects(registry);
      break;
    case 'remove':
      await removeProject(registry, options);
      break;
    case 'info':
      showProjectInfo(registry, options);
      break;
  }
}

/** add：注册项目（path 缺省用 cwd）；重名输出明确错误。 */
async function addProject(registry: ProjectRegistry, options: ProjectCommandOptions): Promise<void> {
  const name = options.name ?? '';
  const p = options.path ?? options.cwd;
  try {
    registry.add(name, p);
    await registry.save();
  } catch (err) {
    if (err instanceof ProjectRegistryError) {
      if (err.code === 'PROJECT_ALREADY_EXISTS') {
        console.log(`❌ 项目 ${name} 已注册，无法重复添加。`);
        return;
      }
      if (err.code === 'PROJECT_NESTED') {
        console.log(`❌ 注册失败：${err.message}`);
        return;
      }
    }
    if (err instanceof Error) {
      console.log(`❌ 注册失败：${err.message}`);
      return;
    }
    throw err;
  }
  const entry = registry.get(name);
  console.log(`✅ 项目 ${name} 已注册（${entry?.path ?? p}）`);
}

/** list：表格列出 name / path / addedAt。 */
function listProjects(registry: ProjectRegistry): void {
  const items = registry.list();
  if (items.length === 0) {
    console.log('暂无已注册项目。');
    return;
  }
  console.log('已注册项目：');
  // 简单表格：两列（name 宽度取最长，path 直接展示）
  const nameWidth = Math.max(...items.map((x) => x.name.length), 4);
  console.log(`${'名称'.padEnd(nameWidth)}  路径`);
  console.log(`${'-'.repeat(nameWidth)}  --------`);
  for (const { name, entry } of items) {
    console.log(`${name.padEnd(nameWidth)}  ${entry.path}`);
  }
  console.log(`\n注册时间：${items.map((x) => `${x.name} → ${x.entry.addedAt}`).join('；')}`);
}

/** remove：卸载项目（不删除项目目录）。 */
async function removeProject(
  registry: ProjectRegistry,
  options: ProjectCommandOptions,
): Promise<void> {
  const name = options.name ?? '';
  if (!registry.remove(name)) {
    console.log(`项目 ${name} 未注册。`);
    return;
  }
  await registry.save();
  console.log(`🗑️ 项目 ${name} 已卸载。`);
}

/** info：显示项目详情（path / whitelist / mcpServers）。 */
function showProjectInfo(registry: ProjectRegistry, options: ProjectCommandOptions): void {
  const name = options.name ?? '';
  const entry = registry.get(name);
  if (entry === undefined) {
    console.log(`项目 ${name} 未注册。`);
    return;
  }
  console.log(`项目：${name}`);
  console.log(`路径：${entry.path}`);
  console.log(`注册时间：${entry.addedAt}`);
  console.log(`白名单：${entry.whitelist !== undefined && entry.whitelist.length > 0 ? entry.whitelist.join(', ') : '（未设置，使用全局）'}`);
  console.log(
    `MCP 服务：${
      entry.mcpServers !== undefined && entry.mcpServers.length > 0
        ? entry.mcpServers.map((m) => `${m.name} (${m.command})`).join(', ')
        : '（未设置，使用全局）'
    }`,
  );
}
