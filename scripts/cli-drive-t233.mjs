#!/usr/bin/env node
/**
 * v5.0 T23.3 手工测试：**非交互**场景取证（2026-10-29）。
 *
 * 覆盖任务书 8 场景里不需要真实终端的部分：
 * | 场景 | 断言 | 为什么不用 PTY |
 * |---|---|---|
 * | 1a | 新用户无 Key 直跑 → 三种配置方式 + 官方地址 + 真实 config 路径，exit 1 | 纯 stdout/stderr 断言 |
 * | 1b | `login --key` 后 `whoami` 显示账号名 + 打码 Key（配置真的生效） | 同上 |
 * | 2 | `init` 双文件（AGENTS.md + PROJECT_GUIDE.md）+ GUIDE 含「高风险区域」+ 非 TTY 默认不覆盖 | 同上 |
 *
 * 场景 1c（配置后进 chat）与 3/4/5/8 在 `scripts/pty-drive-t233.mjs`（需真实 TTY）。
 * 场景 6/7（check→commit / review --fix）在 `scripts/real-key-t233.mjs`（真 Key，单独跑）。
 *
 * ## 零网络
 * 本脚本**全程不打模型**：`init` 是纯本地扫描（`core/project-scan.ts` 无 client），
 * 缺 Key 引导与 `whoami` 都是本地读写。子进程 env 一律经 `childEnv()` 剔除真实 Key
 * （AGENTS 第 31 条「探针自证」的变体：拼 env 不能直通 `{...process.env}`）。
 *
 * ## 隔离与清理（AGENTS 第 16 / 17 条）
 * 项目目录 + HOME 全在临时目录；`try/finally` + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 兜底；
 * 清理幂等、失败打印残留路径；跑完自证残留为 0。
 *
 * 用法：node scripts/cli-drive-t233.mjs [--dump]
 * 前置：npm run build（用 dist/cli/index.js）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DUMP_ONLY = process.argv.includes('--dump');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-t233cli-'));

// ── 清理 ──────────────────────────────────────────────────────

let cleaned = false;
const leftovers = [];
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    leftovers.push(`${ROOT} (${e.code ?? e.message})`);
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e);
  cleanup();
  process.exit(1);
});

// ── 环境 ──────────────────────────────────────────────────────

/** 子进程环境：**显式剔除真实 Key**（直通 `{...process.env}` = 探针没通电）。 */
function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LUMEN_LOCALE: 'zh', ...extra };
  delete env.DEEPSEEK_API_KEY;
  delete env.CONCERTOAI_HINTS;
  return env;
}

function makeEnv(name) {
  const base = path.join(ROOT, name);
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.concertoai'), { recursive: true });
  return { base, dir, home };
}

