/**
 * 顶层致命错误的「用户视角」渲染（v5.0 K17）。
 *
 * ## 为什么需要它
 *
 * K17 实测：`concertoai run` 撞上「端点连不上」时，用户只看到
 * `[ConcertoAI] 未处理的 Promise 拒绝 + TypeError: fetch failed + undici 堆栈`——
 * 一句中文说明都没有。两类错误被混成了一种呈现方式：
 *
 * | 错误性质 | 用户该看到 | 以前 |
 * |---|---|---|
 * | **可归因的外部失败**（端点不可达 / 连接超时） | 「连不上哪个端点」+ 下一步 | 完整堆栈（把配置问题说成程序崩溃） |
 * | **未知异常**（软件缺陷） | 消息 + 堆栈 + 崩溃日志路径（便于反馈） | 完整堆栈（正确） |
 *
 * 本模块只做分类与措辞，**不写盘、不退出**：写 stderr 与退出码由调用方
 * （`src/cli/index.ts` 的 `safeAction`）决定，便于单测直接断言渲染结果。
 *
 * ## 分层约定
 *
 * 错误对象在 `src/model/client.ts` 里只带**事实**（`url` / `baseUrl` / `detail`），
 * 面向用户的措辞一律走 i18n（`errors.endpointUnreachable*`）——所以这里既是渲染点，
 * 也是「同一事实只在一处成为人话」的落地点。
 */

import { fmt, t } from '../i18n';
import { EndpointUnreachableError, TimeoutError } from '../model/client';

export interface FatalErrorReport {
  /** 面向用户的一句话（已按当前 locale 渲染）。 */
  message: string;
  /** 可操作下一步；`undefined` = 无专用建议（走通用 fatalNextStep）。 */
  hint?: string;
  /** true = 打完整堆栈（未知异常/缺陷）；false = 不打堆栈（可归因的外部失败）。 */
  showStack: boolean;
}

/**
 * 把任意异常分类成「该给用户看什么」。
 *
 * 只有两类会走「不打堆栈」的友好分支，且它们都**指向用户可自行修复的外部原因**：
 * - `EndpointUnreachableError`：连不上端点（K17 主场景）；
 * - `TimeoutError`：连得上但超时（同一句话：检查端点/网络/代理）。
 *
 * 其余一律 `showStack: true` —— 包括 `ApiError`（服务端有回应，属鉴权/额度类，
 * 现有各动词已有专门归因）与所有未知 `Error`。**不把未知异常也说成「你的配置问题」**：
 * 那会让用户白折腾配置，还会掩盖真实缺陷。
 */
export function describeFatalError(error: unknown): FatalErrorReport {
  if (error instanceof EndpointUnreachableError) {
    return {
      message: fmt(t().errors.endpointUnreachable, { url: error.url, detail: error.detail }),
      hint: t().errors.endpointUnreachableHint,
      showStack: false,
    };
  }
  if (error instanceof TimeoutError) {
    return {
      message: fmt(t().errors.endpointTimeout, { message: error.message }),
      hint: t().errors.endpointUnreachableHint,
      showStack: false,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    showStack: true,
  };
}
