/**
 * 工作流运行前环境预检（v4.1 T1.4，客户评价问题 1 修复）。
 *
 * 背景：precommit 模板假设项目已配置 lint/typecheck/test 脚本与格式约定；
 * 裸项目直接 `workflow run precommit` → 第一步「Missing script: lint」就失败，
 * 客户评价「这不是开箱即用，为什么我还要先配好 biome.json、lint script？」
 *
 * 方案：run 前**静态预检**（读 package.json + node_modules/.bin 探测 + 配置
 * 文件存在性），返回缺失清单（每项含可自动初始化动作）；CLI 层展示报告并
 * 提供 Y/N 自动初始化（lint/typecheck 可自动；test 无法猜框架仅提示）。
 * 动态 `--version` 探测（专家建议 4 完整版）预留 v4.2。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Workflow } from './types';

/** 预检缺失项。 */
export interface MissingPrerequisite {
  /** 缺失类型：script（脚本缺失）/ dep（依赖未装）/ config（配置文件缺失）。 */
  kind: 'script' | 'dep' | 'config';
  /** 展示名（脚本名 / 工具名 / 配置文件名）。 */
  name: string;
  /** 缺失的 npm script 名（script 类型）。 */
  script?: string;
  /** 自动初始化动作（undefined = 不可自动，如 test 脚本）。 */
  fix?: AutoInitAction;
}

/** 自动初始化动作（CLI 层汇总后统一审批执行）。 */
export interface AutoInitAction {
  /** 要安装的 devDependency 包名（npm install -D <install>）。 */
  install?: string;
  /** 要写入的配置文件（项目相对路径 → 内容）。 */
  writeFile?: { file: string; content: string };
  /** 要注入 package.json 的 script（脚本名 → 命令）。 */
  addScript?: { name: string; command: string };
}

/** 预检结果。 */
export interface PreflightResult {
  /** 缺失项列表（空 = 环境就绪）。 */
  missing: MissingPrerequisite[];
  /** 是否完全就绪（无需任何初始化）。 */
  ok: boolean;
}

/** 提取 `npm run <script>` 引用（兼容 Windows npx.cmd 前缀不在步骤命令中出现）。 */
const NPM_RUN_RE = /\bnpm\s+run\s+([\w:-]+)/g;

/** 从步骤命令提取引用的 npm scripts（去重保序）。 */
export function extractNpmScripts(steps: Workflow['steps']): string[] {
  const scripts: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const m of step.run.matchAll(NPM_RUN_RE)) {
      const script = m[1];
      if (script !== undefined && !seen.has(script)) {
        seen.add(script);
        scripts.push(script);
      }
    }
  }
  return scripts;
}

