/**
 * `--auto-low` 的取值合并（v5.1 T3.2 真机抓到的接线缺陷修复）。
 *
 * ## 这个文件存在的唯一理由：commander 会把同名 flag 解析到**根命令**
 *
 * 本仓 chat 有两个入口（见 `src/cli/index.ts` 的 `addAutoLowOption`）：
 *   ① `concertoai --auto-low`（无子命令，根 action）；
 *   ② `concertoai chat --auto-low`（显式子命令）。
 *
 * 两处都注册了 `--auto-low`（为了两边 `--help` 都能查到）。但 commander 的实际行为是（本仓实测
 * `commander@15.0.0`，见 `node_modules/commander/package.json`；勿凭记忆写版本号——初稿曾误写 v12）：
 * **当父命令与子命令注册了同名 flag 时，写在子命令后面的那个会被父命令吃掉**，子命令的
 * `options` 里根本看不到它。实测（`b070b30` 版代码，真机 PTY 跑 `chat --auto-low`）：
 *
 * ```
 * chat-action options={} rootOpts={"autoLow":true}   ← 子命令拿到空对象，根命令才是 true
 * runChat autoLow=false argv=chat --auto-low        ← 于是开关被静默丢掉
 * ```
 *
 * 后果正是本仓最忌讳的形态：**不报错、安静地给出「功能没生效」**。用户敲了 `--auto-low`
 * 看到界面正常、审批框照旧弹（等于白敲），而 `tests/cli/auto-low-option.test.ts` 当时
 * 只断言「不报 unknown option」——参数被接受了，值与没被传下去是两件事。
 *
 * ## 因此取值必须**合并两级**
 *
 * 子命令有就取子命令，没有就看根命令（`||`，不是 `??`：两级都可能是 `undefined`）。
 * 不允许任何一级被单独信任——只读子命令 ⇒ 今天的 bug；只读根命令 ⇒ `concertoai --auto-low chat`
 * （flag 在子命令前，commander 会先给根命令，问题不大）之外的反向情形又会漏。
 *
 * ⚠️ 判据必须是 `=== true`：`'false'` 这类字符串（env / config 误写）既不是 true 也不该放开。
 * 这个开关是「少问一次」的开关，任何拿不准的输入都必须落回 `false`（fail-closed）。
 */
export interface AutoLowFlagSources {
  /** 子命令自身解析到的 `--auto-low`（`concertoai chat --auto-low`）。 */
  subcommand?: unknown;
  /** 根命令解析到的 `--auto-low`（`concertoai --auto-low`，以及被父命令吃掉的那种情况）。 */
  root?: unknown;
}

/**
 * 合并两级来源，返回**是否启用** `--auto-low`。
 *
 * 纯函数：不读环境、不读时钟、无副作用。
 */
export function resolveAutoLowFlag({ subcommand, root }: AutoLowFlagSources): boolean {
  return subcommand === true || root === true;
}
