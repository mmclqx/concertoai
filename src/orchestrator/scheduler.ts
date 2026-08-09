/**
 * 任务调度器（v3.0 M2 / T2.2，DAG 工作流引擎）。
 *
 * 实现依赖分析 → 拓扑排序 → 并行调度（无依赖任务并行执行）：
 * - topologicalSort：Kahn 算法输出执行顺序，检测循环依赖并返回环路径；
 * - detectFileConflicts：文件级冲突检测（两个任务修改同一文件且无依赖 → 冲突），
 *   支持 'error'（拒绝执行）与 'serialize'（自动串行化）两种策略；
 * - TaskScheduler：就绪队列 + 并发池（默认并发 3），单任务失败 → 级联跳过下游，
 *   支持重试（默认最多 2 次，指数退避）。
 *
 * 与 T2.1 状态机解耦（调度器内部维护任务状态；状态机生命周期由 T2.3 Orchestrator 驱动）。
 */

// ── 类型定义 ──────────────────────────────────────────────────

/** 调度器任务：显式依赖 + 文件声明 + 执行体。 */
export interface SchedulerTask {
  /** 任务 ID（全局唯一）。 */
  id: string;
  /** 依赖任务 ID 列表（必须先完成）。 */
  dependencies: string[];
  /** 该任务修改的文件路径（文件级冲突检测用，可选）。 */
  files?: string[];
  /** 任务执行体（失败时按重试策略重复调用）。 */
  run: () => Promise<TaskRunResult> | TaskRunResult;
}

/** 任务执行结果（ok:false 时 error 给出失败原因）。 */
export interface TaskRunResult {
  /** 是否成功。 */
  ok: boolean;
  /** 失败原因（ok 为 false 时给出）。 */
  error?: string;
}

/** 调度器选项。 */
export interface SchedulerOptions {
  /** 最大并发数（默认 DEFAULT_CONCURRENCY = 3）。 */
  concurrency?: number;
  /** 每个任务失败后最大重试次数（默认 DEFAULT_MAX_RETRIES = 2）。 */
  maxRetries?: number;
  /** 指数退避基数 ms（默认 DEFAULT_RETRY_BASE_DELAY_MS = 100）。 */
  retryBaseDelayMs?: number;
  /** 文件冲突策略（默认 'error'：报冲突不执行；'serialize'：自动串行化）。 */
  fileConflict?: 'error' | 'serialize';
}

/** 文件冲突（两个任务修改同一文件且无依赖链）。 */
export interface FileConflict {
  /** 冲突文件路径。 */
  file: string;
  /** 修改该文件的任务 A。 */
  taskA: string;
  /** 修改该文件的任务 B（与 A 无依赖关系）。 */
  taskB: string;
}

/** 调度结果。 */
export interface ScheduleResult {
  /** 是否全部成功（无失败 / 无跳过 / 无文件冲突）。 */
  ok: boolean;
  /** 拓扑排序的执行顺序（计划顺序）。 */
  order: string[];
  /** 成功完成的任务 id → 结果。 */
  completed: Map<string, TaskRunResult>;
  /** 失败任务 id → 错误信息（含重试耗尽）。 */
  failed: Map<string, string>;
  /** 因依赖失败而级联跳过的任务 id 列表。 */
  skipped: string[];
  /** 检测到的文件冲突（fileConflict='error' 时返回，任务不执行）。 */
  fileConflicts: FileConflict[];
}

/** 拓扑排序结果。 */
export interface TopoSortResult {
  /** 拓扑序（无环时完整）。 */
  order: string[];
  /** 检测到的环路径（无环时为 undefined）。 */
  cycle?: string[];
}

// ── 常量 ──────────────────────────────────────────────────────

/** 默认最大并发数。 */
export const DEFAULT_CONCURRENCY = 3;
/** 默认最大重试次数（失败后最多再试 2 次，共 3 次尝试）。 */
export const DEFAULT_MAX_RETRIES = 2;
/** 默认指数退避基数（毫秒）。 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 100;

// ── 错误类 ────────────────────────────────────────────────────

/** 循环依赖错误：检测到 DAG 环，携带环路径。 */
export class CyclicDependencyError extends Error {
  /** 环路径（如 ['a', 'b', 'c', 'a']）。 */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`检测到循环依赖: ${cycle.join(' → ')}`);
    this.name = 'CyclicDependencyError';
    this.cycle = cycle;
  }
}

// ── 独立纯函数（供测试 / T2.3 复用）──────────────────────────

/**
 * 拓扑排序（Kahn 算法）：输入 Task[]（含 dependencies），输出执行顺序。
 * 依赖不存在的任务抛错；存在环时返回 cycle 路径（不抛错，由调用方决定）。
 */
