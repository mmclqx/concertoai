/**
 * 套件级默认隔离的**顺序自证**（v5.3 B4，2026-11-15）。
 *
 * ## 为什么这条必须单独成文件（而不是塞进 setup.ts 里自证）
 *
 * `tests/setup.ts` 里的 canary 只能证明「env 在我之后被读到了」，证明不了
 * **「env 在测试模块 import 之前就被设好了」**——因为 setup 自己也是模块，
 * 它内部的一切都发生在「它自己执行的时候」。
 *
 * 真正的判据是**模块加载期常量**：`DEFAULT_CONFIG_PATH` 在 `config.ts` 被 import 的那一刻
 * 就定格了。本文件**静态 import** `config.ts`，而 vitest 保证 setupFiles 先于测试文件，
 * 所以这里读到的常量必须落在隔离目录内。
 *
 * 如果哪天有人把 `setupFiles` 从 `vitest.config.ts` 删掉、或把 env 设置挪进 `beforeEach`
 * （等价于「setup 跑在测试模块之后」），本文件立刻红——这是**唯一**能钉住顺序的判据。
 * 变异探针 M5 就是这么验的（见执行日志）。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { handoffPath } from '../../src/cli/handoff';
import { DEFAULT_CONFIG_PATH } from '../../src/store/config';
import { configPath, globalDir, handoffsDir } from '../../src/store/paths';
import { DEFAULT_SESSION_DIR } from '../../src/store/session';

describe('默认隔离：env 在测试模块 import 之前就已生效（顺序判据）', () => {
  const home = os.homedir();

  it('`os.homedir()` 是临时目录；`HOME` 与 `USERPROFILE` **两侧都**指向它（探针通电第一条）', () => {
    expect(home).toContain('ccai-test-home-');
    // 只钉当前平台那一侧，等于换平台静默失效（v5.3 A 的 M2 探针教训）⇒ 两侧都断言，
    // 而且是**等值**断言：Windows 读 USERPROFILE，POSIX 读 HOME，任一侧漏了这里就红。
    expect(process.env.HOME).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
  });

  it('**模块加载期常量** `DEFAULT_CONFIG_PATH` 落在隔离目录内（顺序判据 · M5 的落点）', () => {
    // 这条如果红：说明 config.ts 的 import 发生在 env 设置之前（setup 太晚了）
    expect(
      DEFAULT_CONFIG_PATH.startsWith(home),
      `DEFAULT_CONFIG_PATH=${DEFAULT_CONFIG_PATH} 应在 ${home} 内`,
    ).toBe(true);
  });

  it('`DEFAULT_SESSION_DIR` 同样落在隔离目录内（第二个加载期常量，防只钉一个）', () => {
    expect(DEFAULT_SESSION_DIR.startsWith(home)).toBe(true);
  });

  it('调用期读的路径函数也全部落在隔离目录内（handoff / config / global）', () => {
    expect(handoffPath(process.cwd()).startsWith(home)).toBe(true);
    expect(configPath().startsWith(home)).toBe(true);
    expect(globalDir()).toBe(path.join(home, '.concertoai'));
    expect(handoffsDir()).toBe(path.join(home, '.concertoai', 'handoffs'));
  });

  it('**文档事实**：`AGENTS.md` 的已知边界 B4 必须记「已关闭」且指向 `tests/setup.ts`（B4-DOC-FACT-GUARD）', () => {
    /**
     * ## 为什么这条用例必须存在（它不是「给文档写测试」的形式主义）
     *
     * `AGENTS.md` 的 B4 曾经写着「目录增长**不受守卫约束**」，还推荐了修法
     * `__setHomeForTest()`（函数签名级开关）。2026-11-15 实测**两半都错了**：
     * ① 本文件的隔离已经把它治住（增量 0）；② 那个修法会打断 4 个文件的绝对值断言。
     *
     * 「文档更新成了错的」比「文档过期」严重得多 —— 过期只是信息旧，**错的是把人指向废弃路**，
     * 而照做的人不会去查证，因为文档看起来就是权威。这类不一致**只有机械判据能长期防住**
     * （靠自觉的话，下一个人改代码时不会想起来同步文档）。
     *
     * ## 刻意的边界：只钉两个**事实**，不钉措辞
     *
     * 钉的是「已关闭」+「指向 tests/setup.ts」—— 前者是结论，后者是可核查的入口。
     * **不**断言三格全文、**不**断言字数或句式：措辞会随着下一轮的解释而改，
     * 钉太死会让这条用例在「改得更好」时反而红（护栏咬解释者，本项目已踩过）。
     *
     * 配变异探针验证有牙：把 B4 行改回「不受守卫约束」⇒ 本条必须红；改回 ⇒ 绿。
     */
    const agentsPath = path.join(process.cwd(), 'AGENTS.md');
    const text = readFileSync(agentsPath, 'utf8');
    // 只取 B4 那一行：正文别处提到 B4 不算（顶部「最后更新」段就引用了它）
    const b4Line = text.split(/\r?\n/).find((line) => line.includes('**B4**')) ?? '';

    expect(b4Line, 'AGENTS.md 里找不到 `**B4**` 那一行——表格被改动 / 编号被删？').not.toBe('');
    // 事实一：这条边界已关闭（不是「还在观察」「已降级」）
    expect(b4Line, 'B4 必须写明已关闭（v5.3 B4 已把它治好，实测增量 0）').toContain('已关闭');
    // 事实二：指向真实入口，让照文档的人能点到活证据（会随代码改的那份，不是第二份文档）
    expect(b4Line, 'B4 必须指向 tests/setup.ts（唯一会随代码更新的否决/生效证据）').toContain(
      'tests/setup.ts',
    );
    // 反向：旧说法不许回来。这条是「照错文档施工」的机械判据本体。
    expect(b4Line, 'B4 不许再声称目录增长不受约束——那与实测（增量 0）相反').not.toContain(
      '不受守卫约束',
    );
  });

  it('否定面：隔离目录位于系统临时目录之下（不是用户主目录里的真实路径）', () => {
    // 「不是真实 home」没法直接断言（真实 home 的旧值取不回来了），故断言它**必须**在
    // 系统临时目录之下：用户主目录不会以 tmpdir 开头，这一条足以把「忘了设 env」挡在外面
    // （忘了设时 home 会是 `C:\Users\<你>`，不以 tmpdir 开头）。
    expect(home.startsWith(os.tmpdir())).toBe(true);
    expect(existsSync(path.join(home, '.concertoai'))).toBe(false); // 尚未写入：懒创建
  });
});
