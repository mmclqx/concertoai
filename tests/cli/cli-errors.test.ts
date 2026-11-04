/**
 * commander 参数解析错误的本地化渲染（v5.0 C1）。
 *
 * ## 为什么单独一个文件、且以「纯函数矩阵」为主
 *
 * 这类缺陷的形态是「**用户撞上错误时看到全英文**」，而它不报错、不崩、单测全绿
 * （旧行为下压根没有单测覆盖错误路径）。真正难测的是**渲染是否真的接到了**，
 * 那一条交给同目录的 `commander-errors.test.ts`（真进程）；本文件只钉住
 * 「输入 code + message → 输出什么措辞」这一层映射，以及两个极易回归的性质：
 *
 * 1. **不吞信息**：不认识的 code / commander 改了措辞时，必须回落原文，不许空白；
 * 2. **不猜子命令选项**：候选只来自调用方给的上下文，宁可说「查看用法」也不乱建议。
 *
 * ## 探针通电
 *
 * 「en 下无 CJK」这类否定断言对空字符串同样成立，因此每条 en 断言都在**同一用例内**
 * 先断言 zh 侧确有 CJK。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  isCommanderErrorShape,
  preferredFlag,
  renderCliError,
  suggestSimilar,
} from '../../src/cli/cli-errors';
import { setLocale } from '../../src/i18n';

/** 与真进程一致的候选上下文（命令名取自 `program.commands`，这里用代表性切片）。 */
const CTX = {
  commandNames: ['chat', 'run', 'plan', 'balance', 'doctor', 'init', 'check', 'commit', 'review'],
  optionFlags: ['--project', '--provider', '--version', '--help'],
};

/** CJK 统一汉字区。 */
const CJK = /[\u4e00-\u9fff]/;

afterEach(() => {
  // AGENTS 明文点名的模块级可变状态：切过 en 必须复位
  setLocale('zh');
});

describe('isCommanderErrorShape（只认结构，不 import commander）', () => {
  it('认 { code, message } 形态，含真实 CommanderError 的典型字段', () => {
    expect(isCommanderErrorShape({ code: 'commander.unknownOption', message: 'x' })).toBe(true);
    expect(
      isCommanderErrorShape({
        code: 'commander.unknownOption',
        message: 'x',
        exitCode: 1,
        name: 'CommanderError',
      }),
    ).toBe(true);
  });

  it('不认「长得不像」的值——否则程序 bug 会被伪装成「你参数写错了」', () => {
    for (const value of [
      null,
      undefined,
      0,
      'string',
      { code: 1, message: 'x' }, // code 不是字符串
      { code: 'commander.unknownOption' }, // 缺 message
      { message: 'x' }, // 缺 code
      new TypeError('fetch failed'), // 真实程序 bug 形态
    ]) {
      expect(isCommanderErrorShape(value)).toBe(false);
    }
  });
});

describe('preferredFlag（flags 串 → 提示里显示的选项名）', () => {
  it('有长选项就取长选项并去掉取值占位', () => {
    expect(preferredFlag('-p, --project <name>')).toBe('--project');
    expect(preferredFlag('--provider <name>')).toBe('--provider');
    expect(preferredFlag('-r, --resume [id]')).toBe('--resume');
  });

  it('纯短选项原样保留——绝不编造不存在的长名', () => {
    expect(preferredFlag('-y')).toBe('-y');
    expect(preferredFlag('-t <n>')).toBe('-t');
  });
});

