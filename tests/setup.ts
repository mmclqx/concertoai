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

/**
 * v5.0 T12：场景提示同理默认关闭。
 *
 * 提示的冷却记录写在 `~/.concertoai/hint-state.json`（**开发者的真实 home**）。
 * T13 的 UI 集成测试会走「真的触发一次提示」的路径，若不关掉，`npm test` 会把
 * 测试产生的冷却时间戳写进本机真实状态文件——后果是**开发者自己用 CLI 时提示被
 * 莫名静音 10 分钟**（比复盘那次更难排查，因为它表现为「功能不生效」）。
 *
 * 需要验证「默认开启」语义的用例显式 `vi.stubEnv('CONCERTOAI_HINTS', '')`
 * 或直接注入 `hintsEnabled: true`（测试意图必须写在用例里，不能靠环境巧合）。
 */
process.env.CONCERTOAI_HINTS = 'off';

/**
 * v5.0 T21：本地指标同理默认关闭（虽然产品默认就是 off，这里显式写一遍更保险）。
 *
 * 需要验证「开启后真的记录」的用例必须显式传 `enabled: true` / `metricsEnabled={true}`
 * 或注入 `appendMetricForTest`（把写入重定向到 tmp），**绝不允许**让测试写进
 * `~/.concertoai/metrics.jsonl`——那会让开发者自己的 doctor 汇总里混进测试数据。
 */
process.env.CONCERTOAI_METRICS = 'off';
