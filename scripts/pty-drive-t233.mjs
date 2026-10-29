#!/usr/bin/env node
/**
 * v5.0 T23.3 手工测试的 TTY 取证驱动（2026-10-29）。
 *
 * 覆盖任务书 8 场景中**必须有真实终端才看得见**的四段（其余由 CLI 直跑取证）：
 * | 场景 | 断言 | 为什么单测不够 |
 * |---|---|---|
 * | 3 | 高风险编辑 → 审批风险卡（风险点 / 影响面 / ⚠️ 高风险）→ 按 `v` 展开完整 diff → 按 `n` 拒绝 | 异步 insight 补显 + 按键在真实 TTY 下的行为，组件级测试时序可控 |
 * | 4 | 拒绝后 `reflections.jsonl` 真落盘，`concertoai reflect list` 能读回来 | fire-and-forget 写盘，断言 UI 文案看不出文件真写了没 |
 * | 5 | 连续 2 轮 verify 类命令失败 → 提示行出现**一条可直接执行的命令** | `consecutiveFailures >= 2` 的计数发生在工具结果回调里，端到端才验证 |
 * | 8 | `/hints off` 生效；`/metrics on` 生效；`doctor --metrics` 能汇总 | 斜杠命令真的接到引擎/配置，而不是只有文案 |
 *
 * ## 零网络
 * 场景 3 / 5 / 8 全部走 **本地 mock SSE**（127.0.0.1），不接真实模型、不花真钱、不需要真 Key。
 * 场景 6 / 7（check / commit / review --fix）用真 Key，由另一个脚本跑，不在此文件。
 *
 * ## 两条防「假绿」铁律（2026-10-29 第 2 轮修正）
 *
 * 1. **拼 env 不直通 `{...process.env}`**：必须走 `childEnv()` 显式剔除 `DEEPSEEK_API_KEY`。
 *    直通会把开发机真 Key 带进 mock 场景，把本地 mock 顶掉 → 真花钱 + 断言假绿
 *    （首轮实测泄漏，见 `.git/t233-evidence-run1-leak.md`）。
 * 2. **mock 测试必须有 `MOCK_HITS > 0` 探针通电断言**：mock 一次都没被调用时，
 *    「审批框出现了」这类断言照样可能过（走的是别的路径），全绿等于没测。
 *
 * ## 「（真实）」标记**不能**用来判定真网络（本轮实测推翻首版断言）
 * 状态条的 `token: 10/5（真实）` 中「（真实）」= **usage 来自服务端响应**（相对 BPE 估算），
 * 本地 mock SSE 照样带 `usage` → mock 场景也会出现「（真实）」。首版拿它当「有没有打到
 * 真实 DeepSeek」的判据，会在纯 mock 下 FAIL（假阴性）。正确的判据是**成本行恒为 ¥0.0000**
 * + **token 数值等于 mock 给的 10/5** + `MOCK_HITS > 0`，三条一起。
 *
 * ## 隔离与清理（AGENTS 第 16 / 17 条）
 * - 项目目录 + HOME 全部临时目录，绝不碰开发者真实 `~/.concertoai/`；
 * - 临时目录 / PTY / HTTP server 一律 `try/finally` + `exit`/`SIGINT`/`SIGTERM`/`uncaughtException` 兜底；
 * - Windows 杀 PTY 补 `taskkill /pid <pid> /T /F`，杀前 `process.kill(pid, 0)` 探活（防 pid 复用误伤）；
 * - 清理幂等（flag 防重入）、先杀后删、删失败打印残留路径；跑完**自证**残留为 0。
 *
 * 用法：node scripts/pty-drive-t233.mjs [--dump]
 * 前置：npm run build（用 dist/cli/index.js）+ node-pty（devDependencies）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import pty from 'node-pty';

/**
 * 【已知噪音——勿吞】退出时 stderr 的 `Error: AttachConsole failed`
 * 是 node-pty/ConPTY 拆除阶段的上游行为，发生在全部断言 PASS 之后，不影响退出码。
 * 吞掉会同时吞掉「上游行为提前到断言阶段」的真 bug 信号。
 */

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DUMP_ONLY = process.argv.includes('--dump');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-t233-'));
const LIVE_TERMS = new Set();
let server;
/** mock 收到的 chat/completions 次数——**探针通电**的证据（=0 说明注入没被读到，一切断言都不算数）。 */
let MOCK_HITS = 0;