describe('suggestSimilar（自己算，阈值经实测校准）', () => {
  it('真实错拼能命中（距离 1，含相邻换位）', () => {
    expect(suggestSimilar('docter', CTX.commandNames)).toEqual(['doctor']);
    expect(suggestSimilar('chek', CTX.commandNames)).toEqual(['check']);
    expect(suggestSimilar('reviwe', CTX.commandNames)).toEqual(['review']);
    expect(suggestSimilar('providr', CTX.optionFlags)).toEqual(['--provider']);
    expect(suggestSimilar('--versoin', CTX.optionFlags)).toEqual(['--version']);
  });

  it('差很远的词**不给**候选（乱猜比不猜更坏）', () => {
    // 实测校准点：初版照抄 commander 的「距离 ≤ 3」阈值时，这两条会各自命中
    // `balance` / `--project`,`--provider`,`--version` —— 用户会以为自己敲错了近形词
    expect(suggestSimilar('bogus-xyz', CTX.commandNames)).toEqual([]);
    expect(suggestSimilar('--bogus-opt', CTX.optionFlags)).toEqual([]);
  });

  it('边界：空候选 / 单字符候选 / 完全一致（距离 0 不该被建议「你是不是想输入自己」）', () => {
    expect(suggestSimilar('docter', [])).toEqual([]);
    // 单字符候选排除（`a` 与任何两字符词距离都是 1，纯粹噪音）
    expect(suggestSimilar('ab', ['a'])).toEqual([]);
    // 距离 0：真敲对了同名命令 → 仍算「相似」，但上层只在报错路径调用，不会污染正常路径
    expect(suggestSimilar('doctor', CTX.commandNames)).toEqual(['doctor']);
  });

  it('候选取自真实注册表：绝不返回上下文里没有的名字', () => {
    const candidates = suggestSimilar('balanse', CTX.commandNames);
    expect(candidates).toEqual(['balance']);
    for (const candidate of candidates) {
      expect(CTX.commandNames).toContain(candidate);
    }
  });

  /**
   * ## 否定面：乱敲的词不得匹配任何真实命令/选项
   *
   * 这条是 `editDistance` 漏 `+1` 事故（距离恒 0 ⇒ 相似度恒 1）的回归护栏。
   * 事故当时的测试**有正例**（`docter → doctor`），却照样全绿——因为距离恒 0 的实现
   * 对**任何**词都返回最近的候选，正例因此必然通过。教训：只有正例的测试，
   * 与该 bug 面前没有测试等价。所以这里断言的是「**不**该出现的东西」。
   *
   * 案发形态（真进程实测）：`bogus-xyz` 被建议成 `balance`，`--bogus-opt` 一次给三个候选。
   */
  it('乱敲词在「命令+选项」全集里零候选（配变异探针验证有牙）', () => {
    // 正例自证（探针通电）：同一次调用里先证明相似度**真的算过**，
    // 否则「零候选」可能只是因为候选池根本没进来。
    expect(suggestSimilar('docter', CTX.commandNames)).toEqual(['doctor']);

    const pool = [...CTX.commandNames, ...CTX.optionFlags];
    const garbage = [
      'bogus-xyz',
      'qqqqqq',
      'zzzz',
      'asdfgh',
      'xyzzy',
      '12345',
      '--bogus-opt',
      'wibble-wobble',
      'chatzzzz',
    ];
    for (const word of garbage) {
      expect(suggestSimilar(word, pool), `乱敲词「${word}」不得得到任何建议`).toEqual([]);
      // 三个池子都要为空：只看全集会掩盖「命令池干净、选项池乱给」的半坏形态
      expect(suggestSimilar(word, CTX.commandNames)).toEqual([]);
      expect(suggestSimilar(word, CTX.optionFlags)).toEqual([]);
    }
  });

  /**
   * ## 反向自证：距离真的随编辑次数增长（不是恒 0）
   *
   * 上一条只钉「乱敲词 → 空」，理论上可被「一律返回空」的废实现假绿。
   * 这里自证阶梯：同一候选 `chat`，距离 0/1 命中、距离 ≥3 落空——
   * 三档同时成立，「恒 0」和「恒空」两种废实现都过不去。
   */
  it('同一候选上的相似阶梯：距离 0/1 命中、≥3 落空', () => {
    expect(suggestSimilar('chat', ['chat'])).toEqual(['chat']); // 距离 0
    expect(suggestSimilar('chats', ['chat'])).toEqual(['chat']); // 距离 1（插入）
    expect(suggestSimilar('chatz', ['chat'])).toEqual(['chat']); // 距离 1（替换）
    expect(suggestSimilar('chet', ['chat'])).toEqual(['chat']); // 距离 1（删除）
    expect(suggestSimilar('czzz', ['chat'])).toEqual([]); // 距离 ≥3 ⇒ 落空
  });
});

