/**
 * 工作流内置模板（v4.0 M2 T2.1）。
 *
 * 4 个开箱即用模板：
 * - init-ts      初始化 TS 项目（tsconfig/package.json/git）；
 * - upgrade-deps 依赖升级（npm outdated → 逐个升级 → verify）；
 * - release      发布（lint → test → build → changelog → 审批 → publish）；
 * - precommit    提交前检查（lint + type + test）。
 *
 * 模板以 TS 常量定义（避免内置 YAML 文本维护两份）；`workflow export` 时
 * 序列化为 YAML。release 模板含审批节点示例（publish 前 require: approval）。
 */

import type { Workflow } from './types';

/** 内置模板注册表：name → Workflow。 */
export const WORKFLOW_TEMPLATES: Record<string, Workflow> = {
  'init-ts': {
    name: 'init-ts',
    description: '初始化 TypeScript 项目（tsconfig + package.json + git）',
    steps: [
      { name: 'init-npm', run: 'npm init -y', description: '生成 package.json' },
      { name: 'add-ts', run: 'npm install -D typescript @types/node', depends: ['init-npm'] },
      {
        name: 'write-tsconfig',
        run: 'npx tsc --init',
        depends: ['add-ts'],
        description: '生成 tsconfig.json',
      },
      { name: 'git-init', run: 'git init' },
    ],
  },
  'upgrade-deps': {
    name: 'upgrade-deps',
    description: '依赖升级：检查过期 → 逐个升级 → verify',
    steps: [
      { name: 'outdated', run: 'npm outdated', description: '查看过期依赖' },
      { name: 'upgrade', run: 'npm update', depends: ['outdated'] },
      { name: 'verify', run: 'npm run verify', depends: ['upgrade'] },
    ],
  },
  release: {
    name: 'release',
    description: '发布流程：lint → test → build → changelog → 审批 → publish',
    steps: [
      { name: 'lint', run: 'npm run lint' },
      { name: 'test', run: 'npm run test -- --silent', depends: ['lint'] },
      { name: 'build', run: 'npm run build', depends: ['test'] },
      {
        name: 'changelog',
        run: 'node scripts/update-changelog.mjs',
        depends: ['build'],
        files: ['CHANGELOG.md'],
      },
      {
        name: 'publish',
        run: 'npm publish',
        depends: ['changelog'],
        require: 'approval',
        files: ['package.json', 'package-lock.json'],
        description: '发布前需用户审批（require: approval）',
      },
    ],
  },
  precommit: {
    name: 'precommit',
    description:
      '提交前检查：lint + type + test（前提：项目需已配置 lint/typecheck/test 脚本与格式约定，如 biome.json）',
    steps: [
      {
        name: 'lint',
        run: 'npm run lint',
        description:
          '前置：项目需配置 lint 脚本（如 biome check .）与格式约定 biome.json（indentStyle/lineEnding 与团队一致，避免 Windows CRLF 误报）',
      },
      { name: 'typecheck', run: 'npm run typecheck' },
      { name: 'test', run: 'npm run test -- --silent', depends: ['lint', 'typecheck'] },
    ],
  },
};

/** 内置模板名列表（按注册顺序，供 workflow init 选择）。 */
export const WORKFLOW_TEMPLATE_NAMES: readonly string[] = Object.keys(WORKFLOW_TEMPLATES);

/** 按名取模板；未知返回 undefined。 */
export function getWorkflowTemplate(name: string): Workflow | undefined {
  const template = WORKFLOW_TEMPLATES[name];
  return template === undefined ? undefined : structuredClone(template);
}
