# 2026-11-11 「假 HOME 没生效」差点成为错误归因 —— 真凶是 config 里 `schemaVersion` 写错，**零真钱的验收脚本安静地花了真钱**

## 问题描述

- **现象**：v5.1 手工验收脚本（`scripts/pty-drive-v51.mjs`）的**每一处设计都在防真花钱**：临时项目目录、临时 `HOME`/`USERPROFILE`、`config.json` 里 `baseUrl` 指向本地 mock（`http://127.0.0.1:<port>`）、`apiKey` 写成假的 `sk-****`。结果真机 TTY 跑起来：界面正常、模型正常回话、成本回执**有数字**——因为请求压根没走 mock，而是打到**真实的 DeepSeek 官方端点**了。
- **环境**：Windows x64 / Node 22 / 直连开发机 shell（里面有真实 `DEEPSEEK_API_KEY`）
- **危害等级**：🔴 高 —— 它同时踩中两条红线：① **花了真钱**（本轮实测两场景各一次真实调用，约 ¥0.0054）；② 更贵的是**归因会错**——第一反应是「假 HOME 没生效 / 隔离没做成」，而这只解释了一半。按这个方向修，改多少 HOME 都不会好。

## 根因分析

### 隔离是生效的；失效的是「config 的形状」

先摆事实（可复核）：`os.homedir()` 在 Windows 读 `USERPROFILE`，脚本两个都设了；子进程里 `HOME` 确实指向临时目录。**假 HOME 没问题。**

真正失效的是脚本写下去的 `config.json`：

```jsonc
{ "schemaVersion": 1, ... "providers": { "deepseek": { "baseUrl": "http://127.0.0.1:PORT" } } }
```

`schemaVersion: 1` 在 v4 起是**v3（旧格式）的版本号**（`CONFIG_SCHEMA_VERSION = 1`，v4 = 2）。于是启动期：

1. `isV3Config()`（`src/store/migration.ts`）判 `schemaVersion === 1` ⇒ **true**，触发 `migrateV3ToV4`；
2. `migrateV3ToV4` 的字段映射表只有 `defaultModel → providers.deepseek.model`（以及 `ollama*`），并且**重建** `providers.deepseek = { type:'deepseek', model: defaultModel }`；
3. 重建 ⇒ 我写进去的 `baseUrl` / `apiKey` **被整体丢掉**（`defaultProvider` 也被重置成 `'deepseek'`）；
4. 之后客户端取 baseUrl 得到「没配」⇒ 回落官方端点，而子进程环境里恰好有真 `DEEPSEEK_API_KEY` ⇒ **真钱**。

一句话：**脚本把「我自己写的 v4 配置」标成了「v3 旧配置」，迁移器按旧格式 faithfully 重建，把不想丢的字段丢了。**

### 为什么它安静得可怕

| 层 | 表现 |
|---|---|
| 配置加载 | 不报错：迁移是**合法路径**，还顺手写了 `config.v3.bak` 备份（证明「迁移成功」） |
| 网络层 | 不报错：官端点正常回 200，流式回话正常 |
| 界面 | 不报错：看起来和零真钱的跑法一模一样 |
| 成本回执 | **有数字**，甚至像是「一切正常」的证据 |

如果没有「探针通电」这一步，全部断言会以各种莫名其妙的方式红或绿——而**「花了真钱」这件事本身不产生任何信号**。

## 解决方案

1. **`schemaVersion` 必须写 2**（v4 形态），并在 `writeConfig()` 上方写死理由（脚本现有注释就是本文的浓缩版）。
2. **mock 命中次数作为探针通电证据**：每个场景**第一条**断言不是业务事实，而是 `mockHits > 0`——「本地 mock 真被请求到了」。它把「零真钱」从「没人说话」变成**有证据**。
3. **四道防真花钱的锁**（缺一条都可能打到官方端点）：① `HOME`/`USERPROFILE` → 临时目录；② `DEEPSEEK_API_KEY` → 故意无效的占位值（哪怕 baseUrl 再次丢，也只是一次 401，不是一次扣费）；③ 清空继承来的 `CONCERTOAI_*` / `LUMEN_*`（它们**优先级高于 config**，留着会让脚本文档化的配置静默失效）；④ `LUMEN_LOCALE=zh` 显式钉死（AGENTS：locale 不受外部影响，是写出来的承诺）。
4. 该坑的取证顺序写进脚本注释，后人跑之前先读：**先看 `mockHits`，再看业务断言**。
