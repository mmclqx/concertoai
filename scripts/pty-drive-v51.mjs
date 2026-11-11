#!/usr/bin/env node
/**
 * v5.1 T3.2 手工验收 TTY 端到端驱动（2026-11-11）。
 *
 * 三场景串行，**全部零网络、零真钱**（本地 mock SSE，`providers.deepseek.baseUrl` 指向 127.0.0.1），
 * 每个场景独立临时项目目录 + 独立 `HOME`（绝不碰开发者真实 `~/.concertoai/`）。
 *
 * | # | 场景 | 断言要证明的「用户视角」事实 | 为什么单测不够 |
 * |---|---|---|---|
 * | S1 | `chat --auto-low` + 零命中编辑 | 弹框**没出现**、留痕**出现**（含累计次数与规则条数）、**磁盘上真的改了** | 单测断言的是「decideAutoLow 返回 allow」；「用户看不到框、但文件真的写进去了」只有真 TTY + 真工具链能证明（v5.1 踩坑：审批帧显示过 ≠ 磁盘上有） |
 * | S2 | 分析降级（`approvalInsight: 'plain'` ⇒ `degraded`）| **仍然弹框**、没有留痕、按 `n` 后**磁盘未变** | 降级时 `level` 恰好是 `low`，命门靠 `degraded` 兜住；单测喂的是构造对象，端到端才验证「降级真的被识别成降级」 |
 * | S3 | 同一次输入内连续两个工具 | 状态行出现「第 1 步」「第 2 步」，且**不出现分母**（`/总数`）| 步号由 loop 发、UI 显示，跨层；seq 与渲染是否真的接上只有真 TTY 能看 |
 * | S4 | **首次运行**：完全没有 `config.json` + `chat --auto-low` | 缺 Key 引导（三种真实生效方式）出现、**exit 1 自行退出**（不静默挂起、不需要用户按 Ctrl+C） | AGENTS 边缘路径 ①首次运行 / ③主动退出；单测里所有用例都预设了 config 与 Key，「一身干净的机器上敲第一条命令」谁都没跑过 |
 *
 * 隔离与清理：临时目录 / PTY / HTTP 服务器一律 `try/finally` + 进程钩子兜底；
 * Windows 下 PTY 补 `taskkill /T /F`；清理幂等。
 *
 * 用法：node scripts/pty-drive-v51.mjs [--dump] [--only=s1,s2,s3,s4]
 *   --dump           只打印真实输出（排查用，不断言）
 *   --only=s1,s3     只跑其中几个场景（排查用；不传 = 全跑）
 * 前置：npm run build（用 dist/cli/index.js）+ npm install（需 devDependency node-pty）
 *
 * ⚠️ **总时长**：四场景串行约 13+16+20+9 = 58s，加上 build 与启动余量，
 * 外层工具给 60s 超时**必挂**（2026-11-11 实测：两次「命令执行超时」都不是脚本卡死，
 * 而是脚本本来就比超时更长）。跑它请给 ≥180s。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import pty from 'node-pty';

/**
 * 【已知噪音——勿吞】退出时 stderr 的 `Error: AttachConsole failed`
 * （node-pty/lib/conpty_console_list_agent.js）是 ConPTY 拆除阶段的上游行为，
 * 发生在全部断言 PASS 之后，不影响退出码 0 与断言语义。
 */

const REPO = process.cwd();
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const NODE = process.execPath;
const DUMP_ONLY = process.argv.includes('--dump');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccai-v51-pty-'));

/** @type {Set<import('node-pty').IPty>} */
const LIVE_TERMS = new Set();
/** @type {import('node:http').Server | null} */
let server = null;
let cleaned = false;

