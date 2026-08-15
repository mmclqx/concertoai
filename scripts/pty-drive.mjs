#!/usr/bin/env node
/**
 * node-pty 真实 TTY 交互驱动（v4.1 发布前人工测试自动化替代，2026-08-15）。
 *
 * 背景：CLI 的 promptLine 设计 `!process.stdin.isTTY → undefined`（fail-closed），
 * 管道/重定向无法驱动交互分支；node-pty ConPTY 创建真伪终端，子进程 stdin.isTTY=true，
 * 可自动化验证 preflight y/N、F 等待态（Enter/a/60s 超时）、审批节点 y。
 *
 * 用法：node scripts/pty-drive.mjs [c1|c2|c3|c4|c5|all]
 * 依赖：node-pty@1.1.0（本机已验证 Node v22 兼容，ConPTY 原生模块完整）
 * 安装：npm install --no-save node-pty@1.1.0（不入 package.json；若被 npm ci/prune 清掉需重装）
 * 注意：C1 会真实 `npm install -D @biomejs/biome`（需网络，可能 1-3 分钟）。
 *
 * 输出：每场景 ✅ PASS / ❌ FAIL + 捕获输出；全部 PASS 即真实 TTY 交互验证完成。
 */
import pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const TESTDIR = 'C:\\tmp\\concertoai-tt41';
const WF_DIR = path.join(TESTDIR, '.concertoai', 'workflows');

/**
 * fake bins：绕过 preflight 依赖检查（C2-C4 的 lint 是 node -e，不需要真实 biome）。
 * preflight 只检查 node_modules/.bin/<tool> 存在 + biome.json 存在，不校验真实性。
 */
const FAKE_BINS = {
  'node_modules/.bin/biome': '',
  'node_modules/.bin/biome.cmd': '',
  'node_modules/.bin/tsc': '',
  'node_modules/.bin/tsc.cmd': '',
};

/** 重置测试项目。 */
function setup({ yaml, scripts, extraFiles = {}, fakeBins = false, filename = 'precommit.yml' }) {
  fs.rmSync(TESTDIR, { recursive: true, force: true });
  fs.mkdirSync(WF_DIR, { recursive: true });
  fs.writeFileSync(path.join(TESTDIR, 'package.json'), JSON.stringify({ name: 'tt41', version: '1.0.0', scripts }, null, 2));
  fs.writeFileSync(path.join(WF_DIR, filename), yaml);
  const files = { ...extraFiles, ...(fakeBins ? FAKE_BINS : {}) };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(TESTDIR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

/** 修改测试项目 package.json scripts。 */
function patchScripts(scripts) {
  const pkgPath = path.join(TESTDIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts = { ...(pkg.scripts ?? {}), ...scripts };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

/**
 * 驱动 CLI：按事件序列等待输出后发送按键，任一 expect 命中即 PASS。
 * @param {string} name 场景名
 * @param {string[]} args CLI 参数
 * @param {{cwd?:string, events?:Array<{wait:string,send?:string,before?:()=>void}>, expect?:string[], failIf?:string[], timeoutMs?:number}} opts
 */
function drive(name, args, { cwd = TESTDIR, events = [], expect = [], failIf = [], timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI, ...args], { cwd, cols: 120, rows: 40, env: process.env, name: 'xterm-256color' });
    let out = '';
    let evIdx = 0;
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { term.kill(); } catch { /* already dead */ }
      if (ok) {
        console.log(`\n✅ [${name}] PASS`);
      } else {
        console.log(`\n❌ [${name}] FAIL: ${msg}\n───── 捕获输出 ─────\n${out}\n────────────────────`);
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false, `TIMEOUT ${timeoutMs}ms（输出尾部: ${out.slice(-300)}）`), timeoutMs);
    term.onData((d) => {
      out += d;
      // 依次消费事件：等待匹配文本出现 → 发送按键
      while (evIdx < events.length && !done) {
        const ev = events[evIdx];
        if (!out.includes(ev.wait)) break;
        evIdx += 1;
        setTimeout(() => {
          if (done) return;
          try { ev.before?.(); } catch (e) { finish(false, `before 回调异常: ${e.message}`); return; }
          if (ev.send !== undefined) term.write(ev.send);
        }, 300);
      }
      if (done) return;
      for (const f of failIf) {
        if (out.includes(f)) { finish(false, `命中失败条件 "${f}"`); return; }
      }
      for (const c of expect) {
        if (out.includes(c)) { finish(true); return; }
      }
    });
    term.onExit((e) => {
      if (!done) finish(false, `进程提前退出 code=${e.exitCode} signal=${e.signal}`);
    });
  });
}

