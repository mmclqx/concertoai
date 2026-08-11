/**
 * `concertoai project` 命令组（v3.1 M2 / T2.2）。
 *
 * 子命令：
 * - `concertoai project add <name> [path]`：注册项目（path 缺省用 cwd；重名报错）；
 * - `concertoai project list`：表格列出 name / path / addedAt；
 * - `concertoai project remove <name>`：卸载项目（不删除项目目录）；
 * - `concertoai project info <name>`：显示 path / whitelist / mcpServers；
 * - `concertoai project switch <name>`：校验项目存在并提示用 `-p <name>` 或 cd 启动。
 *
 * 注册表：~/.concertoai/projects.json（ProjectRegistry）。
 * 命令无副作用：add/remove 不触碰项目目录内容。
 */

import chalk from 'chalk';

import { ProjectRegistry, ProjectRegistryError } from '../store/projects';

/** project 命令选项。 */
export interface ProjectCommandOptions {
  /** 工作目录（add 缺省 path 时使用）。 */
  cwd: string;
  /** 子动作。 */
  action: 'add' | 'list' | 'remove' | 'info' | 'switch';
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
      listProjects(registry, options.cwd);
      break;
    case 'remove':
      await removeProject(registry, options);
      break;
    case 'info':
      showProjectInfo(registry, options);
      break;
    case 'switch':
      switchProject(registry, options);
      break;
  }
}

/**
 * switch：校验项目存在并提示。`concertoai -p <name>` / cd 到项目目录后启动
 * 才是真正切换（preAction hook 会 chdir 到项目路径，等价 cd 后启动）。
 */
function switchProject(registry: ProjectRegistry, options: ProjectCommandOptions): void {
  const name = options.name ?? '';
  const entry = registry.get(name);
  if (entry === undefined) {
    console.log(
      `❌ 项目 ${name} 未注册。请先运行 \`concertoai project add ${name} <path>\` 注册。`,
    );
    return;
  }
  console.log(`✅ 已切换到项目 ${name}（${entry.path}）`);
  console.log(
    '提示：后续请用 `concertoai -p <name>` 或 `cd` 到该项目目录后启动 chat，以加载项目级白名单/MCP 配置。',
  );
}

/** add：注册项目（path 缺省用 cwd）；重名输出明确错误。 */
async function addProject(
  registry: ProjectRegistry,
  options: ProjectCommandOptions,
): Promise<void> {
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

/**
 * list：三列表格（名称 | 路径 | 注册时间）；当前 cwd 所在项目整行绿色高亮 + ★（当前）。
 * v3.2 M4 / T4.3：视觉升级（原两列 + 尾部注册时间 → 三列表格 + active 高亮）。
 */
function listProjects(registry: ProjectRegistry, cwd: string): void {
  const items = registry.list();
  if (items.length === 0) {
    console.log('暂无已注册项目。');
    return;
  }
  const current = registry.findByPath(cwd);
  console.log('已注册项目：');
  const nameWidth = Math.max(...items.map((x) => x.name.length), 4);
  const timeWidth = Math.max(...items.map((x) => x.entry.addedAt.length), 10);
  const pathWidth = Math.max(...items.map((x) => x.entry.path.length), 6);
  console.log(
    `${'名称'.padEnd(nameWidth + 8)}  ${'路径'.padEnd(pathWidth)}  ${'注册时间'.padEnd(timeWidth)}`,
  );
  console.log(`${'-'.repeat(nameWidth + 8)}  ${'-'.repeat(pathWidth)}  ${'-'.repeat(timeWidth)}`);
  for (const { name, entry } of items) {
    const isCurrent = current !== undefined && current.name === name;
    const nameCell = isCurrent ? `${name} ★（当前）` : name;
    const row = `${nameCell.padEnd(nameWidth + 8)}  ${entry.path.padEnd(pathWidth)}  ${entry.addedAt}`;
    console.log(isCurrent ? chalk.green(row) : row);
  }
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
  console.log(
    `白名单：${entry.whitelist !== undefined && entry.whitelist.length > 0 ? entry.whitelist.join(', ') : '（未设置，使用全局）'}`,
  );
  console.log(
    `MCP 服务：${
      entry.mcpServers !== undefined && entry.mcpServers.length > 0
        ? entry.mcpServers.map((m) => `${m.name} (${m.command})`).join(', ')
        : '（未设置，使用全局）'
    }`,
  );
}
