#!/usr/bin/env node
/**
 * v5.0 T23.1 审批透明化 TTY 端到端驱动（2026-10-29）。
 *
 * 发布门第 12 项的取证工具：单测证明「函数对」，本脚本证明「用户真能看见整条链路」。
 *
 * 六步串行断言（任一失败即整项不过）：
 * | # | 断言 | 为什么单测不够 |
 * |---|---|---|
 * | ① | 进 chat 后首屏渲染（欢迎语 + 输入框） | App 层是否真的把 state 传给子组件，只有真实 TTY 能看 |
 * | ② | 模型请求一个高风险编辑 → 审批框出现 | 「工具调用 → 审批请求」这段接线，组件级测试覆盖不到 |
 * | ③ | 审批框含**风险点**与**影响面**（rich 教学卡） | insight 是**异步补**的，单测里时序可控、真实环境不一定 |
 * | ④ | 命中高危规则时出现 **⚠️ 高风险审批** | 风险等级由 15 条规则+diff 共同决定，端到端才验证规则真的生效 |
 * | ⑤ | 按 `n` 拒绝后**复盘真的写盘**（reflections.jsonl 有记录） | fire-and-forget 写盘，只断言 UI 文案看不出文件到底写了没 |
 * | ⑥ | `/hints off` 后提示消失 | 斜杠命令真的接到 engine，而不是只有文案 |
 *
 * ## 零网络：本地 mock SSE 服务器
 *
 * 不接真实 DeepSeek、不花真钱、不依赖 API Key —— 起一个 127.0.0.1 的 HTTP 服务，
 * 返回**符合 DeepSeek SSE 协议**的流（`data: {chunk}` … `data: [DONE]`），
 * 让模型「决定」调用 `edit_file` 工具改一个**高风险文件**。
 * config 里 `providers.deepseek.baseUrl` 指向该本地端口。
 *
 * ## 隔离与清理（AGENTS 第 16 / 17 条）
 *
 * - 项目目录 + HOME 全部指向临时目录，绝不碰开发者真实 `~/.concertoai/`；
 * - 临时目录、PTY、本地 HTTP 服务器一律 `try/finally` +
 *   `process.on('exit'/'SIGINT'/'SIGTERM'/'uncaughtException'/'unhandledRejection')` 兜底；
 * - Windows 下杀 PTY 补 `taskkill /T /F`（ConPTY 下 `term.kill()` 只带走壳）；
 * - 杀之前先 `process.kill(pid, 0)` 探活，避免 pid 复用误伤；清理幂等；失败打印残留路径。
 *
 * 用法：node scripts/pty-drive-v50.mjs [--dump]
 *   --dump  只打印真实输出（排查用，不断言）
 * 前置：npm run build（用 dist/cli/index.js）+ npm install（需 devDependency node-pty）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import pty from 'node-pty';

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DUMP_ONLY = process.argv.includes('--dump');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-v50-pty-'));
const DIR = path.join(ROOT, 'proj');
const HOME = path.join(ROOT, 'home');
const REFLECTIONS = path.join(HOME, '.concertoai', 'reflections.jsonl');

/** @type {Set<import('node-pty').IPty>} 存活 PTY，退出兜底时逐个杀 */
const LIVE_TERMS = new Set();
/** @type {import('node:http').Server | null} */
let server = null;
let cleaned = false;

/** 高风险目标文件：含鉴权 + 硬编码密钥，确保命中 high 级规则（auth-change / secret-hardcode）。 */
const RISKY_FILE = 'auth-service.js';
const RISKY_BEFORE = `// 登录鉴权（示例：命中 auth-change + secret-hardcode）
const SECRET = 'dev-secret';

function login(user, pass) {
  if (user === 'admin' && pass === SECRET) {
    return { ok: true, role: 'admin' };
  }
  return { ok: false };
}

module.exports = { login };
`;
/** 模型「想改成」的样子：放宽鉴权 + 硬编码真实密钥 —— 两个高危规则同时命中。 */
const RISKY_SEARCH = `const SECRET = 'dev-secret';`;
// 高熵密钥用运行时拼接：直接写明文长串会被 risk-rules 的占位符规则判成「非硬编码」，规则就不命中
const FAKE_KEY_BODY = ['9f2b8c1d', '4e6a7f8b', '9c0d1e2f', '3a4b5c6d'].join('');
const RISKY_REPLACE = `const SECRET = '${['s', 'k', '-'].join('')}${FAKE_KEY_BODY}';`;

