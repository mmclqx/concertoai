/**
 * 致命错误渲染单测（K17）。
 *
 * ## 这一层解决的是什么
 *
 * 「网络层失败归一化」（`src/model/client.ts`）只解决**事实可归因**；
 * 「用户看到什么」是另一件事，由这里的 `describeFatalError()` 决定。分开测的理由：
 * 归一化是纯数据（能在单测里精确断言字段），呈现是措辞（要按 locale 渲染、要决定打不打堆栈）。
 * 混在一起测会出现「断言了 URL 却没断言不砸堆栈」这种半覆盖。
 *
 * ## 必须同时成立的两条
 *
 * 1. **可归因的外部失败 → 不打堆栈**：`showStack: false` + 消息里带端点 + 有下一步；
 * 2. **未知异常 → 仍打堆栈**：`showStack: true`。若为了「少吓用户」把未知异常也做成
 *    一句话，用户拿不到可反馈的堆栈，真缺陷就永远查不出来（与 K17 相反方向的病）。
 *
 * ## 全局状态
 *
 * `setLocale` 是模块级可变状态（AGENTS「进程级全局状态隔离」）：每条用例自己设，
 * `afterEach` 复位成 zh，不指望用例执行顺序。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { describeFatalError } from '../../src/cli/fatal-report';
import { setLocale } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';
import { ApiError, EndpointUnreachableError, TimeoutError } from '../../src/model/client';

const URL_FULL = 'http://127.0.0.1:9/v1/chat/completions';
const BASE_URL = 'http://127.0.0.1:9/v1';

/** 构造一个端点不可达错误（与 client 归一后的对象同形）。 */
function unreachable(detail = 'ECONNREFUSED'): EndpointUnreachableError {
  return new EndpointUnreachableError(URL_FULL, BASE_URL, detail);
}

afterEach(() => {
  // 复位模块级 locale：任何一条用例切了 en 都不许泄漏给后面的用例
  setLocale('zh');
});

describe('describeFatalError：端点不可达（K17 主场景）', () => {
  it('★ 说清「连不上哪个端点 + 底层原因」，且不打堆栈', () => {
    setLocale('zh');
    const report = describeFatalError(unreachable());

    expect(report.showStack).toBe(false);
    // 端点必须原样出现——用户据此判断是哪个 baseUrl 配错了
    expect(report.message).toContain(URL_FULL);
    expect(report.message).toContain('ECONNREFUSED');
    // 有下一步，且指向配置项（不是「去反馈 bug」）
    expect(report.hint).toBeDefined();
    expect(report.hint).toContain('baseUrl');
    // 反向自证：这句话里不许出现「软件缺陷」语义（那是未知异常分支的措辞）
    expect(report.message).not.toContain('命令执行失败');
    expect(report.hint).not.toContain('doctor');
  });

  it('连接超时也走同一条友好分支（都指向「检查端点/网络」）', () => {
    setLocale('zh');
    const report = describeFatalError(new TimeoutError(30_000));

    expect(report.showStack).toBe(false);
    expect(report.message).toContain('30000');
    expect(report.hint).toContain('baseUrl');
  });

  it('英文环境：渲染英文，且不含中文（AGENTS：en 不得含 CJK）', () => {
    setLocale('en');
    const report = describeFatalError(unreachable());

    expect(report.showStack).toBe(false);
    expect(report.message).toContain(URL_FULL);
    expect(report.message).not.toMatch(/[\u4e00-\u9fff]/);
    expect(report.hint ?? '').not.toMatch(/[\u4e00-\u9fff]/);
    // 反向自证：同一输入在 zh 下必须是中文（否则「en 不含中文」可被恒真的空串骗过）
    setLocale('zh');
    expect(describeFatalError(unreachable()).message).toMatch(/[\u4e00-\u9fff]/);
  });

  it('zh / en 两条文案都不是同一句（防「复制中文进英文键」）', () => {
    expect(zh.errors.endpointUnreachable).not.toBe(en.errors.endpointUnreachable);
    expect(zh.errors.endpointUnreachableHint).not.toBe(en.errors.endpointUnreachableHint);
    expect(zh.errors.endpointTimeout).not.toBe(en.errors.endpointTimeout);
  });
});

describe('describeFatalError：不该被说成「你端点配错了」的那些错误', () => {
  it('★ 未知异常 → 打堆栈（真缺陷必须可反馈），且消息不被改写', () => {
    setLocale('zh');
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    const report = describeFatalError(bug);

    expect(report.showStack).toBe(true);
    expect(report.message).toBe(bug.message);
    // 未知异常不该带上「端点」提示（那是误导用户去改配置）
    expect(report.hint).toBeUndefined();
  });

  it('ApiError（服务端有回应：鉴权/限流/5xx）→ 仍走未知异常分支', () => {
    // 401 是「Key 不对」不是「连不上」，各动词已有专门归因；这里绝不能抢答成端点问题
    const report = describeFatalError(new ApiError(401, 'invalid api key'));
    expect(report.showStack).toBe(true);
    expect(report.hint).toBeUndefined();
  });

  it('非 Error 值（字符串/undefined）→ 兜底成字符串，不打堆栈之外的事也不崩', () => {
    expect(describeFatalError('boom')).toEqual({ message: 'boom', showStack: true });
    expect(describeFatalError(undefined)).toEqual({ message: 'undefined', showStack: true });
  });
});
