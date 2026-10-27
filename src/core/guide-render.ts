/**
 * 双输出渲染器（v5.0 T5）：一份分析 → 两份指南。
 *
 * - `renderAgentsMd`      → AGENTS.md（给 AI：项目是什么 + 怎么改不踩坑）
 * - `renderProjectGuide`  → PROJECT_GUIDE.md（给人：哪里最脆弱 / 改哪易连锁 / 怎么跑通）
 *
 * **核心差异（与 Carbon 的 CARBON.md 的分水岭）**：
 * Carbon 只告诉 AI「项目是什么」；这里额外产出一份**给人看**的指南——
 * 这正是「AI 与人的双向守护」定位的落点。
 *
 * **G7 证据硬约束**：任何结论性描述都必须附 `文件:行号`；
 * 无证据时写「未检测到（扫描范围：N 个文件）」，**禁止编造**。
 */

import type { Evidence, ProjectProfile } from './project-scan';

/** 无证据占位文案（统一措辞，测试断言点）。 */
export function notDetected(profile: ProjectProfile): string {
  const extra =
    profile.truncated === true ? `，已达扫描上限 ${profile.scannedFiles} 个文件（结果不完整）` : '';
  return `未检测到（扫描范围：${profile.scannedFiles} 个文件${extra}）`;
}

/** 风险类别 → 人话（用于「最脆弱的地方」）。 */
const RISK_LABEL: Record<string, string> = {
  network: '网络调用',
  timeout: '超时/中断控制',
  env: '环境变量依赖',
  delete: '删除操作',
  write: '文件写入',
  auth: '鉴权/会话',
  todo: '技术债',
};

/** 取某类别证据。 */
function byKind(profile: ProjectProfile, kind: string): Evidence[] {
  return profile.riskyCalls.filter((e) => e.kind === kind);
}

/** 证据行 → markdown 列表项（`文件:行号 — 说明`）。 */
function evidenceLine(e: Evidence, note?: string): string {
  const line = `\`${e.file}:${e.line}\``;
  const snippet = e.text.replace(/\|/g, '\\|');
  return note === undefined ? `- ${line} — \`${snippet}\`` : `- ${line} — ${note}：\`${snippet}\``;
}

/** 常用命令表（按 scripts 实际存在性列出）。 */
function scriptRows(profile: ProjectProfile): string[] {
  const wanted = ['install', 'dev', 'start', 'build', 'test', 'lint', 'typecheck', 'verify'];
  const rows: string[] = [];
  for (const name of wanted) {
    const cmd = profile.scripts[name];
    if (cmd !== undefined) {
      rows.push(`| \`npm run ${name}\` | \`${cmd}\` |`);
    }
  }
  // 其余脚本也列出（不遗漏自定义流程）
  for (const [name, cmd] of Object.entries(profile.scripts)) {
    if (!wanted.includes(name)) {
      rows.push(`| \`npm run ${name}\` | \`${cmd}\` |`);
    }
  }
  return rows;
}

/**
 * 渲染 AGENTS.md（给 AI）。
 *
 * 结构：项目定位 / 技术栈 / 常用命令 / 目录 / 入口 / 守护要点 / 技术债 / 生成说明。
 */