function killTermTree(term) {
  const pid = term.pid;
  try {
    term.kill();
  } catch {
    /* 已死 */
  }
  if (process.platform !== 'win32' || !pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return; // 已退出，无需补刀
  }
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

/**
 * 幂等清理：先杀 PTY（含进程树），再关 HTTP 服务器，最后删临时目录。
 * 必须**同步**——`process.on('exit')` 里只能做同步工作。
 */
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const term of LIVE_TERMS) killTermTree(term);
  const killed = LIVE_TERMS.size;
  LIVE_TERMS.clear();
  if (server) {
    try {
      server.close();
    } catch {
      /* 已关 */
    }
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log(`🧹 清理完成：PTY ${killed} 个已终止 / mock 服务器已关 / 临时目录已删除（${ROOT}）`);
  } catch (err) {
    console.error(`⚠️  临时目录清理失败，请手动删除：${ROOT}\n   ${err.message}`);
  }
}

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在清理 PTY / mock 服务器 / 临时目录…`);
    cleanup();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  console.error('未捕获异常：', err);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('未处理的 Promise 拒绝：', err);
  cleanup();
  process.exit(1);
});

/** 项目 + 隔离 HOME + 指向本地 mock 的 config。 */
function setup() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.concertoai'), { recursive: true });
  fs.writeFileSync(
    path.join(DIR, 'package.json'),
    JSON.stringify({ name: 'v50demo', version: '1.0.0' }, null, 2),
  );
  fs.writeFileSync(path.join(DIR, RISKY_FILE), RISKY_BEFORE);
  // 一个引用方，让「影响面」真的能扫到东西（不是 ok-zero）
  fs.writeFileSync(
    path.join(DIR, 'server.js'),
    `const { login } = require('./${RISKY_FILE}');\nconsole.log(login('a', 'b'));\n`,
  );
}

/** 写 config（baseUrl 指向 mock 端口；hints 显式 on，审批走 rich）。 */
function writeConfig(port) {
  fs.writeFileSync(
    path.join(HOME, '.concertoai', 'config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        defaultProvider: 'deepseek',
        providers: {
          deepseek: {
            apiKey: 'sk-mock-for-pty-e2e',
            model: 'deepseek-v4-flash',
            baseUrl: `http://127.0.0.1:${port}`,
          },
        },
        hints: 'on',
        approvalInsight: 'rich',
        reflections: 'on',
      },
      null,
      2,
    ),
  );
}

/**
 * 本地 mock SSE 服务器：**零外网**。
 * 第 1 次请求 → 返回一个 edit_file 工具调用（模型"想改"高风险文件）；
 * 第 2 次请求（工具结果回来后）→ 返回纯文本收尾，避免无限循环。
 */
function startMock(port) {
  return new Promise((resolve, reject) => {
    let callCount = 0;
    server = http.createServer((req, res) => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      callCount += 1;
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock' };

        if (callCount === 1) {
          // 流式 tool_call：先 name，再分两段 arguments（验证跨 chunk 累积拼接）
          const args = JSON.stringify({
            path: RISKY_FILE,
            search: RISKY_SEARCH,
            replace: RISKY_REPLACE,
          });
          const half = Math.floor(args.length / 2);
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'edit_file' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }],
                },
                finish_reason: null,
              },
            ],
          });
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
        } else {
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '好的，已按你的要求处理。' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * 起真实 TUI，按时间表发送输入，收集输出。
 * @param {Array<{atMs: number, write: string}>} schedule
 * @param {number} totalMs
 */
function runTui(schedule, totalMs) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI], {
      cwd: DIR,
      cols: 110,
      rows: 45,
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        CONCERTOAI_HINTS: 'on',
        LUMEN_LOCALE: 'zh',
      },
      name: 'xterm-256color',
    });
    LIVE_TERMS.add(term);
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
      killTermTree(term);
      resolve(raw);
    }, totalMs);
    term.onExit(() => {
      clearTimeout(done);
      for (const t of timers) clearTimeout(t);
      setTimeout(() => resolve(raw), 100);
    });
  });
}

