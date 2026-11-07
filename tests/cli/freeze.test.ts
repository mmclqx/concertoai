/**
 * 冻结护栏测试（v5.0 T20 遗留 · `docs/FEATURE_FREEZE.md` §五「机械判定三条」代码化）。
 *
 * ## 这个文件要解决的问题
 *
 * v5.0 声明「功能冻结」后，判定「有没有人悄悄加功能」一直靠**人工核对** `FEATURE_FREEZE.md`
 * §五 的三条判据（命令数 / `src/` 一级目录 / 冻结层文件数）。人工核对的失败方式是
 * **它不会失败**：没人核对的那天，冻结层多出 5 个文件也不会有任何报警。
 *
 * 本文件把三条判据变成断言：冻结层新增 / 改名 / 消失一个文件、新冒出一级模块目录、
 * 新冒出一条命令时，`npm run verify` **必须红**，并且指名道姓说是哪个路径、哪条命令。
 *
 * ## 为什么断言逻辑放在测试里而不放进 `src/`
 *
 * 护栏代码自己也是代码。放进 `src/` 就变成「需要被护栏守护的护栏」，还得为它写测试、
 * 算进包体积与覆盖率；而它的唯一消费者就是本文件。所以 `scanFreezeLayout` / `diffLayout`
 * 留在测试内，并且**根目录可注入**——这样反向自证可以对着 tmp fixture 造违规，
 * 不必为了证明「护栏有牙」去污染真实 `src/`（那才是真事故）。
 *
 * ## 假绿的四种典型形态（每条都有对应的反向用例 / 变异探针钉住）
 *
 * | 废实现 | 症状 | 钉住它的用例 |
 * |---|---|---|
 * | 只比数量 `actual.length === baseline.length` | 改名、换文件都能过 | N2 + 变异探针 M1 |
 * | 只查缺失 `baseline.every(x => actual.includes(x))` | 塞假文件（扩写）能过 | N1 + 变异探针 M2 |
 * | 解析恒返回 `[]`（解析空转） | 「空 === 空」静默全绿 | R4 正例探针 + 变异探针 M3 |
 * | root 指错（路径写错 / 目录不在） | 读到 0 个文件却说「与基线一致」 | M4 用例 + 变异探针 M4 |
 *
 * ## 假**红**的一种典型形态（与假绿同等致命，2026-11-07 换环境实测才暴露）
 *
 * | 过窄的判定 | 症状 | 钉住它的用例 |
 * |---|---|---|
 * | 把 `src/` 下**一切**目录都当模块 | LSP 修复副本 / 它自己的集成用例在 `src/` 下建的 `.` 开头临时目录被误报成「新增一级功能目录」⇒ 并行跑全量时随机红 | N8 + 变异探针 M5 / M6 / M7 |
 *
 * 假红比假绿更早杀死护栏：假绿要等到真出事才被发现，假红会让所有人**当天**就学会
 * 「这条红了不用管」——而一条没人看的护栏等于不存在。所以隐藏条目的取舍写在
 * `isCountedEntry` 的注释里（含代价），并配三个方向的变异探针。
 *
 * 判据一句话（AGENTS「度量类实现必须有否定面 + 变异自证」）：
 * **「这个护栏如果算错，我这条测试会红吗？」** 答否就是没测。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 冻结清单基线（R5：**写死**，禁止运行时现算——现算再比对是同义反复，恒绿）
// ---------------------------------------------------------------------------

/** 冻结层目录名，与 `FEATURE_FREEZE.md` §三「三层清单」同名。 */
type FreezeLayer = 'market' | 'plugin' | 'agents' | 'lsp';

/** 冻结层遍历顺序（固定顺序，让失败信息与台账顺序一致）。 */
const FREEZE_LAYERS: readonly FreezeLayer[] = ['market', 'plugin', 'agents', 'lsp'];

/**
 * 冻结层文件清单基线（**排序后的精确清单**，不是数量）。
 *
 * 基线取证：2026-11-07 00:44 本机实测（`readdirSync` 逐目录打印），与
 * `FEATURE_FREEZE.md` §三 台账 6 / 7 / 8 / 5 **逐个吻合**。
 *
 * 维护约定（牙就在这里，代价是「正常重构也会被拦一次」）：
 * 冻结层的**合法**变更（解冻 / 加文档 / 加命令）必须**同一提交**内更新本常量，
 * 并在提交信息里写明理由；解冻还须按 `FEATURE_FREEZE.md` §七 新建 ADR。
 */
const FREEZE_FILE_BASELINE: Readonly<Record<FreezeLayer, readonly string[]>> = {
  market: ['download.ts', 'index.ts', 'installer.ts', 'promote.ts', 'registry.ts', 'types.ts'],
  plugin: [
    'builtin.ts',
    'installer.ts',
    'loader.ts',
    'manager.ts',
    'permissions.ts',
    'runtime.ts',
    'types.ts',
  ],
  agents: [
    'architect.ts',
    'coder.ts',
    'index.ts',
    'orchestrator.ts',
    'protocol.ts',
    'qa.ts',
    'registry.ts',
    'reviewer.ts',
  ],
  lsp: ['diagnostics.ts', 'framing.ts', 'index.ts', 'protocol.ts', 'server.ts'],
};

