/**
 * The encodings registry: every visual channel in the garden, the metric it encodes, and its bins.
 * The legend is generated from this list and the renderer reads levels from it, so a channel
 * cannot be drawn without a legend entry. See PLAN.md §8.
 */
import { modelFamily } from './pricing';
import type {
  BedSummary,
  BeeFlow,
  GateState,
  LoopChannel,
  PlantSummary,
  SkillCard,
  WeedKind,
} from './views';

export type GardenElement =
  'plant' | 'bed' | 'care_card' | 'irrigation' | 'bee' | 'weed' | 'playbook' | 'season' | 'ambient';

export interface Encoding<I> {
  id: string;
  element: GardenElement;
  channel: string;
  metric: string;
  howComputed: string;
  action: string;
  /** Legend labels, one per level, in order. */
  levels: readonly string[];
  /** Level index into `levels` for an input. */
  level: (input: I) => number;
}

/** Index of the first threshold that `value` is below; thresholds ascending. */
export function binIndex(value: number, thresholds: readonly number[]): number {
  let i = 0;
  while (i < thresholds.length && value >= thresholds[i]!) i++;
  return i;
}

export const MIN_RUNS_FOR_BLOOM = 5;

export const plantHeight: Encoding<PlantSummary> = {
  id: 'plant.height',
  element: 'plant',
  channel: 'Height',
  metric: 'Runs in the selected window',
  howComputed: 'Count of runs for this agent in this bed (log-scaled bins).',
  action: 'Tall plants are load-bearing; short ones are rarely called.',
  levels: ['0 runs', '1–3', '4–15', '16–63', '64+'],
  level: (p) => binIndex(p.runs, [1, 4, 16, 64]),
};

export const plantBloom: Encoding<PlantSummary> = {
  id: 'plant.bloom',
  element: 'plant',
  channel: 'Bloom (flowers and openness)',
  metric: 'Success rate',
  howComputed:
    'success = 1, partial = 0.5, failure = 0, over runs with a known label; unknown excluded. ' +
    `Hollow bud when fewer than ${MIN_RUNS_FOR_BLOOM} labeled runs.`,
  action: 'Full bloom: trust it. Sparse bloom: open the plant and read its failing runs.',
  levels: ['Too few labeled runs', '0–20%', '20–40%', '40–60%', '60–80%', '80–100%'],
  level: (p) =>
    p.success.value === null || p.success.n < MIN_RUNS_FOR_BLOOM
      ? 0
      : 1 + Math.min(4, Math.floor(p.success.value * 5)),
};

export const plantDroop: Encoding<PlantSummary> = {
  id: 'plant.droop',
  element: 'plant',
  channel: 'Droop (stem angle)',
  metric: 'Failure share, last 14 days',
  howComputed: 'Failures ÷ known-label runs in the last 14 days of the window.',
  action: 'Drooping: something recently broke. Check the harness or the prompt.',
  levels: ['Upright (<30%)', 'Leaning (30–50%)', 'Drooping (≥50%)'],
  level: (p) => (p.recentFailureShare === null ? 0 : binIndex(p.recentFailureShare, [0.3, 0.5])),
};

export const plantFade: Encoding<PlantSummary> = {
  id: 'plant.fade',
  element: 'plant',
  channel: 'Fade (desaturation, dry tips)',
  metric: 'Days since last run',
  howComputed: 'Window end minus the last run start, in days.',
  action: 'Faded plants are unused. Retire them or find out why nobody calls them.',
  levels: ['Fresh (<14 d)', 'Fading (14–45 d)', 'Dormant (>45 d or never)'],
  level: (p) => (p.staleDays === null ? 2 : binIndex(p.staleDays, [14, 45])),
};

export const plantHue: Encoding<PlantSummary> = {
  id: 'plant.hue',
  element: 'plant',
  channel: 'Foliage color',
  metric: 'Median cost per run (USD)',
  howComputed:
    'Median of per-run cost; tokens deduped per API message × pricing table. Marked “estimated” when some runs only had stream-start usage.',
  action: 'Darker foliage costs more per run. Consider a cheaper model or a tighter prompt.',
  levels: ['Unknown price', '< $0.05', '$0.05–0.25', '$0.25–1', '$1–5', '≥ $5'],
  level: (p) => (p.costPerRunUsd === null ? 0 : 1 + binIndex(p.costPerRunUsd, [0.05, 0.25, 1, 5])),
};

export const SOIL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'other'] as const;

export const bedTone: Encoding<BedSummary> = {
  id: 'bed.tone',
  element: 'bed',
  channel: 'Bed edging color + label',
  metric: 'Model family of the current harness',
  howComputed: 'Most-used model in the current harness version.',
  action: 'Compare harnesses at a glance.',
  levels: ['Fable', 'Opus', 'Sonnet', 'Haiku', 'Other / unknown'],
  level: (b) => SOIL_FAMILIES.indexOf(modelFamily(b.soil.model)),
};

export const bedTexture: Encoding<BedSummary> = {
  id: 'bed.texture',
  element: 'bed',
  channel: 'Soil texture density',
  metric: 'Tools + MCP servers available',
  howComputed: 'Tool names from the harness listing plus configured MCP servers.',
  action: 'Very dense soil: the agent may have more tools than it needs.',
  levels: ['< 15', '15–39', '40–79', '80+'],
  level: (b) => binIndex(b.soil.toolCount + b.soil.mcpCount, [15, 40, 80]),
};