/** 目标文件：极小的纯逻辑文件，改动是「加一行注释」⇒ 零命中 15 类规则。 */
const LOW_FILE = 'src/math.js';
const LOW_BEFORE = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}
`;
const LOW_SEARCH = '  return a + b;';
const LOW_REPLACE = '  return a + b; // 求和';
const LOW_AFTER_MARK = '// 求和';

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
    return;
  }
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

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

/** 场景 S1 / S2：模型「想改」低风险文件。 */
const EDIT_TURN = {
  toolCalls: [
    {
      id: 'call_edit',
      name: 'edit_file',
      args: { path: LOW_FILE, search: LOW_SEARCH, replace: LOW_REPLACE },
    },
  ],
  text: '好的，我给 add 加了一行注释。',
};

/** 场景 S3：两次**独立轮次**的 read_file（各占一步，验证步号累加）。 */
/**
 * 场景 S3：两次 `run_command`（各占一步，验证步号累加）。
 *
 * ⚠️ **不能用 `read_file`**：它是 `parallelSafe` 且秒回，`tool_call` 到 `tool_result`
 * 之间没有可渲染的间隙，实测整帧里**根本抓不到**「第 N 步 · 执行工具: read_file」
 * （2026-11-11 实测：断言全红、帧里只有「思索中」）。
 * 用需要审批的 `run_command` 才有稳定的停留时间——审批框不按 y 就一直挂着，
 * 期间状态行持续渲染步号，抓帧才有东西可断言（这是「断言守的对象压根不渲染」的反面教训）。
 */
const RUN_TURN_1 = {
  toolCalls: [{ id: 'call_r1', name: 'run_command', args: { command: 'echo one' } }],
  text: null,
};
const RUN_TURN_2 = {
  toolCalls: [{ id: 'call_r2', name: 'run_command', args: { command: 'echo two' } }],
  text: '两条命令都跑完了。',
};

/**
 * 清空会「偷偷改变被测行为」或「偷偷打通真钱」的环境变量。
 *
 * 这一条是**本轮实测踩出来的**（2026-11-11）：
 * - 开发机 shell 里有 `DEEPSEEK_API_KEY`（真 Key）。只要隔离 HOME 里的 config 有一处没被读到，
 *   客户端就会拿这个真 Key 打**官方端点**——不报错、界面照常、成本回执还有数字，
 *   于是「零网络零真钱」的验收脚本会**安静地花掉真钱**（本轮实测花了约 ¥0.0054 才发现）。
 * - `CONCERTOAI_APPROVAL_INSIGHT` / `LUMEN_*` 会覆盖 config，让 `approvalInsight: 'plain'` 场景假绿。
 *
 * 所以：先删干净，再由场景显式加回它**想**控制的那几个（`LUMEN_LOCALE` 必须显式给，
 * 「locale 不受外部影响」要写在脚本里，不能依赖开发机 shell——AGENTS 进程级全局状态隔离）。
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(DEEPSEEK|OPENAI|OLLAMA)_/i.test(key) || /^(LUMEN_|CONCERTOAI_)/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

/** 单场景环境：独立 proj + 独立 HOME。 */
function makeEnv(scenario) {
  const base = path.join(ROOT, scenario);
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home, '.concertoai'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `v51-${scenario}`, version: '1.0.0' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, LOW_FILE), LOW_BEFORE);
  return { dir, home };
}

/**
 * 写 config：baseUrl 指向 mock；`approvalInsight` 决定走 rich 还是降级 plain。
 *
 * ⚠️ `schemaVersion` **必须写 2**（v4 形态）。写 1 会被 `isV3Config()` 判成 v3 并触发
 * `migrateV3ToV4`：那份迁移**只按 defaultModel 重建 `providers.deepseek`**，
 * 于是 `baseUrl` / `apiKey` 被整体丢掉，请求静默打到**真实 DeepSeek 端点**——
 * 而子进程里恰好有 `DEEPSEEK_API_KEY`（开发机 shell 里就有）⇒ 真的花钱。
 * 本轮实测踩到（2026-11-11，两个场景各一次真实调用），见
 * `docs/09-踩坑记录/2026-11-11-手工测试的假HOME没生效其实是schemaVersion写错.md`。
 */
function writeConfig(home, port, approvalInsight) {
  fs.writeFileSync(
    path.join(home, '.concertoai', 'config.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: {
          deepseek: {
            apiKey: 'sk-****',
            model: 'deepseek-v4-flash',
            baseUrl: `http://127.0.0.1:${port}`,
          },
        },
        hints: 'on',
        approvalInsight,
        reflections: 'on',
      },
      null,
      2,
    ),
  );
}