/** 读取 package.json（不存在 / 非法 JSON → undefined）。 */
export function readPackageJson(cwd: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 检查 node_modules/.bin/<tool> 是否存在（Windows 兼容无扩展名 / .cmd / .exe）。 */
export function binExists(cwd: string, tool: string): boolean {
  const binDir = path.join(cwd, 'node_modules', '.bin');
  return [tool, `${tool}.cmd`, `${tool}.exe`].some((name) => existsSync(path.join(binDir, name)));
}

/**
 * 默认 biome.json（v4.1.1 P0 修复：biome 2.x 兼容）。
 *
 * v4.1 初版用了 biome 1.9.4 的 `$schema` + `linter.rules.recommended: true`——在 biome 2.x
 * （实测 2.5.8）下报「schema 版本不匹配（Expected 2.5.8 / Found 1.9.4）」+ `recommended`
 * 字段 deprecated，导致 preflight 自动初始化后 lint 必然失败（破坏「装完直接 run」承诺）。
 *
 * 2.x 正确写法（已实测 biome 2.5.8 校验通过）：
 * - `$schema` 指向 2.x（2.5.8；biome 对「配置 schema 版本 ≤ CLI 版本」向后兼容）
 * - `linter.rules.preset: "recommended"` 替代 deprecated 的 `recommended: true`
 * 保守配置保留：空格缩进 + LF，规避 Windows CRLF 误报（见 4.0.1 模板说明）。
 */
export function defaultBiomeJson(): string {
  return `${JSON.stringify(
    {
      $schema: 'https://biomejs.dev/schemas/2.5.8/schema.json',
      files: { ignoreUnknown: true },
      formatter: { enabled: true, indentStyle: 'space', indentWidth: 2, lineEnding: 'lf' },
      linter: { enabled: true, rules: { preset: 'recommended' } },
    },
    null,
    2,
  )}\n`;
}

/**
 * 默认 tsconfig.json（v4.1.1 P0 修复：typecheck 自动初始化生成）。
 *
 * v4.1 preflight 只装 typescript + 注入 `tsc --noEmit`，但裸项目没有 tsconfig.json →
 * tsc 无 tsconfig 时不检查文件而是打印 help（exit 1），typecheck 必然失败。
 * 这里生成精简但合理的基线（target/module 现代、strict、noEmit、skipLibCheck），
 * 保证「装完模板直接 run」typecheck 可跑通；用户后续可自行调整。
 */
export function defaultTsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'esnext',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`;
}

/** 为缺失脚本生成自动初始化动作（lint/typecheck 可自动；test 无法猜框架 → undefined）。 */
export function autoInitForScript(script: string): AutoInitAction | undefined {
  if (script === 'lint') {
    return {
      install: '@biomejs/biome',
      writeFile: { file: 'biome.json', content: defaultBiomeJson() },
      addScript: { name: 'lint', command: 'biome check .' },
    };
  }
  if (script === 'typecheck') {
    // v4.1.1 P0：同时生成 tsconfig.json——裸项目无 tsconfig 时 tsc 打印 help 而非检查文件
    return {
      install: 'typescript',
      writeFile: { file: 'tsconfig.json', content: defaultTsconfigJson() },
      addScript: { name: 'typecheck', command: 'tsc --noEmit' },
    };
  }
  return undefined; // test：无法猜 jest/vitest，仅提示
}

/**
 * 预检：解析步骤里的 `npm run <script>` → 检查脚本存在 + 关键依赖已装 + 配置文件存在。
 * 返回缺失清单（每项含可自动初始化动作，供 CLI 层展示并审批后应用）。
 */
export function checkPrerequisites(workflow: Workflow, cwd: string): PreflightResult {
  const pkg = readPackageJson(cwd);
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  const missing: MissingPrerequisite[] = [];

  const npmScripts = extractNpmScripts(workflow.steps);
  for (const script of npmScripts) {
    if (typeof scripts[script] !== 'string' || scripts[script].trim() === '') {
      missing.push({ kind: 'script', name: script, script, fix: autoInitForScript(script) });
    }
  }

  // 关键依赖探测：lint → biome；typecheck → typescript
  const wantsLint = npmScripts.includes('lint');
  const wantsTypecheck = npmScripts.includes('typecheck');
  if (wantsLint && !binExists(cwd, 'biome')) {
    missing.push({ kind: 'dep', name: 'biome', fix: { install: '@biomejs/biome' } });
  }
  if (wantsTypecheck && !binExists(cwd, 'tsc')) {
    missing.push({ kind: 'dep', name: 'typescript', fix: { install: 'typescript' } });
  }
  // 格式约定配置文件缺失（lint 走 biome check 时）
  if (wantsLint && !existsSync(path.join(cwd, 'biome.json'))) {
    missing.push({
      kind: 'config',
      name: 'biome.json',
      fix: { writeFile: { file: 'biome.json', content: defaultBiomeJson() } },
    });
  }
  // v4.1.1 P0：typecheck 需要 tsconfig.json——缺失时 tsc 打印 help 而非检查文件
  if (wantsTypecheck && !existsSync(path.join(cwd, 'tsconfig.json'))) {
    missing.push({
      kind: 'config',
      name: 'tsconfig.json',
      fix: { writeFile: { file: 'tsconfig.json', content: defaultTsconfigJson() } },
    });
  }

  // 专家细节 1（2026-08-15）：半完成状态精确化——依赖已装/配置已存在时，script 缺失项的
  // fix 裁剪掉已完成维度，只保留仍缺失的动作（避免「npm install 成功但写 JSON 失败」后
  // 下次 run 重复安装）。三维检测独立，applyAutoInit 按 fix 精确执行。
  const depMissing = new Set(missing.filter((m) => m.kind === 'dep').map((m) => m.name));
  for (const m of missing) {
    if (m.kind !== 'script' || m.fix === undefined) {
      continue;
    }
    // install 维度：该脚本对应工具已装（不在 dep 缺失清单）→ 裁掉 install
    const toolForInstall =
      m.fix.install === '@biomejs/biome'
        ? 'biome'
        : m.fix.install === 'typescript'
          ? 'tsc'
          : undefined;
    if (toolForInstall !== undefined && !depMissing.has(toolForInstall)) {
      delete m.fix.install;
    }
    // writeFile 维度：配置文件已存在 → 裁掉 writeFile
    if (m.fix.writeFile !== undefined && existsSync(path.join(cwd, m.fix.writeFile.file))) {
      delete m.fix.writeFile;
    }
  }

  return { missing, ok: missing.length === 0 };
}

/** 汇总自动初始化动作（去重）：返回唯一动作列表 + 可读的计划摘要。 */
export function summarizeAutoInit(actions: AutoInitAction[]): {
  unique: AutoInitAction[];
  commands: string[];
  writes: string[];
} {
  const installs = new Set<string>();
  const writes = new Map<string, string>();
  const scripts = new Map<string, string>();
  for (const a of actions) {
    if (a.install !== undefined) {
      installs.add(a.install);
    }
    if (a.writeFile !== undefined) {
      writes.set(a.writeFile.file, a.writeFile.content);
    }
    if (a.addScript !== undefined) {
      scripts.set(a.addScript.name, a.addScript.command);
    }
  }
  const unique: AutoInitAction[] = [];
  for (const pkg of installs) {
    unique.push({ install: pkg });
  }
  for (const [file, content] of writes) {
    unique.push({ writeFile: { file, content } });
  }
  for (const [name, command] of scripts) {
    unique.push({ addScript: { name, command } });
  }
  return {
    unique,
    commands: [...installs].map((p) => `npm install -D ${p} --no-audit --no-fund`),
    writes: [...writes.keys()],
  };
}

/**
 * 应用自动初始化动作：更新 package.json scripts / 写配置文件。
 * 返回错误信息（undefined = 成功）。注意：安装命令（install）由 CLI 层
 * 在审批后统一执行（execAsync），本函数只做文件类写入——文件写入失败回滚不落盘。
 */
export function applyAutoInitWrites(actions: AutoInitAction[], cwd: string): string | undefined {
  // 先合并所有 package.json scripts 变更，一次性读写（原子性）
  const scriptsToAdd = new Map<string, string>();
  const filesToWrite: Array<{ file: string; content: string }> = [];
  for (const a of actions) {
    if (a.addScript !== undefined) {
      scriptsToAdd.set(a.addScript.name, a.addScript.command);
    }
    if (a.writeFile !== undefined) {
      filesToWrite.push(a.writeFile);
    }
  }

  if (scriptsToAdd.size > 0) {
    const pkgPath = path.join(cwd, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
      for (const [name, command] of scriptsToAdd) {
        scripts[name] = command;
      }
      pkg.scripts = scripts;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    } catch (err) {
      return `更新 package.json 失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  for (const w of filesToWrite) {
    try {
      writeFileSync(path.join(cwd, w.file), w.content, 'utf8');
    } catch (err) {
      return `写入 ${w.file} 失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}