/**
 * 冻结层文件数台账（`FEATURE_FREEZE.md` §三 第二张表）。
 *
 * 这是**第二把锁**：光改上面的清单数组就能让护栏变绿（把新文件"登记"进基线），
 * 但台账数字对不上就会红——想扩写必须**连着改两处并解释**，而不是顺手消警。
 */
const FREEZE_COUNT_LEDGER: Readonly<Record<FreezeLayer, number>> = {
  market: 6,
  plugin: 7,
  agents: 8,
  lsp: 5,
};

/**
 * `src/` 一级子目录基线（23 个，2026-11-07 实测）。
 *
 * ⚠️ `agent`（单数 · 子代理）与 `agents`（复数 · 团队/市场）**并存**，所以判据必须是
 * **精确集合相等**，绝不能用 `startsWith('agent')` 之类前缀匹配——那样删掉 `agents/`
 * 也照样绿（护栏失明，且失明得很安静）。
 */
const TOP_LEVEL_DIR_BASELINE: readonly string[] = [
  'agent',
  'agents',
  'balance',
  'cli',
  'core',
  'i18n',
  'knowledge',
  'loop',
  'lsp',
  'market',
  'mcp',
  'model',
  'observable',
  'orchestrator',
  'planner',
  'plugin',
  'reviewer',
  'skill',
  'store',
  'tools',
  'ui',
  'utils',
  'workflow',
];

/**
 * 注册命令基线（26 条，2026-11-07 实测，两路互证）。
 *
 * 取证方式：① 真跑 `concertoai --help --all` 的 `Commands:` 段 ② `src/cli/index.ts`
 * 里 `.command(` 出现 26 处（`src/core/suggestion.ts` 另 2 处是 JSDoc 注释，不算注册）。
 * 断言采用 ①（真实进程）：源码里写了个没注册的名字（或注册了源码里查不到）都能被抓到。
 */
const COMMAND_BASELINE: readonly string[] = [
  'account',
  'audit',
  'balance',
  'chat',
  'check',
  'commit',
  'config',
  'doctor',
  'fix',
  'init',
  'login',
  'logout',
  'lsp',
  'plan',
  'plugin',
  'project',
  'provider',
  'reflect',
  'review',
  'run',
  'self-heal',
  'snapshot',
  'team',
  'update',
  'whoami',
  'workflow',
];

// ---------------------------------------------------------------------------
// 纯函数：扫描 + 比对（root 可注入 ⇒ 反向自证不必污染真实 src/）
//
// 刻意**不加 `export`**：biome 的 `lint/suspicious/noExportsInTest` 禁止测试文件导出
// （除 `*.test.ts` 里 `it`/`describe` 之外的导出会让「测试文件被当模块消费」成为可能）。
// 本文件的所有辅助函数只有本文件的用例在用，注入点在**参数**（`root`）而不在模块边界，
// 所以「可注入」的诉求仍然满足——反向自证改 fixture，不必改仓库。
// ---------------------------------------------------------------------------

/** 一次布局扫描的结果（全部为 posix 相对路径，见 R8）。 */
interface FreezeLayout {
  /** 冻结层 → 该层内的文件名清单（子目录以 `名字/` 结尾，让「悄悄建子目录」也可见）。 */
  readonly freezeDirs: Readonly<Record<FreezeLayer, readonly string[]>>;
  /** `src/` 下一级子目录名清单。 */
  readonly topLevelDirs: readonly string[];
}

/** 布局比对结果（`ok === false` 即冻结违规）。 */
interface FreezeDiff {
  /** 冻结层里**多出来**的路径（冻结违规：有人在扩写）。 */
  readonly added: readonly string[];
  /** 冻结层里**消失**的路径（可能是误删，也可能是解冻没更新基线）。 */
  readonly removed: readonly string[];
  /** `src/` 下新冒出来的一级功能目录（§五 判据 2）。 */
  readonly topLevelAdded: readonly string[];
  /** `src/` 下消失的一级目录。 */
  readonly topLevelRemoved: readonly string[];
  readonly ok: boolean;
  /** 人话版失败信息：差异 + 为什么算违规 + 三条处置路径（供 verify 输出直接阅读）。 */
  readonly message: string;
}

