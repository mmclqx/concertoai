#!/usr/bin/env node
/**
 * preflight 自动初始化端到端验证（v4.1.1 P0 修复，2026-08-16）。
 *
 * 背景：专家手工测试 mt43 暴露「装好了但跑不通」——preflight 自动初始化
 * 只装依赖 + 写旧 schema biome.json + 注入 scripts，但：
 *   1. biome.json 用 1.9.4 schema + deprecated recommended → biome 2.5.8 lint 必败
 *   2. 不生成 tsconfig.json → tsc 打印 help 而非检查文件 → typecheck 必败
 * 本脚本用 node-pty 真实 TTY 驱动，验证修复后「裸项目 → preflight 自动初始化 →
 * lint + typecheck 全部跑通」。
 *
 * 用法：node scripts/pty-drive-p0.mjs
 * 依赖：node-pty@1.1.0（npm install --no-save node-pty@1.1.0）
 * 注意：会真实 npm install -D @biomejs/biome typescript（需网络，1-3 分钟）。
 */
import pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const TESTDIR = 'C:\\tmp\\concertoai-p0';
const WF_DIR = path.join(TESTDIR, '.concertoai', 'workflows');

/** 重置裸项目（无 scripts、无 tsconfig、无 biome.json、index.ts 故意 CRLF 未格式化）。 */
function setup() {
  fs.rmSync(TESTDIR, { recursive: true, force: true });
  fs.mkdirSync(WF_DIR, { recursive: true });
  // v4.1.1 发布门修复（2026-08-17）：必须加 "type": "module"——tsconfig 模板用
  // nodenext + verbatimModuleSyntax，无 type:module 的项目按 CJS 处理，而 index.ts 的
  // `export const` 是 ESM 语法 → tsc 报 TS1287，typecheck 必败（failIf 里 'error TS1287'
  // 正是此风险）。mt44 通过是因为污染后实跑项目根（package.json 有 type:module）。
  // 模拟现代 ESM 项目，与 index.ts 自洽，验证目标仍是「preflight 自动初始化 → 跑通」。
  fs.writeFileSync(
    path.join(TESTDIR, 'package.json'),
    JSON.stringify(
      { name: 'p0', version: '1.0.0', scripts: {}, type: 'module' },
      null,
      2,
    ),
  );
  // v4.1.1 修复（2026-08-17 实测）：此前故意 CRLF → lint 必然报 format → expect
  // 「✅ 工作流 precommit 执行成功」永不匹配，脚本从未真正跑通。
  // 本脚本目的是验证「preflight 自动初始化 → lint/typecheck 跑通」（配置正确性），
  // index.ts 应格式良好（LF），format 噪音由 411 场景 A 的完整通过路径另行覆盖。
  fs.writeFileSync(path.join(TESTDIR, 'index.ts'), 'export const test: number = 1;\n');
  fs.writeFileSync(
    path.join(WF_DIR, 'precommit.yml'),
    [
      'name: precommit',
      'description: 提交前检查',
      'steps:',
      '  - name: lint',
      '    run: npm run lint',
      '  - name: typecheck',
      '    run: npm run typecheck',
      '',
    ].join('\n'),
  );
}

/**
 * 驱动 CLI：等待匹配文案 → 发送按键；expect 任一命中 PASS。
 * @param {string} name
 * @param {string[]} args
 * @param {{events?:Array<{wait:string,send?:string}>, expect?:string[], failIf?:string[], timeoutMs?:number}} opts
 */
function drive(name, args, { events = [], expect = [], failIf = [], timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI, ...args], {
      cwd: TESTDIR,
      cols: 120,
      rows: 40,
      env: process.env,
      name: 'xterm-256color',
    });
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
        console.log(`\n❌ [${name}] FAIL: ${msg}\n───── 捕获输出（尾部 3000） ─────\n${out.slice(-3000)}\n────────────────────────────`);
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false, `TIMEOUT ${timeoutMs}ms（输出尾部: ${out.slice(-400)}）`), timeoutMs);
    term.onData((d) => {
      out += d;
      while (evIdx < events.length && !done) {
        const ev = events[evIdx];
        if (!out.includes(ev.wait)) break;
        evIdx += 1;
        setTimeout(() => {
          if (done) return;
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

/** 核心场景：裸项目 → preflight 自动初始化（y→计划→y→真实安装）→ lint + typecheck 全过。 */
async function p0() {
  setup();
  return drive('P0 preflight 自动初始化 → lint+typecheck 全过', ['workflow', 'run', 'precommit'], {
    events: [
      { wait: '是否自动初始化以上可修复项? [Y/n]:', send: 'y\r' },
      { wait: '确认执行初始化? (y/N):', send: 'y\r' },
    ],
    // 关键断言：工作流整体执行成功（lint schema 兼容 + typecheck 有 tsconfig）
    expect: ['✅ 工作流 precommit 执行成功'],
    failIf: [
      'schema version does not match', // biome 旧 schema 报错
      'deserialize',                   // biome 配置解析失败
      'tsc: The TypeScript Compiler - Version', // tsc 打印 help（无 tsconfig）
      'Missing script',                // scripts 未注入
      'error TS1287',                  // tsconfig 模板回归 nodenext+verbatimModuleSyntax
      '❌ 初始化失败',
      '已停止执行',
    ],
    timeoutMs: 300000, // 真实 npm install
  });
}

const run = async () => {
  const ok = await p0();
  console.log(`\n════════ 结果：${ok ? '✅ 全部 PASS' : '❌ FAIL'} ════════`);
  process.exit(ok ? 0 : 1);
};
run();