/** 场景 C1：preflight 自动初始化 y→计划→y→安装→写文件→lint 跑通。 */
async function c1() {
  setup({
    yaml: 'name: precommit\ndescription: 提交前检查\nsteps:\n  - name: lint\n    run: npm run lint\n',
    scripts: {},
  });
  return drive('C1 preflight 自动初始化(y→计划→y→安装→lint 通过)', ['workflow', 'run', 'precommit'], {
    events: [
      { wait: '是否自动初始化以上可修复项? [Y/n]:', send: 'y\r' },
      { wait: '确认执行初始化? (y/N):', send: 'y\r' },
    ],
    expect: ['✅ 环境初始化完成', '▶ 开始执行工作流 precommit', '✅ 工作流 precommit 执行成功'],
    failIf: ['❌ 初始化失败', '已停止执行'],
    timeoutMs: 300000, // npm install 真实下载
  });
}

/** 场景 C2：F 等待态 → 手动修复 → Enter 重试通过。 */
async function c2() {
  setup({
    yaml: 'name: precommit\nsteps:\n  - name: lint\n    run: npm run lint\n',
    scripts: { lint: 'node -e "console.log(\'before\'); process.exit(1)"' },
    fakeBins: true,
    extraFiles: { 'biome.json': '{}\n' },
  });
  return drive('C2 F 等待态(Enter 重试)', ['workflow', 'run', 'precommit'], {
    events: [
      { wait: '选择 (R/S/F/A):', send: 'f\r' },
      {
        wait: '等待修复完成 (Enter 重试 / a 放弃):',
        before: () => patchScripts({ lint: 'node -e "console.log(\'fixed\')"' }),
        send: '\r',
      },
    ],
    expect: ['✅ 工作流 precommit 执行成功'],
    failIf: ['已自动回滚', '❌ 工作流'],
    timeoutMs: 60000,
  });
}

/** 场景 C3：F 等待态 → a 放弃（整体回滚）。 */
async function c3() {
  setup({
    yaml: 'name: precommit\nsteps:\n  - name: lint\n    run: npm run lint\n    files:\n      - marker.txt\n',
    scripts: { lint: 'node -e "process.exit(1)"' },
    fakeBins: true,
    extraFiles: { 'marker.txt': 'x', 'biome.json': '{}\n' },
  });
  return drive('C3 F 等待态(a 放弃回滚)', ['workflow', 'run', 'precommit'], {
    events: [
      { wait: '选择 (R/S/F/A):', send: 'f\r' },
      { wait: '等待修复完成 (Enter 重试 / a 放弃):', send: 'a\r' },
    ],
    expect: ['已自动回滚'],
    failIf: ['✅ 工作流'],
    timeoutMs: 30000,
  });
}

/** 场景 C4：F 等待态 → 60s 无输入 → 超时自动放弃（不挂起）。 */
async function c4() {
  setup({
    yaml: 'name: precommit\nsteps:\n  - name: lint\n    run: npm run lint\n',
    scripts: { lint: 'node -e "process.exit(1)"' },
    fakeBins: true,
    extraFiles: { 'biome.json': '{}\n' },
  });
  return drive('C4 F 等待态(60s 超时自动放弃)', ['workflow', 'run', 'precommit'], {
    events: [{ wait: '选择 (R/S/F/A):', send: 'f\r' }],
    expect: ['已自动回滚'],
    failIf: ['✅ 工作流'],
    timeoutMs: 90000, // 等待真实 60s 超时
  });
}

/** 场景 C5：审批节点 require: approval → y 继续执行。 */
async function c5() {
  setup({
    yaml: 'name: release\nsteps:\n  - name: ok\n    run: node -e "console.log(\'ok\')"\n  - name: publish\n    run: node -e "console.log(\'published\')"\n    require: approval\n',
    scripts: {},
    filename: 'release.yml',
  });
  return drive('C5 审批节点(y 继续)', ['workflow', 'run', 'release'], {
    events: [{ wait: '步骤需要审批，命令:', send: 'y\r' }],
    expect: ['published', '✅ 工作流 release 执行成功'],
    failIf: ['❌ 工作流'],
    timeoutMs: 30000,
  });
}

const which = process.argv[2] ?? 'all';
const suite = {
  c1, c2, c3, c4, c5,
};
const run = async () => {
  if (which === 'all') {
    const results = [];
    for (const key of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      results.push([key, await suite[key]()]);
    }
    console.log('\n════════ 汇总 ════════');
    for (const [k, ok] of results) console.log(`${ok ? '✅' : '❌'} ${k}`);
    process.exit(results.every(([, ok]) => ok) ? 0 : 1);
  } else if (suite[which]) {
    process.exit((await suite[which]()) ? 0 : 1);
  } else {
    console.error(`未知场景 ${which}（可用: c1|c2|c3|c4|c5|all）`);
    process.exit(1);
  }
};
run();