/**
 * 子进程环境：**四道防真花钱的锁**（缺一条就可能打到真实端点）。
 *
 * 1. `HOME` / `USERPROFILE` → 临时目录（配置、会话、复盘都不落进开发者真实 `~/.concertoai/`）；
 *    Windows 下 `os.homedir()` 读 `USERPROFILE`，两个都要设。
 * 2. `DEEPSEEK_API_KEY` → **占位假值**。哪怕配置意外丢了 baseUrl（本轮真踩到过），
 *    打出去的也是一次 401，而不是一次真扣费。
 * 3. 清掉继承来的 `CONCERTOAI_*` / `LUMEN_*`：这些环境变量**优先级高于 config**
 *    （`approvalInsight` / `hints` / `maxTurns` 都是），留着会让本脚本的 config 静默失效。
 * 4. `LUMEN_LOCALE=zh` 显式钉死：断言全是中文文案，不能依赖开发机 shell 的语言。
 */
const MOCK_API_KEY = 'sk-mock-v51-do-not-spend';
function buildEnv(home) {
  // 注：MOCK_API_KEY 是个**故意不可能有效**的占位串（真端点上必然 401）
  const drop = /^(home|userprofile|deepseek_api_key|concertoai_.*|lumen_.*)$/i;
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (drop.test(key)) continue;
    base[key] = value;
  }
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    DEEPSEEK_API_KEY: MOCK_API_KEY,
    LUMEN_LOCALE: 'zh',
    CONCERTOAI_HINTS: 'on',
  };
}

/**
 * 本地 mock SSE：按 `turns` 顺序回放（最后一轮之后一直回纯文本收尾）。
 * 流式 tool_call 的 arguments **分两段发**，顺带验证跨 chunk 拼接。
 *
 * `hitCount` 是本脚本的**探针通电证据**：它 > 0 才证明 config 里的 `baseUrl` 真的被读到了。
 * 否则「零真钱」只是没说话，不是证据（AGENTS「检索类/归因类都要正例自证」）。
 */
let mockHits = 0;
function startMock(port, turns) {
  return new Promise((resolve, reject) => {
    let callCount = 0;
    mockHits = 0;
    server = http.createServer((req, res) => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      callCount += 1;
      mockHits += 1;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock' };
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const turn = turns[callCount - 1];

        if (turn && turn.toolCalls.length > 0) {
          const call = turn.toolCalls[0];
          const args = JSON.stringify(call.args);
          const half = Math.floor(args.length / 2);
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: call.id, type: 'function', function: { name: call.name } },
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
                delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] },
                finish_reason: null,
              },
            ],
          });
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] },
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
                delta: { role: 'assistant', content: (turn && turn.text) || '好的，已按要求处理。' },
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
 * 起真实 TUI（PTY），按时间表发按键，收集去色后的整帧文本 + **进程退出码**。
 *
 * 退出码是本轮补的（S4 用得上）：S1–S3 都是我们按 Ctrl+C 收尾，`exitCode` 是被杀的噪音；
 * 但「首次运行」这条边缘路径的判据恰恰是**它自己退出**（exit 1 + 引导），
 * 拿不到退出码就只能靠「帧里有字样」猜它是不是挂在那里。超时被杀记 `null`（≠ 自己退出）。
 */
function runTui({ dir, home }, args, schedule, totalMs) {
  return new Promise((resolve) => {
    const term = pty.spawn(NODE, [CLI, ...args], {
      cwd: dir,
      cols: 110,
      rows: 45,
      env: buildEnv(home),
      name: 'xterm-256color',
    });
    LIVE_TERMS.add(term);
    let raw = '';
    let exited = null;
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
      resolve({ frame: strip(raw), exitCode: null });
    }, totalMs);
    term.onExit(({ exitCode }) => {
      exited = typeof exitCode === 'number' ? exitCode : null;
      clearTimeout(done);
      for (const t of timers) clearTimeout(t);
      setTimeout(() => resolve({ frame: strip(raw), exitCode: exited }), 100);
    });
  });
}

