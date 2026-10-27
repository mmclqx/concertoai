/**
 * 全局测试环境设置（v5.0 T10）。
 *
 * ## 为什么需要这个文件
 *
 * 拒绝复盘记录默认写入 `~/.concertoai/reflections.jsonl`（**开发者的真实 home**）。
 * T9 的审批集成测试会走「按 n 拒绝」的真实路径，于是 `npm test` 把测试产生的记录
 * 直接写进了本机真实复盘文件——实测一次全量跑完多了 16 条 `a.ts` / `b.txt` 垃圾记录
 * （见 09-踩坑记录/2026-10-28-测试污染真实复盘记录.md）。
 *
 * 修法是**默认关闭**：测试进程一律不许写复盘，需要验证写入路径的用例显式传
 * `reflectionsEnabled={true}` 或注入 `appendReflectionForTest`（两者都让意图明确）。
 *
 * ## 为什么用环境变量而不是 mock 文件系统
 *
 * 环境变量是产品**本来就支持**的双轨开关之一（`CONCERTOAI_REFLECTIONS=off`），
 * 让测试走这条真实开关链路，比 mock `node:fs` 更贴近用户实际行为，也不会因为
 * 模块 mock 顺序问题偶发失效。
 */
process.env.CONCERTOAI_REFLECTIONS = 'off';