export function topologicalSort(tasks: SchedulerTask[]): TopoSortResult {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  if (idToTask.size !== tasks.length) {
    throw new Error('任务 ID 重复：调度器要求任务 ID 全局唯一');
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    dependents.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!idToTask.has(dep)) {
        throw new Error(`任务 ${task.id} 依赖不存在的任务: ${dep}`);
      }
      // 边 dep → task：task 依赖 dep
      dependents.get(dep)?.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      break;
    }
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (order.length !== tasks.length) {
    // 剩余节点构成环：提取环路径
    const inCycle = new Set(tasks.map((t) => t.id).filter((id) => (inDegree.get(id) ?? 0) > 0));
    return { order, cycle: findCycle(tasks, inCycle) };
  }
  return { order };
}

/** 在指定子图内用 DFS 找任意环路径（返回完整环，含回到起点的边）。 */
function findCycle(tasks: SchedulerTask[], inSubgraph: Set<string>): string[] {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const dfs = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const startIdx = path.indexOf(id);
      return [...path.slice(startIdx), id];
    }
    if (visited.has(id)) {
      return undefined;
    }
    visiting.add(id);
    path.push(id);
    for (const dep of idToTask.get(id)?.dependencies ?? []) {
      if (!inSubgraph.has(dep)) {
        continue;
      }
      const cycle = dfs(dep);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const id of inSubgraph) {
    const cycle = dfs(id);
    if (cycle !== undefined && cycle.length > 0) {
      return cycle;
    }
  }
  return [];
}

/** 判断 from 是否直接或间接依赖 to（依赖路径查询）。 */
export function hasDependencyPath(tasks: SchedulerTask[], from: string, to: string): boolean {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current === to) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const dep of idToTask.get(current)?.dependencies ?? []) {
      if (!visited.has(dep)) {
        stack.push(dep);
      }
    }
  }
  return false;
}

/**
 * 文件级依赖冲突检测：
 * 两个任务修改同一文件且彼此无依赖链（直接或间接）→ 冲突（并行写同一文件）。
 * 存在依赖链的任务对天然串行，不算冲突。
 */
export function detectFileConflicts(tasks: SchedulerTask[]): FileConflict[] {
  const fileToTasks = new Map<string, string[]>();
  for (const task of tasks) {
    for (const file of task.files ?? []) {
      const list = fileToTasks.get(file);
      if (list === undefined) {
        fileToTasks.set(file, [task.id]);
      } else {
        list.push(task.id);
      }
    }
  }

  const conflicts: FileConflict[] = [];
  for (const [file, taskIds] of fileToTasks) {
    if (taskIds.length < 2) {
      continue;
    }
    for (let i = 0; i < taskIds.length; i += 1) {
      const a = taskIds[i];
      if (a === undefined) {
        continue;
      }
      for (let j = i + 1; j < taskIds.length; j += 1) {
        const b = taskIds[j];
        if (b === undefined) {
          continue;
        }
        const aDependsOnB = hasDependencyPath(tasks, a, b);
        const bDependsOnA = hasDependencyPath(tasks, b, a);
        if (!aDependsOnB && !bDependsOnA) {
          conflicts.push({ file, taskA: a, taskB: b });
        }
      }
    }
  }
  return conflicts;
}

// ── 调度器 ────────────────────────────────────────────────────

/**
 * 任务调度器：拓扑排序 → 文件冲突处理 → 就绪队列 + 并发池并行执行。
 * 单任务失败 → 记录 failed 并级联跳过下游；支持重试（指数退避）。
 */
export class TaskScheduler {
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fileConflict: 'error' | 'serialize';

  constructor(options?: SchedulerOptions) {
    this.concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.fileConflict = options?.fileConflict ?? 'error';
  }

  /** 调度执行全部任务，返回完整结果（失败/跳过/冲突均在结果中体现）。 */
  async schedule(tasks: SchedulerTask[]): Promise<ScheduleResult> {
    if (tasks.length === 0) {
      return {
        ok: true,
        order: [],
        completed: new Map(),
        failed: new Map(),
        skipped: [],
        fileConflicts: [],
      };
    }

    // 1. 文件冲突检测与处理
    let working = tasks;
    const conflicts = detectFileConflicts(tasks);
    if (conflicts.length > 0 && this.fileConflict === 'error') {
      return {
        ok: false,
        order: [],
        completed: new Map(),
        failed: new Map(),
        skipped: [],
        fileConflicts: conflicts,
      };
    }
    if (conflicts.length > 0 && this.fileConflict === 'serialize') {
      working = this.serializeConflicts(tasks, conflicts);
    }

    // 2. 拓扑排序（环 → 抛 CyclicDependencyError）
    const topo = topologicalSort(working);
    if (topo.cycle !== undefined && topo.cycle.length > 0) {
      throw new CyclicDependencyError(topo.cycle);
    }
    const order = topo.order;

    // 3. 并行执行（就绪队列 + 并发池）
    return this.execute(working, order);
  }