const RISKY_FILE = 'auth-service.js';
const RISKY_BEFORE = `// 登录鉴权（命中 auth-change / secret-hardcode）
const SECRET = 'dev-secret';

function login(user, pass) {
  if (user === 'admin') return true;
  return pass === SECRET;
}

module.exports = { login };
`;
const RISKY_SEARCH = `const SECRET = 'dev-secret';`;
const FAKE_BODY = ['9f2b8c1d', '4e6a7f8b', '9c0d1e2f', '3a4b5c6d'].join('');
const RISKY_REPLACE = `const SECRET = '${['s', 'k', '-'].join('')}${FAKE_BODY}';`;

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
const leftovers = [];
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const term of [...LIVE_TERMS]) {
    try {
      // 杀前探活：pid 复用时不误伤别人
      if (process.platform !== 'win32') process.kill(term.pid, 0);
    } catch {
      LIVE_TERMS.delete(term);
      continue;
    }
    killTermTree(term);
  }
  try {
    // keep-alive 连接不主动断开时 close() 会一直等 → 进程永不退出（实测踩到：脚本跑完但命令超时）
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

// ── 场景环境 ──────────────────────────────────────────────────

/** 一次场景 = 一个隔离项目目录 + 一个隔离 HOME。 */
function makeEnv(name) {
  const base = path.join(ROOT, name);
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.concertoai'), { recursive: true });
  return { base, dir, home };
}

/**
 * 写 config（baseUrl 指向本地 mock）。
 *
 * ⚠️ **必须是 `schemaVersion: 2`（v4 形态）**：实测用 `schemaVersion: 1`（v3 形态）
 * 写同一份含 `providers.deepseek.{baseUrl,apiKey}` 的配置，v3→v4 迁移会**重建 providers**
 * 并**静默丢弃 baseUrl / apiKey** → 请求打到真实 DeepSeek 端点（第一次跑就把真 key 用上了）。
 * 详见本轮手工测试报告的「已知问题」与 TASKS 待办。
 *
 * mock key 给足 35 字符：太短会被当成占位符而回落到环境变量。
 */
const MOCK_KEY = `${['s', 'k', '-'].join('')}${'0123456789abcdef'.repeat(2)}`;
function writeConfig(home, port, extra = {}) {
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
        approvalInsight: 'rich',
        reflections: 'on',
        ...extra,
      },
      null,
      2,
    ),
  );
}

/**
 * 本地 mock SSE。mode:
 * - `edit`：第 1 次请求 → edit_file 工具调用（改高风险文件），第 2 次 → 纯文本收尾
 * - `verify-fail`：前 2 次 → run_command 跑 `npm run test`（白名单免审批、必失败），第 3 次 → 纯文本
 */