const run = async () => {
  try {
    setup();
    // 端口 0 = 让系统分配空闲端口，避免固定端口冲突（并行跑也不撞）
    await startMock(0);
    const port = server.address().port;
    writeConfig(port);
    console.log(`项目: ${DIR}`);
    console.log(`HOME: ${HOME}`);
    console.log(`mock baseUrl: http://127.0.0.1:${port}\n`);

    // 时间表：等首屏 → 发需求 → 等审批框 → 按 n 拒绝 → 等复盘 → /hints off
    // ⚠️ 文本与回车必须分两次写（T13 实测踩坑：同批写入时 useInput 拿到旧快照，onSubmit('')）
    const raw = await runTui(
      [
        { atMs: 3000, write: '帮我把 dev-secret 换成一个真实密钥' },
        { atMs: 3400, write: '\r' },
        { atMs: 11000, write: 'n' },
        { atMs: 16000, write: '/hints off' },
        { atMs: 16400, write: '\r' },
      ],
      21000,
    );
    const frame = strip(raw);

    if (DUMP_ONLY) {
      console.log('===== 去色输出（尾部 6000）=====');
      console.log(frame.slice(-6000));
      return 0;
    }

    // 复盘文件：等一小会儿让 fire-and-forget 写盘落地
    await new Promise((r) => setTimeout(r, 500));
    let reflections = '';
    try {
      reflections = fs.readFileSync(REFLECTIONS, 'utf8');
    } catch {
      reflections = '';
    }
    const reflectionLines = reflections.split(/\r?\n/).filter(Boolean);

    const checks = [
      {
        name: '① 进 chat 首屏渲染（欢迎语 + 输入框）',
        ok: /欢迎使用 ConcertoAI/.test(frame) && /输入你的需求/.test(frame),
      },
      {
        name: '② 模型请求编辑 → 审批框出现（rich 教学卡标题）',
        ok: /审批/.test(frame) && /编辑文件/.test(frame),
      },
      {
        name: '③ 审批框含「风险点：」与「影响面：」',
        ok: /风险点：/.test(frame) && /影响面：/.test(frame),
      },
      {
        name: '④ 命中高危规则 → 出现 ⚠️ 高风险审批',
        ok: /⚠️\s*高风险审批/.test(frame),
      },
      {
        name: '⑤ 按 n 拒绝 → 复盘真的写盘（reflections.jsonl 有记录）',
        ok: reflectionLines.length > 0,
      },
      {
        name: '⑥ /hints off → 提示已关闭回执出现',
        ok: /已关闭场景提示/.test(frame),
      },
    ];

    let allOk = true;
    for (const c of checks) {
      console.log(`${c.ok ? '✅' : '❌'} ${c.name}`);
      if (!c.ok) allOk = false;
    }

    if (!allOk) {
      console.log('\n───── 去色输出（尾部 6000）─────');
      console.log(frame.slice(-6000));
      console.log('────────────────────────────────');
      console.log(`\n复盘文件 ${REFLECTIONS} 行数=${reflectionLines.length}`);
    } else {
      const risk = frame.match(/风险点：[^\n]*/);
      const impact = frame.match(/影响面：[^\n]*/);
      console.log(`\n风险点实际内容：${risk ? risk[0] : '(未捕获)'}`);
      console.log(`影响面实际内容：${impact ? impact[0] : '(未捕获)'}`);
      console.log(`复盘记录条数：${reflectionLines.length}`);
    }
    console.log(`\n════════ 结果：${allOk ? '✅ 全部 PASS' : '❌ FAIL'} ════════`);
    return allOk ? 0 : 1;
  } finally {
    cleanup();
  }
};

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('\n❌ 脚本异常：', err);
    cleanup();
    process.exitCode = 1;
  });