/** 反斜杠统一成 `/`：保证基线在 Windows / POSIX 上逐字相同（R8）。 */
function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/**
 * 以 `.` 开头的条目一律**不计入**布局（实测必需，不是图省事）。
 *
 * 为什么必须容忍（换环境实测抓到，2026-11-07 `LUMEN_LOCALE=en npm run verify` 3 红）：
 * `src/lsp/diagnostics.ts` 的 lint 修复副本**只能**落在项目 `src/` 下（`biome.json` 的
 * `files.includes: ['src/**']` 会忽略 `os.tmpdir()`，见该函数注释），用完即删；
 * `tests/lsp/diagnostics.test.ts` 的集成用例同样在 `src/` 下建 `.lsp-fix-itest-*`。
 * vitest 并行跑时这些目录**短暂存在**，冻结扫描恰好落在窗口内就会读到 ⇒ 护栏因为
 * 「别的测试正在正常工作」而变红。**红灯一旦不可信，护栏就没人看了**。
 *
 * 代价（写出来，不当没发生）：`src/.` 下的垃圾目录本护栏看不见。`.gitignore` 另加
 * `src/.lsp-fix-itest-*` / `src/.concertoai-lsp-fix-*` 两条，挡住「残留污染 git status」；
 * 但挡不住「留垃圾」——留下的垃圾由 `git status --ignored` 人工清理。
 * 取舍是刻意的：隐藏目录**不是功能模块**（§五 判据 2 问的是「有没有新模块」），
 * 而假红会让整条护栏失去信任。
 */
function isCountedEntry(entry: { name: string }): boolean {
  return !entry.name.startsWith('.');
}

/** 把文件名清单归一：丢弃隐藏条目 + 子目录加 `/` 后缀 + posix 化 + 排序（顺序稳定，`toEqual` 才有意义）。 */
function normalizeNames(
  entries: readonly { name: string; isDirectory: () => boolean }[],
): string[] {
  return entries
    .filter(isCountedEntry)
    .map((entry) => toPosix(entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

/**
 * 扫描一个仓库根目录下的冻结布局。
 *
 * **根目录不存在 / 冻结层目录不存在一律抛错**，绝不返回「空清单」——
 * 返回空清单会让「解析空转」与「目录被整个删掉」都显示成「与基线一致」
 * （变异探针 M4：把 root 指错，必须红，而不是「0 个文件 === 相等」）。
 */
function scanFreezeLayout(root: string): FreezeLayout {
  if (!existsSync(root)) {
    throw new Error(
      `冻结护栏扫描失败：根目录不存在（root=${root}）。路径写错时不许静默返回空清单。`,
    );
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const topLevelDirs = entries
    .filter((entry) => entry.isDirectory() && isCountedEntry(entry))
    .map((entry) => toPosix(entry.name))
    .sort();

  const freezeDirs = {} as Record<FreezeLayer, readonly string[]>;
  for (const layer of FREEZE_LAYERS) {
    const layerPath = path.join(root, layer);
    if (!existsSync(layerPath)) {
      throw new Error(
        `冻结护栏扫描失败：冻结层目录不存在 ${toPosix(path.join(root, layer))}（被删除或被改名？）。`,
      );
    }
    freezeDirs[layer] = normalizeNames(readdirSync(layerPath, { withFileTypes: true }));
  }
  return { freezeDirs, topLevelDirs };
}

/**
 * 比对实际布局与基线，产出**双向**差异（R1）。
 *
 * 双向是刻意的：只查「新增」会漏掉误删，只查「缺失」会漏掉扩写——
 * 两个方向都必须红，且失败信息要能一眼分清是哪种（前者是冻结违规，后者可能是误删）。
 */
function diffLayout(actual: FreezeLayout, baseline: FreezeLayout): FreezeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const layer of FREEZE_LAYERS) {
    const baselineSet = new Set(baseline.freezeDirs[layer]);
    const actualSet = new Set(actual.freezeDirs[layer]);
    for (const file of actual.freezeDirs[layer]) {
      if (!baselineSet.has(file)) {
        added.push(`src/${layer}/${file}`);
      }
    }
    for (const file of baseline.freezeDirs[layer]) {
      if (!actualSet.has(file)) {
        removed.push(`src/${layer}/${file}`);
      }
    }
  }
  const baselineDirs = new Set(baseline.topLevelDirs);
  const actualDirs = new Set(actual.topLevelDirs);
  const topLevelAdded = actual.topLevelDirs.filter((dir) => !baselineDirs.has(dir));
  const topLevelRemoved = baseline.topLevelDirs.filter((dir) => !actualDirs.has(dir));

  const ok =
    added.length === 0 &&
    removed.length === 0 &&
    topLevelAdded.length === 0 &&
    topLevelRemoved.length === 0;

  if (ok) {
    return { added, removed, topLevelAdded, topLevelRemoved, ok, message: '冻结层布局与基线一致' };
  }
  const lines = ['冻结护栏告警（docs/FEATURE_FREEZE.md §五 机械判定 第 2 / 3 条）：'];
  if (added.length > 0) {
    lines.push(`  新增（冻结违规）：${added.join('、')}`);
  }
  if (removed.length > 0) {
    lines.push(`  消失（可能是误删，也可能是解冻时没更新基线）：${removed.join('、')}`);
  }
  if (topLevelAdded.length > 0) {
    lines.push(`  src/ 新增一级功能目录（冻结违规）：${topLevelAdded.join('、')}`);
  }
  if (topLevelRemoved.length > 0) {
    lines.push(`  src/ 一级目录消失：${topLevelRemoved.join('、')}`);
  }
  lines.push(
    '  处置三选一：① 合法变更 → 同一提交内更新 tests/cli/freeze.test.ts 基线并写明理由（解冻还须按 §七 新建 ADR）' +
      '② 非法扩写 → 回退该文件 / 目录 ③ 误删 → 恢复文件',
  );
  return { added, removed, topLevelAdded, topLevelRemoved, ok, message: lines.join('\n') };
}

/** 命令集合比对（§五 判据 1）：多一条 / 少一条都是需要人工确认的变更。 */
function diffCommands(
  actual: readonly string[],
  baseline: readonly string[] = COMMAND_BASELINE,
): {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly ok: boolean;
} {
  const baselineSet = new Set(baseline);
  const actualSet = new Set(actual);
  const added = actual.filter((name) => !baselineSet.has(name));
  const removed = baseline.filter((name) => !actualSet.has(name));
  return { added, removed, ok: added.length === 0 && removed.length === 0 };
}

/** 把基线表装成 `FreezeLayout`（供 `diffLayout` 直接对比真实扫描结果）。 */
function baselineLayout(): FreezeLayout {
  return { freezeDirs: FREEZE_FILE_BASELINE, topLevelDirs: TOP_LEVEL_DIR_BASELINE };
}

// ---------------------------------------------------------------------------
// 真实进程：`--help --all` 的 Commands: 段（R3 / R7）
// ---------------------------------------------------------------------------

/** tsx 入口（与 `npm run dev` 等价，不依赖 dist 构建产物）。 */
const TSX_CLI = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * 起真实 CLI 进程跑 `--help --all`，返回原始输出。
 *
 * 环境必须**钉死**（R7 / AGENTS「进程级全局状态隔离」）：不钉 `LUMEN_LOCALE`
 * 就会随开发机 shell 走——本机中文、CI 英文，命令集合断言会在别人的机器上莫名其妙地红。
 * `HOME` / `USERPROFILE` 同理：入口会碰 `~/.concertoai`（迁移 / 建目录 / 读技能），
 * 不隔离就写进开发者真实 home（v5.0 T14 实测技能目录被堆了 191 个垃圾目录）。
 */
function runHelpAll(home: string): string {
  return execFileSync(process.execPath, [TSX_CLI, 'src/cli/index.ts', '--help', '--all'], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CONCERTOAI_HINTS: 'off',
      CONCERTOAI_METRICS: 'off',
      LUMEN_LOCALE: 'zh',
      HOME: home,
      USERPROFILE: home,
    },
  });
}

