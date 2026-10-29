#!/usr/bin/env node
/**
 * v5.0 T23.3 手工测试驱动（第 2 部分）：场景 1 与场景 2。
 *
 * 与 `pty-drive-t233.mjs`（场景 3/4/5/8，本地 mock SSE）互补：本文件覆盖**前两步新手路**，
 * 全程**零网络、零真 Key、不花钱**：
 *
 * | 场景 | 用户动作 | 断言重点 |
 * |---|---|---|
 * | 1 | 新用户直接 `concertoai chat`（没配 Key）→ 跟着引导配置 → 再进 chat | 引导**说得出三种真生效方式** + 行数不淹没 + 配好后真能进（不是空头支票） |
 * | 2 | `concertoai init` → 双文件 → 打开 `PROJECT_GUIDE.md` 看「最脆弱的地方」 | 两份文件都落盘 + 每条结论带 `文件:行号` + 二次运行默认不覆盖（fail-closed） |
 *
 * ## 隔离（AGENTS 第 16 / 17 条）
 * - 项目目录与 HOME 全在 `mkdtemp` 临时目录，**不碰**开发者真实 `~/.concertoai/`；
 * - 子进程 env 一律走 `childEnv()`：显式 `delete DEEPSEEK_API_KEY`（**禁止直通 `{...process.env}`**）；
 * - 清理进 `try/finally` + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 兜底，幂等 flag，跑完自证残留为 0；
 * - Windows 杀 PTY 用 `taskkill /pid <pid> /T /F`，杀前 `process.kill(pid, 0)` 探活。
 *
 * 用法：node scripts/t233-scenarios-12.mjs [--dump]
 * 前置：npm run build（用 dist/cli/index.js）+ node-pty
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-t233b-'));
const LIVE_TERMS = new Set();
const leftovers = [];
/** 本地 mock 收到的 chat/completions 次数——**探针通电**证据（=0 说明配置没被读到，断言不算数）。 */
let MOCK_HITS = 0;
let server;

/**
 * 极简本地 mock SSE（只回纯文本）。
 *
 * 用途：证明「引导里的方式 ③（写 config.json 的 providers.deepseek.apiKey）」对 chat **真生效**
 * ——只看「能进 chat」是假绿（进 chat 不读 Key），必须看到 mock 真收到请求。
 */
function startMock() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      MOCK_HITS += 1;
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock' };
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '收到，这是本地 mock 的回复。' }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ── 清理 ──────────────────────────────────────────────────────

function killTermTree(term) {
  const pid = term?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        term.kill();
      }
    }
  } catch {
    /* 已死 */
  }
  LIVE_TERMS.delete(term);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const term of [...LIVE_TERMS]) {
    try {
      if (process.platform !== 'win32') process.kill(term.pid, 0); // 杀前探活
    } catch {
      LIVE_TERMS.delete(term);
      continue;
    }
    killTermTree(term);
  }
  try {
    // keep-alive 连接不主动断开时 close() 会一直等 → 进程永不退出（T23.1 实测踩到）
    server?.closeAllConnections?.();
    server?.close();
  } catch {
    /* ignore */
  }
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

// ── 公共 ──────────────────────────────────────────────────────

/** 子进程环境：**必须显式剔除真实 Key**（禁止直通 `{...process.env}`）。 */
function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LUMEN_LOCALE: 'zh', ...extra };
  delete env.DEEPSEEK_API_KEY;
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

function runCli(args, dir, home) {
  return spawnSync(NODE, [CLI, ...args], {
    cwd: dir,
    env: childEnv(home),
    encoding: 'utf8',
  });
}

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const GATE_GRACE_MS = 6000;

