# [2026-08-11] npm 发布令牌过期导致 publish 失败（403 Forbidden / 2FA 验证失败）

## 问题描述
- 现象：本地执行 `npm publish` 发布 @concertoai/cli 时失败，npm 返回 **`403 Forbidden`**（E403），同时伴随 **2FA（OTP）验证失败** 提示，发布无法进行；`npm whoami` 同样报认证错误。
- 环境：Windows 本地发布（发布流程「方式 B」），npm ≥ 10

## 根因分析
- 直接原因：`~/.npmrc` 中缓存的 `//registry.npmjs.org/:_authToken=` 令牌已过期失效。npm 侧对过期/无效令牌统一返回 403 Forbidden；当账户开启了 2FA 且令牌已失效时，`npm publish` 会先触发 OTP 验证，令牌无效导致 2FA 校验也一并失败，现象上表现为「403 + 2FA 验证失败」双错误。
- 深层原因：npm 令牌有有效期（默认 1 年），过期后 npm 不会自动续期；发布流程（docs/04-发布流程.md）的「前置检查」与 AGENTS.md 发布门检查清单均未包含「令牌有效性验证」步骤，导致在令牌已过期的情况下仍直接进入 `npm publish`，等到 npm 拒绝才发现。且本地 `~/.npmrc` 中的令牌是长期静默缓存，没有任何过期提醒。

## 解决方案
- 修复方式：
  1. 重新登录生成新令牌：执行 `npm login`（web 认证，自动写入 `~/.npmrc` 的新 `_authToken`）；
  2. 验证令牌有效：`npm whoami` 返回用户名即通过；再次 `npm publish` 时若提示 OTP，输入账户 2FA 一次性密码；
  3. 长期方案：优先切换「方式 A」GitHub Actions + Trusted Publishing（OIDC 认证，无需本地令牌，彻底消除令牌过期问题）。
- 涉及文件：`docs/04-发布流程.md`（前置检查补 `npm whoami`；方式 B 补令牌生成/过期说明）、`AGENTS.md`（发布门检查清单补令牌有效性项）、本文档

## 经验教训
- 如何避免同类问题：
  1. 发布前先 `npm whoami` 验证令牌有效性（若 401/403 则先 `npm login`），再执行 `npm publish`；
  2. 熟悉 npm 令牌过期机制：令牌有有效期，接近过期前应主动重新生成（`npm token create` 或 `npm login`）；
  3. 优先使用 GitHub Actions + Trusted Publishing 发布（OIDC，无令牌过期问题），本地发布仅作备用；
  4. 发布流程前置检查必须包含认证验证，防止「命令白跑一遍才发现认证失败」。
- 是否需要更新规范：✅
- 规范更新位置：`docs/04-发布流程.md`（前置检查 + 方式 B）、`AGENTS.md`（发布门检查清单）

## 相关链接
- 对话记录：npm publish 令牌过期踩坑（2026-08-11）
- 相关 PR/Commit：（随本记录一并提交）