export function renderAgentsMd(profile: ProjectProfile): string {
  const L: string[] = [];
  L.push('# AGENTS.md');
  L.push('');
  L.push('> 本文件由 `concertoai init` 分析生成，供 AI 编码助手阅读。');
  L.push('> 每条结论均基于真实扫描，带 `文件:行号` 证据；无证据处标注「未检测到」。');
  L.push('> 可手工修改：修改后本文件优先于自动生成内容。');
  L.push('');

  // ── 项目定位 ──
  L.push('## 项目定位');
  L.push('');
  if (profile.description !== undefined && profile.description !== '') {
    L.push(`**${profile.name ?? '（未命名）'}**：${profile.description}`);
  } else if (profile.name !== undefined) {
    L.push(`**${profile.name}**（package.json 未提供 description，建议补充一句项目定位）`);
  } else {
    L.push(`⚠️ 未找到 package.json：${notDetected(profile)}`);
  }
  L.push('');

  // ── 技术栈 ──
  L.push('## 技术栈');
  L.push('');
  if (profile.deps.length === 0 && profile.devDeps.length === 0) {
    L.push(`运行时依赖：${notDetected(profile)}`);
  } else {
    L.push(
      `- 运行时依赖（${profile.deps.length}）：${profile.deps.length === 0 ? '无' : profile.deps.join('、')}`,
    );
    L.push(
      `- 开发依赖（${profile.devDeps.length}）：${profile.devDeps.length === 0 ? '无' : profile.devDeps.join('、')}`,
    );
  }
  const stacks: string[] = [];
  if (profile.config.hasTsconfig) stacks.push('TypeScript（tsconfig.json）');
  if (profile.config.hasBiome) stacks.push('Biome');
  if (profile.config.hasEslint) stacks.push('ESLint');
  if (profile.config.hasCi) stacks.push('CI（.github/workflows 或 .gitlab-ci.yml）');
  if (stacks.length > 0) {
    L.push(`- 工程配置：${stacks.join('、')}`);
  }
  L.push('');

  // ── 常用命令 ──
  L.push('## 常用命令');
  L.push('');
  const rows = scriptRows(profile);
  if (rows.length === 0) {
    L.push(`未检测到 npm scripts：${notDetected(profile)}`);
  } else {
    L.push('| 命令 | 实际执行 |');
    L.push('| --- | --- |');
    L.push(...rows);
  }
  L.push('');

  // ── 目录与入口 ──
  L.push('## 目录结构（顶层）');
  L.push('');
  L.push(
    profile.topDirs.length === 0
      ? `未检测到顶层目录：${notDetected(profile)}`
      : profile.topDirs.map((d) => `- \`${d}/\``).join('\n'),
  );
  L.push('');
  L.push('## 入口文件');
  L.push('');
  L.push(
    profile.entryFiles.length === 0
      ? `未检测到入口文件：${notDetected(profile)}`
      : profile.entryFiles.map((f) => `- \`${f}\``).join('\n'),
  );
  L.push('');

  // ── 守护要点（AI 视角）──
  L.push('## 守护要点（改动前请确认）');
  L.push('');
  const risky: string[] = [];
  for (const kind of ['auth', 'delete', 'write', 'network', 'timeout', 'env']) {
    const list = byKind(profile, kind);
    if (list.length === 0) {
      continue;
    }
    risky.push(
      `### ${RISK_LABEL[kind] ?? kind}（${list.length} 处，示例 ${Math.min(list.length, 3)}）`,
    );
    risky.push('');
    risky.push(...list.slice(0, 3).map((e) => evidenceLine(e)));
    risky.push('');
  }
  L.push(
    risky.length === 0 ? `未检测到已知风险模式：${notDetected(profile)}` : risky.join('\n').trim(),
  );
  L.push('');
  L.push('### 改动影响面');
  L.push('');
  if (profile.mostImported.length === 0) {
    L.push('未检测到被多处引用的文件（依赖关系简单）');
  } else {
    L.push('以下文件被多个模块引用，修改需格外谨慎：');
    L.push('');
    for (const item of profile.mostImported.slice(0, 5)) {
      L.push(`- \`${item.file}\` — 被 ${item.count} 个文件引用`);
    }
  }
  L.push('');

  // ── 技术债 ──
  L.push('## 技术债（TODO / FIXME）');
  L.push('');
  if (profile.todos.length === 0) {
    L.push(`未检测到 TODO/FIXME：${notDetected(profile)}`);
  } else {
    L.push(`共 ${profile.todos.length} 处（示例前 ${Math.min(profile.todos.length, 5)} 条）：`);
    L.push('');
    L.push(...profile.todos.slice(0, 5).map((e) => evidenceLine(e)));
  }
  L.push('');

  // ── 提交前检查 ──
  L.push('## 提交前检查');
  L.push('');
  if (profile.scripts.verify !== undefined) {
    L.push('- 运行 `npm run verify`（本项目已配置一站式检查）');
  } else {
    const has = ['build', 'lint', 'typecheck', 'test'].filter(
      (s) => profile.scripts[s] !== undefined,
    );
    L.push(
      has.length === 0
        ? '- ⚠️ 未检测到任何检查脚本，建议先补充 build/lint/test'
        : `- 依次运行：${has.map((s) => `\`npm run ${s}\``).join(' / ')}`,
    );
  }
  L.push('- 高风险改动（鉴权 / 删除 / 写入 / 网络超时）建议先在 `concertoai chat` 里用 `/review`');
  L.push('');

  return L.join('\n');
}

/**
 * 渲染 PROJECT_GUIDE.md（给人）。
 *
 * 三大章节（专家建议三的核心）：
 * 1. 这个项目最脆弱的地方（带证据）
 * 2. 改哪里最容易引发连锁反应（被依赖最多的文件）
 * 3. 如何快速跑通本地环境（脚本推导）
 */
export function renderProjectGuide(profile: ProjectProfile): string {
  const L: string[] = [];
  L.push('# PROJECT_GUIDE.md — 给人类开发者的上手指南');
  L.push('');
  L.push('> 本文件由 `concertoai init` 分析生成。与 `AGENTS.md` 同源（一次分析、两份输出）：');
  L.push('> AGENTS.md 给 AI 读，本文件给你读。**建议先看「最脆弱的地方」。**');
  L.push('>');
  L.push('> 每条结论都带 `文件:行号` 证据，可直接跳转核对；无证据处标注「未检测到」。');
  L.push('');

  // ── 一句话说明 ──
  L.push('## 这是什么项目');
  L.push('');
  if (profile.description !== undefined && profile.description !== '') {
    L.push(`${profile.name ?? ''}：${profile.description}`);
  } else {
    L.push(
      `${profile.name ?? '（未命名项目）'}（package.json 未提供 description）　共扫描 ${profile.scannedFiles} 个源码文件。`,
    );
  }
  L.push('');

  // ══ 章节 1：最脆弱的地方 ══
  L.push('## 一、这个项目最脆弱的地方');
  L.push('');
  L.push('> 「脆弱」= 改错后果明显、但代码里不显眼的地方。按风险从高到低排列。');
  L.push('');
  const orderedKinds = ['auth', 'delete', 'write', 'network', 'timeout', 'env'];
  let anyRisk = false;
  for (const kind of orderedKinds) {
    const list = byKind(profile, kind);
    if (list.length === 0) {
      continue;
    }
    anyRisk = true;
    L.push(`### ${RISK_LABEL[kind] ?? kind}`);
    L.push('');
    L.push(...list.slice(0, 3).map((e) => evidenceLine(e)));
    L.push('');
  }
  if (!anyRisk) {
    L.push(notDetected(profile));
    L.push('');
  }

  // ══ 章节 2：连锁反应区 ══
  L.push('## 二、改哪里最容易引发连锁反应');
  L.push('');
  if (profile.mostImported.length === 0) {
    L.push(`未检测到被多处 import 的本地文件（依赖关系简单）：${notDetected(profile)}`);
  } else {
    L.push('以下文件被多个模块直接引用，改动它们的影响面最大：');
    L.push('');
    L.push('| 文件 | 被引用文件数 | 风险提示 |');
    L.push('| --- | --- | --- |');
    for (const item of profile.mostImported) {
      const hint = item.count >= 8 ? '⚠️ 高频引用，改签名前先全局搜索' : '改签名前先搜索调用方';
      L.push(`| \`${item.file}\` | ${item.count} | ${hint} |`);
    }
  }
  L.push('');

  // ══ 章节 3：跑通本地环境 ══
  L.push('## 三、如何快速跑通本地环境');
  L.push('');
  const steps: string[] = [];
  const depManager = profile.config.hasLockfile
    ? '项目含 lockfile，请使用 npm install（不要混用包管理器）'
    : undefined;
  if (profile.scripts.install !== undefined) {
    steps.push('1. 安装依赖：`npm run install`');
  } else {
    steps.push('1. 安装依赖：`npm install`');
  }
  if (depManager !== undefined) {
    steps.push(`   - ${depManager}`);
  }
  const devScript = profile.scripts.dev ?? profile.scripts.start;
  if (devScript !== undefined) {
    steps.push(`2. 启动开发：\`npm run ${profile.scripts.dev !== undefined ? 'dev' : 'start'}\``);
  } else {
    steps.push('2. 启动开发：未检测到 dev/start 脚本，请查看 README 或自行确认入口');
  }
  if (profile.scripts.test !== undefined) {
    steps.push('3. 跑测试：`npm run test`');
  } else {
    steps.push('3. 跑测试：未检测到 test 脚本');
  }
  if (profile.scripts.verify !== undefined) {
    steps.push('4. 提交前全量检查：`npm run verify`');
  } else {
    const has = ['build', 'lint', 'typecheck'].filter((s) => profile.scripts[s] !== undefined);
    if (has.length > 0) {
      steps.push(`4. 提交前检查：${has.map((s) => `\`npm run ${s}\``).join(' / ')}`);
    } else {
      steps.push('4. 提交前检查：未检测到 build/lint/typecheck 脚本（建议补充）');
    }
  }
  L.push(...steps);
  L.push('');
  if (profile.entryFiles.length > 0) {
    L.push(`入口文件：${profile.entryFiles.map((f) => `\`${f}\``).join('、')}`);
    L.push('');
  }

  // ── 附加：技术债 ──
  if (profile.todos.length > 0) {
    L.push('## 附加：已知技术债（TODO / FIXME）');
    L.push('');
    L.push(`共 ${profile.todos.length} 处，示例：`);
    L.push('');
    L.push(...profile.todos.slice(0, 5).map((e) => evidenceLine(e)));
    L.push('');
  }

  // ── 结尾建议 ──
  //
  // ⚠️ 硬约束（AGENTS 规则 15，v4.1.1「装好却跑不通」教训）：这里只能推荐**当前版本真实存在**的命令。
  // 历史问题：曾写 `concertoai check / fix / commit / review`，但这些 CLI 动词直到 v5.0 M4
  // 才落地，用户照做只会看到 `unknown command`。M4（T15-T18）完成后由 T19 护栏统一改回动词形式。
  L.push('## 建议工作流');
  L.push('');
  L.push('- 接手陌生模块：先看上面「最脆弱的地方」，再看「连锁反应区」');
  L.push('- 改高风险代码前：`concertoai chat` 里用 `/review <file>`（9 维审查，带证据）');
  L.push('- 提交前：按上面第三节第 4 步跑项目自己的检查脚本');
  L.push('- 构建/测试报错：`concertoai self-heal`（解析 verify 输出并尝试修复）');
  L.push('');

  return L.join('\n');
}

/** 摘要（生成后打印给用户，≤6 行，不要求读全文）。 */
export function renderSummary(
  profile: ProjectProfile,
  agentsPath: string,
  guidePath: string,
): string[] {
  const riskyCount = profile.riskyCalls.filter((e) =>
    ['auth', 'delete', 'write'].includes(e.kind),
  ).length;
  const chain = profile.mostImported[0];
  return [
    '✨ 分析完成！生成了两份文件：',
    `- ${agentsPath}（供 ConcertoAI 阅读与执行）`,
    `- ${guidePath}（供人类开发者阅读，建议花 1 分钟看「一、这个项目最脆弱的地方」）`,
    `扫描范围：${profile.scannedFiles} 个源码文件${
      profile.truncated ? '（已达上限，结果不完整）' : ''
    }`,
    riskyCount > 0
      ? `⚠️ 检测到 ${riskyCount} 处高风险调用（鉴权/删除/写入），已在指南中附具体行号`
      : '✅ 未检测到鉴权/删除/写入类高风险调用',
    chain === undefined
      ? '依赖关系简单：没有文件被多处引用'
      : `连锁风险最高：\`${chain.file}\` 被 ${chain.count} 个文件引用`,
  ];
}
