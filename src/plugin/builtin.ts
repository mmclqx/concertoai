/**
 * 内置 4 个示例插件内容（v4.0 M4 / T4.3/T4.1）。
 *
 * 市场条目见 src/market/types.ts BUILTIN_PLUGIN_ITEMS（sha256='builtin'）；
 * 安装时由 PluginInstaller 检测 builtin 标记 → 从本文件取内容直装（不下载）。
 * 每个插件 = plugin.json 部分 + entry（ESM 代码）。
 */

import type { Plugin } from './types';

/** 内置插件内容：plugin.json 字段 + entry 源码。 */
export interface BuiltinPluginContent {
  plugin: Plugin;
  /** ESM 入口源码（写入 index.mjs）。 */
  entry: string;
}

/** 内置插件内容表（name → 内容）。 */
export const BUILTIN_PLUGIN_CONTENTS: Record<string, BuiltinPluginContent> = {
  'git-status': {
    plugin: {
      name: 'git-status',
      version: '1.0.0',
      description: '一键查看 git 状态摘要（分支/暂存/未跟踪）',
      author: 'ConcertoAI',
      category: 'tool',
      permissions: [{ type: 'read', paths: ['.git'] }],
      entry: 'index.mjs',
    },
    entry: `// git-status 插件（内置示例）：查看 git 状态摘要
export const create = () => ({
  id: 'git-status',
  description: '一键查看 git 状态摘要（分支/暂存/未跟踪）',
  permission: 'read',
  run: async (ctx) => {
    const { execFileSync } = await import('node:child_process');
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: ctx.cwd })
      .toString().trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ctx.cwd })
      .toString().trim();
    return { branch, dirty: status.split(/\\r?\\n/).filter(Boolean).length };
  },
});
`,
  },
  'api-docs': {
    plugin: {
      name: 'api-docs',
      version: '1.0.0',
      description: '自动扫描代码生成 API 文档（Express 优先）',
      author: 'ConcertoAI',
      category: 'tool',
      permissions: [{ type: 'read', paths: ['src'] }],
      entry: 'index.mjs',
    },
    entry: `// api-docs 插件（内置示例）：扫描 Express 路由生成文档
export const create = () => ({
  id: 'api-docs',
  description: '自动扫描代码生成 API 文档（Express 优先）',
  permission: 'read',
  run: async (ctx) => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const routes = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (readFileSync(full, { encoding: 'utf8' }).includes('router.')) routes.push(full);
      }
    };
    try { walk(path.join(ctx.cwd, 'src')); } catch { /* 无 src 目录 */ }
    return { routes, count: routes.length };
  },
});
`,
  },
  'todo-tracker': {
    plugin: {
      name: 'todo-tracker',
      version: '1.0.0',
      description: '跟踪代码中 TODO/FIXME 标记并生成任务清单',
      author: 'ConcertoAI',
      category: 'tool',
      permissions: [
        { type: 'read', paths: ['src'] },
        { type: 'write', paths: ['TODO.md'] },
      ],
      entry: 'index.mjs',
    },
    entry: `// todo-tracker 插件（内置示例）：扫描 TODO/FIXME 生成任务清单
export const create = () => ({
  id: 'todo-tracker',
  description: '跟踪代码中 TODO/FIXME 标记并生成任务清单',
  permission: 'read',
  run: async (ctx) => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const todos = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (f.includes('node_modules')) continue;
        try { if (readdirSync(full)) { walk(full); continue; } } catch { /* 文件 */ }
        const text = readFileSync(full, { encoding: 'utf8' });
        for (const m of text.matchAll(/TODO|FIXME/g)) todos.push({ file: full, mark: m[0] });
      }
    };
    try { walk(path.join(ctx.cwd, 'src')); } catch { /* 无 src */ }
    return { todos, count: todos.length };
  },
});
`,
  },
  'release-helper': {
    plugin: {
      name: 'release-helper',
      version: '1.0.0',
      description: '发布辅助：版本检查 → lint/test 门禁 → 发布命令',
      author: 'ConcertoAI',
      category: 'workflow',
      permissions: [
        { type: 'read', paths: ['package.json'] },
        { type: 'shell', allowlist: ['npm run verify'] },
      ],
      entry: 'index.mjs',
    },
    entry: `// release-helper 插件（内置示例）：发布门禁检查
export const create = () => ({
  id: 'release-helper',
  description: '发布辅助：版本检查 → lint/test 门禁 → 发布命令',
  permission: 'shell', // 声明 shell 权限 → guard 通过后仍走宿主审批流（插件不可绕过）
  run: async (ctx) => {
    const { execFileSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(readFileSync(path.join(ctx.cwd, 'package.json'), 'utf8'));
    // shell 权限白名单命令（guard 由 PluginManager 拦截 + 宿主审批，fail-closed）
    execFileSync('npm', ['run', 'verify'], { cwd: ctx.cwd, stdio: 'pipe' });
    return { version: pkg.version, verified: true };
  },
});
`,
  },
};

/** 按名称获取内置插件内容（非内置返回 undefined）。 */
export function getBuiltinPluginContent(name: string): BuiltinPluginContent | undefined {
  return BUILTIN_PLUGIN_CONTENTS[name];
}
