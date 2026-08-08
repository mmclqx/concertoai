/**
 * 计划步骤依赖检测器。
 *
 * 解析 markdown 格式的计划文本，提取步骤并检测依赖关系：
 * - 显式依赖：步骤中 `depends on: N` / `依赖: 步骤N` 格式
 * - 文件依赖：后续步骤引用了前面步骤写入的文件路径
 * - 隐式依赖：write → read 关系（后续步骤读取前面步骤写入的文件）
 *
 * 输出拓扑排序的执行顺序，检测循环依赖。
 */

import type { DepsAnalysis, PlanStep, StepDependency } from './types';

// ── 正则常量 ──

/** 匹配编号列表：1. / 1) / - [ ] / 步骤1 */
const STEP_LINE_RE = /^(?:\d+[.)]\s+|[-*]\s+\[ \]\s+|步骤\s*(\d+)[：:]\s*)(.*)/;

/** 匹配显式依赖声明：depends on: 1,2 / 依赖: 步骤 3,4 */
const DEPENDS_ON_RE = /(?:depends?\s+on|依赖)[：:]\s*(?:步骤\s*)?([\d,\s]+)/i;

/** 匹配文件路径引用：`path` / 'path' / 纯路径 */
const FILE_REF_RE = /(?:[`'"]|^)([^\s`'"]*\.\w{1,10})(?:[`'"]|$)/gim;

/** 写操作关键词。 */
const WRITE_KEYWORDS = [
  '编辑',
  '创建',
  '修改',
  '写入',
  '删除',
  '追加',
  'edit',
  'create',
  'write',
  'modify',
  'delete',
  'update',
  'append',
];

/** 读操作关键词。 */
const READ_KEYWORDS = [
  '读取',
  '查看',
  '检查',
  '搜索',
  '列出',
  'read',
  'view',
  'check',
  'search',
  'list',
  'find',
  'grep',
];

// ── 主函数 ──

/**
 * 分析 markdown 计划文本，提取步骤与依赖关系。
 * 输入为模型输出的计划（/plan 阶段一的结果）。
 */
export function analyzeDeps(planText: string): DepsAnalysis {
  const steps = extractSteps(planText);
  const dependencies = detectDependencies(steps);
  const { ordered, cycles } = topologicalSort(steps, dependencies);
  const parallelGroups = computeParallelGroups(ordered, dependencies);

  return { steps, dependencies, ordered, cycles, parallelGroups };
}

// ── 步骤提取 ──

function extractSteps(text: string): PlanStep[] {
  const lines = text.split('\n');
  const steps: PlanStep[] = [];
  let currentStep: PlanStep | null = null;

  for (const line of lines) {
    const match = line.match(STEP_LINE_RE);
    if (match !== null) {
      // 发现新步骤，保存上一个
      if (currentStep !== null) {
        steps.push(currentStep);
      }
      const title = (match[2] ?? match[1] ?? line).trim();
      currentStep = {
        index: steps.length + 1,
        title,
        description: line.trim(),
        declaredDeps: [],
        fileRefs: [],
        isWrite: false,
      };
    } else if (currentStep !== null) {
      // 续行：追加到上一步描述
      currentStep.description += `\n${line}`;
    }
  }

  if (currentStep !== null) {
    steps.push(currentStep);
  }

  // 后处理：提取文件引用、写标记、显式依赖
  for (const step of steps) {
    // 显式依赖
    const depMatch = step.description.match(DEPENDS_ON_RE);
    if (depMatch !== null) {
      step.declaredDeps = (depMatch[1] ?? '')
        .split(/[,，\s]+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => !Number.isNaN(n) && n > 0 && n !== step.index);
    }

    // 文件路径引用
    const refs = new Set<string>();
    let fileMatch = FILE_REF_RE.exec(step.description);
    while (fileMatch !== null) {
      const ref = fileMatch[1];
      if (ref !== undefined) {
        refs.add(ref);
      }
      fileMatch = FILE_REF_RE.exec(step.description);
    }
    step.fileRefs = [...refs];

    // 写操作标记
    step.isWrite = WRITE_KEYWORDS.some((kw) =>
      step.description.toLowerCase().includes(kw.toLowerCase()),
    );
  }

  return steps;
}

// ── 依赖检测 ──

function detectDependencies(steps: PlanStep[]): StepDependency[] {
  const deps: StepDependency[] = [];

  // 1. 显式依赖
  for (const step of steps) {
    for (const depIndex of step.declaredDeps) {
      const target = steps.find((s) => s.index === depIndex);
      if (target !== undefined) {
        deps.push({
          from: step.index,
          to: depIndex,
          reason: `${step.title} 显式声明依赖 ${target.title}`,
        });
      }
    }
  }

  // 2. 文件依赖：如果步骤 B 引用了步骤 A 写入的文件，则 B 依赖 A
  for (const stepB of steps) {
    for (const stepA of steps) {
      if (stepA.index >= stepB.index) {
        continue; // 只检查前面的步骤
      }
      if (!stepA.isWrite) {
        continue;
      }
      // 检查 stepB 是否引用了 stepA 写入的文件
      for (const refB of stepB.fileRefs) {
        for (const refA of stepA.fileRefs) {
          if (refA === refB || refB.endsWith(refA) || refA.endsWith(refB)) {
            deps.push({
              from: stepB.index,
              to: stepA.index,
              reason: `${stepB.title} 读取 ${refB}，依赖 ${stepA.title} 创建/修改该文件`,
            });
          }
        }
      }
    }
  }

  // 3. 隐式读写依赖：如果步骤 A 是写操作，步骤 B 是读操作，且 B 在 A 之后
  //    且没有更明确的文件引用，添加弱依赖（读依赖写）
  for (const stepB of steps) {
    if (!READ_KEYWORDS.some((kw) => stepB.description.toLowerCase().includes(kw.toLowerCase()))) {
      continue;
    }
    for (const stepA of steps) {
      if (stepA.index >= stepB.index) {
        continue;
      }
      if (!stepA.isWrite) {
        continue;
      }
      // 检查是否已有文件依赖
      const alreadyDep = deps.some((d) => d.from === stepB.index && d.to === stepA.index);
      if (!alreadyDep && stepB.fileRefs.length > 0 && stepA.fileRefs.length > 0) {
        deps.push({
          from: stepB.index,
          to: stepA.index,
          reason: `${stepB.title}（读）依赖 ${stepA.title}（写）的文件变更`,
        });
      }
    }
  }

  // 去重
  const seen = new Set<string>();
  return deps.filter((d) => {
    const key = `${d.from}→${d.to}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// ── 拓扑排序（Kahn 算法） ──

function topologicalSort(
  steps: PlanStep[],
  deps: StepDependency[],
): { ordered: number[]; cycles: number[][] } {
  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();

  for (const step of steps) {
    inDegree.set(step.index, 0);
    adj.set(step.index, []);
  }

  for (const dep of deps) {
    adj.get(dep.to)?.push(dep.from);
    inDegree.set(dep.from, (inDegree.get(dep.from) ?? 0) + 1);
  }

  // Kahn 算法
  const queue: number[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  const ordered: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    ordered.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // 检测循环：排序后还有入度 > 0 的节点
  const cycles: number[][] = [];
  const remaining = [...inDegree.entries()].filter(([, d]) => d > 0).map(([n]) => n);
  if (remaining.length > 0) {
    cycles.push(remaining);
  }

  return { ordered, cycles };
}

// ── 并行组计算 ──

/**
 * 将拓扑排序结果分组：同一组内的步骤无互依赖，可并行执行。
 */
function computeParallelGroups(ordered: number[], deps: StepDependency[]): number[][] {
  if (ordered.length === 0) {
    return [];
  }

  const depMap = new Map<number, Set<number>>();
  for (const dep of deps) {
    if (!depMap.has(dep.from)) {
      depMap.set(dep.from, new Set());
    }
    depMap.get(dep.from)?.add(dep.to);
  }

  const groups: number[][] = [];
  const remaining = new Set(ordered);
  const completed = new Set<number>();

  while (remaining.size > 0) {
    const group: number[] = [];
    for (const step of remaining) {
      const depsOf = depMap.get(step);
      if (depsOf === undefined || [...depsOf].every((d) => completed.has(d))) {
        group.push(step);
      }
    }
    if (group.length === 0) {
      // 剩余节点有循环依赖 → 全部放入一组串行执行
      group.push(...remaining);
      groups.push(group);
      break;
    }
    for (const step of group) {
      remaining.delete(step);
      completed.add(step);
    }
    groups.push(group);
  }

  return groups;
}
