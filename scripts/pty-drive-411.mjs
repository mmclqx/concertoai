#!/usr/bin/env node
/**
 * v4.1.1 手工测试 TTY 驱动（2026-08-17）。
 *
 * 场景 A（完整通过路径）：test 脚本已配置，lint/typecheck 缺失 → preflight 自动
 *   初始化（y → 计划 → y → 真实 npm install biome+typescript + 写 biome.json/
 *   tsconfig.json + 注入 scripts）→ precommit 3 步全绿——验证「装完直接 run」承诺。
 * 场景 B（循环依赖友好失败）：人工构造 test↔build 环（模拟修复前 release 模板 +
 *   推断叠加的成环结果）→ workflow run release → 友好失败提示（不崩溃、不进 crash.log）。
 *
 * 用法：node scripts/pty-drive-411.mjs
 * 依赖：node-pty@1.1.0（npm install --no-save node-pty@1.1.0）
 * 注意：场景 A 会真实 npm install -D @biomejs/biome typescript（需网络，1-3 分钟）。
 */
import pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DIR_A = 'C:\\tmp\\concertoai-411a';
const DIR_B = 'C:\\tmp\\concertoai-411b';

/** 重置项目目录。 */
function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.concertoai', 'workflows'), { recursive: true });
}

/** 场景 A：test 已配、lint/typecheck 缺失的「半裸」项目（模拟用户已配 test 框架）。 */
function setupA() {
  resetDir(DIR_A);
  // v4.1.1 发布门修复（2026-08-17）：加 "type": "module"——与 pty-drive-p0 同因：
  // tsconfig 模板 nodenext + verbatimModuleSyntax，无 type:module 时 index.ts 的
  // ESM export 触发 TS1287 → typecheck 必败（场景 A 有 typecheck 步骤）。
  fs.writeFileSync(
    path.join(DIR_A, 'package.json'),
    JSON.stringify(
      { name: 'mt411a', version: '1.0.0', scripts: { test: 'echo passed' }, type: 'module' },
      null,
      2,
    ),
  );
  // LF + 格式良好，避免 format 干扰「装完直接 run」主验证
  fs.writeFileSync(path.join(DIR_A, 'index.ts'), 'export const test: number = 1;\n');
  fs.writeFileSync(
    path.join(DIR_A, '.concertoai', 'workflows', 'precommit.yml'),
    [
      'name: precommit',
      'description: 提交前检查：lint + type + test',
      'steps:',
      '  - name: lint',
      '    run: npm run lint',
      '  - name: typecheck',
      '    run: npm run typecheck',
      '  - name: test',
      '    run: npm run test -- --silent',
      '    depends:',
      '      - lint',
      '      - typecheck',
      '',
    ].join('\n'),
  );
}

/** 场景 B：全脚本已配（echo 桩），但构造 test↔build 环（修复前 release 模板+推断叠加的结果）。 */
function setupB() {
  resetDir(DIR_B);
  fs.writeFileSync(
    path.join(DIR_B, 'package.json'),
    JSON.stringify(
      {
        name: 'mt411b',
        version: '1.0.0',
        scripts: {
          lint: 'echo lint-ok',
          test: 'echo test-ok',
          build: 'echo build-ok',
          changelog: 'echo changelog-ok',
          publish: 'echo publish-ok',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(DIR_B, 'index.ts'), 'export const test: number = 1;\n');
  fs.writeFileSync(
    path.join(DIR_B, '.concertoai', 'workflows', 'release.yml'),
    [
      'name: release',
      'description: 循环依赖复现（test ↔ build）',
      'steps:',
      '  - name: lint',
      '    run: npm run lint',
      '  - name: test',
      '    run: npm run test -- --silent',
      '    depends:',
      '      - build',
      '  - name: build',
      '    run: npm run build',
      '    depends:',
      '      - test',
      '',
    ].join('\n'),
  );
}

/**
 * 驱动 CLI：等待匹配文案 → 发送按键；expect 任一命中 PASS。
 * @param {string} name
 * @param {string} cwd
 * @param {string[]} args
 * @param {{events?:Array<{wait:string,send?:string}>, expect?:string[], failIf?:string[], timeoutMs?:number}} opts
 */
function drive(name, cwd, args, { events = [], expect = [], failIf = [], timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI, ...args], {
      cwd,
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

/** 场景 A：完整通过路径——preflight 自动初始化 lint/typecheck → precommit 3 步全绿。 */
async function sceneA() {
  setupA();
  return drive('A preflight 自动初始化 → precommit 全绿（test 已配）', DIR_A, ['workflow', 'run', 'precommit'], {
    events: [
      { wait: '是否自动初始化以上可修复项? [Y/n]:', send: 'y\r' },
      { wait: '确认执行初始化? (y/N):', send: 'y\r' },
    ],
    expect: ['✅ 工作流 precommit 执行成功'],
    failIf: [
      'schema version does not match',
      'deserialize',
      'tsc: The TypeScript Compiler - Version',
      'Missing script',
      '❌ 初始化失败',
      '已停止执行',
      '步骤 test 失败',
    ],
    timeoutMs: 300000,
  });
}

/** 场景 B：循环依赖友好失败——不崩溃、不进 crash.log、给修复提示。 */
async function sceneB() {
  setupB();
  return drive('B 循环依赖友好失败（test↔build 环）', DIR_B, ['workflow', 'run', 'release'], {
    expect: ['检测到循环依赖', 'test → build → test'],
    failIf: ['未处理的 Promise', 'crash.log', 'process exited'],
    timeoutMs: 60000,
  });
}

const run = async () => {
  const a = await sceneA();
  const b = await sceneB();
  const ok = a && b;
  console.log(`\n════════ 结果：${ok ? '✅ 全部 PASS' : '❌ FAIL'}（A=${a ? 'PASS' : 'FAIL'} B=${b ? 'PASS' : 'FAIL'}）════════`);
  process.exit(ok ? 0 : 1);
};
run();