/** 跑一次 TUI；`after` 是就绪门（匹配到才发键，否则等 grace 后硬发并记录）。 */
function runTui(dir, home, steps, totalMs) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI], {
      cwd: dir,
      cols: 120,
      rows: 50,
      env: childEnv(home),
      name: 'xterm-256color',
    });
    LIVE_TERMS.add(term);
    let raw = '';
    const startedAt = Date.now();
    const pending = [...steps];
    const gateMisses = [];
    const pump = () => {
      while (pending.length > 0) {
        const step = pending[0];
        const elapsed = Date.now() - startedAt;
        if (elapsed < step.atMs) return;
        if (step.after !== undefined && !step.after.test(raw)) {
          if (elapsed < step.atMs + GATE_GRACE_MS) return;
          gateMisses.push(step.write);
        }
        pending.shift();
        try {
          term.write(step.write);
        } catch {
          /* dead */
        }
      }
    };
    term.onData((d) => {
      raw += d;
      pump();
    });
    const tick = setInterval(pump, 100);
    const done = setTimeout(() => {
      clearInterval(tick);
      killTermTree(term);
      resolve({ raw: strip(raw), gateMisses });
    }, totalMs);
    term.onExit(() => {
      clearTimeout(done);
      clearInterval(tick);
      setTimeout(() => resolve({ raw: strip(raw), gateMisses }), 120);
    });
  });
}

// ── 断言 ──────────────────────────────────────────────────────

const results = [];
const transcript = [];
const LOG = path.join(REPO, '.git', 't233b-progress.log');
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

// ── 执行的目录（AGENTS 第 16 条：报告要记「实际执行目录」）──
const actualDirs = {};

