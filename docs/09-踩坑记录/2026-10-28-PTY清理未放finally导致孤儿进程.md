# PTY 清理未放 finally 导致孤儿进程与临时目录残留

> 日期：2026-10-28　版本：v5.0 T13（场景提示 UI 端到端脚本）　严重度：中高（会拖死编辑器宿主，且下次照样踩）
> 触发场景：`scripts/pty-drive-t13.mjs` 用真实 PTY 驱动 TUI，跑完要自清临时目录与子进程

## 现象

T13 端到端脚本 `scripts/pty-drive-t13.mjs` 编写当日，**VS Code 闪退**了一次。事后核查（这次是**侥幸干净**）：

| 检查项 | 结果 |
|---|---|
| `%TEMP%\ccai-t13-pty-*` 残留目录 | 0 个（两处裸 `fs.rmSync` 都执行到了） |
| 残留 `node dist/cli/index.js` 进程 | 0 个 |
| 真实 `~/.concertoai/hint-state.json` 污染 | 未污染（隔离 HOME 生效） |

**但代码审查发现清理没有兜底**——修复前的结构是「正常路径末尾顺手清理」：

```js
const run = async () => {
  setup();
  const raw = await runTui(...);      // ← 这里抛异常，下面三行全不执行
  const frame = strip(raw);
  fs.rmSync(ROOT, { recursive: true, force: true });   // ← 裸清理（无 finally）
  ...
  process.exit(allOk ? 0 : 1);        // ← 裸退出
};
run();                                 // ← 没有 .catch，reject 直接变 unhandledRejection
```

只要偏离 happy path 就会漏：

| 偏离路径 | 后果 |
|---|---|
| `runTui` 内抛异常（spawn 失败 / `onData` 回调异常） | PTY 存活、临时目录留盘、`run()` 的 reject 无人接 |
| 断言段抛错（`frame.match` 等处） | 同上 |
| 用户 Ctrl+C / 终端关闭 | **无 SIGINT 处理器**，进程直接死，PTY 子进程与目录全留 |
| 宿主（VS Code）闪退 | 进程被硬杀，任何末尾清理都不可能执行 |
| Windows 下 `term.kill()` 本身 | 只杀 conpty 壳，真正跑 CLI 的 `node` 子进程可能**变孤儿** |

其中「闪退」那条最致命：**末尾清理在进程被外力杀死时 100% 失效**，而这正是当时发生的事。

## 根因分析

- **直接原因**：清理逻辑写在成功路径的末尾，而非 `try/finally`；无信号（SIGINT/SIGTERM）与 `uncaughtException` / `unhandledRejection` 兜底；`term.kill()` 是唯一的杀进程手段，在 Windows ConPTY 下不等价于「杀进程树」。
- **深层原因**：
  1. **把「清理」当成最后一行代码，而不是生命周期契约**。PTY 句柄与临时目录属于**外部资源（子进程 + 文件系统）**，其释放是 must-run，必须绑定在语言级保证（`finally`）+ 进程级事件（`exit` / 信号 / 未捕获异常）上，不能依赖「代码顺序走到这里」。
  2. **「杀 PTY」≠「杀进程树」**（同一坑在 `2026-08-11-超时后子进程树残留需手动清理.md` 已踩过一次：Windows 必须 `taskkill /T /F`，POSIX 用进程组信号）。当时只修了 `src/agents/qa.ts`，没有把这条上升为「所有起子进程的脚本都要遵守」的规范，所以同类问题在新脚本上重演。
  3. **清理失败静默**：`fs.rmSync` 抛错（Windows 子进程刚死时目录 EBUSY/EPERM 很常见）会连错误一起吞掉，后人看不到「有东西留下」。
  4. **收尾顺序有隐藏依赖**：第一版修复把 `LIVE_TERMS.delete(term)` 放在 `term.kill()` **之前**，等于在杀之前就把资源从登记表摘掉——一旦 kill 没能带走子进程树，`cleanup()` 再也补不了刀。

## 解决方案

修复 `scripts/pty-drive-t13.mjs`：

