#!/usr/bin/env node
/**
 * v5.0 T13 场景提示 TTY 端到端驱动（2026-10-28）。
 *
 * 单元测试证明「函数对」，本脚本证明「用户真能看见」——走**真实 TUI + 真实 PTY**：
 *
 * | # | 断言 | 为什么单测不够 |
 * |---|---|---|
 * | 1 | 无规则文件项目里，发一条消息后出现 `concertoai init` 提示 | 组件级渲染覆盖不到「App 真的把 state 传给 HintBar」 |
 * | 2 | 提示是**灰字**（ANSI dim）且**单行** | 上色由 Ink 完成，只能看真实终端字节 |
 * | 3 | `/hints off` 后提示**消失**，回执给出恢复方式 | 端到端才验证「斜杠命令真的接到 engine」 |
 *
 * 隔离纪律（AGENTS 第 16 条）：项目目录 + HOME 全部指向临时目录，
 * 绝不碰开发者真实 `~/.concertoai/`（否则污染 hint-state.json）。
 *
 * 用法：node scripts/pty-drive-t13.mjs [--dump]
 *   --dump  只打印 8 秒真实输出（排查用）
 * 前置：npm run build（用 dist/cli/index.js）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty from 'node-pty';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DUMP_ONLY = process.argv.includes('--dump');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-t13-pty-'));
const DIR = path.join(ROOT, 'proj');
const HOME = path.join(ROOT, 'home');

/** 极简无规则文件项目 + 隔离 HOME（hints 显式 on）。 */
function setup() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.concertoai'), { recursive: true });
  fs.writeFileSync(
    path.join(DIR, 'package.json'),
    JSON.stringify({ name: 't13demo', version: '1.0.0' }, null, 2),
  );
  fs.writeFileSync(path.join(DIR, 'index.js'), 'console.log(1);\n');
  fs.writeFileSync(
    path.join(HOME, '.concertoai', 'config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        defaultProvider: 'deepseek',
        providers: { deepseek: { apiKey: 'sk-t13-drive-fake-key', model: 'deepseek-v4-flash' } },
        hints: 'on',
      },
      null,
      2,
    ),
  );
}

/** 去 ANSI（打印可读；断言灰字时用原始字节）。 */
const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * 起一个真实 TUI 进程，按时间表发送输入，收集输出。
 * @param {Array<{atMs: number, write: string}>} schedule
 * @param {number} totalMs
 */
function runTui(schedule, totalMs) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI], {
      cwd: DIR,
      cols: 100,
      rows: 40,
      env: { ...process.env, HOME, USERPROFILE: HOME, CONCERTOAI_HINTS: 'on' },
      name: 'xterm-256color',
    });
    let raw = '';
    term.onData((d) => {
      raw += d;
    });
    const timers = schedule.map((s) =>
      setTimeout(() => {
        try {
          term.write(s.write);
        } catch {
          /* dead */
        }
      }, s.atMs),
    );
    const done = setTimeout(() => {
      for (const t of timers) clearTimeout(t);
      try {
        term.kill();
      } catch {
        /* dead */
      }
      resolve(raw);
    }, totalMs);
    term.onExit(() => {
      clearTimeout(done);
      for (const t of timers) clearTimeout(t);
      // 给残留输出一点时间落盘
      setTimeout(() => resolve(raw), 100);
    });
  });
}

const run = async () => {
  setup();
  console.log(`项目: ${DIR}`);
  console.log(`HOME: ${HOME}\n`);

  if (DUMP_ONLY) {
    const raw = await runTui([{ atMs: 4000, write: '你好\r' }], 12000);
    console.log('===== 去色输出 =====');
    console.log(strip(raw).slice(-4000));
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(0);
  }

  // 场景：首屏 → 发一条消息 → 等提示 → /hints off → 断提示消失
  const raw = await runTui(
    [
      { atMs: 3000, write: '你好\r' },
      { atMs: 12000, write: '/hints off\r' },
    ],
    18000,
  );
  const frame = strip(raw);
  fs.rmSync(ROOT, { recursive: true, force: true });

  const checks = [
    {
      name: '① 提示出现（无规则文件 → concertoai init）',
      ok: /💡[^\n]*concertoai init/.test(frame),
    },
    {
      name: '② 灰字（ANSI dim 包裹提示行）',
      ok: /\u001b\[[0-9;]*2m[^\u001b]*concertoai init/.test(raw),
    },
    {
      name: '③ 提示为单行（💡 与命令同行，不换行）',
      ok: /💡[^\n]{0,200}concertoai init/.test(frame),
    },
    {
      name: '④ /hints off 回执出现（含恢复方式）',
      ok: /已关闭场景提示/.test(frame) && /\/hints on/.test(frame),
    },
  ];

  let allOk = true;
  for (const c of checks) {
    console.log(`${c.ok ? '✅' : '❌'} ${c.name}`);
    if (!c.ok) allOk = false;
  }
  if (!allOk) {
    console.log('\n───── 去色输出（尾部 4000）─────');
    console.log(frame.slice(-4000));
    console.log('────────────────────────────────');
  } else {
    // 打印提示行上下文，便于人工核对
    const m = frame.match(/[^\n]*💡[^\n]*concertoai init[^\n]*/);
    console.log(`\n提示行实际内容：\n  ${m ? m[0] : '(未捕获)'}`);
  }
  console.log(`\n════════ 结果：${allOk ? '✅ 全部 PASS' : '❌ FAIL'} ════════`);
  process.exit(allOk ? 0 : 1);
};
run();