/**
 * 从 `--help --all` 的 `Commands:` 段解析出命令名集合。
 *
 * 解析**不许空转**：找不到 `Commands:` 段直接抛错（若哪天 commander 改了输出格式，
 * 宁可红也不要静默返回 `[]` 让「空 === 空」假绿——变异探针 M3 钉的就是这个）。
 */
function parseCommandNames(helpAll: string): string[] {
  const lines = helpAll.split(/\r?\n/);
  const start = lines.indexOf('Commands:');
  if (start < 0) {
    throw new Error('`--help --all` 输出里没有 `Commands:` 段（commander 输出格式变了？）');
  }
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      break;
    }
    const name = /^ {2}(\S+)/.exec(line)?.[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// tmp fixture：反向自证专用（**绝不**为了自证去改真实 src/）
// ---------------------------------------------------------------------------

/**
 * 造一个「与基线完全一致」的假 `src/` 目录（**注意：返回的就是 src 目录本身**）。
 *
 * 形状必须与 `scanFreezeLayout` 的入参一致——它收的是 `src/` 路径而不是仓库根
 * （实测踩过一次：fixture 造在 `root/src/` 却把 `root` 传进去，8 条反向用例
 * 全部因为「冻结层目录不存在」而红，红得对但红得没道理，等于没测）。
 *
 * 为什么要把 23 个一级目录也造出来：如果 fixture 只有 4 个冻结层目录，
 * 那它本身就与基线不一致，反向用例同样会**因为别的原因**变红。
 * 所以每条反向用例都先断言「未篡改的 fixture 与基线零差异」，再篡改，再看是不是因为篡改而红。
 */
function createSrcFixture(): string {
  const srcRoot = mkdtempSync(path.join(os.tmpdir(), 'concertoai-freeze-'));
  for (const dir of TOP_LEVEL_DIR_BASELINE) {
    mkdirSync(path.join(srcRoot, dir), { recursive: true });
  }
  // 一级文件（真实 `src/` 有 `index.ts` / `version.ts`）：不进断言，但让 fixture 形状更真
  writeFileSync(path.join(srcRoot, 'index.ts'), '// fixture\n', 'utf8');
  writeFileSync(path.join(srcRoot, 'version.ts'), '// fixture\n', 'utf8');
  for (const layer of FREEZE_LAYERS) {
    for (const file of FREEZE_FILE_BASELINE[layer]) {
      writeFileSync(path.join(srcRoot, layer, file), '// fixture\n', 'utf8');
    }
  }
  return srcRoot;
}

/** 造 fixture → 跑断言 → **无论如何**删干净（R6：护栏自己不许留垃圾）。 */
function withFixture(run: (srcRoot: string) => void): void {
  const srcRoot = createSrcFixture();
  try {
    run(srcRoot);
  } finally {
    rmSync(srcRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** 真实仓库的 `src/` 绝对路径。 */
const SRC_ROOT = path.join(process.cwd(), 'src');

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('R4 正例探针：比较之前先证明「扫描真的读到了东西」', () => {
  it('四个冻结层都非空、一级目录非空（否则「空 === 空」会静默全绿）', () => {
    // 这条用例存在的原因：所有「A 与 B 相等」的断言，在 A、B 双双为空时也会通过。
    // 先把「读到了东西」钉死，后面的精确比对才有意义。
    const layout = scanFreezeLayout(SRC_ROOT);
    for (const layer of FREEZE_LAYERS) {
      expect(
        layout.freezeDirs[layer].length,
        `冻结层 src/${layer}/ 扫描结果为空（扫描空转？）`,
      ).toBeGreaterThan(0);
    }
    expect(layout.topLevelDirs.length, 'src/ 一级目录扫描结果为空（扫描空转？）').toBeGreaterThan(
      0,
    );
    // 基线自身也必须是「有内容的」：基线被误清空时上面两条挡不住
    const baseline = baselineLayout();
    for (const layer of FREEZE_LAYERS) {
      expect(baseline.freezeDirs[layer].length, `基线 src/${layer}/ 为空`).toBeGreaterThan(0);
    }
    expect(baseline.topLevelDirs.length).toBeGreaterThan(0);
  });

  it('tsx 入口真实存在（缺了它「真跑 CLI」会以 ENOENT 失败，看不出所以然）', () => {
    expect(existsSync(TSX_CLI), `${TSX_CLI} 不存在：先 npm ci`).toBe(true);
  });
});

describe('冻结层文件清单与基线精确一致（R1 / §五 判据 3）', () => {
  for (const layer of FREEZE_LAYERS) {
    it(`src/${layer}/ 文件清单双向精确相等（禁 arrayContaining / 只比数量）`, () => {
      const actual = scanFreezeLayout(SRC_ROOT).freezeDirs[layer];
      // `toEqual` 而非 `arrayContaining` / 长度比较：只有精确清单能抓住「改名」——
      // 改名不改数量，只比 length 的护栏对改名完全失明（变异探针 M1）。
      expect(actual, `冻结层 src/${layer}/ 与基线不一致（新增=冻结违规 / 消失=可能误删）`).toEqual([
        ...FREEZE_FILE_BASELINE[layer],
      ]);
    });
  }

  it('四层合计 26 个文件，且与 §三 台账 6 / 7 / 8 / 5 逐个吻合（第二把锁）', () => {
    // 光把新文件「登记」进基线数组就能让上面四条变绿；这条要求台账数字同步，
    // 逼着「想让护栏闭嘴的人」至少连着改两处并解释——顺手消警不再可能。
    let total = 0;
    for (const layer of FREEZE_LAYERS) {
      expect(
        FREEZE_FILE_BASELINE[layer].length,
        `基线 src/${layer}/ 的文件数与 FEATURE_FREEZE.md §三 台账（${FREEZE_COUNT_LEDGER[layer]}）不符`,
      ).toBe(FREEZE_COUNT_LEDGER[layer]);
      total += FREEZE_COUNT_LEDGER[layer];
    }
    expect(total).toBe(26);
    // 真实仓库同样必须是 26（基线自我一致 ≠ 仓库一致，两件事分开断言）
    const layout = scanFreezeLayout(SRC_ROOT);
    const actualTotal = FREEZE_LAYERS.reduce(
      (sum, layer) => sum + layout.freezeDirs[layer].length,
      0,
    );
    expect(actualTotal, `四个冻结层合计 ${actualTotal} 个文件（台账 26）`).toBe(26);
  });

  it('基线自身有序且无重复（无序的基线会让「顺序变了」这种假差异变红）', () => {
    for (const layer of FREEZE_LAYERS) {
      const list = FREEZE_FILE_BASELINE[layer];
      expect(list, `基线 src/${layer}/ 未排序`).toEqual([...list].sort());
      expect(new Set(list).size, `基线 src/${layer}/ 有重复项`).toBe(list.length);
    }
  });
});

describe('src/ 一级目录集合精确相等（R2 / §五 判据 2）', () => {
  it('23 个一级功能目录一个不多一个不少（禁止前缀匹配）', () => {
    const actual = scanFreezeLayout(SRC_ROOT).topLevelDirs;
    expect(actual, 'src/ 一级目录与基线不一致（新增一级目录 = 新增模块，冻结违规）').toEqual([
      ...TOP_LEVEL_DIR_BASELINE,
    ]);
    expect(actual.length).toBe(23);
  });

  it('`agent`（子代理）与 `agents`（团队/市场）并存——两个都在，缺一即红', () => {
    // 这条挡的是「用 startsWith('agent') 判存在」这类写法：那样删掉 agents/ 也照样绿。
    const actual = new Set(scanFreezeLayout(SRC_ROOT).topLevelDirs);
    expect(actual.has('agent'), 'src/agent 消失了（子代理模块被删？）').toBe(true);
    expect(actual.has('agents'), 'src/agents 消失了（团队/市场模块被删？）').toBe(true);
    // 反过来：前缀匹配会把 `agent` 当成 `agents` 的匹配项，这里显式证明两者是独立条目
    expect(actual.size).toBe(new Set(TOP_LEVEL_DIR_BASELINE).size);
  });
});

describe('注册命令集合精确相等（R3 / §五 判据 1，真跑 CLI）', () => {
  let home: string;
  let commands: string[];

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-freeze-help-'));
    commands = parseCommandNames(runHelpAll(home));
  }, 300_000);

  it('`--help --all` 解析出 26 条命令（正例探针：解析不许空转）', () => {
    // 没有这条，下面「集合相等」在解析恒返回 [] 时会假绿（变异探针 M3 的靶子）
    expect(commands.length, 'Commands: 段解析出的命令数不对（解析空转 / 输出格式变了？）').toBe(26);
    expect(commands).toContain('chat');
    expect(commands).toContain('self-heal'); // 带连字符的名字也在：证明解析没截断
  });

  it('命令集合一个不多一个不少（多一条 = 新增功能面，少一条 = 破坏性删除）', () => {
    expect([...commands].sort(), '注册命令与冻结基线不一致（多/少都需要人工确认）').toEqual([
      ...COMMAND_BASELINE,
    ]);
  });

  it('清理临时 HOME（护栏自己不许在 /tmp 留垃圾）', () => {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    expect(existsSync(home)).toBe(false);
  });
});

describe('R8 路径归一：基线是 posix，Windows 反斜杠不许进基线', () => {
  it('基线里的每一条都是相对 posix 路径（无反斜杠、无盘符、无绝对路径）', () => {
    for (const layer of FREEZE_LAYERS) {
      for (const file of FREEZE_FILE_BASELINE[layer]) {
        expect(file, `基线含反斜杠：${file}（Windows 专用，换平台会整片红）`).not.toContain('\\');
        expect(file, `基线含绝对路径 / 盘符：${file}`).not.toMatch(/^([A-Za-z]:|\/)/);
        expect(file).not.toContain('..');
      }
    }
    for (const dir of TOP_LEVEL_DIR_BASELINE) {
      expect(dir).not.toContain('\\');
      expect(dir).not.toContain('/'); // 一级目录名里不该有分隔符
    }
  });

  it('扫描结果归一：用 path.join 拼出的反斜杠路径也会被转成正斜杠', () => {
    // 直接测 `toPosix` 的等价行为（通过扫描器观测）：Windows 上 readdir 返回的
    // `name` 本身没有分隔符，这条用「子目录后缀 + 归一」间接证明归一逻辑在链路上。
    withFixture((root) => {
      const layout = scanFreezeLayout(root);
      const flat = Object.values(layout.freezeDirs).flat();
      for (const file of flat) {
        expect(file).not.toContain('\\');
      }
      // 真仓库同样：扫描结果里不许出现反斜杠
      const real = scanFreezeLayout(SRC_ROOT);
      for (const dir of real.topLevelDirs) {
        expect(dir).not.toContain('\\');
      }
    });
  });
});

describe('R6 只读：fixture 建在临时目录、用完即删，真实仓库零写入', () => {
  it('fixture 用完目录已不存在，且真实 src/ 未被触碰', () => {
    let created = '';
    withFixture((root) => {
      created = root;
      expect(root.startsWith(os.tmpdir()), 'fixture 必须建在 tmp 里').toBe(true);
      expect(scanFreezeLayout(root).topLevelDirs.length).toBe(23);
    });
    expect(existsSync(created), 'fixture 目录没被清理（try/finally 失效？）').toBe(false);
    // 真实仓库仍是 26 个冻结层文件：证明整套反向自证没有污染 src/
    const layout = scanFreezeLayout(SRC_ROOT);
    const total = FREEZE_LAYERS.reduce((sum, layer) => sum + layout.freezeDirs[layer].length, 0);
    expect(total).toBe(26);
  });
});

describe('M4 根目录指错必须报错（不许「0 个文件 === 相等」）', () => {
  it('root 不存在时抛错，而不是静默返回空清单', () => {
    // 「解析空转」的最常见来源不是正则写错，而是**路径写错**：root 指到一个不存在
    // 的目录 → readdir 抛错或返回空 → 「空清单与空清单相等」→ 全绿。必须抛错。
    expect(() =>
      scanFreezeLayout(path.join(os.tmpdir(), 'concertoai-freeze-not-exist-xyz')),
    ).toThrow(/根目录不存在/);
  });

  it('冻结层目录被整个删掉时抛错（指名道姓，不冒充「该层空清单」）', () => {
    withFixture((root) => {
      expect(
        diffLayout(scanFreezeLayout(root), baselineLayout()).ok,
        '未篡改的 fixture 必须零差异',
      ).toBe(true);
      rmSync(path.join(root, 'lsp'), { recursive: true, force: true });
      expect(() => scanFreezeLayout(root)).toThrow(/lsp/);
    });
  });
});

// ---------------------------------------------------------------------------
// 反向自证 N1–N7（核心：证明护栏有牙）
//
// 每条用例的写法固定为三步：① 未篡改的 fixture 必须零差异（证明基线可用）
// ② 施加一处刻意违规 ③ 必须红，且**红在正确的位置**（信息里点名那个路径）。
// 只断言 `ok === false` 是不够的——它也可能是「因为别的原因」红的。
// ---------------------------------------------------------------------------

describe('反向自证 N1–N6：护栏必须红（配变异探针验证有牙）', () => {
  it('N1 往 src/market/ 塞一个 extra.ts → 红，并点名 src/market/extra.ts【变异探针 M2】', () => {
    // 变异探针 M2：把 R1 退化成「只查缺失」`baseline.every(x => actual.includes(x))`
    // ⇒ 本条必须变红（塞了文件却查不出来）。改回 ⇒ 绿。
    withFixture((root) => {
      expect(diffLayout(scanFreezeLayout(root), baselineLayout()).ok).toBe(true);
      writeFileSync(path.join(root, 'market', 'extra.ts'), '// 违规扩写\n', 'utf8');
      const diff = diffLayout(scanFreezeLayout(root), baselineLayout());
      expect(diff.ok, '给冻结层加文件却判绿 = 护栏失明').toBe(false);
      expect(diff.added).toEqual(['src/market/extra.ts']);
      expect(diff.message).toContain('src/market/extra.ts');
      expect(diff.message).toContain('冻结违规');
      expect(diff.message).toContain('FEATURE_FREEZE.md');
    });
  });

  it('N2 把 src/plugin/types.ts 改名 → 红（**数量没变**也必须红）【变异探针 M1】', () => {
    // 变异探针 M1：把 R1 退化成「只比数量」`actual.length === baseline.length`
    // ⇒ 本条必须变红（改名不改数量，长度比较完全看不出）。改回 ⇒ 绿。
    withFixture((root) => {
      expect(diffLayout(scanFreezeLayout(root), baselineLayout()).ok).toBe(true);
      const before = readdirSync(path.join(root, 'plugin')).length;
      rmSync(path.join(root, 'plugin', 'types.ts'));
      writeFileSync(path.join(root, 'plugin', 'types-renamed.ts'), '// 改名\n', 'utf8');
      expect(readdirSync(path.join(root, 'plugin')).length, '前置：数量必须不变').toBe(before);
      const diff = diffLayout(scanFreezeLayout(root), baselineLayout());
      expect(diff.ok, '改名后数量没变就判绿 = 只数个数').toBe(false);
      expect(diff.added).toEqual(['src/plugin/types-renamed.ts']);
      expect(diff.removed).toEqual(['src/plugin/types.ts']);
    });
  });

  it('N3 删掉 src/lsp/server.ts → 红（防「只查增不查减」）', () => {
    withFixture((root) => {
      expect(diffLayout(scanFreezeLayout(root), baselineLayout()).ok).toBe(true);
      rmSync(path.join(root, 'lsp', 'server.ts'));
      const diff = diffLayout(scanFreezeLayout(root), baselineLayout());
      expect(diff.ok, '冻结层文件消失却判绿 = 只查新增').toBe(false);
      expect(diff.removed).toEqual(['src/lsp/server.ts']);
      expect(diff.message).toContain('误删');
    });
  });

  it('N4 在 src/ 下新建一级目录 foo/ → 红（§五 判据 2）', () => {
    withFixture((root) => {
      expect(diffLayout(scanFreezeLayout(root), baselineLayout()).ok).toBe(true);
      mkdirSync(path.join(root, 'foo'));
      const diff = diffLayout(scanFreezeLayout(root), baselineLayout());
      expect(diff.ok, '冒出一级功能目录却判绿 = 只盯着 4 个冻结层').toBe(false);
      expect(diff.topLevelAdded).toEqual(['foo']);
      expect(diff.message).toContain('新增一级功能目录');
    });
  });

  it('N8 隐藏目录不算模块 → 不红；再加一个非隐藏目录 → 仍红（两个方向一起钉）【变异探针 M5】', () => {
    // 这条守的是 2026-11-07 换环境实测（`LUMEN_LOCALE=en npm run verify`）暴露的**真实假红**：
    // LSP 修复副本（`src/lsp/diagnostics.ts`）与它自己的集成用例
    // （`tests/lsp/diagnostics.test.ts`）都会在 `src/` 下建 `.` 开头的临时目录，
    // vitest 并行跑时短暂存在，冻结扫描撞进窗口就误报「新增一级功能目录」。
    // 故隐藏条目必须**不计入**（见 `isCountedEntry` 注释里的取舍与代价）。
    //
    // 三个变异探针钉三条不同的歪路（都实测过，结果表见执行日志）：
    // - **M5**：`isCountedEntry` 改成恒 `false`（过滤放宽到「全部忽略」）⇒ 本条红
    //   （未篡改的 fixture 都不再零差异），**且全文件 17 红**——说明这条用例是「全忽略」的靶子，
    //   而不是唯一的靶子。
    // - **M6**：冻结层归一那条链路去掉 `.filter(isCountedEntry)`（退回修复前写法）⇒ 本条红。
    //   第一版 N8 **没**覆盖冻结层内部，M6 实测是**全绿**——「一级目录那半边拦不住冻结层那半边」，
    //   补上 `market/.tmp-workspace` 那两行断言后才变红。
    // - **M7**：一级目录扫描去掉过滤（退回修复前写法，即假红根因）⇒ 本条红。
    // 只断言「隐藏被忽略」是不够的——那种写法在「全忽略」的废实现下照样绿。
    withFixture((root) => {
      expect(
        diffLayout(scanFreezeLayout(root), baselineLayout()).ok,
        '未篡改的 fixture 必须零差异',
      ).toBe(true);

      mkdirSync(path.join(root, '.lsp-fix-itest-abc123'));
      // 冻结层**内部**也塞一个隐藏目录：`normalizeNames` 这条链路必须同样忽略它。
      // 缺这一条时实测（变异探针 M6）「退回到不过滤隐藏条目」仍然全绿——一级目录那半边
      // 拦不住冻结层那半边，两处过滤得分别钉。
      mkdirSync(path.join(root, 'market', '.tmp-workspace'));
      const withHidden = diffLayout(scanFreezeLayout(root), baselineLayout());
      expect(withHidden.ok, '隐藏临时目录被当成新模块 = 假红（护栏自身失信）').toBe(true);
      expect(withHidden.topLevelAdded).toEqual([]);
      const layout = scanFreezeLayout(root);
      expect(layout.topLevelDirs).not.toContain('.lsp-fix-itest-abc123');
      expect(
        layout.freezeDirs.market,
        '冻结层里冒出的隐藏目录被当成了新文件（`market/.tmp-workspace/`）',
      ).not.toContain('.tmp-workspace/');

      // 反方向钉：非隐藏目录必须照样红（否则「全部忽略」式废实现能混过去）
      mkdirSync(path.join(root, 'foo'));
      const withFoo = diffLayout(scanFreezeLayout(root), baselineLayout());
      expect(withFoo.ok, '非隐藏的一级目录也被忽略 = 过滤条件放得太宽').toBe(false);
      expect(withFoo.topLevelAdded).toEqual(['foo']);
    });
  });

  it('N5 命令集合多一条 deploy / 少一条 check → 各红（§五 判据 1）', () => {
    const added = diffCommands([...COMMAND_BASELINE, 'deploy']);
    expect(added.ok, '多出一条命令却判绿').toBe(false);
    expect(added.added).toEqual(['deploy']);
    expect(added.removed).toEqual([]);

    const removed = diffCommands(COMMAND_BASELINE.filter((name) => name !== 'check'));
    expect(removed.ok, '少了一条命令却判绿').toBe(false);
    expect(removed.removed).toEqual(['check']);
    expect(removed.added).toEqual([]);

    // 正例：原样不动必须绿（否则上面两条只是「恒红」，同样没有证据力）
    expect(diffCommands([...COMMAND_BASELINE]).ok).toBe(true);
  });

  it('N6 基线里写错一个文件名（模拟基线过期）→ 红（证明基线真被比较，不是装饰）', () => {
    withFixture((root) => {
      const stale: FreezeLayout = {
        freezeDirs: {
          ...FREEZE_FILE_BASELINE,
          lsp: [...FREEZE_FILE_BASELINE.lsp.filter((f) => f !== 'framing.ts'), 'framing-old.ts'],
        },
        topLevelDirs: TOP_LEVEL_DIR_BASELINE,
      };
      const diff = diffLayout(scanFreezeLayout(root), stale);
      expect(diff.ok, '基线写错却判绿 = 根本没比内容').toBe(false);
      expect(diff.added).toEqual(['src/lsp/framing.ts']);
      expect(diff.removed).toEqual(['src/lsp/framing-old.ts']);
    });
  });
});

describe('N7 正例：真实仓库与基线零差异（护栏一上来就红 = 没护栏）', () => {
  it('真实 src/ 布局与基线完全一致，且失败信息为空差异态', () => {
    const diff = diffLayout(scanFreezeLayout(SRC_ROOT), baselineLayout());
    // 失败时把完整 message 打出来，省得只看到「expected false to be true」
    expect(diff.message).toBe('冻结层布局与基线一致');
    expect(diff.ok).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.topLevelAdded).toEqual([]);
    expect(diff.topLevelRemoved).toEqual([]);
  });
});