1. **资源登记**：`LIVE_TERMS = new Set()` 记录所有存活 PTY（`runTui` 里 add）。
2. **进程树杀法** `killTermTree(term)`：先 `term.kill()`，Windows 下再探活（`process.kill(pid, 0)`）→ `taskkill /pid <pid> /T /F`。**先探活再补刀**：已退出的 pid 不碰，避免误伤被复用的 pid。
3. **幂等 `cleanup()`**：`cleaned` 标志防重入；先杀全部 PTY（含进程树），再 `fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`（`maxRetries` 专门对付 Windows 的 EBUSY）；**删不掉时打印残留路径**，不静默。
4. **单出口 + finally**：`run()` 整体包 `try { ... return code } finally { cleanup() }`，删掉两处裸 `fs.rmSync` 与两处 `process.exit`，改为 `process.exitCode = code`。
5. **进程级兜底**：`process.on('exit', cleanup)` + `SIGINT` / `SIGTERM` / `SIGHUP`（打印一行提示后 `cleanup()` + `exit(130)`）+ `uncaughtException` / `unhandledRejection`（打印错误后 `cleanup()` + `exit(1)`）。
6. **顺序修正**：`detach()` 只清定时器，PTY 留在 `LIVE_TERMS` 里由 `cleanup()` 兜底；正常收尾也用 `killTermTree()` 而非裸 `term.kill()`。

## 验证

| 验证 | 结果 |
|---|---|
| `node --check scripts/pty-drive-t13.mjs` | ✅ 语法通过 |
| `node scripts/pty-drive-t13.mjs --dump`（实跑 12s 真实 PTY） | ✅ 输出 `🧹 清理完成：PTY 1 个已终止 / 临时目录已删除` |
| 跑后 `%TEMP%\ccai-t13-pty-*` 残留 | ✅ **0 个** |
| 跑后残留 `node dist/cli/index.js` 进程 | ✅ **0 个** |

> 注：按用户要求本轮**未跑全量测试**（`npm run verify` 已在提交 13 个 T13 文件时全绿：146 文件 / 1969 用例），脚本改动不参与 vitest。

## 经验教训

- **凡「外部资源」清理，一律 `try/finally`，禁止写在末尾**：PTY、子进程、临时目录、临时文件、监听器、锁文件都算。判据很简单——「进程被硬杀时这段代码还会执行吗？」不会，就得补 `process.on('exit' / 信号)`。
- **Windows 上杀 PTY 必须补进程树**：`term.kill()` 只带走壳，`taskkill /T /F` 才带走树；POSIX 用 `process.kill(-pid, 'SIGKILL')`。杀之前先探活，避免 pid 复用误伤。
- **清理顺序有语义**：先杀资源、再删目录、最后从登记表摘除。「先摘登记再杀」= 放弃兜底。
- **清理失败必须可见**：打印残留路径与原因，否则等于埋雷。
- **端到端脚本不能只测 happy path**：这个脚本本身是「验证体验」的工具，结果自己的清理路径没被测过。**起真实资源的验证脚本，必须自证清理**（跑完自查残留目录/进程，像本轮这样）。
- 是否需要更新规范：✅（根因含「规范未覆盖」：既有规范只讲测试目录隔离，未讲临时资源释放纪律）
- 规范更新位置：`AGENTS.md` 提交前自查清单**新增第 17 条「临时资源清理纪律」**（PTY/子进程/临时目录必须 `try/finally` + 退出兜底 + Windows 进程树杀法 + 清理失败留痕）

## 相关链接

- 同型前案：`docs/09-踩坑记录/2026-08-11-超时后子进程树残留需手动清理.md`（`src/agents/qa.ts` killTree，Windows 未等待 taskkill / POSIX 未杀进程组）
- 隔离纪律前案：`docs/09-踩坑记录/2026-08-16-手工测试cd跨盘符未生效污染项目根目录.md`（AGENTS 第 16 条来源）
- 相关 Commit：`3982638 feat(v5.0-M3): T13 场景提示 UI 与端到端测试`（脚本引入）；本次 `fix(scripts)` 提交（清理兜底）