/**
 * 单场景执行：独立目录 + 独立 mock + 真 TTY。
 * @param {{id: string, title: string, args: string[], approvalInsight: 'rich'|'plain', turns: any[], schedule: any[], totalMs: number, checks: Array<{name: string, ok: (ctx: any) => boolean}>}} sc
 */
async function runScenario(sc) {
  const env = makeEnv(sc.id);
  await startMock(0, sc.turns);
  const port = server.address().port;
  // S4 刻意**不写 config**：那才是「一身干净的机器」的真实形态（也顺带证明没有 config 时不崩）
  if (sc.noConfig !== true) writeConfig(env.home, port, sc.approvalInsight);
  console.log(`\n───── ${sc.id}｜${sc.title} ─────`);
  console.log(`项目: ${env.dir}`);
  console.log(`HOME: ${env.home}`);
  console.log(
    `mock baseUrl: http://127.0.0.1:${port}｜approvalInsight=${sc.noConfig === true ? '(无 config)' : sc.approvalInsight}｜argv=${sc.args.join(' ') || '(无)'}`,
  );

  // server 必须**每个场景结束就关**（哪怕 --dump 提前 return）：否则上一台的监听
  // 句柄会一直挂在事件循环上，脚本跑完全部断言也不退出（本轮实测踩到：240s 超时才被发现）
  try {
    const { frame, exitCode } = await runTui(env, sc.args, sc.schedule, sc.totalMs);
    const disk = fs.readFileSync(path.join(env.dir, LOW_FILE), 'utf8');

    if (DUMP_ONLY) {
      console.log('===== 去色输出（尾部 3500）=====');
      console.log(frame.slice(-3500));
      console.log(`exitCode=${exitCode}`);
      return { ok: true, frame, disk, exitCode };
    }

    // 【探针通电】先证「mock 真的被请求到了」，再谈其它断言。
    // 顺序放在最前面是刻意的：baseUrl 没生效时，其它断言会以各种莫名其妙的方式红，
    // 而这一条能一句话说清根因（本轮真实事故：schemaVersion 写 1 触发 v3 迁移 ⇒ 打真端点）。
    // S4 例外（`requireMock: false`）：它**期望根本不发请求**，把「0 命中」当红就是自相矛盾。
    const probes =
      sc.requireMock === false
        ? [
            {
              name: `⓪ 探针通电（反向）：mock 命中 ${mockHits} 次 = 期望的 0（缺 Key 时不该发请求）`,
              ok: () => mockHits === 0,
            },
          ]
        : [
            {
              name: `⓪ 探针通电：本地 mock 收到 ${mockHits} 次请求（>0 才证明 config.baseUrl 生效、零真钱）`,
              ok: () => mockHits > 0,
            },
          ];
    const results = [...probes, ...sc.checks].map((c) => {
      const ctx = { frame, disk, before: LOW_BEFORE, mockHits, exitCode, home: env.home };
      return { name: c.name, ok: Boolean(c.ok(ctx)) };
    });
    console.log(`mock 命中次数：${mockHits}｜exitCode=${exitCode}`);
    for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
    const ok = results.every((r) => r.ok);
    if (!ok) {
      console.log('\n───── 去色输出（尾部 3500）─────');
      console.log(frame.slice(-3500));
      console.log('────────────────────────────────');
      console.log(`磁盘内容是否已变：${disk.includes(LOW_AFTER_MARK)}`);
    }
    return { ok, frame, disk, exitCode };
  } finally {
    if (server) {
      server.closeAllConnections?.();
      server.close();
      server = null;
    }
  }
}