describe('renderCliError：各 code → 本地化文案（zh）', () => {
  const render = (code: string, message: string, exitCode = 1) =>
    renderCliError({ code, message, exitCode }, CTX);

  it('unknownCommand → 「没有这个命令」+ 候选（不出现 error: 前缀）', () => {
    const out = render('commander.unknownCommand', "error: unknown command 'docter'");
    expect(out.text).toContain('没有这个命令：docter');
    expect(out.text).toContain('`doctor`');
    expect(out.text).not.toContain('error:');
    expect(out.exitCode).toBe(1);
  });

  it('unknownOption → 「没有这个选项」+ 候选', () => {
    const out = render('commander.unknownOption', "error: unknown option '--providr'");
    expect(out.text).toContain('没有这个选项：--providr');
    expect(out.text).toContain('`--provider`');
  });

  it('**归类修正**：顶层多余参数按「未知命令」渲染（commander 报的是 too many arguments）', () => {
    // 根命令有默认 action（无子命令 → 进 chat），于是 `bogus-xyz` 落进 root 的实参，
    // commander 只能报「参数太多」。对用户来说「参数太多」是错的归因。
    const out = render(
      'commander.excessArguments',
      'error: too many arguments. Expected 0 arguments but got 1: bogus-xyz.',
    );
    expect(out.text).toContain('没有这个命令：bogus-xyz');
    expect(out.text).not.toContain('参数');
    expect(out.text).toContain('--help --all');
  });

  it('子命令多余参数仍按「参数过多」说，且带上命令名与实参', () => {
    const out = render(
      'commander.excessArguments',
      "error: too many arguments for 'run'. Expected 1 argument but got 2: a, b.",
    );
    expect(out.text).toContain('concertoai run 只接受 1 个参数，收到 2 个：a, b');
    expect(out.text).toContain('查看用法');
  });

  it('missingArgument / optionMissingArgument / missingMandatoryOptionValue', () => {
    expect(
      render('commander.missingArgument', "error: missing required argument 'task'").text,
    ).toContain('缺少必需参数：task');
    expect(
      render(
        'commander.optionMissingArgument',
        "error: option '-p, --project <name>' argument missing",
      ).text,
    ).toContain('选项 --project 缺少参数值'); // flags 串已收敛成长选项
    expect(
      render(
        'commander.missingMandatoryOptionValue',
        "error: required option '--key <k>' not specified",
      ).text,
    ).toContain('缺少必需选项：--key');
  });

  it('conflictingOption：解析出两个选项名（含环境变量形态不崩）', () => {
    const optionForm = render(
      'commander.conflictingOption',
      "error: option '--a' cannot be used with option '--b'",
    );
    expect(optionForm.text).toContain('选项冲突：--a 不能与 --b');
    // 环境变量形态：`environment variable 'FOO'` 不是选项名，这里只要求不崩且保住两个字面量
    const envForm = render(
      'commander.conflictingOption',
      "error: environment variable 'FOO' cannot be used with option '--b'",
    );
    expect(envForm.text).toContain('FOO');
    expect(envForm.text).toContain('--b');
  });

  it('invalidArgument：只去掉 error: 前缀，不重写句子（那可能是我们自己写的）', () => {
    const out = render(
      'commander.invalidArgument',
      "error: option '--n <n>' argument 'x' is invalid.",
    );
    expect(out.text).toContain("option '--n <n>' argument 'x' is invalid.");
    expect(out.text).not.toContain('error:');
  });

  it('version / help：**不打印任何东西**（commander 已自行输出），只透传退出码', () => {
    expect(render('commander.version', '(outputHelp)', 0)).toEqual({ text: '', exitCode: 0 });
    expect(render('commander.helpDisplayed', '(outputHelp)', 0)).toEqual({ text: '', exitCode: 0 });
    // `help({ error: true })`：帮助已打到 stderr，退出码必须是 1（不是 0）
    expect(render('commander.help', '(outputHelp)', 1)).toEqual({ text: '', exitCode: 1 });
  });
});

describe('renderCliError：不吞信息（回落与退出码）', () => {
  it('未知 code → 回落原文，保住事实', () => {
    const out = renderCliError(
      { code: 'commander.somethingNew', message: 'error: brand new wording', exitCode: 1 },
      CTX,
    );
    expect(out.text).toContain('brand new wording');
  });

  it('commander 改了 excessArguments 措辞 → 回落原文（不空白、不硬套模板）', () => {
    const out = renderCliError(
      {
        code: 'commander.excessArguments',
        message: 'error: totally different wording',
        exitCode: 1,
      },
      CTX,
    );
    expect(out.text).toContain('totally different wording');
  });

  it('退出码原样透传（含自定义非 1 值）', () => {
    expect(
      renderCliError({ code: 'commander.unknownOption', message: 'x', exitCode: 7 }, CTX).exitCode,
    ).toBe(7);
    // 没给 exitCode 时按 1 兜底（commander 自己也是这么默认的）
    expect(renderCliError({ code: 'commander.unknownCommand', message: 'x' }, CTX).exitCode).toBe(
      1,
    );
  });
});

describe('renderCliError：en 下全英文（同用例先自证 zh 侧确有中文）', () => {
  it('每一种 code 在 en 下都零 CJK，而 zh 下确实有 CJK', () => {
    const cases: Array<[string, string]> = [
      ['commander.unknownCommand', "error: unknown command 'docter'"],
      ['commander.unknownOption', "error: unknown option '--providr'"],
      [
        'commander.excessArguments',
        'error: too many arguments. Expected 0 arguments but got 1: bogus-xyz.',
      ],
      [
        'commander.excessArguments',
        "error: too many arguments for 'run'. Expected 1 argument but got 2: a, b.",
      ],
      ['commander.missingArgument', "error: missing required argument 'task'"],
      ['commander.optionMissingArgument', "error: option '--project <name>' argument missing"],
      ['commander.missingMandatoryOptionValue', "error: required option '--key <k>' not specified"],
      ['commander.conflictingOption', "error: option '--a' cannot be used with option '--b'"],
      ['commander.invalidArgument', "error: option '--n <n>' argument 'x' is invalid."],
      ['commander.somethingNew', 'error: brand new wording'],
    ];

    for (const [code, message] of cases) {
      setLocale('zh');
      expect(renderCliError({ code, message, exitCode: 1 }, CTX).text).toMatch(CJK); // 探针通电
      setLocale('en');
      expect(renderCliError({ code, message, exitCode: 1 }, CTX).text).not.toMatch(CJK);
    }
  });
});