  /** serialize 策略：为冲突任务对添加依赖边（输入顺序靠前者先执行），返回克隆任务。 */
  private serializeConflicts(tasks: SchedulerTask[], conflicts: FileConflict[]): SchedulerTask[] {
    const cloned = tasks.map((t) => ({ ...t, dependencies: [...t.dependencies] }));
    const idIndex = new Map(cloned.map((t, i) => [t.id, i]));
    for (const conflict of conflicts) {
      const indexA = idIndex.get(conflict.taskA);
      const indexB = idIndex.get(conflict.taskB);
      if (indexA === undefined || indexB === undefined) {
        continue;
      }
      // 靠前者先执行：靠后者依赖靠前者
      if (indexA < indexB) {
        const taskB = cloned[indexB];
        taskB?.dependencies.push(conflict.taskA);
      } else {
        const taskA = cloned[indexA];
        taskA?.dependencies.push(conflict.taskB);
      }
    }
    // 加边后可能形成环 → 交由 topologicalSort 检测（调用方抛 CyclicDependencyError）
    return cloned;
  }

  /**
   * 波次（wave）分层 + 并发池执行。
   *
   * 按拓扑序计算依赖深度分层：同层任务无依赖关系可并行；层间严格串行
   * （天然满足依赖约束）。层内用固定 worker 并发池限制并发，任务失败后
   * 级联标记下游 skipped（当前层未执行 / 后续层均跳过）。
   */
  private async execute(tasks: SchedulerTask[], order: string[]): Promise<ScheduleResult> {
    const idToTask = new Map(tasks.map((t) => [t.id, t]));
    const completed = new Map<string, TaskRunResult>();
    const failed = new Map<string, string>();
    const skipped = new Set<string>();

    // 任务状态：pending / done / failed / skipped
    const status = new Map<string, 'pending' | 'done' | 'failed' | 'skipped'>();
    const dependents = new Map<string, string[]>();
    for (const task of tasks) {
      status.set(task.id, 'pending');
      dependents.set(task.id, []);
    }
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        dependents.get(dep)?.push(task.id);
      }
    }

    /** 级联跳过：任务失败后，所有（直接或间接）下游任务标记 skipped。 */
    const markSkippedDownstream = (taskId: string): void => {
      const queue = [taskId];
      while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined) {
          break;
        }
        for (const next of dependents.get(current) ?? []) {
          if (status.get(next) === 'pending') {
            status.set(next, 'skipped');
            skipped.add(next);
            queue.push(next);
          }
        }
      }
    };

    /** 执行单个任务（含重试与指数退避）；失败后级联跳过下游。 */
    const runTask = async (taskId: string): Promise<void> => {
      const task = idToTask.get(taskId);
      if (task === undefined) {
        failed.set(taskId, '任务不存在');
        return;
      }
      let attempts = 0;
      for (;;) {
        attempts += 1;
        let result: TaskRunResult;
        try {
          result = await task.run();
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok) {
          completed.set(taskId, result);
          status.set(taskId, 'done');
          return;
        }
        // 失败：未超过重试上限 → 指数退避后重试
        if (attempts <= this.maxRetries) {
          const delay = this.retryBaseDelayMs * 2 ** (attempts - 1);
          await sleep(delay);
          continue;
        }
        failed.set(taskId, result.error ?? '任务执行失败');
        status.set(taskId, 'failed');
        markSkippedDownstream(taskId);
        return;
      }
    };

    /** 层内并发池执行：固定 worker 数，共享游标取任务。 */
    const runLayer = async (layer: string[]): Promise<void> => {
      let cursor = 0;
      const workerCount = Math.min(this.concurrency, layer.length);
      const workers: Promise<void>[] = [];
      for (let i = 0; i < workerCount; i += 1) {
        workers.push(
          (async () => {
            while (cursor < layer.length) {
              const taskId = layer[cursor];
              if (taskId === undefined) break; // 游标越界防御（noUncheckedIndexedAccess 收窄）
              cursor += 1;
              if (status.get(taskId) !== 'pending') {
                continue; // 已被级联跳过
              }
              await runTask(taskId);
            }
          })(),
        );
      }
      await Promise.all(workers);
    };

    // 逐层执行（同层并行，层间串行）
    for (const layer of computeLayers(tasks, order)) {
      await runLayer(layer);
    }

    return {
      ok: failed.size === 0 && skipped.size === 0,
      order,
      completed,
      failed,
      skipped: [...skipped],
      fileConflicts: [],
    };
  }
}

/**
 * 波次分层：按拓扑序计算每个任务的依赖深度（wave = max(depWave) + 1），
 * 同层任务无依赖关系（可并行），层间严格满足依赖约束。
 */
function computeLayers(tasks: SchedulerTask[], order: string[]): string[][] {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const wave = new Map<string, number>();
  for (const id of order) {
    const task = idToTask.get(id);
    let currentWave = 0;
    for (const dep of task?.dependencies ?? []) {
      const depWave = wave.get(dep) ?? 0;
      currentWave = Math.max(currentWave, depWave + 1);
    }
    wave.set(id, currentWave);
  }
  const layers: string[][] = [];
  for (const id of order) {
    const currentWave = wave.get(id) ?? 0;
    if (layers[currentWave] === undefined) {
      layers[currentWave] = [];
    }
    layers[currentWave]?.push(id);
  }
  return layers;
}

/** 延迟工具（指数退避）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