const S1 = {
  id: 's1',
  title: '--auto-low：零命中编辑自动放行（不弹框 + 有留痕 + 磁盘真的改了）',
  args: ['chat', '--auto-low'],
  approvalInsight: 'rich',
  turns: [EDIT_TURN, { toolCalls: [], text: EDIT_TURN.text }],
  schedule: [
    { atMs: 3000, write: '给 add 函数加一行注释' },
    { atMs: 3400, write: '\r' },
    { atMs: 11000, write: '\x03' },
  ],
  totalMs: 13000,
  checks: [
    {
      name: '① 留痕出现：⚡ 已自动放行 1 次（含规则条数）',
      ok: ({ frame }) => /⚡ 已自动放行 1 次（未命中 \d+ 条已知风险规则）/.test(frame),
    },
    {
      name: '② 弹框**没出现**（帧里没有 rich 审批卡标题「✅ 低风险审批」）',
      ok: ({ frame }) => !/✅ 低风险审批/.test(frame),
    },
    {
      name: '③ 磁盘上真的改了（含 // 求和）',
      ok: ({ disk }) => disk.includes(LOW_AFTER_MARK),
    },
  ],
};

const S2 = {
  id: 's2',
  title: '分析降级（approvalInsight=plain ⇒ degraded=true, level=low）：仍然弹框，按 n 后磁盘未变',
  args: ['chat', '--auto-low'],
  approvalInsight: 'plain',
  turns: [EDIT_TURN, { toolCalls: [], text: EDIT_TURN.text }],
  schedule: [
    { atMs: 3000, write: '给 add 函数加一行注释' },
    { atMs: 3400, write: '\r' },
    { atMs: 11000, write: 'n' },
    { atMs: 14000, write: '\x03' },
  ],
  totalMs: 16000,
  checks: [
    {
      // plain 路径的真实标题是「编辑文件: 编辑文件 src/math.js」（i18n `approval.editTitle`
      // + `summaryEdit`；「即将写入」是另一处 fix/review 场景的标题，别照抄）。
      // 实测抓帧确认过：判定条件写错会「该绿不绿」，所以这里同时断言按键行，双保险。
      name: '① 仍然弹框（plain 审批框出现：标题 + 「批准 (y / Enter)」按键行）',
      ok: ({ frame }) =>
        /编辑文件: 编辑文件 src\/math\.js/.test(frame) && /批准 \(y \/ Enter\)/.test(frame),
    },
    {
      name: '② 没有自动放行留痕（降级绝不放行）',
      ok: ({ frame }) => !/已自动放行/.test(frame),
    },
    {
      name: '③ 按 n 拒绝 ⇒ 磁盘一字未改',
      ok: ({ disk, before }) => disk === before,
    },
  ],
};

const S3 = {
  id: 's3',
  title: '步序显示：同一次输入内两个工具 ⇒ 第 1 步 / 第 2 步，且无分母',
  args: ['chat'],
  approvalInsight: 'rich',
  // ⚠️ 必须是 RUN_TURN_*（`run_command`），不能换成 read_file：见 RUN_TURN_1 上方注释。
  turns: [RUN_TURN_1, RUN_TURN_2, { toolCalls: [], text: RUN_TURN_2.text }],
  schedule: [
    { atMs: 3000, write: '跑两条命令' },
    { atMs: 3400, write: '\r' },
    // 两个 `run_command` 都要经审批才会往下走（shell 一律问）：先 `y` 放第一个，
    // 第二个才会被模型请求 ⇒ 步号 1→2 才有机会出现。
    { atMs: 8000, write: 'y' },
    { atMs: 13000, write: 'y' },
    { atMs: 18000, write: '\x03' },
  ],
  totalMs: 20000,
  checks: [
    {
      name: '① 出现「第 1 步 · 执行工具: run_command」',
      ok: ({ frame }) => /第 1 步 · 执行工具: run_command/.test(frame),
    },
    {
      name: '② 出现「第 2 步 · 执行工具: run_command」（步号真的累加）',
      ok: ({ frame }) => /第 2 步 · 执行工具: run_command/.test(frame),
    },
    {
      name: '③ 没有分母（不出现「第 N 步 · … /数字」）',
      ok: ({ frame }) => !/第 \d+ 步[^\n]{0,40}\/\s*\d+/.test(frame),
    },
  ],
};

