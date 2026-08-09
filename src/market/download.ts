/**
 * 市场下载共享函数（v3.0 M4 / T4.2）。
 *
 * 技能市场（v2.1 src/cli/slash/skill.ts 的 fetchSkill）与 Agent 市场
 * （T4.2 安装器）共用的「下载 → sha256 校验」底层逻辑。
 * T4.2 从两处抽取，避免重复实现；技能市场与 Agent 安装器均复用本函数。
 */

import { createHash } from 'node:crypto';

/**
 * 下载远程内容并校验 sha256（fail-closed：校验不通过视为失败）。
 *
 * @param url 下载地址
 * @param expectedSha256 期望的 sha256 校验值
 * @param timeoutMs 超时（默认 15s，与技能市场一致）
 * @returns 内容文本；网络错误 / HTTP 非 2xx / sha256 不匹配 → null
 */
export async function fetchVerifiedContent(
  url: string,
  expectedSha256: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      return null;
    }
    const text = await resp.text();
    const actual = createHash('sha256').update(text).digest('hex');
    if (actual !== expectedSha256) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}
