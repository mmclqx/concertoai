/**
 * 全局安装冒烟（G1 / 原 T4.1）——**验证 bin 垫片真的能跑**，而不只是「包能装」。
 *
 * ## 这个脚本为什么被重写（2026-11-13）
 *
 * v5.1.0 发布时只做了「临时目录 `npm install` + 直接 `node dist/cli/index.js`」。
 * 那证明了「代码进没进包」，但**没证明用户 `npm i -g` 之后敲的 `concertoai` / `ccai`
 * 两个命令能不能跑**——而发布日志里恰好有 `bin[concertoai] script name was cleaned`
 * 两条告警。这就是 G1 的缺口：**bin 垫片（shim）与包内容是两个不同的失败面**。
 *
 * ## 旧版的三个问题（本文件已修）
 *
 * 1. 要求**当前目录**已有 `.tgz`（换个目录就 throw）；
 * 2. 结束时 `unlinkSync(tgz)` —— 会**删掉仓库里真实的 tarball**；
 * 3. 只 `console.log`、**零断言**（`--help` 打了什么都没判），只测 `concertoai` 不测
 *    `ccai`、不测退出码、不测错误路径 ⇒ 「冒烟通过」只是一句话，不是证据。
 *
 * ## 两种模式
 *
 * ```
 * node scripts/smoke-install.mjs                    # 本地 tarball（npm pack 到临时目录，离线可用）
 * node scripts/smoke-install.mjs --registry 5.1.0    # 装线上包（发布后的真机证明）
 * node scripts/smoke-install.mjs --keep              # 保留临时前缀供排查
 * ```
 *
 * 退出码：全绿 `0`；任一条失败 `1`（便于接 CI）。**刻意不接进 `npm run verify`**：
 * registry 模式需要网络、且会写全局前缀，属于发布门而不是单测。
 *
 * ## 五条断言（G1 判据；④ 拆 a/b，因为 `--bogus` 客观上没有候选可建议）
 *
 * | # | 断言 | 为什么这么造 |
 * |---|---|---|
 * | ⓪ | 探针通电：两个垫片存在且非空 + 安装包 version = 期望版本 | 否则「四条全过」可能是 PATH 上别的东西接住了命令 |
 * | ① | `concertoai --version` = 期望版本 | 期望值**不硬编码**：本地模式取 `package.json`，registry 模式取请求的版本 |
 * | ② | `ccai --version` = 同一版本 | `ccai` 是**第二入口**，旧脚本从没测过 |
 * | ③ | `concertoai chat --help` 含 `--auto-low` | 同时断言**不含** `--bogus`，防「help 打了一堆东西就算过」 |
 * | ④a | `chat --auto-lo` ⇒ exit 1 **且**给建议 | 有候选时必须给「你是不是想输入 `--auto-low`？」 |
 * | ④b | `--bogus` ⇒ exit 1 **且**给兜底、**不瞎猜** | 无候选时不许出现「你是不是想输入」（编辑距离那个坑的否定面） |
 *
 * ## 必须避开的取证陷阱（我自己踩过两次）
 *
 * 本脚本**完全不用 shell**：所有子进程走 `spawnSync(cmd, args)`，直接取 `status`
 * （真实退出码）。不用 `& echo %errorlevel%`（cmd 在**解析整行时**就展开，拿到的是
 * 上一条命令的残留值），也不用 PowerShell 的 `$LASTEXITCODE`（命令没真跑时是残留值）。
 * 唯一的例外是 Windows 执行 `.cmd` 垫片——那必须经 `cmd /d /s /c`，且路径要加双引号
 * 以容纳空格（`C:\Users\John Doe\…`）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/** 解析命令行参数（手写，不为 4 个开关引入依赖）。 */
function parseArgs(argv) {
  const opts = { registry: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--registry') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--registry 需要一个版本号，例如：--registry 5.1.0');
      }
      opts.registry = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: node scripts/smoke-install.mjs [--registry <version>] [--keep]',
          '',
          '  默认            打包当前仓库为 tarball 并全局安装到临时前缀（离线）',
          '  --registry <v>  改为安装 registry 上的 @concertoai/cli@<v>（发布后真机证明）',
          '  --keep          保留临时前缀（排查失败现场用）',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`不认识的参数：${arg}（--help 看用法）`);
    }
  }
  return opts;
}

/** 定位 npm 的 CLI 入口：直接用 node 跑它，彻底绕开 shell 与 .cmd 垫片。 */
function resolveNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error('找不到 npm-cli.js；请确认 npm 与 node 装在同一前缀下');
  }
  return found;
}

const NPM_CLI = resolveNpmCli();

/**
 * 跑一个子进程并返回 `{ code, out }`。
 *
 * `code` 取 `spawnSync().status`——**唯一可信**的退出码来源（见文件头的取证陷阱）。
 * `null` 表示被信号杀死（超时 / 崩溃），一律按失败处理，绝不当作 0。
 */