export const bedStrata: Encoding<BedSummary> = {
  id: 'bed.strata',
  element: 'bed',
  channel: 'Soil strata lines',
  metric: 'CLAUDE.md chain size',
  howComputed: 'Total bytes of instruction files in the current harness version.',
  action: 'Many strata: instructions may be bloated.',
  levels: ['None', '< 4 KB', '4–16 KB', '≥ 16 KB'],
  level: (b) =>
    b.soil.instructionBytes === 0 ? 0 : 1 + binIndex(b.soil.instructionBytes, [4096, 16384]),
};

export const careCardSize: Encoding<SkillCard> = {
  id: 'care_card.size',
  element: 'care_card',
  channel: 'Seed-packet size',
  metric: 'Skill invocations by this plant',
  howComputed: 'Count of Skill tool calls naming this skill in this plant’s runs.',
  action: 'Big packets are the skills that matter here.',
  levels: ['1–3', '4–15', '16–63', '64+'],
  level: (s) => binIndex(s.invocations, [4, 16, 64]),
};

export const irrigationFlow: Encoding<LoopChannel> = {
  id: 'irrigation.flow',
  element: 'irrigation',
  channel: 'Flow speed and channel width',
  metric: 'Loop runs per day',
  howComputed: 'Runs attributed to the loop ÷ days in the window.',
  action: 'Wide, fast channels are where loops spend.',
  levels: ['< 0.2/day', '0.2–1/day', '1–5/day', '≥ 5/day'],
  level: (l) => binIndex(l.runsPerDay, [0.2, 1, 5]),
};

const LOOP_STATES = ['flowing', 'flooding', 'dry'] as const;
export const irrigationState: Encoding<LoopChannel> = {
  id: 'irrigation.state',
  element: 'irrigation',
  channel: 'Water state',
  metric: 'Loop health',
  howComputed:
    'Flooding: rate > 3× its baseline, or consecutive runs with no progress. Dry: 3× the expected interval with no run.',
  action: 'Flooding: stop a runaway loop. Dry: a dead loop.',
  levels: ['Flowing', 'Flooding (runaway)', 'Dry (dead)'],
  level: (l) => LOOP_STATES.indexOf(l.state),
};

export const beeCount: Encoding<BeeFlow> = {
  id: 'bee.count',
  element: 'bee',
  channel: 'Bees on a path',
  metric: 'Subagent calls, parent → child',
  howComputed: 'Count of Agent/Task tool calls from the parent plant spawning the child agent.',
  action: 'See which agents hand work to which.',
  levels: ['1 bee: 1–3 calls', '2 bees: 4–15', '3 bees: 16+'],
  level: (b) => binIndex(b.calls, [4, 16]),
};

const WEED_KINDS: readonly WeedKind[] = ['orphan', 'duplicate', 'unowned'];
export const weedKind: Encoding<{ kind: WeedKind }> = {
  id: 'weed.kind',
  element: 'weed',
  channel: 'Weed',
  metric: 'Hygiene issue',
  howComputed:
    'Orphan: defined but not run in 30 days. Duplicate: near-identical description or name shadowing. Unowned: missing description or broken reference.',
  action: 'Pull it: delete, merge, or document.',
  levels: ['Orphan', 'Duplicate', 'Unowned'],
  level: (w) => WEED_KINDS.indexOf(w.kind),
};

const GATES: readonly GateState[] = ['open', 'closed', 'unknown'];
export const playbookGate: Encoding<{ gate: GateState }> = {
  id: 'playbook.gate',
  element: 'playbook',
  channel: 'Gate on a stepping-stone path',
  metric: 'Playbook step gate',
  howComputed: 'Open when the most recent run of the step satisfied its gate spec.',
  action: 'A closed gate shows where the playbook breaks.',
  levels: ['Open', 'Closed', 'Unknown (no runs)'],
  level: (s) => GATES.indexOf(s.gate),
};

export const seasonBand: Encoding<{ index: number }> = {
  id: 'season.band',
  element: 'season',
  channel: 'Background tint band',
  metric: 'Harness version',
  howComputed:
    'One band per harness version; boundaries from git commits or observed fingerprint changes.',
  action: 'Line up a harness change with what happened to outcomes.',
  levels: ['Alternating tints, one per season'],
  level: () => 0,
};

export const ambientSway: Encoding<unknown> = {
  id: 'ambient.sway',
  element: 'ambient',
  channel: 'Gentle sway',
  metric: 'None (ambient, no meaning)',
  howComputed: 'Decorative motion. Disabled with prefers-reduced-motion.',
  action: 'None.',
  levels: ['Ambient'],
  level: () => 0,
};

export const ENCODINGS = [
  plantHeight,
  plantBloom,
  plantDroop,
  plantFade,
  plantHue,
  bedTone,
  bedTexture,
  bedStrata,
  careCardSize,
  irrigationFlow,
  irrigationState,
  beeCount,
  weedKind,
  playbookGate,
  seasonBand,
  ambientSway,
] as const satisfies readonly Encoding<never>[];

export interface LegendEntry {
  id: string;
  element: GardenElement;
  channel: string;
  metric: string;
  howComputed: string;
  action: string;
  levels: readonly string[];
}

export function legend(): LegendEntry[] {
  return ENCODINGS.map(({ id, element, channel, metric, howComputed, action, levels }) => ({
    id,
    element,
    channel,
    metric,
    howComputed,
    action,
    levels,
  }));
}
