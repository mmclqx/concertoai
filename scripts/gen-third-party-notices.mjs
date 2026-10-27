#!/usr/bin/env node
/**
 * 生成 THIRD_PARTY_NOTICES.md + LICENSES/（v5.0 T4）。
 *
 * 为什么用脚本而不是手抄：
 * - 手抄必然与真实 node_modules 漂移（版本号/许可证类型），本次实测就发现两处计划书错误：
 *   ① cli-highlight 实际是 **ISC**（计划书写 MIT）② tiktoken 的 npm 包**未随包附带 LICENSE 文件**；
 * - BSD-3-Clause（highlight.js，经 cli-highlight 传递）**要求二进制分发复现版权声明**，
 *   而 tsup 默认把依赖打进 dist → 必须完整声明，不能只写"注明"。
 *
 * 输出：
 * - LICENSES/<pkg>-<version>.txt：许可证原文（上游未提供时写说明文件，不伪造）
 * - THIRD_PARTY_NOTICES.md：直接依赖 + 声明被一同打包的传递依赖（highlight.js）
 *
 * 用法：node scripts/gen-third-party-notices.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 直接运行时依赖（与 package.json dependencies 对应）。 */
const DIRECT_DEPS = [
  'chalk',
  'cli-highlight',
  'commander',
  'ink',
  'react',
  'tiktoken',
  'zod',
];

/** 需要额外声明的传递依赖（被 tsup 打进 dist，且带「必须复现声明」类许可证）。 */
const TRANSITIVE_DEPS = ['highlight.js'];

const ROOT = process.cwd();
const LICENSE_DIR = path.join(ROOT, 'LICENSES');

