import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { GateSpec, LoopTriggerKind } from '@garden/core';

const Gate = z.union([
  z.enum(['step_success', 'tests_pass', 'manual']).transform((kind): GateSpec => ({ kind })),
  z
    .object({ command_ok: z.string() })
    .transform((g): GateSpec => ({ kind: 'command_ok', pattern: g.command_ok })),
]);

const Step = z
  .object({
    id: z.string(),
    skill: z.string().optional(),
    agent: z.string().optional(),
    gate: Gate.default({ kind: 'step_success' }),
  })
  .refine((s) => s.skill || s.agent, 'a step needs `skill` or `agent`');

const Duration = z.string().regex(/^\d+(m|h|d|w)$/, 'use e.g. 30m, 6h, 1d, 1w');

const GardenYaml = z.object({
  playbooks: z
    .array(
      z.object({ name: z.string(), project: z.string().optional(), steps: z.array(Step).min(1) }),
    )
    .default([]),
  loops: z
    .array(
      z.object({
        name: z.string(),
        project: z.string().optional(),
        agent: z.string().default('main'),
        trigger: z
          .enum(['cron', 'hook', 'loop_skill', 'headless_repeat', 'stop_continuation', 'declared'])
          .default('declared'),
        every: Duration.optional(),
        match: z.string().optional(),
      }),
    )
    .default([]),
  pricing: z
    .record(
      z.string(),
      z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        contextWindow: z.number().default(1_000_000),
      }),
    )
    .default({}),
});

export type GardenConfig = z.infer<typeof GardenYaml>;
export type DeclaredLoop = GardenConfig['loops'][number] & { trigger: LoopTriggerKind };

export const EMPTY_GARDEN_CONFIG: GardenConfig = { playbooks: [], loops: [], pricing: {} };

export function durationSeconds(d: string): number {
  const n = Number(d.slice(0, -1));
  return n * { m: 60, h: 3600, d: 86400, w: 604800 }[d.slice(-1) as 'm' | 'h' | 'd' | 'w'];
}

/** Load garden.yaml. Missing file → empty config. Invalid file → throws with a readable message. */
export function loadGardenConfig(path: string | undefined): GardenConfig {
  if (!path || !existsSync(path)) return EMPTY_GARDEN_CONFIG;
  const result = GardenYaml.safeParse(parse(readFileSync(path, 'utf8')) ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid ${path}:\n${issues}`);
  }
  return result.data;
}
