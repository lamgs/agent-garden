/** Router glue: GardenData (one window) → router input, plus a per-window index cache. */
import type { GardenView } from '@garden/core';
import {
  buildRouterIndex,
  candidateKey,
  type RouterIndex,
  type RouterInput,
  type RouterRunInput,
} from '@garden/router';
import type { GardenData } from './data';

export function routerInputFrom(data: GardenData, garden: GardenView): RouterInput {
  const plantsByAgent = new Map<string, string[]>();
  for (const p of garden.plants)
    plantsByAgent.set(p.agentId, [...(plantsByAgent.get(p.agentId) ?? []), p.id]);
  const plantsBySkill = new Map<string, string[]>();
  for (const s of garden.skills)
    plantsBySkill.set(s.skillId, [...(plantsBySkill.get(s.skillId) ?? []), s.plantId]);
  const skillsByRun = new Map<string, Set<string>>();
  for (const c of data.skillCalls) {
    const set = skillsByRun.get(c.runId) ?? new Set<string>();
    set.add(c.skillId);
    skillsByRun.set(c.runId, set);
  }
  const runs: RouterRunInput[] = data.runs.map((r) => ({
    id: r.id,
    preview: r.taskPreview,
    label: r.label,
    candidateKeys: [
      candidateKey('agent', r.agentId),
      ...[...(skillsByRun.get(r.id) ?? [])].sort().map((s) => candidateKey('skill', s)),
    ],
  }));
  return {
    candidates: [
      ...data.agents.map((a) => ({
        kind: 'agent' as const,
        id: a.id,
        name: a.name,
        description: a.definition?.description ?? null,
        plantIds: [...new Set(plantsByAgent.get(a.id) ?? [])],
      })),
      ...data.skills.map((s) => ({
        kind: 'skill' as const,
        id: s.id,
        name: s.name,
        description: s.description,
        plantIds: [...new Set(plantsBySkill.get(s.id) ?? [])],
      })),
    ],
    runs,
  };
}

/** Small LRU of router indexes keyed by window. Cleared when a manual label changes outcomes. */
export class RouterCache {
  private map = new Map<string, RouterIndex>();
  constructor(private readonly max = 4) {}

  get(key: string, build: () => RouterIndex): RouterIndex {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const idx = build();
    this.map.set(key, idx);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return idx;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export function buildWindowIndex(data: GardenData, garden: GardenView): RouterIndex {
  return buildRouterIndex(routerInputFrom(data, garden));
}