/** 读取包元信息。 */
function readPkg(name) {
  const file = path.join(ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(file)) {
    return undefined;
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 找包内许可证文件名（大小写不敏感，兼容 license / LICENSE / LICENSE.txt / licence）。 */
function findLicenseFile(name) {
  const dir = path.join(ROOT, 'node_modules', name);
  if (!existsSync(dir)) {
    return undefined;
  }
  const hit = readdirSync(dir).find((f) => /^licen[cs]e(\.(txt|md))?$/i.test(f));
  return hit === undefined ? undefined : path.join(dir, hit);
}

/**
 * 作者 → 字符串。
 * package.json 无 author 时（如 react / chalk），回退到 LICENSE 原文里的 Copyright 行——
 * 版权声明是合规必需项，不能因为 package.json 缺字段就显示"未声明"。
 */
function authorOf(pkg, licensePath) {
  const a = pkg.author;
  if (typeof a === 'string') {
    return a;
  }
  if (a !== undefined && typeof a.name === 'string') {
    return [a.name, a.email === undefined ? undefined : `<${a.email}>`]
      .filter(Boolean)
      .join(' ');
  }
  if (licensePath !== undefined) {
    const line = readFileSync(licensePath, 'utf8')
      .split(/\r?\n/)
      .find((l) => /copyright/i.test(l));
    if (line !== undefined) {
      return line.replace(/^\s*(?:\*|\/\/|#)?\s*/, '').trim();
    }
  }
  return '（package.json 与 LICENSE 均未声明版权信息）';
}

/** 处理单个依赖：复制许可证原文（或写说明），返回元信息。 */
function collect(name) {
  const pkg = readPkg(name);
  if (pkg === undefined) {
    throw new Error(`依赖未安装：${name}（请先 npm install）`);
  }
  const license = typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN';
  const src = findLicenseFile(name);
  const targetName = `${name.replace('/', '-').replace('@', '')}-${pkg.version}.txt`;
  const target = path.join(LICENSE_DIR, targetName);

  if (src !== undefined) {
    writeFileSync(target, readFileSync(src, 'utf8'), 'utf8');
  } else {
    // 上游未随包附带 LICENSE：如实说明 + 指向 package.json 声明与上游仓库，**不伪造原文**
    const repo =
      typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
    writeFileSync(
      target,
      [
        `# ${name}@${pkg.version} — 许可证声明：${license}`,
        '',
        '⚠️  本包在 npm 发布物中**未附带 LICENSE 文件**（实测确认）。',
        '',
        `package.json 中声明的许可证：${license}`,
        repo === '' ? '' : `上游仓库：${repo}`,
        '',
        '为合规起见，本文件记录该事实，许可证全文请以上游仓库 LICENSE 文件为准。',
        '本项目未修改该依赖源码，仅作为运行时依赖使用。',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  return {
    name,
    version: pkg.version,
    license,
    author: authorOf(pkg, src),
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : '',
    repo:
      typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
    licenseFile: name === 'tiktoken' ? undefined : path.basename(src ?? ''),
    file: targetName,
    hasUpstreamLicense: src !== undefined,
  };
}

/** 主流程。 */
function main() {
  mkdirSync(LICENSE_DIR, { recursive: true });
  const direct = DIRECT_DEPS.map(collect);
  const transitive = TRANSITIVE_DEPS.map(collect);

  const row = (d) =>
    `| \`${d.name}\` | ${d.version} | ${d.license} | ${d.author} | [${d.file}](./LICENSES/${d.file}) |`;

  const needsAttribution = [...direct, ...transitive].filter((d) =>
    /BSD|Apache/.test(d.license),
  );

  const md = [
    '# 第三方许可声明（THIRD_PARTY_NOTICES）',
    '',
    '> 本文件由 `scripts/gen-third-party-notices.mjs` **自动生成**，请勿手工编辑。',
    `> 生成时间：${new Date().toISOString().slice(0, 10)} · 数据来源：本仓库 node_modules 实测`,
    '',
    '## 说明',
    '',
    'ConcertoAI 通过 tsup 打包，运行时依赖会被打包进 `dist/`。因此下述依赖的许可证声明',
    '随本项目一同分发，原始许可证全文见 [`LICENSES/`](./LICENSES/) 目录。',
    '',
    '本项目**未修改**任何第三方依赖的源码。',
    '',
    '## 直接依赖',
    '',
    '| 包 | 版本 | 许可证 | 版权声明 | 许可证全文 |',
    '| --- | --- | --- | --- | --- |',
    ...direct.map(row),
    '',
    '## 随包分发的传递依赖',
    '',
    '以下依赖不是直接依赖，但会被打包进产物，需要一并声明：',
    '',
    '| 包 | 版本 | 许可证 | 版权声明 | 许可证全文 |',
    '| --- | --- | --- | --- | --- |',
    ...transitive.map(row),
    '',
  ];

  if (needsAttribution.length > 0) {
    md.push(
      '## 需要复现版权声明的许可证（BSD / Apache）',
      '',
      '以下依赖使用 BSD-3-Clause 等「二进制分发须复现版权声明」的许可证，',
      '本项目按要求在此处及 `LICENSES/` 中复现其版权信息：',
      '',
      ...needsAttribution.map(
        (d) => `- **${d.name}@${d.version}** — ${d.license} — Copyright ${d.author}`,
      ),
      '',
    );
  }

  const noLicenseFile = [...direct, ...transitive].filter((d) => !d.hasUpstreamLicense);
  if (noLicenseFile.length > 0) {
    md.push(
      '## 已知的许可证文件缺失（如实记录）',
      '',
      '以下依赖在 npm 发布物中**未附带 LICENSE 文件**（本项目无法凭空生成其原文），',
      '其许可证类型以上游仓库为准，`LICENSES/` 中为说明文件：',
      '',
      ...noLicenseFile.map(
        (d) =>
          `- **${d.name}@${d.version}** — package.json 声明 \`${d.license}\`${d.repo === '' ? '' : ` — 上游：${d.repo}`}`,
      ),
      '',
    );
  }

  md.push(
    '## 本项目许可证',
    '',
    'ConcertoAI 本身以 MIT 许可证发布，详见 [LICENSE](./LICENSE)。',
    '',
  );

  writeFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), md.join('\n'), 'utf8');
  console.log(
    `✅ 已生成 THIRD_PARTY_NOTICES.md + LICENSES/（${direct.length} 直接 + ${transitive.length} 传递）`,
  );
}

main();