function runCli(args, dir, home, extraEnv = {}) {
  const r = spawnSync(NODE, [CLI, ...args], {
    cwd: dir,
    env: childEnv(home, extraEnv),
    encoding: 'utf8',
    // stdin 显式给空串：非 TTY 下任何交互都按「用户取消」处理（fail-closed 实测证据）
    input: '',
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── 断言框架 ──────────────────────────────────────────────────

const results = [];
const transcript = [];
const LOG = path.join(REPO, '.git', 't233cli-progress.log');
fs.writeFileSync(LOG, '');
function say(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    /* ignore */
  }
}
function check(scenario, name, cond, detail = '') {
  results.push({ scenario, name, pass: cond === true, detail });
  say(`${cond ? 'PASS' : 'FAIL'} | 场景${scenario} | ${name}${detail ? ` | ${detail}` : ''}`);
}
function note(line) {
  say(`OBSERVE | ${line}`);
}

// ── 主流程 ────────────────────────────────────────────────────

const run = () => {
  // ═══════════════ 场景 1a：新用户无 Key 直跑 → 缺 Key 引导 ═══════════════
  {
    const { dir, home } = makeEnv('s1');
    const r = runCli([], dir, home);
    transcript.push({ scenario: '1a', cwd: dir, exit: r.status, raw: r.out });
    if (DUMP_ONLY) console.log(r.out);

    check(1, '无 Key 直跑不静默启动，退出码非 0', r.status !== 0, `exit=${r.status}`);
    check(1, '引导说清了「缺什么」', r.out.includes('未检测到 DeepSeek API Key'));
    check(1, '方式 1 环境变量（三种 shell 都给）', /PowerShell/.test(r.out) && /cmd\.exe/.test(r.out) && /bash\/zsh/.test(r.out));
    check(1, '方式 2 账号登录命令可直接复制', r.out.includes('concertoai login myname --key'));
    check(1, '方式 3 配置文件（给出**真实**路径且该目录存在）', r.out.includes(path.join(home, '.concertoai', 'config.json')));
    check(1, '给出去哪儿拿 Key 的官方地址', r.out.includes('https://platform.deepseek.com/api_keys'));
    check(1, '下一步是能验证的命令（doctor）', r.out.includes('concertoai doctor'));
    // 输出淹没检查（AGENTS 边缘路径④）：引导 ≤ 20 行
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim() !== '').length;
    check(1, '引导不淹没终端（≤20 行）', lines <= 20, `${lines} 行`);

    // ── 场景 1b：按方式 2 配置 → whoami 确认生效 ──
    const key = `${['s', 'k', '-'].join('')}${'0123456789abcdef'.repeat(2)}`;
    const login = runCli(['login', 't233user', '--key', key], dir, home);
    const who = runCli(['whoami'], dir, home);
    transcript.push({ scenario: '1b', cwd: dir, exit: who.status, raw: `${login.out}\n${who.out}` });
    check(1, 'login --key 成功（exit 0）', login.status === 0, `exit=${login.status}`);
    check(1, 'whoami 显示账号名', who.out.includes('t233user'));
    check(1, 'whoami 的 Key 是打码的（不泄露完整 Key）', who.out.includes('****') && !who.out.includes(key));
    check(1, 'whoami 只露后 4 位（用户能对上自己那把 key）', who.out.includes(key.slice(-4)));
  }

  // ═══════════════ 场景 2：init 双输出 ═══════════════
  {
    const { dir, home } = makeEnv('s2');
    /**
     * fixture 设计（每一条都对应一个要验证的能力，而不是随便找几个文件）：
     * - `src/auth.js` 含 `process.env.JWT_SECRET`（env 规则）+ TODO → 验 G7「结论必须带 `文件:行号`」
     * - `src/server.js` 含 `fs.unlinkSync(...)` → 验 delete 规则（**实测漏报，报告记为 K4**）
     * - `src/index.js` + `src/server.js` 都用 **CJS `require('./auth')`** 引 auth.js → 验 CJS 依赖统计
     * - `src/a.ts` + `src/b.ts` 都用 **ESM `from './rules'`** 引 rules.ts → 验 ESM 依赖统计
     */
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        { name: 't233demo', version: '1.0.0', scripts: { build: 'tsc', test: 'vitest' }, dependencies: { express: '^4' } },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'auth.js'),
      [
        '// 登录鉴权',
        'const SECRET = process.env.JWT_SECRET;',
        '',
        'function login(user, pass) {',
        "  if (user === 'admin') return true;",
        '  return pass === SECRET;',
        '}',
        '',
        '// TODO: 补密码哈希',
        'module.exports = { login };',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'index.js'),
      "const { login } = require('./auth');\nconsole.log(login('a', 'b'));\n",
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'server.js'),
      "const { login } = require('./auth');\nconst fs = require('fs');\nfs.unlinkSync('tmp');\n",
    );
    fs.writeFileSync(path.join(dir, 'src', 'rules.ts'), 'export const RULES = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), "import { RULES } from './rules';\nconsole.log(RULES);\n");
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), "import { RULES } from './rules';\nconsole.log(RULES);\n");

    const first = runCli(['init'], dir, home);
    transcript.push({ scenario: '2', cwd: dir, exit: first.status, raw: first.out });
    if (DUMP_ONLY) console.log(first.out);

    const agents = path.join(dir, 'AGENTS.md');
    const guide = path.join(dir, 'PROJECT_GUIDE.md');
    check(2, 'init 退出码 0', first.status === 0, `exit=${first.status}`);
    check(2, '双文件都生成了（AGENTS.md + PROJECT_GUIDE.md）', fs.existsSync(agents) && fs.existsSync(guide));
    const summaryLines = first.out.split(/\r?\n/).filter((l) => l.trim() !== '').length;
    check(2, '摘要只给少量行，不要求读全文（≤10 行）', summaryLines <= 10, `${summaryLines} 行`);

    const agentsText = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '';
    const guideText = fs.existsSync(guide) ? fs.readFileSync(guide, 'utf8') : '';
    transcript.push({ scenario: '2-files', agentsText, guideText });

    check(2, 'AGENTS.md 是给 AI 的（含技术栈/常用命令）', agentsText.includes('技术栈') && agentsText.includes('常用命令'));
    check(2, 'PROJECT_GUIDE.md 是给人的（含「最脆弱的地方」章节）', guideText.includes('最脆弱的地方'));
    // G7 证据硬约束：命中的结论必须带 `文件:行号`，且行号要对得上真实内容
    check(2, 'G7：环境变量依赖带真实行号（src/auth.js:2）', guideText.includes('`src/auth.js:2`'), guideText.match(/`src\/auth\.js:\d+`/g)?.join(' ') ?? '无');
    check(2, 'G7：TODO 带真实行号（src/auth.js:9）且内容逐字一致', guideText.includes('`src/auth.js:9`') && guideText.includes('补密码哈希'));
    check(2, 'ESM 依赖聚合正确（rules.ts 被 2 个文件引用）', guideText.includes('`src/rules`') && /2/.test(guideText.split('连锁反应')[1] ?? ''));
    check(2, '没有「编造」痕迹（无 Lorem / 占位符 / undefined）', !/Lorem|待补充|undefined|null/.test(guideText));

    // CJS 覆盖观察（已知问题 K3：`require('./x')` 不进依赖统计 → CJS 项目「连锁反应」恒为未检测到）
    note(
      `CJS 依赖统计：${/`src\/auth`/.test(guideText) ? '已识别' : '未识别（K3，`require()` 未纳入统计）'}`,
    );
    // delete 规则覆盖观察（已知问题 K4：规则写 `\\bunlink\\s*\\(`，`unlinkSync(` 不命中）
    note(`删除类风险：${guideText.includes('unlinkSync') ? '已识别' : '未识别（K4，unlink 规则缺 (Sync)? 变体）'}`);

    // 非 TTY 再跑一次：默认不覆盖（fail-closed）
    const before = fs.readFileSync(guide, 'utf8');
    const second = runCli(['init'], dir, home);
    const after = fs.readFileSync(guide, 'utf8');
    transcript.push({ scenario: '2-rerun', cwd: dir, exit: second.status, raw: second.out });
    check(2, '非 TTY 重跑不覆盖既有文件（fail-closed）', before === after && second.status === 0, `exit=${second.status}`);
    check(2, '重跑如实告知「未做更改」而不是假装重新生成', /未写入任何文件/.test(second.out), second.out.trim().split(/\r?\n/).slice(-1)[0] ?? '');

    // --force 才覆盖：改一份源码后重跑，内容必须真的更新（只看回执会被措辞骗过去）
    fs.appendFileSync(path.join(dir, 'src', 'auth.js'), '// FIXME: 换成 bcrypt\n');
    const forced = runCli(['init', '--force'], dir, home);
    const afterForce = fs.readFileSync(guide, 'utf8');
    transcript.push({ scenario: '2-force', cwd: dir, exit: forced.status, raw: forced.out });
    check(2, '--force 真的重新生成（新加的 FIXME 出现在产物里）', forced.status === 0 && afterForce !== before && /bcrypt/.test(afterForce), `exit=${forced.status}`);
    note('--force 的摘要与首次生成逐字相同（未明说「已覆盖」，K6 体验观察）');
  }

  // ── 收尾 ──
  cleanup();
  const failed = results.filter((r) => !r.pass);
  say(`\n合计 ${results.length} 条断言；PASS ${results.length - failed.length}；FAIL ${failed.length}`);
  say(`清理自证：临时目录存在 ${fs.existsSync(ROOT)} / 清理失败 ${leftovers.length}`);
  if (leftovers.length) say(`残留：${leftovers.join(', ')}`);

  fs.writeFileSync(
    path.join(REPO, '.git', 't233cli-transcript.json'),
    JSON.stringify({ results, transcript, root: ROOT, cleaned: !fs.existsSync(ROOT) }, null, 2),
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

run();