const S4 = {
  id: 's4',
  title: '首次运行（无 config、无会话）+ Ctrl+C：界面正常起来、不擅自写 config、退出体面',
  args: ['chat', '--auto-low'],
  approvalInsight: 'rich', // 无效：本场景不写 config
  noConfig: true,
  requireMock: false, // 不发任何请求：探针反向断言 0 命中（零网络）
  turns: [],
  schedule: [
    // 只用 Ctrl+C 收尾：AGENTS 边缘路径 ③「用户主动退出」。
    { atMs: 4000, write: '\x03' },
  ],
  totalMs: 12000,
  checks: [
    {
      name: '① 界面正常起来（帧里出现 chat 的功能提示行，不是白屏/崩溃）',
      ok: ({ frame }) => /环境检查|退出：Ctrl\+C|\/help/.test(frame),
    },
    {
      name: '② 没有报错堆栈（首次运行不该以 TypeError / Error: 收场）',
      ok: ({ frame }) => !/TypeError|Error:|Cannot read|undefined is not/.test(frame),
    },
    {
      name: '③ 没擅自创建 config.json（首次运行只读不写，写配置是 login/init/config set 的事）',
      ok: ({ home }) => !fs.existsSync(path.join(home, '.concertoai', 'config.json')),
    },
    {
      name: '④ Ctrl+C ⇒ **自己退出**（exitCode 非 null，不是被我们超时杀掉）',
      ok: ({ exitCode }) => exitCode !== null,
    },
    {
      name: '⑤ 退出提示体面（帧里出现 Ctrl+C 对应的说明，用户知道会话去哪了）',
      ok: ({ frame }) => /退出：Ctrl\+C|会话已保存/.test(frame),
    },
    {
      // 【正例自证】③ 是「某个文件不存在」的否定断言：路径写错、HOME 没生效时它**永远绿**。
      // 所以当轮必须证明「这个 HOME 真的被用了」——Ctrl+C 后会话文件会落在这里。
      name: '⑥ 正例自证：HOME 真的生效（会话文件落在该临时 HOME 的 sessions/ 下）',
      ok: ({ home }) => {
        const dir = path.join(home, '.concertoai', 'sessions');
        if (!fs.existsSync(dir)) return false;
        return fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
      },
    },
  ],
};

/** 单跑某几个场景（排查用）：`--only=s1,s3`；不传 = 全跑。 */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const activeScenarios = [S1, S2, S3, S4].filter(
  (sc) => ONLY === '' || ONLY.split(',').includes(sc.id),
);
if (activeScenarios.length === 0) {
  console.error(`--only=${ONLY} 没有匹配任何场景（可用：s1,s2,s3）`);
  process.exit(2);
}

const run = async () => {
  try {
    const results = [];
    for (const sc of activeScenarios) {
      results.push({ id: sc.id, ...(await runScenario(sc)) });
    }
    if (DUMP_ONLY) return 0;
    const allOk = results.every((r) => r.ok);
    console.log('\n════════ 汇总 ════════');
    for (const r of results) console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.id}`);
    console.log(`\n════════ 结果：${allOk ? '✅ 全部 PASS' : '❌ 有 FAIL'} ════════`);
    return allOk ? 0 : 1;
  } finally {
    cleanup();
  }
};

run()
  .then((code) => {
    process.exitCode = code;
    // 兜底：node-pty（ConPTY）在本机偶尔留下一个不自动关闭的句柄，导致「断言全过但进程不退出」。
    // 200ms 后强制退出（`unref()` 保证它不阻止正常退出，只在真挂住时才生效）。
    setTimeout(() => process.exit(code), 200).unref();
  })
  .catch((err) => {
    console.error('\n❌ 脚本异常：', err);
    cleanup();
    process.exitCode = 1;
  });