const run = async () => {
  // ═════════ 场景 1：新用户缺 Key → 引导 → 配置 → 进 chat ═════════
  {
    const { dir, home } = makeEnv('s1');
    actualDirs.s1 = { dir, home };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 's1demo', version: '1.0.0' }, null, 2));

    // ② 没有 Key 直接 chat（非 TTY 一路，能一行命令取到完整引导）
    const noKey = runCli(['chat'], dir, home);
    const guide = `${noKey.stdout ?? ''}${noKey.stderr ?? ''}`;
    transcript.push({ scenario: '1-nokey', raw: guide, exit: noKey.status, dir });
    if (DUMP_ONLY) console.log(guide);

    const guideLines = guide.split(/\r?\n/).filter((l) => l.trim() !== '');
    check(1, '缺 Key 时给出引导而不是抛栈', /未检测到 DeepSeek API Key/.test(guide), `exit=${noKey.status}`);
    check(1, '引导退出码非 0（脚本/CI 能判失败）', noKey.status !== 0, `exit=${noKey.status}`);
    check(1, '三种方式都在（环境变量 / login / config.json）',
      guide.includes('1. 设置环境变量') && guide.includes('2. 登录账号') && guide.includes('3. 写入配置文件'));
    check(1, '给出真生效的变量名 DEEPSEEK_API_KEY', guide.includes('DEEPSEEK_API_KEY'));
    check(1, '给出可复制的 login 命令', guide.includes('concertoai login myname --key sk-...'));
    check(1, '给出 config.json 里真实生效的字段路径', guide.includes('"providers"') && guide.includes('"deepseek"') && guide.includes('"apiKey"'));
    check(1, '给出官方获取地址', guide.includes('https://platform.deepseek.com/api_keys'));
    check(1, '输出不淹没（≤ 24 行）', guideLines.length <= 24, `${guideLines.length} 行`);

    // ③ 照引导配置（方式 3：写 config.json 的 providers.deepseek.apiKey，schemaVersion 2 = v4 形态）
    const port = await startMock();
    const MOCK_KEY = `${['s', 'k', '-'].join('')}${'0123456789abcdef'.repeat(2)}`;
    fs.writeFileSync(
      path.join(home, '.concertoai', 'config.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          defaultProvider: 'deepseek',
          providers: {
            deepseek: { type: 'deepseek', apiKey: MOCK_KEY, model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${port}` },
          },
          hints: 'on',
        },
        null,
        2,
      ),
    );

    // ④ 进 chat 并**真发一条消息**：只有 mock 收到请求才能证明「方式 3」生效
    //    （只看「能进 chat」是假绿——进 chat 根本不读 Key）
    const chat = await runTui(
      dir,
      home,
      [
        { atMs: 1500, write: '你好', after: /输入你的需求/ },
        { atMs: 2300, write: '\r' },
        { atMs: 8000, write: '\u0003' },
      ],
      9500,
    );
    transcript.push({ scenario: '1-chat', raw: chat.raw, gateMisses: chat.gateMisses, dir, mockHits: MOCK_HITS });
    if (DUMP_ONLY) console.log(chat.raw);

    check(1, '照引导配置后能真的进 chat（首屏欢迎语）', chat.raw.includes('欢迎使用 ConcertoAI'));
    check(1, '输入框提示可见（用户知道怎么说话）', chat.raw.includes('输入你的需求'));
    check(1, '状态条显示 Provider 与模型（用户知道在为谁付费）', chat.raw.includes('Provider: deepseek') && chat.raw.includes('deepseek-v4-flash'));
    check(1, '探针通电：方式 ③（config.json 写 apiKey）对 chat 真生效（本地 mock 收到请求）', MOCK_HITS > 0, `mock 命中 ${MOCK_HITS} 次`);
    check(1, '模型回复到达界面（不是只有请求发出去）', chat.raw.includes('本地 mock 的回复'));
    check(1, '全程零成本（本地 mock 不花钱）', (chat.raw.match(/成本: ¥[\d.]+/g) ?? []).every((c) => c === '成本: ¥0.0000'));
    check(1, 'Ctrl+C 退出体面（不刷栈）', !/Error:|at Object\./.test(chat.raw), `gate 超时 ${chat.gateMisses.length} 个`);

    // ⑤ 引导里写的下一步 `concertoai doctor` 验证环境——**实测不认方式 ③**
    const doc = runCli(['doctor'], dir, home);
    const docOut = `${doc.stdout ?? ''}${doc.stderr ?? ''}`;
    transcript.push({ scenario: '1-doctor', raw: docOut, exit: doc.status, dir });
    // ⚠️ 已知缺陷 K2：doctor 走 resolveApiKeyCached()（不读 config 的 providers.apiKey），
    // 而 getApiKey() 读 → 用户按引导方式 ③ 配好后 chat 能用，doctor 却说「❌ API Key: 未设置」。
    // 用户裁决（2026-10-29）：T23.3 是手工测试报告，不修 bug → 只观察 + 记 TASKS 待办。
    note(
      `场景 1：doctor 对方式 ③ 已配的 Key 报「${(docOut.match(/[✅❌] API Key: [^\r\n]*/) ?? ['(未匹配)'])[0].trim()}」；退出码 ${doc.status}（已知缺陷 K2/K1，见报告）`,
    );
  }

  // ═════════ 场景 2：init 双文件 + PROJECT_GUIDE 高风险区域 ═════════
  {
    const { dir, home } = makeEnv('s2');
    actualDirs.s2 = { dir, home };
    // 造一个「真有风险点」的迷你项目：鉴权判断、硬编码密钥、删除调用、被多处引用的核心文件
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        { name: 's2demo', version: '1.0.0', scripts: { test: 'vitest run', lint: 'biome check src' } },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'auth.js'),
      [
        "const SECRET = 'hardcoded-secret-123';",
        'function login(user, pass) {',
        "  if (user === 'admin') return true;",
        '  return pass === SECRET;',
        '}',
        'module.exports = { login };',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'store.js'),
      ["const fs = require('node:fs');", 'function purge(p) {', '  fs.rmSync(p, { recursive: true });', '}', 'module.exports = { purge };'].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'index.js'),
      ["const { login } = require('./auth');", "const { purge } = require('./store');", "console.log(login('a','b'), purge);"].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'server.js'),
      ["const { login } = require('./auth');", "module.exports = { login };", '// TODO: 加超时'].join('\n'),
    );

    // ① 首次运行
    const init1 = runCli(['init'], dir, home);
    const out1 = `${init1.stdout ?? ''}${init1.stderr ?? ''}`;
    transcript.push({ scenario: '2-init1', raw: out1, exit: init1.status, dir });
    if (DUMP_ONLY) console.log(out1);

    const agentsPath = path.join(dir, 'AGENTS.md');
    const guidePath = path.join(dir, 'PROJECT_GUIDE.md');
    check(2, '首次 init 成功退出', init1.status === 0, `exit=${init1.status}`);
    check(2, '双文件都生成（AGENTS.md 给 AI + PROJECT_GUIDE.md 给人）', fs.existsSync(agentsPath) && fs.existsSync(guidePath));
    const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
    const guideMd = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
    transcript.push({ scenario: '2-files', agentsChars: agents.length, guideChars: guideMd.length, dir });

    check(2, 'AGENTS.md 有内容（给 AI 的规则不是空文件）', agents.length > 200, `${agents.length} 字符`);
    check(2, 'PROJECT_GUIDE.md 有内容（给人看的指南）', guideMd.length > 200, `${guideMd.length} 字符`);
    check(2, 'PROJECT_GUIDE 含「一、这个项目最脆弱的地方」（用户被指路的第一节）', guideMd.includes('这个项目最脆弱的地方'));
    check(2, 'PROJECT_GUIDE 含高风险条目并带具体行号（G7 证据优先）', /高风险|鉴权|删除/.test(guideMd) && /[A-Za-z0-9_./-]+\.(js|ts|mjs):\d+/.test(guideMd),
      guideMd.match(/[A-Za-z0-9_./-]+\.(js|ts|mjs):\d+/)?.[0] ?? '');
    check(2, 'PROJECT_GUIDE 指出连锁反应区（被引用最多的文件）', guideMd.includes('连锁反应'));
    check(2, '摘要行数受控（≤ 6 行摘要，不淹没终端）', out1.split(/\r?\n/).filter((l) => l.trim() !== '').length <= 12,
      `${out1.split(/\r?\n/).filter((l) => l.trim() !== '').length} 行`);

    // ② 二次运行：非 TTY 默认不覆盖（fail-closed），exit 0 + 明说未写入
    const init2 = runCli(['init'], dir, home);
    const out2 = `${init2.stdout ?? ''}${init2.stderr ?? ''}`;
    transcript.push({ scenario: '2-init2', raw: out2, exit: init2.status, dir });
    check(2, '二次 init 默认不覆盖（非 TTY fail-closed）', out2.includes('已存在，非交互环境不覆盖') && out2.includes('未写入任何文件'));
    check(2, '二次 init 不改动原文件（内容逐字未变）', fs.readFileSync(guidePath, 'utf8') === guideMd);

    // ③ 非项目目录：不生成空文件污染目录
    const { dir: emptyDir, home: home3 } = makeEnv('s2b');
    actualDirs.s2b = { dir: emptyDir, home: home3 };
    const init3 = runCli(['init'], emptyDir, home3);
    const out3 = `${init3.stdout ?? ''}${init3.stderr ?? ''}`;
    transcript.push({ scenario: '2-notproject', raw: out3, exit: init3.status, dir: emptyDir });
    check(2, '非项目目录友好退出且不生成文件', init3.status === 1 && out3.includes('看起来不是项目根目录') && fs.readdirSync(emptyDir).length === 0);
  }

  // ── 收尾 ──
  cleanup();
  const failed = results.filter((r) => !r.pass);
  say(`\n合计 ${results.length} 条断言；PASS ${results.length - failed.length}；FAIL ${failed.length}`);
  say(`清理自证：PTY 残留 ${LIVE_TERMS.size} / 临时目录存在 ${fs.existsSync(ROOT)} / 清理失败 ${leftovers.length}`);
  if (leftovers.length) say(`残留：${leftovers.join(', ')}`);

  fs.writeFileSync(
    path.join(REPO, '.git', 't233b-transcript.json'),
    JSON.stringify({ results, transcript, actualDirs, root: ROOT, cleaned: !fs.existsSync(ROOT) }, null, 2),
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

await run();
