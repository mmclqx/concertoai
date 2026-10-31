/**
 * `cost-gate.mjs` 的类型声明（供 `tests/**` 直接 import 做单测）。
 *
 * 为什么分开写：脚本是 `.mjs`（不带类型标注），而测试与 `npm run typecheck`
 * 走 strict TS。声明文件让「同一份判定逻辑」既能被 node 直接跑，也能被 vitest 断言，
 * **不复制第二份实现**（副本会漂移，而闸门漂移 = 花钱纪律静默失效）。
 */

export declare const COST_LINE_PATTERN: RegExp;

export type CostParseResult =
  | { ok: true; cost: number; raw: string }
  | { ok: false; reason: string };

export declare function parseCostLine(text: string): CostParseResult;

export interface CostReading {
  measured: boolean;
  cost?: number;
}

export interface GateDecision {
  stop: boolean;
  cost?: number;
  total?: number;
  reason: string;
}

export declare function gateDecision(
  reading: CostReading | undefined | null,
  limitCny: number,
  label?: string,
): GateDecision;

export declare function totalGateDecision(
  readings: readonly CostReading[],
  totalLimitCny: number,
): GateDecision;