function run(file, args, options = {}) {
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    env: { ...process.env, LUMEN_LOCALE: 'zh' },
    timeout: options.timeoutMs ?? 60_000,
    // Windows 执行 `.cmd` 垫片时必须逐字传参：Node 默认会把参数里的 `"` 转义成 `\"`，
    // 而 cmd 不认 `\"`（实测报 `'\"C:\...\concertoai.cmd\"' 不是内部或外部命令`）。
    windowsVerbatimArguments: options.verbatim === true,
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** 用 npm CLI 跑一条命令（不经 shell）。 */
function npm(args, options = {}) {
  return run(process.execPath, [NPM_CLI, ...args], options);
}

/** 执行临时前缀下的 bin 垫片（Windows 上 `.cmd` 必须经 `cmd /d /s /c`）。 */
function runShim(prefix, name, args, options = {}) {
  const shim = IS_WIN ? path.join(prefix, `${name}.cmd`) : path.join(prefix, name);
  if (IS_WIN) {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    /**
     * 三条实测结论（2026-11-13，`windowsVerbatimArguments` 是必需项）：
     *
     * | 写法 | 结果 |
     * |---|---|
     * | `['/d','/s','/c', '"<shim>" --version']`（不 verbatim） | ❌ `'"C:\...\concertoai.cmd"' 不是内部或外部命令` —— Node 把 `"` 转义成 `\"`，cmd 不认 |
     * | 同上 + `verbatim: true` | ✅ |
     * | `verbatim: true` + `call "<shim>"` | ✅（本文件采用；`call` 对含空格的路径更稳） |
     * | `spawnSync(shim, args, { shell: true })` | ✅ 但路径含空格时会裂，且多一层 shell 变数 |
     */
    return run(comspec, ['/d', '/s', '/c', `call "${shim}" ${args.join(' ')}`], {
      ...options,
      verbatim: true,
    });
  }
  return run(shim, args, options);
}

/** 断言收集器：全部跑完再汇总，一次看到所有红项。 */
const results = [];
function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const value = fn();
    if (value === true) {
      ok = true;
    } else if (typeof value === 'string') {
      ok = true;
      detail = value;
    } else {
      detail = '断言返回了非 true';
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` ｜ ${detail}`}`);
}

/** 去掉尾部空白，便于日志对比。 */
const trim = (s) => s.replace(/\s+$/u, '');

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-smoke-'));
  /**
   * 前缀与「干净 cwd」都放临时目录：
   * 后者保证「不是因为当前目录正好是仓库所以能跑」（旧版在仓库根跑，这一点是盲区）。
   */
  const prefix = path.join(tmp, 'prefix');
  const cleanCwd = path.join(tmp, 'cwd');
  const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

  /**
   * 期望版本：本地 tarball ⇒ 仓库版本；registry ⇒ 请求的那个版本。
   * **绝不硬编码**（v5.1.0 发版时 `tests/smoke.test.ts` 硬编码版本号，bump 之后立刻假红，
   * 修法见提交 43844d3）。
   */
  const expectedVersion = opts.registry ?? pkgJson.version;

  console.log(
    `模式: ${opts.registry === null ? '本地 tarball' : `registry @concertoai/cli@${opts.registry}`}`,
  );
  console.log(`期望版本: ${expectedVersion}`);
  console.log(`临时目录: ${tmp}`);

  try {
    mkdirSync(prefix, { recursive: true });
    mkdirSync(cleanCwd, { recursive: true });

    // ── 准备安装源 ──
    let installTarget;
    if (opts.registry === null) {
      /**
       * 打到哪里很关键：旧版在仓库根打 tarball 再 `unlinkSync`，等于**删掉仓库真实文件**。
       * 这里 `--pack-destination` 指向临时目录，仓库零污染。
       */
      const packDir = path.join(tmp, 'pack');
      mkdirSync(packDir, { recursive: true });
      const packed = npm(['pack', '--pack-destination', packDir], { cwd: root, timeoutMs: 180_000 });
      if (packed.code !== 0) {
        throw new Error(`npm pack 失败（exit=${packed.code}）：\n${trim(packed.out)}`);
      }
      const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
      if (tgz === undefined) {
        throw new Error(`npm pack 没有产出 .tgz：\n${trim(packed.out)}`);
      }
      installTarget = path.join(packDir, tgz);
    } else {
      installTarget = `@concertoai/cli@${opts.registry}`;
    }

    // ── 全局安装到临时前缀 ──
    console.log('\n───── 全局安装 ─────');
    const installed = npm(
      ['install', '-g', '--prefix', prefix, installTarget, '--no-audit', '--no-fund'],
      { timeoutMs: 180_000 },
    );
    if (installed.code !== 0) {
      throw new Error(`npm install -g 失败（exit=${installed.code}）：\n${trim(installed.out)}`);
    }

    console.log('\n───── 判据 ─────');

    // ⓪ 探针通电
    check('⓪ 探针通电：两个 bin 垫片都存在且非空，且安装包 version = 期望版本', () => {
      const shims = ['concertoai', 'ccai'].map((n) =>
        IS_WIN ? path.join(prefix, `${n}.cmd`) : path.join(prefix, n),
      );
      for (const shim of shims) {
        if (!existsSync(shim)) {
          throw new Error(`垫片不存在：${shim}`);
        }
        if (statSync(shim).size === 0) {
          throw new Error(`垫片是空文件：${shim}`);
        }
      }
      const installedPkg = JSON.parse(
        readFileSync(path.join(prefix, 'node_modules', '@concertoai', 'cli', 'package.json'), 'utf8'),
      );
      if (installedPkg.version !== expectedVersion) {
        throw new Error(`安装包版本是 ${installedPkg.version}，期望 ${expectedVersion}`);
      }
      return `垫片 ${shims.length} 个，version=${installedPkg.version}`;
    });

    // ① / ② 两个 bin 的 --version
    const verifyVersion = (name) => () => {
      const r = runShim(prefix, name, ['--version'], { cwd: cleanCwd });
      const out = trim(r.out);
      if (r.code !== 0) {
        throw new Error(`exit=${r.code}（应为 0）\n${out}`);
      }
      if (out !== expectedVersion) {
        throw new Error(`输出 "${out}" ≠ "${expectedVersion}"`);
      }
      return `exit=0，输出 ${out}`;
    };
    check(`① \`concertoai --version\` = ${expectedVersion}`, verifyVersion('concertoai'));
    check(`② \`ccai --version\` = ${expectedVersion}（第二入口）`, verifyVersion('ccai'));

    // ③ 子命令帮助里能查到参数
    check('③ `concertoai chat --help` 含 `--auto-low`，且不含 `--bogus`', () => {
      const r = runShim(prefix, 'concertoai', ['chat', '--help'], { cwd: cleanCwd });
      if (r.code !== 0) {
        throw new Error(`exit=${r.code}（应为 0）\n${trim(r.out)}`);
      }
      if (!r.out.includes('--auto-low')) {
        throw new Error('帮助里没有 --auto-low');
      }
      // 反例：help 打了一堆东西不代表对；必须是「这一条在」而不是「有输出」
      if (r.out.includes('--bogus')) {
        throw new Error('帮助里出现了 --bogus（说明断言命中的不是参数表）');
      }
      return 'exit=0，命中 --auto-low';
    });

    // ④a 有候选 ⇒ 必须给建议
    check('④a 拼错 `chat --auto-lo` ⇒ 退出码 1 且建议 `--auto-low`', () => {
      const r = runShim(prefix, 'concertoai', ['chat', '--auto-lo'], { cwd: cleanCwd });
      if (r.code !== 1) {
        throw new Error(`exit=${r.code}（应为 1）\n${trim(r.out)}`);
      }
      if (!r.out.includes('你是不是想输入')) {
        throw new Error(`没有给出建议：\n${trim(r.out)}`);
      }
      if (!r.out.includes('--auto-low')) {
        throw new Error(`建议里没有 --auto-low：\n${trim(r.out)}`);
      }
      return 'exit=1，给出建议';
    });

    // ④b 无候选 ⇒ 不许瞎猜（否定面）
    check('④b `--bogus` ⇒ 退出码 1 且给兜底、**不**瞎猜建议', () => {
      const r = runShim(prefix, 'concertoai', ['--bogus'], { cwd: cleanCwd });
      if (r.code !== 1) {
        throw new Error(`exit=${r.code}（应为 1）\n${trim(r.out)}`);
      }
      if (!r.out.includes('没有这个选项')) {
        throw new Error(`没有说明「没有这个选项」：\n${trim(r.out)}`);
      }
      // 否定面：无候选还提示「你是不是想输入」= 瞎猜，会把用户引到错误方向
      if (r.out.includes('你是不是想输入')) {
        throw new Error(`无候选却给了建议（瞎猜）：\n${trim(r.out)}`);
      }
      return 'exit=1，兜底提示且无瞎猜';
    });
  } finally {
    if (opts.keep) {
      console.log(`\n--keep：保留临时目录 ${tmp}`);
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n════════ 汇总：${results.length - failed.length}/${results.length} 通过 ════════`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`❌ ${f.name} ｜ ${f.detail}`);
    console.error('\n冒烟失败。');
    return 1;
  }
  console.log('全局安装冒烟通过（两个 bin 均可执行 + 参数面正常）。');
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`\n❌ 冒烟中断：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
