/**
 * 内置子代理注册（v2.0）。
 */

import type { SubagentSpawner } from '../spawner';
import { EXPLORE_AGENT } from './explore';
import { RESEARCH_AGENT } from './research';

/** 将所有内置子代理注册到 spawner。 */
export function registerBuiltinSubagents(spawner: SubagentSpawner): void {
  spawner.register(EXPLORE_AGENT).register(RESEARCH_AGENT);
}

export { EXPLORE_AGENT, RESEARCH_AGENT };