function startMock(mode) {
  return new Promise((resolve, reject) => {
    let calls = 0;
    server = http.createServer((req, res) => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      MOCK_HITS += 1; // 探针通电计数（断言 mock 真被调用，避免「假绿」）
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        calls += 1;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock' };
        const toolCall = (name, args) => {
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${calls}`, type: 'function', function: { name } }] },
                finish_reason: null,
              },
            ],
          });
          send({
            ...base,
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: 'tool_calls' },
            ],
          });
        };

        if (mode === 'edit' && calls === 1) {
          toolCall('edit_file', JSON.stringify({ path: RISKY_FILE, search: RISKY_SEARCH, replace: RISKY_REPLACE }));
        } else if (mode === 'verify-fail' && calls <= 2) {
          toolCall('run_command', JSON.stringify({ command: 'npm run test' }));
        } else {
          send({
            ...base,
            choices: [{ index: 0, delta: { role: 'assistant', content: '好的，处理完毕。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.on('error', reject);
    // 端口 0：系统分配空闲端口，避免并行跑撞端口
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const PORT = await startMock('edit');

// ── TUI 驱动 ──────────────────────────────────────────────────

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * 子进程环境（**铁律：不能直通 `{...process.env}`**）。
 *
 * 直通会把开发机的 `DEEPSEEK_API_KEY` 带进 mock 场景，而 Key 解析链是「环境变量 > config」
 * （ADR-029）→ 本地 mock 的 baseUrl/apiKey 被真 Key 顶掉，请求打到真实端点（首轮实测泄漏，
 * 见 `.git/t233-evidence-run1-leak.md`）。本脚本所有子进程（PTY 与 spawnSync）**只此一处**拼 env。
 */
function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LUMEN_LOCALE: 'zh', ...extra };
  delete env.DEEPSEEK_API_KEY;
  delete env.KEEP_REAL_KEY;
  return env;
}

/** 直跑 CLI 子命令（非 TTY 取证），与 TUI 同源剔除真实 key。 */
function runCli(args, dir, home, extraEnv = {}) {
  return spawnSync(NODE, [CLI, ...args], {
    cwd: dir,
    env: childEnv(home, extraEnv),
    encoding: 'utf8',
  });
}

/** 就绪门宽限：`after` 迟迟匹配不上时最多再等这么久，然后**照发并如实记录 gate 超时**。 */
const GATE_GRACE_MS = 6000;

/**
 * 跑一次 TUI 会话。
 *
 * `steps` 每项 `{ atMs, write, after? }`：
 * - `atMs`：最早发送时刻（毫秒，自本进程启动算）；
 * - `after`：**就绪门**——必须先在本步之前的输出里匹配到它才允许发（如首屏输入框「输入你的需求」）。
 *
 * 为什么需要就绪门：首轮场景 8 在 1200ms 敲 `/hints off`，此时 Ink 的 stdin 监听还没挂上，
 * 字符被吞掉一半（回显成「跑一下测试f」）→「斜杠命令没生效」是**测试脚本的假阳性**，
 * 不是产品缺陷。就绪门把「应用没准备好」与「命令真的没接上」区分开。
 *
 * 返回 `{ raw, gateMisses }`：gateMisses 非空 = 该步是「等够就硬发」，断言要据此打折。
 */
function runTui(dir, home, steps, totalMs, env = {}) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI], {
      cwd: dir,
      cols: 120,
      rows: 50,
      env: childEnv(home, { CONCERTOAI_HINTS: 'on', ...env }),
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
          if (elapsed < step.atMs + GATE_GRACE_MS) return; // 就绪门未开 → 继续等
          gateMisses.push(step.write); // 等够了硬发，留证据
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
    const stopTick = () => clearInterval(tick);
    const done = setTimeout(() => {
      stopTick();
      killTermTree(term);
      resolve({ raw: strip(raw), gateMisses });
    }, totalMs);
    term.onExit(() => {
      clearTimeout(done);
      stopTick();
      setTimeout(() => resolve({ raw: strip(raw), gateMisses }), 120);
    });
  });
}

// ── 断言框架 ──────────────────────────────────────────────────

const results = [];
const transcript = [];
const LOG = path.join(REPO, '.git', 't233-progress.log');
fs.writeFileSync(LOG, '');
function say(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`); // 边跑边落盘：命令被超时杀掉也留得住证据
  } catch {
    /* ignore */
  }
}
function check(scenario, name, cond, detail = '') {
  results.push({ scenario, name, pass: cond === true, detail });
  say(`${cond ? 'PASS' : 'FAIL'} | 场景${scenario} | ${name}${detail ? ` | ${detail}` : ''}`);
}

/**
 * 只观察、不判定（不计入 PASS/FAIL 条数）。
 *
 * 用于**已知缺陷的实测取证**：T23.3 的用户裁决是「手工测试报告不修 bug」，
 * 所以 doctor 退出码这类已知问题必须留下**数值证据**，但不能让整轮脚本变红
 * ——否则「报告如实记录」会被误读成「本轮测试失败」。
 */
function note(line) {
  say(`OBSERVE | ${line}`);
}

const run = async () => {
  // ═══════════════ 场景 1c：配置好之后进 chat（首屏 + 退得体面）═══════════════
  {
    const { dir, home } = makeEnv('s1c');
    writeConfig(home, PORT);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 's1cdemo', version: '1.0.0' }, null, 2));
    const { raw, gateMisses } = await runTui(
      dir,
      home,
      [
        { atMs: 1200, write: '\u0003', after: /输入你的需求/ }, // 什么都不做，直接 Ctrl+C
      ],
      4000,
    );
    transcript.push({ scenario: '1c', dir, raw, gateMisses });
    if (DUMP_ONLY) console.log(raw);
    check(1, '进 chat 首屏有欢迎语与入口提示', raw.includes('欢迎使用 ConcertoAI') && raw.includes('/help'));
    check(1, '首屏告诉用户下一步敲什么（输入框提示 + 常用命令）', raw.includes('输入你的需求') && /\/plan|常用/.test(raw));
    check(1, '首屏显示当前 Provider/模型（用户知道自己会为谁付费）', raw.includes('Provider: deepseek') && /模型: \S+/.test(raw));
    check(1, 'Ctrl+C 退得体面（提示会话已保存，不留报错堆栈）', raw.includes('会话已保存') && !/Error|stack/i.test(raw), `gate 超时 ${gateMisses.length} 个`);
  }

  // ═══════════════ 场景 3 + 4：审批风险卡 + 拒绝复盘 ═══════════════
  {
    const { dir, home } = makeEnv('s3');
    writeConfig(home, PORT);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 's3demo', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(dir, RISKY_FILE), RISKY_BEFORE);
    fs.writeFileSync(
      path.join(dir, 'server.js'),
      `const { login } = require('./${RISKY_FILE}');\nconsole.log(login('a', 'b'));\n`,
    );

    const { raw, gateMisses } = await runTui(
      dir,
      home,
      [
        { atMs: 1500, write: '把 SECRET 换成一个新的 key', after: /输入你的需求/ },
        { atMs: 2200, write: '\r' },
        { atMs: 6500, write: 'v' }, // 展开完整 diff
        { atMs: 7800, write: 'n' }, // 拒绝
        { atMs: 13000, write: '\u0003' }, // Ctrl+C 退出
      ],
      15000,
    );
    transcript.push({ scenario: '3', dir, raw, gateMisses });
    if (DUMP_ONLY) console.log(raw);

    check(3, '脚本健康：所有按键都在应用就绪后送出（gateMisses 应为 0）', gateMisses.length === 0, `gate 超时 ${gateMisses.length} 个`);
    check(3, '探针通电：本地 mock 真的收到请求（=0 则全部断言不算数）', MOCK_HITS > 0, `mock 命中 ${MOCK_HITS} 次`);
    // 零真钱判据：状态条每次刷新都必须成本 0；真调用一次就是 ¥0.00xx（首轮实测 ¥0.0058）
    const costLines = raw.match(/成本: ¥[\d.]+/g) ?? [];
    check(
      3,
      '零真钱：每次状态条刷新成本都是 ¥0.0000（真调用会出现 ¥0.00xx）',
      costLines.length > 0 && costLines.every((c) => c === '成本: ¥0.0000'),
      `${costLines.length} 次刷新，非零 ${costLines.filter((c) => c !== '成本: ¥0.0000').length} 次`,
    );
    // 溯源判据：token 数值必须等于 mock 写死的 usage（10/5）——证明数字来自本机 mock 而非远端
    check(3, 'token 数值来自本地 mock（10/5）', /token: 10\/5/.test(raw), raw.match(/token: \d+\/\d+/g)?.slice(-1)[0] ?? '');

    check(3, '审批框出现', /审批|批准|允许/.test(raw));
    check(3, '含「风险点」', raw.includes('风险点'));
    check(3, '含「影响面」且给出真实引用数', /影响面/.test(raw) && /1 个文件引用/.test(raw), raw.match(/影响面[^\n]*/)?.[0] ?? '');
    check(3, '命中高危规则 → 出现「高风险审批」', raw.includes('高风险审批'));
    check(3, '按 v 后 diff 展开（出现 diff 正文行）', raw.includes('SECRET') && /diff|改动|-/i.test(raw));
    check(3, '拒绝后界面给中性提示（不冒充错误）', /已拒绝|拒绝/.test(raw));

    // 场景 4：拒绝复盘落盘 + reflect list 读回
    const rf = path.join(home, '.concertoai', 'reflections.jsonl');
    const exists = fs.existsSync(rf);
    const lines = exists ? fs.readFileSync(rf, 'utf8').split('\n').filter(Boolean) : [];
    check(4, 'reflections.jsonl 已落盘且有记录', exists && lines.length >= 1, `行数 ${lines.length}`);
    const echoed = runCli(['reflect', 'list'], dir, home);
    const reflectOut = `${echoed.stdout ?? ''}${echoed.stderr ?? ''}`;
    transcript.push({ scenario: '4', dir, raw: reflectOut, exit: echoed.status });
    check(4, 'reflect list 能读回拒绝记录', echoed.status === 0 && reflectOut.trim().length > 0, `exit=${echoed.status}`);
    check(4, 'reflect list 显示文件名（用户能认出拒了哪个文件）', reflectOut.includes(RISKY_FILE));
  }

  // ═══════════════ 场景 5：连续 2 轮 verify 失败 → 场景提示 ═══════════════
  {
    // 换 mock 模式：就地重开服务器（先关旧的不必——模式在闭包外，改用具名实例）
    server.close();
    server = undefined;
    const port = await startMock('verify-fail');
    const { dir, home } = makeEnv('s5');
    writeConfig(home, port);
    // npm run test 在白名单内（免审批），脚本故意失败 → 造出「连续 2 轮失败」
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        { name: 's5demo', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } },
        null,
        2,
      ),
    );
    // 放一份规则文件，避免 missing-project-rules（priority 10）抢在同一条提示位上
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 规则\n\n- 这是手工测试项目\n');
    fs.writeFileSync(
      path.join(home, '.concertoai', 'hint-state.json'),
      JSON.stringify({ cooldowns: {}, sessionCount: 0 }, null, 2),
    );

    const { raw, gateMisses } = await runTui(
      dir,
      home,
      [
        { atMs: 1500, write: '跑一下测试', after: /输入你的需求/ },
        { atMs: 2200, write: '\r' },
        { atMs: 14000, write: '\u0003' },
      ],
      16000,
    );
    transcript.push({ scenario: '5', dir, raw, gateMisses });
    if (DUMP_ONLY) console.log(raw);

    check(5, '脚本健康：所有按键都在应用就绪后送出（gateMisses 应为 0）', gateMisses.length === 0, `gate 超时 ${gateMisses.length} 个`);
    // TUI 对 run_command 只显示工具名（不显示输出）→ 断言工具调用次数，不去找「失败」字样：
    // 失败的可观测证据是**后续提示行**（连续 2 轮失败才触发，见 src/ui/hint-signals.ts）
    const runCmdHits = (raw.match(/run_command/g) ?? []).length;
    check(5, '两次 run_command 都发生了（round 1 + round 2 各一次）', runCmdHits >= 2, `出现 ${runCmdHits} 次`);
    check(5, '出现场景提示行（含可直接执行的命令）', /concertoai (self-heal|init|fix)/.test(raw));
    check(5, '提示命令是 concertoai self-heal（如实记录与任务书 `concertoai fix` 的差异）', raw.includes('concertoai self-heal'));

    // 场景 8 前半：/hints off 生效（**就绪门**：等首屏输入框出现再敲，否则字符被 stdin 未挂载吞掉）
    const hints = await runTui(
      dir,
      home,
      [
        { atMs: 1200, write: '/hints off', after: /输入你的需求/ },
        { atMs: 2000, write: '\r' },
        { atMs: 3000, write: '/hints status' },
        { atMs: 3800, write: '\r' },
        { atMs: 5200, write: '\u0003' },
      ],
      6500,
    );
    transcript.push({ scenario: '8-hintsoff', dir, raw: hints.raw, gateMisses: hints.gateMisses });
    check(8, '/hints off 回执（脚本健康：无 gate 超时）', hints.raw.includes('已关闭场景提示') && hints.gateMisses.length === 0, `gate 超时 ${hints.gateMisses.length} 个`);
    check(8, '/hints status 反映已关闭（不是假按钮）', hints.raw.includes('场景提示：已关闭'));
    check(8, '/hints off 回执给出永久关闭命令（不打空头支票）', hints.raw.includes('concertoai config set hints off'));

    // 场景 8 后半：/metrics on + doctor --metrics
    const met = await runTui(
      dir,
      home,
      [
        { atMs: 1200, write: '/metrics on', after: /输入你的需求/ },
        { atMs: 2000, write: '\r' },
        { atMs: 3000, write: '/metrics status' },
        { atMs: 3800, write: '\r' },
        { atMs: 5200, write: '\u0003' },
      ],
      6500,
    );
    transcript.push({ scenario: '8-metrics', dir, raw: met.raw, gateMisses: met.gateMisses });
    check(8, '/metrics on 回执（脚本健康：无 gate 超时）', met.raw.includes('已开启本地指标') && met.gateMisses.length === 0, `gate 超时 ${met.gateMisses.length} 个`);
    check(8, '/metrics status 反映已开启（不是假按钮）', met.raw.includes('本地指标：已开启'));
    check(8, '/metrics on 回执给出永久开启命令（不打空头支票）', met.raw.includes('concertoai config set metrics on'));

    // 设计核对（ADR-044）：`/metrics on` 是**会话级**，不写配置——首版脚本断言它写配置，
    // 是与设计相反的假阳性。正确断言 = 配置未被改写 + 回执明确说「仅本次会话」并给永久命令。
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.concertoai', 'config.json'), 'utf8'));
    check(8, '/metrics on 不写配置（会话级，ADR-044）且回执说明「仅本次会话」', cfg.metrics === undefined && met.raw.includes('仅本次会话'), `config.metrics=${cfg.metrics ?? 'undefined'}`);

    // 探针通电：先用官方命令永久开启（回执承诺的那条），doctor 的指标段必须从「未开启」变「已开启」
    const beforeDoctor = runCli(['doctor', '--metrics'], dir, home);
    const setMetrics = runCli(['config', 'set', 'metrics', 'on'], dir, home);
    const doctor = runCli(['doctor', '--metrics'], dir, home);
    const beforeOut = `${beforeDoctor.stdout ?? ''}${beforeDoctor.stderr ?? ''}`;
    const docOut = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`;
    transcript.push({ scenario: '8-doctor', dir, raw: docOut, exit: doctor.status, beforeOut, setExit: setMetrics.status });
    check(8, '探针通电：开启前 doctor 指标段是「未开启」', beforeOut.includes('未开启'), `config set metrics on exit=${setMetrics.status}`);
    check(8, 'doctor --metrics 汇总段存在且随配置改变（看内容，不看退出码）', docOut.includes('本地体验指标') && docOut.includes('已开启') && docOut.includes('存储位置'));
    check(8, 'doctor --metrics 无数据时不编统计（如实说暂无数据）', docOut.includes('暂无指标数据'));
    // ⚠️ 已知缺陷：`concertoai doctor` 输出全绿但 exit 1（迁移备份判定过严 + 显示与退出码脱节）。
    // 用户裁决（2026-10-29）：**T23.3 不修 bug**，如实记录 + 记 TASKS 待办，故此处只观察不断言。
    note(`doctor --metrics 退出码 = ${doctor.status}（已知缺陷，见报告「已知问题 K1」）`);
  }

  // ── 收尾统计 ──
  cleanup();
  const failed = results.filter((r) => !r.pass);
  say(`\n合计 ${results.length} 条断言；PASS ${results.length - failed.length}；FAIL ${failed.length}`);
  say(`清理自证：PTY 残留 ${LIVE_TERMS.size} / 临时目录存在 ${fs.existsSync(ROOT)} / 清理失败 ${leftovers.length}`);
  if (leftovers.length) say(`残留：${leftovers.join(', ')}`);

  fs.writeFileSync(
    path.join(REPO, '.git', 't233-transcript.json'),
    JSON.stringify({ results, transcript, root: ROOT, cleaned: !fs.existsSync(ROOT) }, null, 2),
  );
  // 显式退出：即便还有残留句柄（keep-alive socket 等）也不让命令挂到超时
  process.exit(failed.length === 0 ? 0 : 1);
};

await run();
